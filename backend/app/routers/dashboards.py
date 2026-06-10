import re
import uuid
from datetime import datetime, timezone
from typing import List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..database import get_session
from ..dependencies import require_role
from ..events import publish
from ..models import CustomBar, Dashboard, DashboardPanel, Role
from ..schemas import (
    CustomBarOut,
    DashboardCreateIn,
    DashboardDetailOut,
    DashboardPanelContentIn,
    DashboardPanelCreateIn,
    DashboardPanelOut,
    DashboardPanelUpdateIn,
    DashboardSummaryOut,
    DashboardUpdateIn,
    RoadmapResponse,
)

router = APIRouter()

DEFAULT_FILTERS = {
    "projects": [],
    "fixVersions": [],
    "components": [],
    "incrementStart": None,
    "incrementEnd": None,
    "ganttMode": "standard",
    "showDependencies": True,
    "swimlanes": [],
}

DEFAULT_PANELS = [
    {"type": "rich_text", "title": "Weekly update", "row": 1, "column": 1, "width": 12, "height": 3},
    {"type": "rich_text", "title": "Highlights", "row": 4, "column": 1, "width": 4, "height": 4},
    {"type": "rich_text", "title": "Risks", "row": 4, "column": 5, "width": 4, "height": 4},
    {"type": "metrics", "title": "Metrics", "row": 4, "column": 9, "width": 4, "height": 4},
]


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "dashboard"


async def ensure_unique_slug(session: AsyncSession, base_slug: str) -> str:
    slug = base_slug
    suffix = 2
    while True:
        exists = await session.execute(select(Dashboard).where(Dashboard.slug == slug))
        if not exists.scalars().first():
            return slug
        slug = f"{base_slug}-{suffix}"
        suffix += 1


def panel_to_out(panel: DashboardPanel) -> DashboardPanelOut:
    return DashboardPanelOut(
        id=str(panel.id),
        type=panel.type,
        title=panel.title,
        row=panel.row,
        column=panel.column,
        width=panel.width,
        height=panel.height,
        collapsed=bool(panel.collapsed),
        contentJson=panel.content_json,
        contentHtml=panel.content_html,
        updatedAt=panel.updated_at.isoformat() if panel.updated_at else None,
    )


def custom_bar_to_out(cb: CustomBar) -> CustomBarOut:
    return CustomBarOut(
        id=str(cb.id),
        name=cb.name,
        swimlaneId=cb.swimlane_id,
        start=cb.start,
        end=cb.end,
        color=cb.color or '#a78bfa',
        showName=cb.show_name,
        dashboardId=str(cb.dashboard_id),
    )


@router.get("/dashboards", response_model=List[DashboardSummaryOut])
async def list_dashboards(session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(Dashboard).order_by(Dashboard.updated_at.desc()))
    dashboards = result.scalars().all()
    return [
        DashboardSummaryOut(
            id=str(item.id),
            slug=item.slug,
            title=item.title,
            folder=item.folder,
            description=item.description,
            updatedAt=item.updated_at.isoformat() if item.updated_at else None,
        )
        for item in dashboards
    ]


@router.post("/dashboards", response_model=DashboardDetailOut)
async def create_dashboard(
    payload: DashboardCreateIn,
    session: AsyncSession = Depends(get_session),
    _user=Depends(require_role(Role.editor)),
):
    base_slug = slugify(payload.slug or payload.title)
    slug = await ensure_unique_slug(session, base_slug)
    filters = payload.filters.model_dump() if payload.filters else DEFAULT_FILTERS

    dashboard = Dashboard(
        slug=slug,
        title=payload.title,
        folder=payload.folder,
        description=payload.description,
        filters_json=filters,
        updated_at=datetime.now(timezone.utc),
    )
    session.add(dashboard)
    await session.flush()

    for panel in DEFAULT_PANELS:
        session.add(
            DashboardPanel(
                dashboard_id=dashboard.id,
                type=panel["type"],
                title=panel.get("title"),
                row=panel["row"],
                column=panel["column"],
                width=panel["width"],
                height=panel["height"],
                updated_at=datetime.now(timezone.utc),
            )
        )

    await session.commit()
    await session.refresh(dashboard)
    panel_rows = await session.execute(select(DashboardPanel).where(DashboardPanel.dashboard_id == dashboard.id))
    panels = [panel_to_out(panel) for panel in panel_rows.scalars().all()]

    return DashboardDetailOut(
        id=str(dashboard.id),
        slug=dashboard.slug,
        title=dashboard.title,
        folder=dashboard.folder,
        description=dashboard.description,
        filters=dashboard.filters_json or DEFAULT_FILTERS,
        panels=panels,
        customBars=[],
        updatedAt=dashboard.updated_at.isoformat() if dashboard.updated_at else None,
    )


