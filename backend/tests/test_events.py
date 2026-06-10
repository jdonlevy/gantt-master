"""Tests for the SSE events facade.

The HTTP /events endpoint is exercised indirectly here — its core behaviour
is just ``subscribe()`` / ``unsubscribe()`` plus the ``publish()`` fanout,
which we cover directly to avoid the complexity of asserting on a live SSE
stream in tests. End-to-end stream behaviour is covered by manual
two-browser verification documented in the PR.

These tests run against the default ``InProcessBus`` — the lifespan
isn't entered, so no Postgres LISTEN connection is opened. Cross-pod
behaviour is covered by ``test_events_bus.py``.
"""

import asyncio

import pytest

from app import events
from app.events_bus import InProcessBus, set_bus


@pytest.fixture(autouse=True)
def _fresh_in_process_bus():
    """Each test starts with a brand-new InProcessBus so subscriber
    state can't leak between tests."""
    set_bus(InProcessBus())
    yield
    set_bus(InProcessBus())


@pytest.mark.asyncio
async def test_publish_to_no_subscribers_is_noop():
    """Publishing with zero subscribers must not raise."""
    await events.publish("nonexistent-slug", "panel.updated", {"panelId": "x"})


@pytest.mark.asyncio
async def test_subscribe_and_publish_delivers_event():
    """A subscribed queue receives the published event."""
    queue = events.subscribe("dash-1")
    await events.publish("dash-1", "panel.updated", {"panelId": "p1", "updatedAt": "2026-05-22T00:00:00Z"})
    message = await asyncio.wait_for(queue.get(), timeout=1.0)
    assert message["event"] == "panel.updated"
    assert message["data"] == {"panelId": "p1", "updatedAt": "2026-05-22T00:00:00Z"}


@pytest.mark.asyncio
async def test_publish_only_fans_out_to_matching_slug():
    """Subscribers on different slugs are isolated."""
    q1 = events.subscribe("dash-1")
    q2 = events.subscribe("dash-2")
    await events.publish("dash-1", "panel.updated", {"panelId": "p1"})
    msg = await asyncio.wait_for(q1.get(), timeout=1.0)
    assert msg["data"] == {"panelId": "p1"}
    assert q2.empty()


@pytest.mark.asyncio
async def test_publish_fans_out_to_multiple_subscribers_on_same_slug():
    """All subscribers on the same slug receive the event."""
    q1 = events.subscribe("dash-1")
    q2 = events.subscribe("dash-1")
    await events.publish("dash-1", "panel.updated", {"panelId": "p1"})
    assert (await asyncio.wait_for(q1.get(), timeout=1.0))["data"]["panelId"] == "p1"
    assert (await asyncio.wait_for(q2.get(), timeout=1.0))["data"]["panelId"] == "p1"


@pytest.mark.asyncio
async def test_unsubscribe_removes_subscriber():
    """An unsubscribed queue does not receive subsequent events."""
    queue = events.subscribe("dash-1")
    events.unsubscribe("dash-1", queue)
    await events.publish("dash-1", "panel.updated", {"panelId": "p1"})
    assert queue.empty()


@pytest.mark.asyncio
async def test_unsubscribe_is_idempotent():
    """Unsubscribing twice or on a non-existent slug must not raise."""
    queue = events.subscribe("dash-1")
    events.unsubscribe("dash-1", queue)
    events.unsubscribe("dash-1", queue)
    events.unsubscribe("nonexistent", queue)


def test_format_sse_emits_spec_compliant_wire_format():
    """The wire format matches the SSE spec: event, data, blank-line terminator."""
    out = events.format_sse({"event": "panel.updated", "data": {"panelId": "p1"}})
    assert out == b'event: panel.updated\ndata: {"panelId":"p1"}\n\n'
