"""Jira OAuth linkage flow.

Azure AD is the primary auth. Users opt into linking a Jira account so
the backend can call Jira on their behalf. The dance:

1. ``POST /api/jira/link`` (Azure-authenticated, JSON) — generates a
   signed state cookie binding the OAuth flow to the current Azure user,
   and returns ``{auth_url}``. The SPA then navigates to that URL.

   Note: this is a POST + JSON rather than a redirect-style GET because
   the browser cannot attach the Azure AD Bearer token to a top-level
   navigation. The SPA fetches with ``Authorization: Bearer ...``, gets
   the URL, and sets ``window.location`` itself.

2. ``GET /api/callback`` — Atlassian redirects the browser here with
   ``?code&state``. No Bearer token is available on this hop, so we
   identify the user from the signed state cookie set in step 1. (The
   path stays as ``/api/callback`` rather than ``/api/jira/callback``
   so the existing DT_JIRA_OAUTH_REDIRECT_URI in Vault and the
   Atlassian app's allow-list don't need updating.)

3. ``POST /api/jira/unlink`` (Azure-authenticated) — clears the token.
"""

import hashlib
import hmac
import secrets
import time
import uuid
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import exchange_code, get_cloud_resource
from ..database import get_session
from ..dependencies import get_current_user
from ..models import User
from ..settings import settings
from ..users import store_jira_link

router = APIRouter()

_STATE_COOKIE = "dt_jira_link_state"
_COOKIE_TTL_SECONDS = 600


def _sign_state(user_id: str, nonce: str) -> str:
    """Sign ``user_id:nonce`` with the session secret so the callback can
    trust the user identity read out of the cookie.
    """
    payload = f"{user_id}:{nonce}".encode()
    sig = hmac.new(settings.session_secret.encode(), payload, hashlib.sha256).hexdigest()
    return f"{user_id}:{nonce}:{sig}"


def _verify_state(cookie_value: str | None, callback_state: str) -> str:
    """Verify the cookie and return the user_id, or raise 400."""
    if not cookie_value:
        raise HTTPException(status_code=400, detail="Missing Jira link state cookie.")
    try:
        user_id, nonce, sig = cookie_value.split(":", 2)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Malformed state cookie.") from exc
    expected = hmac.new(
        settings.session_secret.encode(),
        f"{user_id}:{nonce}".encode(),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(expected, sig):
        raise HTTPException(status_code=400, detail="State cookie signature invalid.")
    if not hmac.compare_digest(nonce, callback_state):
        raise HTTPException(status_code=400, detail="OAuth state mismatch.")
    return user_id


@router.post("/jira/link")
async def start_jira_link(
    user: User = Depends(get_current_user),
):
    """Begin the Jira OAuth dance for the signed-in Azure AD user.

    Returns ``{auth_url}``. The SPA navigates to that URL.
    """
    if not settings.jira_oauth_client_id or not settings.jira_oauth_redirect_uri:
        raise HTTPException(status_code=500, detail="Jira OAuth is not configured")

    nonce = secrets.token_urlsafe(16)
    params = {
        "audience": "api.atlassian.com",
        "client_id": settings.jira_oauth_client_id,
        "scope": "read:jira-work write:jira-work offline_access",
        "redirect_uri": settings.jira_oauth_redirect_uri,
        "response_type": "code",
        "prompt": "consent",
        "state": nonce,
    }
    auth_url = f"https://auth.atlassian.com/authorize?{urlencode(params)}"

    response = JSONResponse({"auth_url": auth_url})
    response.set_cookie(
        _STATE_COOKIE,
        _sign_state(str(user.id), nonce),
        httponly=True,
        secure=True,
        samesite="lax",
        path="/",
        max_age=_COOKIE_TTL_SECONDS,
    )
    return response


# Path kept as /api/callback (not /api/jira/callback) so the existing
# DT_JIRA_OAUTH_REDIRECT_URI in Vault and the Atlassian app's allow-list
# don't have to be updated. The handler itself only completes the
# per-user Jira linkage now — the historical login flow is gone.
@router.get("/callback")
async def jira_callback(
    request: Request,
    code: str = Query(...),
    state: str = Query(...),
    db: AsyncSession = Depends(get_session),
):
    """Complete the Jira OAuth dance and persist the token on the user row.

    The browser is redirected here by Atlassian — no Azure AD Bearer is
    available, so we identify the user from the signed state cookie set
    by ``/api/jira/link``.
    """
    user_id_str = _verify_state(request.cookies.get(_STATE_COOKIE), state)
    try:
        user_id = uuid.UUID(user_id_str)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid user id in state.") from exc

    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")

    token = await exchange_code(code)
    resource = await get_cloud_resource(token["access_token"])
    token["cloud_id"] = resource.get("id")
    token["resource_url"] = resource.get("url")
    token["expires_at"] = time.time() + token.get("expires_in", 3600)

    await store_jira_link(db, user, token)
    await db.commit()

    response = RedirectResponse(settings.ui_base_url)
    response.delete_cookie(_STATE_COOKIE, path="/")
    return response


@router.post("/jira/unlink")
async def unlink_jira(
    db: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
):
    """Forget the linked Jira account for the signed-in user."""
    user.jira_account_id = None
    user.jira_token_json = None
    await db.commit()
    return {"ok": True}
