import secrets
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import delete, select

from .database import SessionLocal
from .models import AuthSession


async def create_session(token: dict) -> str:
    session_id = secrets.token_urlsafe(24)
    async with SessionLocal() as session:
        session.add(AuthSession(id=session_id, token_json=token))
        await session.commit()
    return session_id


async def get_token(session_id: Optional[str]) -> Optional[dict]:
    if not session_id:
        return None
    async with SessionLocal() as session:
        result = await session.execute(select(AuthSession).where(AuthSession.id == session_id))
        record = result.scalars().first()
        if not record:
            return None
        record.updated_at = datetime.now(timezone.utc)
        await session.commit()
        return record.token_json


async def update_token(session_id: Optional[str], token: dict) -> None:
    if not session_id:
        return
    async with SessionLocal() as session:
        result = await session.execute(select(AuthSession).where(AuthSession.id == session_id))
        record = result.scalars().first()
        if not record:
            return
        record.token_json = token
        record.updated_at = datetime.utcnow()
        await session.commit()


async def clear_session(session_id: Optional[str]) -> None:
    if not session_id:
        return
    async with SessionLocal() as session:
        await session.execute(delete(AuthSession).where(AuthSession.id == session_id))
        await session.commit()