@router.get("/dashboards/{slug}", response_model=DashboardDetailOut)
async def get_dashboard(slug: str, session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(Dashboard).where(Dashboard.slug == slug))
    dashboard = result.scalars().first()
    if not dashboard:
        raise HTTPException(status_code=404, detail="Dashboard not found")

    panel_rows = await session.execute(
        select(DashboardPanel).where(DashboardPanel.dashboard_id == dashboard.id).order_by(DashboardPanel.row, DashboardPanel.column)
    )
    panels = [panel_to_out(panel) for panel in panel_rows.scalars().all()]

    bar_rows = await session.execute(select(CustomBar).where(CustomBar.dashboard_id == dashboard.id))
    custom_bars = [custom_bar_to_out(cb) for cb in bar_rows.scalars().all()]

    return DashboardDetailOut(
        id=str(dashboard.id),
        slug=dashboard.slug,
        title=dashboard.title,
        folder=dashboard.folder,
        description=dashboard.description,
        filters=dashboard.filters_json or DEFAULT_FILTERS,
        panels=panels,
        customBars=custom_bars,
        updatedAt=dashboard.updated_at.isoformat() if dashboard.updated_at else None,
    )


@router.get("/dashboards/{slug}/snapshot", response_model=RoadmapResponse | None)
async def get_dashboard_snapshot(slug: str, session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(Dashboard).where(Dashboard.slug == slug))
    dashboard = result.scalars().first()
    if not dashboard or not dashboard.roadmap_json:
        return None
    return dashboard.roadmap_json


@router.put("/dashboards/{slug}/snapshot", response_model=RoadmapResponse)
async def update_dashboard_snapshot(
    slug: str,
    payload: RoadmapResponse,
    session: AsyncSession = Depends(get_session),
    _user=Depends(require_role(Role.editor)),
):
    result = await session.execute(select(Dashboard).where(Dashboard.slug == slug))
    dashboard = result.scalars().first()
    if not dashboard:
        raise HTTPException(status_code=404, detail="Dashboard not found")
    dashboard.roadmap_json = payload.model_dump()
    dashboard.roadmap_updated_at = datetime.utcnow()
    await session.commit()
    return payload


@router.put("/dashboards/{slug}", response_model=DashboardDetailOut)
async def update_dashboard(
    slug: str,
    payload: DashboardUpdateIn,
    session: AsyncSession = Depends(get_session),
    _user=Depends(require_role(Role.editor)),
):
    result = await session.execute(select(Dashboard).where(Dashboard.slug == slug))
    dashboard = result.scalars().first()
    if not dashboard:
        raise HTTPException(status_code=404, detail="Dashboard not found")

    fields = payload.model_fields_set
    if "title" in fields and payload.title is not None:
        dashboard.title = payload.title
    if "folder" in fields:
        dashboard.folder = payload.folder
    if "description" in fields:
        dashboard.description = payload.description
    if "filters" in fields:
        dashboard.filters_json = payload.filters.model_dump() if payload.filters is not None else None
    dashboard.updated_at = datetime.now(timezone.utc)

    await session.commit()
    await session.refresh(dashboard)

    panel_rows = await session.execute(
        select(DashboardPanel).where(DashboardPanel.dashboard_id == dashboard.id).order_by(DashboardPanel.row, DashboardPanel.column)
    )
    panels = [panel_to_out(panel) for panel in panel_rows.scalars().all()]

    bar_rows = await session.execute(select(CustomBar).where(CustomBar.dashboard_id == dashboard.id))
    custom_bars = [custom_bar_to_out(cb) for cb in bar_rows.scalars().all()]

    return DashboardDetailOut(
        id=str(dashboard.id),
        slug=dashboard.slug,
        title=dashboard.title,
        folder=dashboard.folder,
        description=dashboard.description,
        filters=dashboard.filters_json or DEFAULT_FILTERS,
        panels=panels,
        customBars=custom_bars,
        updatedAt=dashboard.updated_at.isoformat() if dashboard.updated_at else None,
    )


