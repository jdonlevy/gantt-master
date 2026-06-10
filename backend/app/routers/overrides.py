from datetime import datetime
import uuid
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from ..database import get_session
from ..dependencies import require_role
from ..models import DependencyOverride, FixVersionOverride, Role
from ..schemas import DependencyOverrideIn, DependencyOverrideOut, FixVersionOverrideIn

router = APIRouter()


def parse_date(value: str | None):
    if not value:
        return None
    return datetime.fromisoformat(value).date()


def parse_uuid(value: str | None):
    if not value:
        return None
    try:
        return uuid.UUID(value)
    except ValueError:
        return None


def _resolve_dashboard_scope(raw: str | None) -> uuid.UUID | None:
    """Parse a dashboardId for a scoped request.

    Returns None when the payload omits dashboardId entirely (default/shared
    scope), a UUID when it's a valid id, and raises 422 when the caller sent
    a non-empty but malformed id. The previous behaviour silently coerced
    the bad id to None and then treated the request as unscoped, which could
    collide with the wrong row set.
    """

    if not raw:
        return None
    parsed = parse_uuid(raw)
    if parsed is None:
        raise HTTPException(
            status_code=422,
            detail="dashboardId must be a valid UUID when provided.",
        )
    return parsed


@router.post("/overrides/fix-version")
async def upsert_override(
    payload: FixVersionOverrideIn,
    session: AsyncSession = Depends(get_session),
    _user=Depends(require_role(Role.editor)),
):
    dashboard_id = _resolve_dashboard_scope(payload.dashboardId)
    override_query = select(FixVersionOverride).where(FixVersionOverride.fix_version_id == payload.fixVersionId)
    if dashboard_id:
        override_query = override_query.where(FixVersionOverride.dashboard_id == dashboard_id)
    result = await session.execute(override_query)
    override = result.scalar_one_or_none()
    if not override:
        override = FixVersionOverride(fix_version_id=payload.fixVersionId, dashboard_id=dashboard_id)
        session.add(override)
    elif dashboard_id:
        override.dashboard_id = dashboard_id

    if payload.uatStart is not None:
        override.uat_start = parse_date(payload.uatStart)
    if payload.uatEnd is not None:
        override.uat_end = parse_date(payload.uatEnd)
    if payload.liveStart is not None:
        override.live_start = parse_date(payload.liveStart)
    if payload.liveEnd is not None:
        override.live_end = parse_date(payload.liveEnd)
    if payload.notes is not None:
        override.notes = payload.notes

    await session.commit()
    await session.refresh(override)

    return {
        "id": override.fix_version_id,
        "dashboardId": str(override.dashboard_id) if override.dashboard_id else None,
        "uatStart": override.uat_start.isoformat() if override.uat_start else None,
        "uatEnd": override.uat_end.isoformat() if override.uat_end else None,
        "liveStart": override.live_start.isoformat() if override.live_start else None,
        "liveEnd": override.live_end.isoformat() if override.live_end else None,
        "notes": override.notes,
    }


def _serialize_dependency_override(override: DependencyOverride) -> DependencyOverrideOut:
    return DependencyOverrideOut(
        id=str(override.id),
        fromId=override.from_id,
        toId=override.to_id,
        fromType=override.from_type,
        toType=override.to_type,
        dashboardId=str(override.dashboard_id) if override.dashboard_id else None,
    )


@router.post("/overrides/dependency", response_model=DependencyOverrideOut, status_code=201)
async def create_dependency_override(
    payload: DependencyOverrideIn,
    session: AsyncSession = Depends(get_session),
    _user=Depends(require_role(Role.editor)),
):
    """Create a manual "A blocks B" dependency for a dashboard.

    Returns 409 if the same (dashboard, from, to) triple already exists.
    Self-links and invalid node types are rejected by the Pydantic validator
    (422). We also treat the reverse triple (B blocks A) as a conflict to
    avoid building trivially-cyclic manual graphs.
    """

    dashboard_id = _resolve_dashboard_scope(payload.dashboardId)

    def _scope_to_dashboard(query):
        """Scope a query to the same dashboard bucket as the incoming payload.

        Postgres treats NULL != NULL, so the unique index on
        (dashboard_id, from_id, to_id) does NOT catch duplicates when
        dashboard_id is NULL. We handle that bucket explicitly with IS NULL.
        """

        if dashboard_id is not None:
            return query.where(DependencyOverride.dashboard_id == dashboard_id)
        return query.where(DependencyOverride.dashboard_id.is_(None))

    # Reject forward duplicate explicitly — covers the NULL dashboard_id case
    # the unique index misses.
    forward_query = _scope_to_dashboard(
        select(DependencyOverride).where(
            DependencyOverride.from_id == payload.fromId,
            DependencyOverride.to_id == payload.toId,
        )
    )
    existing_forward = (await session.execute(forward_query)).scalar_one_or_none()
    if existing_forward is not None:
        raise HTTPException(
            status_code=409,
            detail="Dependency already exists.",
        )

    # Reject cycles at the pair level — keeps the UI predictable.
    reverse_query = _scope_to_dashboard(
        select(DependencyOverride).where(
            DependencyOverride.from_id == payload.toId,
            DependencyOverride.to_id == payload.fromId,
        )
    )
    existing_reverse = (await session.execute(reverse_query)).scalar_one_or_none()
    if existing_reverse is not None:
        raise HTTPException(
            status_code=409,
            detail="Reverse dependency already exists between these items.",
        )

    override = DependencyOverride(
        dashboard_id=dashboard_id,
        from_id=payload.fromId,
        to_id=payload.toId,
        from_type=payload.fromType,
        to_type=payload.toType,
    )
    session.add(override)
    try:
        await session.commit()
    except IntegrityError:
        # Race: another request inserted the same triple between our SELECT
        # and COMMIT. Still surface as 409.
        await session.rollback()
        raise HTTPException(
            status_code=409,
            detail="Dependency already exists.",
        )
    await session.refresh(override)
    return _serialize_dependency_override(override)


@router.delete("/overrides/dependency/{override_id}", status_code=204)
async def delete_dependency_override(
    override_id: str,
    session: AsyncSession = Depends(get_session),
    _user=Depends(require_role(Role.editor)),
):
    """Remove a manual dependency by primary key.

    Jira-sourced dependencies do not flow through this table, so there is no
    way to delete them here — the UI should only expose removal for manual
    deps.
    """

    parsed_id = parse_uuid(override_id)
    if parsed_id is None:
        raise HTTPException(status_code=404, detail="Dependency override not found.")

    result = await session.execute(
        select(DependencyOverride).where(DependencyOverride.id == parsed_id)
    )
    override = result.scalar_one_or_none()
    if override is None:
        raise HTTPException(status_code=404, detail="Dependency override not found.")

    await session.delete(override)
    await session.commit()
    return None
