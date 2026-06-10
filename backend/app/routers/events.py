"""Server-Sent Events endpoint for live dashboard updates.

Replaces the frontend's content-poll loops. One persistent SSE connection
per dashboard tab; the server pushes `panel.updated` events when content
mutates so peers refetch only the affected panel — no polling chatter and
no presence-coupling workarounds.

Auth: viewer role required (anyone allowed to read the dashboard can
subscribe to its event stream).
"""

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from .. import azure_auth
from ..database import SessionLocal
from ..events import format_sse, subscribe, unsubscribe
from ..models import ROLE_RANK, Role
from ..users import upsert_user_from_azure

logger = logging.getLogger("uvicorn.error")

router = APIRouter()

# Send a comment line every 15s to keep proxies / load balancers from
# closing the connection on idle. Browsers ignore comment lines but the
# bytes traverse the proxy and reset its idle timer.
_HEARTBEAT_INTERVAL_SECS = 15.0


def _resolve_token(request: Request, query_token: str | None) -> str:
    """Pick the access token from either the Authorization header (curl,
    proxies) or the ``?token=`` query param (EventSource, which can't set
    headers from the browser). Header wins if both are present so an
    explicit Bearer can override a stale query token."""
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        return auth_header[7:].strip()
    if query_token:
        return query_token
    raise HTTPException(status_code=401, detail="Missing access token (header or ?token=)")


async def _authenticate_sse_request(request: Request, query_token: str | None, db: AsyncSession) -> None:
    """Authenticate an SSE subscription.

    Same JWT pipeline as every other API route — same Azure AD checks,
    same User upsert, same viewer-role gate — but tolerant of the token
    arriving in the query string instead of an Authorization header.
    """
    token = _resolve_token(request, query_token)
    ctx = azure_auth.get_user_context_from_token(token)
    user = await upsert_user_from_azure(db, ctx)
    await db.commit()
    if ROLE_RANK[user.role] < ROLE_RANK[Role.viewer]:
        raise HTTPException(status_code=403, detail="Insufficient role")


@router.get("/dashboards/{slug}/events")
async def dashboard_events(
    slug: str,
    request: Request,
    token: str | None = Query(default=None),
):
    """Open a Server-Sent Events stream for live updates on a dashboard.

    Auth: standard ``Authorization: Bearer ...`` header, OR ``?token=...``
    query param (because EventSource can't set headers). Viewer role
    required either way.

    The stream emits:
      - event: panel.updated  data: {"panelId": "...", "updatedAt": "..."}
      - SSE comments every 15s as a heartbeat (browsers ignore these)

    Browsers auto-reconnect; events emitted during a disconnect are lost.
    The frontend should refetch dashboard state on reconnect to recover.
    """
    # Scope the DB session to *just* the auth/upsert step. The stream loop
    # below runs for the lifetime of the EventSource connection (unbounded,
    # kept alive by 15s heartbeats), so the request-scoped Depends(get_session)
    # used elsewhere would pin one Postgres connection + one SQLAlchemy
    # session per open tab forever — exhausts the pool and OOMs the pod.
    async with SessionLocal() as db:
        await _authenticate_sse_request(request, token, db)
    queue = subscribe(slug)

    async def stream():
        # Initial comment so the browser fires the `open` event immediately
        # rather than waiting for the first real message.
        yield b": connected\n\n"
        try:
            while True:
                try:
                    message = await asyncio.wait_for(
                        queue.get(), timeout=_HEARTBEAT_INTERVAL_SECS
                    )
                except asyncio.TimeoutError:
                    # No event in the heartbeat window — emit a comment to
                    # keep the connection alive.
                    yield b": heartbeat\n\n"
                    continue
                yield format_sse(message)
        except asyncio.CancelledError:
            # Client disconnected — Starlette cancels the generator.
            raise
        finally:
            unsubscribe(slug, queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            # Disable nginx response buffering so events flush immediately
            # rather than batching at the proxy.
            "X-Accel-Buffering": "no",
        },
    )
