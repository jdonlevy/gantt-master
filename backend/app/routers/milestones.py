from datetime import datetime
import uuid
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..database import get_session
from ..dependencies import require_role
from ..models import Milestone, Role
from ..schemas import MilestoneIn, MilestoneOut, MilestoneUpdate

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


@router.post("/milestones", response_model=MilestoneOut)
async def create_milestone(
    payload: MilestoneIn,
    session: AsyncSession = Depends(get_session),
    _user=Depends(require_role(Role.editor)),
):
    dashboard_id = parse_uuid(payload.dashboardId)
    milestone = Milestone(
        label=payload.label,
        date=parse_date(payload.date),
        color=payload.color,
        project_scope=payload.projectScope,
        show_label=payload.showLabel,
        dashboard_id=dashboard_id,
    )
    session.add(milestone)
    await session.commit()
    await session.refresh(milestone)
    return MilestoneOut(
        id=str(milestone.id),
        label=milestone.label,
        date=milestone.date.isoformat(),
        color=milestone.color,
        projectScope=milestone.project_scope,
        showLabel=milestone.show_label,
        dashboardId=str(milestone.dashboard_id) if milestone.dashboard_id else None,
    )


@router.put("/milestones/{milestone_id}", response_model=MilestoneOut)
async def update_milestone(
    milestone_id: str,
    payload: MilestoneUpdate,
    session: AsyncSession = Depends(get_session),
    _user=Depends(require_role(Role.editor)),
):
    result = await session.execute(select(Milestone).where(Milestone.id == milestone_id))
    milestone = result.scalar_one_or_none()
    if not milestone:
        raise HTTPException(status_code=404, detail="Milestone not found")

    if payload.label is not None:
        milestone.label = payload.label
    if payload.date is not None:
        milestone.date = parse_date(payload.date)
    if payload.color is not None:
        milestone.color = payload.color
    if payload.projectScope is not None:
        milestone.project_scope = payload.projectScope
    if payload.showLabel is not None:
        milestone.show_label = payload.showLabel
    if payload.dashboardId is not None:
        milestone.dashboard_id = parse_uuid(payload.dashboardId)

    await session.commit()
    await session.refresh(milestone)
    return MilestoneOut(
        id=str(milestone.id),
        label=milestone.label,
        date=milestone.date.isoformat(),
        color=milestone.color,
        projectScope=milestone.project_scope,
        showLabel=milestone.show_label,
        dashboardId=str(milestone.dashboard_id) if milestone.dashboard_id else None,
    )


@router.delete("/milestones/{milestone_id}")
async def delete_milestone(
    milestone_id: str,
    session: AsyncSession = Depends(get_session),
    _user=Depends(require_role(Role.editor)),
):
    result = await session.execute(select(Milestone).where(Milestone.id == milestone_id))
    milestone = result.scalar_one_or_none()
    if not milestone:
        raise HTTPException(status_code=404, detail="Milestone not found")
    await session.delete(milestone)
    await session.commit()
    return {"ok": True}
