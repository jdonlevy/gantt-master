"""In-pod entry points for SSE pub/sub.

Thin facade over ``events_bus.get_bus()``. Keeps the legacy
``subscribe``/``unsubscribe``/``publish``/``format_sse`` signatures so
callers (the SSE router, the panel-update handler) don't need to know
which transport is active. The transport itself is selected in
``main.lifespan`` — see ``events_bus.py`` and ``docs/cross-pod-sse.md``.
"""

import asyncio
import json
from typing import Any

from .events_bus import get_bus


def subscribe(slug: str) -> asyncio.Queue:
    """Register a new subscriber for ``slug`` and return its queue."""
    return get_bus().subscribe(slug)


def unsubscribe(slug: str, queue: asyncio.Queue) -> None:
    """Remove a subscriber. Safe to call multiple times."""
    get_bus().unsubscribe(slug, queue)


async def publish(slug: str, event_name: str, payload: dict[str, Any]) -> None:
    """Fanout an event to every subscriber listening on ``slug``.

    Cross-pod delivery happens through the active bus (PostgresListenBus
    in prod, InProcessBus in tests). Best-effort: a queue-full or NOTIFY
    failure for one subscriber must not block the publisher.
    """
    await get_bus().publish(slug, event_name, payload)


def format_sse(message: dict[str, Any]) -> bytes:
    """Encode an event for the wire as per the SSE spec."""
    return (
        f"event: {message['event']}\n"
        f"data: {json.dumps(message['data'], separators=(',', ':'))}\n\n"
    ).encode("utf-8")
