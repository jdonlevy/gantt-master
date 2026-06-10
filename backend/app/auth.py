"""Jira OAuth 2.0 helpers — used by the Jira linkage flow.

Azure AD is the primary auth source (see ``azure_auth.py``). Jira OAuth
is now a per-user opt-in to grant the backend access to Jira on the
signed-in user's behalf. These helpers do the OAuth dance with
Atlassian; storage of the resulting token lives on
``users.jira_token_json`` (see ``users.store_jira_link``).
"""

import time
from typing import Dict, Optional

import httpx
from fastapi import HTTPException

from .settings import settings

# Refresh the access token this many seconds before it actually expires.
_EXPIRY_BUFFER_SECS = 300


async def exchange_code(code: str) -> Dict:
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            "https://auth.atlassian.com/oauth/token",
            json={
                "grant_type": "authorization_code",
                "client_id": settings.jira_oauth_client_id,
                "client_secret": settings.jira_oauth_client_secret,
                "code": code,
                "redirect_uri": settings.jira_oauth_redirect_uri,
            },
        )
        response.raise_for_status()
        return response.json()


async def refresh_token(refresh_token: str) -> Dict:
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            "https://auth.atlassian.com/oauth/token",
            json={
                "grant_type": "refresh_token",
                "client_id": settings.jira_oauth_client_id,
                "client_secret": settings.jira_oauth_client_secret,
                "refresh_token": refresh_token,
            },
        )
        response.raise_for_status()
        return response.json()


async def get_cloud_resource(access_token: str) -> Dict:
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(
            "https://api.atlassian.com/oauth/token/accessible-resources",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        response.raise_for_status()
        data = response.json()
        if not data:
            raise HTTPException(status_code=401, detail="No Jira cloud resources")
        return data[0]


async def ensure_fresh_token(token: dict) -> Optional[dict]:
    """Refresh the Jira token if it's expired or about to expire.

    Returns the (possibly refreshed) token dict, or ``None`` if a
    refresh was needed but failed — caller should treat the user as
    unlinked.
    """
    expires_at = token.get("expires_at", 0)
    if time.time() + _EXPIRY_BUFFER_SECS < expires_at:
        return token

    rt = token.get("refresh_token")
    if not rt:
        return None
    try:
        new_token = await refresh_token(rt)
    except (httpx.HTTPStatusError, httpx.RequestError):
        return None
    new_token["cloud_id"] = token.get("cloud_id")
    new_token["resource_url"] = token.get("resource_url")
    new_token["expires_at"] = time.time() + new_token.get("expires_in", 3600)
    return new_token
