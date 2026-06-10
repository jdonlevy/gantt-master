import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_session
from ..dependencies import require_role
from ..models import ROLE_RANK, Role, User

router = APIRouter()


class AdminUserOut(BaseModel):
    id: str
    email: Optional[str]
    displayName: Optional[str]
    role: str
    lastSeenAt: Optional[str]


class UpdateRoleIn(BaseModel):
    role: Role


def _serialize(user: User) -> AdminUserOut:
    return AdminUserOut(
        id=str(user.id),
        email=user.email,
        displayName=user.display_name,
        role=user.role.value,
        lastSeenAt=user.last_seen_at.isoformat() if user.last_seen_at else None,
    )


@router.get("/admin/users", response_model=List[AdminUserOut])
async def list_users(
    session: AsyncSession = Depends(get_session),
    _user=Depends(require_role(Role.admin)),
):
    result = await session.execute(select(User).order_by(User.display_name.asc()))
    return [_serialize(u) for u in result.scalars().all()]


@router.patch("/admin/users/{user_id}", response_model=AdminUserOut)
async def update_user_role(
    user_id: str,
    payload: UpdateRoleIn,
    session: AsyncSession = Depends(get_session),
    actor: User = Depends(require_role(Role.admin)),
):
    try:
        target_id = uuid.UUID(user_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid user id") from exc

    target = await session.get(User, target_id)
    if target is None:
        raise HTTPException(status_code=404, detail="User not found")

    # Prevent demoting the last remaining admin — otherwise role management
    # locks itself out and only a manual DB poke (or bootstrap re-trigger)
    # can recover.
    if target.role == Role.admin and payload.role != Role.admin:
        admin_count = (
            await session.execute(select(func.count()).select_from(User).where(User.role == Role.admin))
        ).scalar_one()
        if admin_count <= 1:
            raise HTTPException(status_code=400, detail="Cannot demote the last admin")

    target.role = payload.role
    await session.commit()
    await session.refresh(target)
    return _serialize(target)
