"""FastAPI dependencies for authentication + role gating.

Auth source: Azure AD JWT (Bearer token). The frontend acquires it via
MSAL.js and sends it on every request. ``get_current_user`` validates
the token, upserts the User row keyed by Azure ``oid``, and returns the
ORM row. ``require_role(min_role)`` is the per-route gate.
"""

from typing import Callable

from fastapi import Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from . import azure_auth
from .database import get_session
from .models import ROLE_RANK, Role, User
from .users import upsert_user_from_azure


async def get_current_user(
    request: Request,
    db: AsyncSession = Depends(get_session),
) -> User:
    """Resolve the current User row from the Azure AD JWT.

    1. Validate the Bearer token.
    2. Upsert the User by ``azure_oid`` (creates on first login, refreshes
       email/display_name/last_seen on subsequent calls).
    3. Return the tracked ORM row so callers can mutate it within the same
       request transaction if needed.
    """
    ctx = azure_auth.get_user_context(request)
    user = await upsert_user_from_azure(db, ctx)
    await db.commit()
    return user


async def get_current_user_optional(
    request: Request,
    db: AsyncSession = Depends(get_session),
) -> User | None:
    """Like :func:`get_current_user` but returns ``None`` for unauthenticated
    callers instead of raising. Used by ``/api/session`` so the SPA can
    render a "please sign in" state without seeing a 401.
    """
    try:
        return await get_current_user(request=request, db=db)
    except HTTPException:
        return None


def require_role(min_role: Role) -> Callable:
    """Dependency factory: 403 if user.role rank < min_role rank."""

    async def _dep(user: User = Depends(get_current_user)) -> User:
        if ROLE_RANK[user.role] < ROLE_RANK[min_role]:
            raise HTTPException(status_code=403, detail="Insufficient role")
        return user

    return _dep