@router.post("/dashboards/{slug}/panels", response_model=DashboardPanelOut)
async def create_panel(
    slug: str,
    payload: DashboardPanelCreateIn,
    session: AsyncSession = Depends(get_session),
    _user=Depends(require_role(Role.editor)),
):
    result = await session.execute(select(Dashboard).where(Dashboard.slug == slug))
    dashboard = result.scalars().first()
    if not dashboard:
        raise HTTPException(status_code=404, detail="Dashboard not found")

    panel = DashboardPanel(
        dashboard_id=dashboard.id,
        type=payload.type,
        title=payload.title,
        row=payload.row,
        column=payload.column,
        width=payload.width,
        height=payload.height,
        updated_at=datetime.now(timezone.utc),
    )
    session.add(panel)
    await session.commit()
    await session.refresh(panel)

    return panel_to_out(panel)


@router.put("/dashboards/{slug}/panels/{panel_id}", response_model=DashboardPanelOut)
async def update_panel(
    slug: str,
    panel_id: str,
    payload: DashboardPanelUpdateIn,
    session: AsyncSession = Depends(get_session),
    _user=Depends(require_role(Role.editor)),
):
    result = await session.execute(select(Dashboard).where(Dashboard.slug == slug))
    dashboard = result.scalars().first()
    if not dashboard:
        raise HTTPException(status_code=404, detail="Dashboard not found")

    try:
        panel_uuid = uuid.UUID(panel_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid panel id") from exc

    panel_rows = await session.execute(
        select(DashboardPanel).where(DashboardPanel.dashboard_id == dashboard.id, DashboardPanel.id == panel_uuid)
    )
    panel = panel_rows.scalars().first()
    if not panel:
        raise HTTPException(status_code=404, detail="Panel not found")

    if payload.title is not None:
        panel.title = payload.title
    if payload.row is not None:
        panel.row = payload.row
    if payload.column is not None:
        panel.column = payload.column
    if payload.width is not None:
        panel.width = payload.width
    if payload.height is not None:
        panel.height = payload.height
    if payload.collapsed is not None:
        panel.collapsed = payload.collapsed

    panel.updated_at = datetime.now(timezone.utc)
    await session.commit()
    await session.refresh(panel)

    return panel_to_out(panel)


@router.get("/dashboards/{slug}/panels/{panel_id}/content")
async def get_panel_content(
    slug: str,
    panel_id: str,
    session: AsyncSession = Depends(get_session),
    _user=Depends(require_role(Role.viewer)),
):
    result = await session.execute(select(Dashboard).where(Dashboard.slug == slug))
    dashboard = result.scalars().first()
    if not dashboard:
        raise HTTPException(status_code=404, detail="Dashboard not found")

    try:
        panel_uuid = uuid.UUID(panel_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid panel id") from exc

    panel_rows = await session.execute(
        select(DashboardPanel).where(DashboardPanel.dashboard_id == dashboard.id, DashboardPanel.id == panel_uuid)
    )
    panel = panel_rows.scalars().first()
    if not panel:
        raise HTTPException(status_code=404, detail="Panel not found")

    return {
        "contentJson": panel.content_json,
        "updatedAt": panel.updated_at.isoformat() if panel.updated_at else None,
    }


@router.put("/dashboards/{slug}/panels/{panel_id}/content", response_model=DashboardPanelOut)
async def update_panel_content(
    slug: str,
    panel_id: str,
    payload: DashboardPanelContentIn,
    session: AsyncSession = Depends(get_session),
    _user=Depends(require_role(Role.editor)),
):
    result = await session.execute(select(Dashboard).where(Dashboard.slug == slug))
    dashboard = result.scalars().first()
    if not dashboard:
        raise HTTPException(status_code=404, detail="Dashboard not found")

    try:
        panel_uuid = uuid.UUID(panel_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid panel id") from exc

    panel_rows = await session.execute(
        select(DashboardPanel).where(DashboardPanel.dashboard_id == dashboard.id, DashboardPanel.id == panel_uuid)
    )
    panel = panel_rows.scalars().first()
    if not panel:
        raise HTTPException(status_code=404, detail="Panel not found")

    if payload.contentJson is not None:
        panel.content_json = payload.contentJson
    if payload.contentHtml is not None:
        panel.content_html = payload.contentHtml

    panel.updated_at = datetime.now(timezone.utc)
    await session.commit()
    await session.refresh(panel)

    # Notify all subscribers on this dashboard's SSE stream so peers can
    # refetch this panel's content without polling. Best-effort: queues are
    # bounded and we never block the response on slow consumers.
    await publish(
        slug,
        "panel.updated",
        {
            "panelId": str(panel.id),
            "updatedAt": panel.updated_at.isoformat() if panel.updated_at else None,
        },
    )

    return panel_to_out(panel)


@router.delete("/dashboards/{slug}/panels/{panel_id}")
async def delete_panel(
    slug: str,
    panel_id: str,
    session: AsyncSession = Depends(get_session),
    _user=Depends(require_role(Role.editor)),
):
    result = await session.execute(select(Dashboard).where(Dashboard.slug == slug))
    dashboard = result.scalars().first()
    if not dashboard:
        raise HTTPException(status_code=404, detail="Dashboard not found")

    try:
        panel_uuid = uuid.UUID(panel_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid panel id") from exc

    panel_rows = await session.execute(
        select(DashboardPanel).where(DashboardPanel.dashboard_id == dashboard.id, DashboardPanel.id == panel_uuid)
    )
    panel = panel_rows.scalars().first()
    if not panel:
        raise HTTPException(status_code=404, detail="Panel not found")

    await session.delete(panel)
    await session.commit()
    return {"ok": True}


@router.post("/dashboards/{slug}/duplicate", response_model=DashboardDetailOut)
async def duplicate_dashboard(
    slug: str,
    session: AsyncSession = Depends(get_session),
    _user=Depends(require_role(Role.editor)),
):
    result = await session.execute(select(Dashboard).where(Dashboard.slug == slug))
    source = result.scalars().first()
    if not source:
        raise HTTPException(status_code=404, detail="Dashboard not found")

    new_slug = await ensure_unique_slug(session, source.slug)
    copy = Dashboard(
        slug=new_slug,
        title=f"{source.title} (copy)",
        folder=source.folder,
        description=source.description,
        filters_json=source.filters_json,
        updated_at=datetime.now(timezone.utc),
    )
    session.add(copy)
    await session.flush()

    panel_rows = await session.execute(
        select(DashboardPanel).where(DashboardPanel.dashboard_id == source.id)
    )
    for panel in panel_rows.scalars().all():
        session.add(
            DashboardPanel(
                dashboard_id=copy.id,
                type=panel.type,
                title=panel.title,
                row=panel.row,
                column=panel.column,
                width=panel.width,
                height=panel.height,
                collapsed=bool(panel.collapsed),
                content_json=panel.content_json,
                content_html=panel.content_html,
                updated_at=datetime.now(timezone.utc),
            )
        )

    source_bars = await session.execute(select(CustomBar).where(CustomBar.dashboard_id == source.id))
    for bar in source_bars.scalars().all():
        session.add(
            CustomBar(
                dashboard_id=copy.id,
                name=bar.name,
                swimlane_id=bar.swimlane_id,
                start=bar.start,
                end=bar.end,
                color=bar.color,
            )
        )

    await session.commit()
    await session.refresh(copy)
    copied_panels = await session.execute(
        select(DashboardPanel).where(DashboardPanel.dashboard_id == copy.id)
    )
    panels = [panel_to_out(p) for p in copied_panels.scalars().all()]

    copied_bars = await session.execute(select(CustomBar).where(CustomBar.dashboard_id == copy.id))
    custom_bars = [custom_bar_to_out(cb) for cb in copied_bars.scalars().all()]

    return DashboardDetailOut(
        id=str(copy.id),
        slug=copy.slug,
        title=copy.title,
        folder=copy.folder,
        description=copy.description,
        filters=copy.filters_json or DEFAULT_FILTERS,
        panels=panels,
        customBars=custom_bars,
        updatedAt=copy.updated_at.isoformat() if copy.updated_at else None,
    )


@router.delete("/dashboards/{slug}")
async def delete_dashboard(
    slug: str,
    session: AsyncSession = Depends(get_session),
    _user=Depends(require_role(Role.editor)),
):
    result = await session.execute(select(Dashboard).where(Dashboard.slug == slug))
    dashboard = result.scalars().first()
    if not dashboard:
        raise HTTPException(status_code=404, detail="Dashboard not found")
    await session.delete(dashboard)
    await session.commit()
    return {"ok": True}
