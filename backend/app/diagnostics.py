"""Periodic memory + state telemetry for catching leaks.

After multiple OOMKill incidents on the 256Mi container limit it became
clear the codebase had no visibility into what was accumulating in
memory. This module emits a single log line every ``_INTERVAL_SECS``
seconds with: resident set size, count of live asyncio tasks, SSE
subscriber count, JWKS cache size, presence-table size, and SQLAlchemy
pool counters. A real leak shows up as one of those numbers growing
monotonically next to a climbing RSS.

The task is started from ``main.lifespan`` and cancelled cleanly on
shutdown — it never holds any database session or HTTP resources of its
own.
"""

from __future__ import annotations

import asyncio
import logging
import resource
import sys

logger = logging.getLogger("uvicorn.error")

_INTERVAL_SECS = 30.0


def _rss_mb() -> float:
    """Process resident set size in MiB.

    ``ru_maxrss`` is in kilobytes on Linux and bytes on macOS — branch
    on platform so dev-laptop readings agree with prod readings.
    """
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    if sys.platform == "darwin":
        return rss / (1024 * 1024)
    return rss / 1024


async def _sample_and_log() -> None:
    from . import azure_auth
    from .events_bus import get_bus
    from .database import engine
    # ``backend.app.routers.__init__`` re-exports ``presence`` as the APIRouter
    # instance (``from .presence import router as presence``), so the usual
    # ``from .routers import presence`` returns the router, not the module.
    # Import the dict directly to read its current size.
    from .routers.presence import _presence as presence_dict

    rss = _rss_mb()

    # Subscriber counts come from whichever bus is active (in-process in
    # tests / smoke runs, Postgres LISTEN/NOTIFY in prod). The counts
    # reflect *this pod's* local subscribers only; with the LISTEN bus
    # the same slug may have subscribers on other pods that we can't see.
    sub_counts = get_bus().subscriber_counts()
    sub_total = sum(sub_counts.values())
    slug_count = len(sub_counts)

    jwks_keys = len(azure_auth._jwks_cache._keys)
    presence_entries = len(presence_dict)

    try:
        task_count = len(asyncio.all_tasks())
    except RuntimeError:
        task_count = -1

    pool = getattr(engine.sync_engine, "pool", None)
    pool_size = getattr(pool, "size", lambda: -1)() if pool else -1
    pool_checked_out = getattr(pool, "checkedout", lambda: -1)() if pool else -1
    pool_overflow = getattr(pool, "overflow", lambda: -1)() if pool else -1

    logger.info(
        "diag rss=%.1fMiB tasks=%d sse_slugs=%d sse_subs=%d jwks_keys=%d "
        "presence=%d pool_size=%d pool_checked_out=%d pool_overflow=%d",
        rss,
        task_count,
        slug_count,
        sub_total,
        jwks_keys,
        presence_entries,
        pool_size,
        pool_checked_out,
        pool_overflow,
    )


async def _diagnostics_loop() -> None:
    while True:
        try:
            await _sample_and_log()
        except Exception:
            logger.exception("diagnostics sample failed")
        await asyncio.sleep(_INTERVAL_SECS)


def start_diagnostics() -> asyncio.Task:
    return asyncio.create_task(_diagnostics_loop(), name="diagnostics")
