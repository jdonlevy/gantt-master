"""Lightweight in-memory presence tracking.

Records which bar each authenticated user is currently editing so that
other viewers can see an "X is editing this" indicator without needing
a database migration or WebSocket infrastructure.

Each presence entry lives for at most PRESENCE_TTL_SECS seconds after the
last heartbeat — the frontend should PUT a heartbeat whenever it considers
the user to be "actively editing" (e.g. while a date picker is open).
"""

import time
from typing import Dict

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..dependencies import get_current_user, require_role
from ..models import Role, User

router = APIRouter()

PRESENCE_TTL_SECS = 30

# tab_id (or user_id str) → entry dict
_presence: Dict[str, dict] = {}


def _purge_stale() -> None:
    now = time.time()
    stale = [k for k, entry in _presence.items() if now - entry["updated_at"] > PRESENCE_TTL_SECS]
    for k in stale:
        del _presence[k]


@router.get("/me")
async def get_me(user: User = Depends(get_current_user)):
    """Return the current user's identity for presence display."""
    return {
        "accountId": str(user.id),
        "displayName": user.display_name or user.email or "Unknown",
        "avatarUrl": None,
    }


class PresencePayload(BaseModel):
    slug: str
    barId: str
    tabId: str = ""


@router.put("/presence")
async def set_presence(payload: PresencePayload, user: User = Depends(require_role(Role.editor))):
    """Record that the current user is editing a specific bar on a dashboard."""
    key = payload.tabId or str(user.id)
    _purge_stale()
    _presence[key] = {
        "accountId": str(user.id),
        "displayName": user.display_name or user.email or "Unknown",
        "avatarUrl": None,
        "slug": payload.slug,
        "barId": payload.barId,
        "updated_at": time.time(),
    }
    return {"ok": True}


@router.delete("/presence")
async def clear_presence(tabId: str = "", user: User = Depends(get_current_user)):
    """Clear the current user's presence entry."""
    key = tabId or str(user.id)
    _presence.pop(key, None)
    return {"ok": True}


@router.get("/presence/{slug}")
async def get_presence(slug: str, tabId: str = "", user: User = Depends(require_role(Role.viewer))):
    """Return all active editors on a dashboard (excluding the caller)."""
    caller_key = tabId or str(user.id)
    _purge_stale()
    now = time.time()
    result = []
    for key, entry in _presence.items():
        if key == caller_key:
            continue
        if entry["slug"] != slug:
            continue
        if now - entry["updated_at"] > PRESENCE_TTL_SECS:
            continue
        result.append({
            "accountId": entry["accountId"],
            "displayName": entry["displayName"],
            "avatarUrl": entry["avatarUrl"],
            "barId": entry["barId"],
        })
    return result
