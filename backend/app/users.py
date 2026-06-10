from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import ensure_fresh_token
from .models import Role, User
from .settings import settings


async def fetch_jira_identity(access_token: str, resource_url: str) -> Optional[dict]:
    """Call Jira ``/myself`` with the linked user's access token.

    Used when a user links their Jira account so we can populate
    ``users.jira_account_id`` for future linkage idempotency.
    """
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.get(
            f"{resource_url}/rest/api/3/myself",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Accept": "application/json",
            },
        )
        if response.status_code != 200:
            return None
        return response.json()


async def upsert_user_from_azure(db: AsyncSession, ctx: dict) -> User:
    """Materialise / refresh the User row from an Azure AD JWT context.

    ``ctx`` is the dict returned by :func:`azure_auth.get_user_context`:
    ``{user_id (oid), name, email, roles, token}``.

    Bootstraps the first admin: if no admin exists yet and the user's
    email is in ``DT_BOOTSTRAP_ADMINS``, the row is created as / promoted
    to admin. Never demotes an existing admin.
    """
    oid = ctx["user_id"]
    email = (ctx.get("email") or None)
    display_name = ctx.get("name") or None
    bootstrap_emails = set(settings.bootstrap_admin_emails)
    now = datetime.now(timezone.utc)

    result = await db.execute(select(User).where(User.azure_oid == oid))
    user = result.scalar_one_or_none()

    if user is None:
        role = Role.viewer
        if email and email.lower() in bootstrap_emails:
            admin_count = (
                await db.execute(select(func.count()).select_from(User).where(User.role == Role.admin))
            ).scalar_one()
            if admin_count == 0:
                role = Role.admin
        user = User(
            azure_oid=oid,
            email=email,
            display_name=display_name,
            role=role,
            last_seen_at=now,
        )
        db.add(user)
    else:
        user.email = email or user.email
        user.display_name = display_name or user.display_name
        user.last_seen_at = now
        if user.role != Role.admin and email and email.lower() in bootstrap_emails:
            admin_count = (
                await db.execute(select(func.count()).select_from(User).where(User.role == Role.admin))
            ).scalar_one()
            if admin_count == 0:
                user.role = Role.admin

    await db.flush()
    return user


async def get_jira_token(db: AsyncSession, user: User) -> dict:
    """Return a valid Jira OAuth token for the user, refreshing if needed.

    Raises ``HTTPException(412)`` if the user hasn't linked their Jira
    account, or if a refresh attempt failed (the linkage is cleared so
    the frontend can prompt for a re-link).
    """
    token = user.jira_token_json
    if not token:
        raise HTTPException(status_code=412, detail="Jira account not linked")

    fresh = await ensure_fresh_token(token)
    if fresh is None:
        user.jira_token_json = None
        await db.commit()
        raise HTTPException(status_code=412, detail="Jira refresh failed, please re-link")
    if fresh is not token:
        user.jira_token_json = fresh
        await db.commit()
    return fresh


async def store_jira_link(db: AsyncSession, user: User, token: dict) -> User:
    """Persist a Jira OAuth token onto the user record.

    Called by the Jira link callback. Pulls ``accountId`` from
    ``/myself`` so we can render "linked to <accountId>" and prevent
    accidental duplicate links.
    """
    access_token = token.get("access_token")
    resource_url = token.get("resource_url")
    if access_token and resource_url:
        identity = await fetch_jira_identity(access_token, resource_url)
        if identity and identity.get("accountId"):
            user.jira_account_id = identity["accountId"]

    user.jira_token_json = token
    await db.flush()
    return user
