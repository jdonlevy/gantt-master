import uuid
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..database import get_session
from ..dependencies import require_role
from ..models import CustomBar, Role
from ..schemas import CustomBarIn, CustomBarOut, CustomBarUpdate

router = APIRouter()


def parse_uuid(value: str | None):
    if not value:
        return None
    try:
        return uuid.UUID(value)
    except ValueError:
        return None


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


@router.post("/custom_bars", response_model=CustomBarOut)
async def create_custom_bar(
    payload: CustomBarIn,
    session: AsyncSession = Depends(get_session),
    _user=Depends(require_role(Role.editor)),
):
    dashboard_id = parse_uuid(payload.dashboardId)
    if not dashboard_id:
        raise HTTPException(status_code=400, detail="Invalid dashboardId")
    bar = CustomBar(
        name=payload.name,
        swimlane_id=payload.swimlaneId,
        start=payload.start,
        end=payload.end,
        color=payload.color,
        show_name=payload.showName,
        dashboard_id=dashboard_id,
    )
    session.add(bar)
    await session.commit()
    await session.refresh(bar)
    return custom_bar_to_out(bar)


@router.put("/custom_bars/{bar_id}", response_model=CustomBarOut)
async def update_custom_bar(
    bar_id: str,
    payload: CustomBarUpdate,
    session: AsyncSession = Depends(get_session),
    _user=Depends(require_role(Role.editor)),
):
    result = await session.execute(select(CustomBar).where(CustomBar.id == bar_id))
    bar = result.scalar_one_or_none()
    if not bar:
        raise HTTPException(status_code=404, detail="Custom bar not found")
    if payload.name is not None:
        bar.name = payload.name
    if payload.start is not None:
        bar.start = payload.start
    if payload.end is not None:
        bar.end = payload.end
    if payload.color is not None:
        bar.color = payload.color
    if payload.showName is not None:
        bar.show_name = payload.showName
    await session.commit()
    await session.refresh(bar)
    return custom_bar_to_out(bar)


@router.delete("/custom_bars/{bar_id}")
async def delete_custom_bar(
    bar_id: str,
    session: AsyncSession = Depends(get_session),
    _user=Depends(require_role(Role.editor)),
):
    result = await session.execute(select(CustomBar).where(CustomBar.id == bar_id))
    bar = result.scalar_one_or_none()
    if not bar:
        raise HTTPException(status_code=404, detail="Custom bar not found")
    await session.delete(bar)
    await session.commit()
    return {"ok": True}
