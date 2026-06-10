import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware
from .settings import settings
from .diagnostics import start_diagnostics
from .events_bus import install_postgres_bus
from .routers import (
    admin,
    custom_bars,
    dashboards,
    events,
    generate_update,
    jira_link,
    milestones,
    overrides,
    presence,
    roadmap,
    session,
)

def enforce_required_env() -> None:
    environment = (os.getenv("ENVIRONMENT") or "development").lower()
    if environment not in {"prod", "production"}:
        return
    missing = [name for name in ("DT_UI_BASE_URL", "DT_CORS_ORIGINS") if not os.getenv(name)]
    if missing:
        missing_list = ", ".join(missing)
        raise RuntimeError(f"Missing required environment variables for production: {missing_list}")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    enforce_required_env()
    # Cross-pod SSE bus. In dev/CI it's fine if Postgres isn't reachable
    # yet — fall back to the in-process default so the app still boots
    # for tests / one-shot smoke runs. In prod the connection failure
    # would re-raise on the first publish attempt, which is what we want
    # (loud) — the install itself doesn't.
    sse_bus = None
    try:
        sse_bus = await install_postgres_bus(settings.database_url)
    except Exception:
        # Logged inside the bus; carry on with the default InProcessBus
        # so the HTTP surface is still up. A multi-replica deployment is
        # already unsafe in that state — see docs/cross-pod-sse.md.
        import logging
        logging.getLogger("uvicorn.error").exception(
            "SSE bus failed to start; falling back to in-process delivery"
        )
    diagnostics_task = start_diagnostics()
    try:
        yield
    finally:
        diagnostics_task.cancel()
        if sse_bus is not None:
            await sse_bus.stop()


app = FastAPI(title="delivery-tracker", lifespan=lifespan)


def build_cors_origins():
    raw_origins = settings.cors_origins or ""
    origins = [origin.strip().rstrip("/") for origin in raw_origins.split(",") if origin.strip()]
    ui_origin = (settings.ui_base_url or "").strip().rstrip("/")
    if ui_origin and ui_origin not in origins:
        origins.append(ui_origin)
    if not origins:
        origins = ["http://localhost:3000"]
    return origins


app.add_middleware(
    CORSMiddleware,
    allow_origins=build_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_middleware(SessionMiddleware, secret_key=settings.session_secret)

app.include_router(roadmap, prefix="/api")
app.include_router(generate_update, prefix="/api")
app.include_router(overrides, prefix="/api")
app.include_router(milestones, prefix="/api")
app.include_router(custom_bars, prefix="/api")
app.include_router(dashboards, prefix="/api")
app.include_router(session, prefix="/api")
app.include_router(admin, prefix="/api")
app.include_router(jira_link, prefix="/api")
app.include_router(presence, prefix="/api")
app.include_router(events, prefix="/api")


@app.get("/health")
async def health():
    return {"status": "ok"}
