"""Bus-level tests for the SSE pub/sub transport.

In-process coverage exercises ``InProcessBus`` and the ``PostgresListenBus``
fallback paths with a stubbed asyncpg connection — enough to verify that
``publish()`` never awaits the DB on the request path and that the
background drain task actually drains. The live LISTEN/NOTIFY round-trip
is gated on ``DT_DATABASE_URL_LIVE`` — set it to a working DSN to run the
cross-pod simulation locally; CI skips it.
"""

import asyncio
import json
import os
import time

import pytest

from app.events_bus import (
    InProcessBus,
    PostgresListenBus,
    PG_CHANNEL,
    _MAX_PAYLOAD_BYTES,
    _OUTBOUND_MAXSIZE,
    get_bus,
    install_postgres_bus,
    set_bus,
)


@pytest.fixture(autouse=True)
def _reset_bus():
    set_bus(InProcessBus())
    yield
    set_bus(InProcessBus())


# ── Fake asyncpg connection ──────────────────────────────────────────
#
# Lets us exercise the bus's drain/lifecycle paths deterministically
# without a running Postgres. Only implements the subset of the asyncpg
# Connection surface that ``PostgresListenBus`` actually touches.


class _FakeConn:
    """Drop-in stand-in for ``asyncpg.Connection`` used by PostgresListenBus.

    Records every ``execute()`` call so tests can assert what was issued,
    and supports a few knobs to simulate adversarial conditions:

    * ``execute_delay``      — per-call sleep (slow DB / would-block NOTIFY).
    * ``execute_hangs``      — never returns from execute() (half-open socket).
    * ``execute_raises``     — raise this exception when execute() is called.
    * ``executes_in_flight`` — count of execute() calls currently running.
                               Lets concurrency tests assert the bus's lock
                               actually serialises drain + probe.
    """

    def __init__(self) -> None:
        self.executes: list[tuple[str, tuple]] = []
        self.execute_delay: float = 0.0
        self.execute_hangs: bool = False
        self.execute_raises: Exception | None = None
        self.executes_in_flight: int = 0
        self.max_executes_in_flight: int = 0
        self._closed: bool = False
        self.listener_callback = None
        self.termination_callback = None

    async def add_listener(self, channel: str, callback) -> None:
        # Real asyncpg installs a callback that fires on NOTIFY from the
        # server. Tests can call this directly to simulate inbound events.
        self.listener_callback = callback

    def add_termination_listener(self, callback) -> None:
        # asyncpg's ``add_termination_listener`` is sync — it registers a
        # callback fired when the connection is closed for any reason.
        self.termination_callback = callback

    async def execute(self, query: str, *args) -> None:
        if self.execute_raises is not None:
            raise self.execute_raises
        self.executes_in_flight += 1
        try:
            self.max_executes_in_flight = max(
                self.max_executes_in_flight, self.executes_in_flight
            )
            if self.execute_hangs:
                # Sleep "forever" — caller is expected to time out.
                await asyncio.sleep(3600)
            if self.execute_delay:
                await asyncio.sleep(self.execute_delay)
            self.executes.append((query, args))
        finally:
            self.executes_in_flight -= 1

    def is_closed(self) -> bool:
        return self._closed

    async def close(self) -> None:
        self._closed = True


class _FakeListenBus(PostgresListenBus):
    """PostgresListenBus that connects to a ``_FakeConn`` instead of a real DB.

    Each call to ``_connect_with_listener`` produces a fresh ``_FakeConn``
    (so reconnect tests can observe a new connection). Tests that want
    to pre-configure the *next* connection's behaviour can push a
    ``_FakeConn`` onto ``next_conns`` before triggering the reconnect.
    """

    def __init__(self) -> None:
        super().__init__(dsn="postgresql://fake")
        self.connect_attempts: int = 0
        self.next_conns: list[_FakeConn] = []
        self.all_conns: list[_FakeConn] = []

    @property
    def fake_conn(self) -> _FakeConn:
        """Convenience for tests that only ever expect one connection."""
        return self.all_conns[-1]

    async def _connect_with_listener(self) -> None:
        self.connect_attempts += 1
        conn = self.next_conns.pop(0) if self.next_conns else _FakeConn()
        self.all_conns.append(conn)
        await conn.add_listener(PG_CHANNEL, self._on_notify)
        conn.add_termination_listener(self._on_terminated)
        self._conn = conn


# ── InProcessBus + shared local-fanout coverage ──────────────────────


@pytest.mark.asyncio
async def test_in_process_bus_drops_event_for_full_queue_without_blocking():
    """A slow consumer's full queue must not block the publisher; the
    event is dropped for that subscriber and others still receive it."""
    bus = InProcessBus()
    q1 = bus.subscribe("dash-1")
    while not q1.full():
        q1.put_nowait({"event": "filler", "data": {}})
    q2 = bus.subscribe("dash-1")

    await asyncio.wait_for(
        bus.publish("dash-1", "panel.updated", {"panelId": "p1"}),
        timeout=1.0,
    )
    assert (await asyncio.wait_for(q2.get(), timeout=1.0))["data"]["panelId"] == "p1"


@pytest.mark.asyncio
async def test_unsubscribe_cleans_up_empty_slug():
    """The slug entry is removed once the last subscriber unsubscribes —
    confirms the local fanout dict doesn't grow without bound across a
    busy session of users opening and closing dashboards."""
    bus = InProcessBus()
    q = bus.subscribe("dash-1")
    assert bus.subscriber_counts() == {"dash-1": 1}
    bus.unsubscribe("dash-1", q)
    assert bus.subscriber_counts() == {}


# ── PostgresListenBus — request path is DB-independent ──────────────


@pytest.mark.asyncio
async def test_postgres_bus_local_fanout_happens_on_publish_path_without_connection():
    """Even without a connection, ``publish()`` must deliver to local
    queues immediately. This is what lets same-pod live sync keep
    working during a brief LISTEN-connection outage."""
    bus = PostgresListenBus(dsn="postgresql://unused")
    # No start() — _conn stays None.
    q = bus.subscribe("dash-1")
    await bus.publish("dash-1", "panel.updated", {"panelId": "p1"})
    msg = await asyncio.wait_for(q.get(), timeout=1.0)
    assert msg["data"]["panelId"] == "p1"


@pytest.mark.asyncio
async def test_publish_does_not_await_notify_on_request_path():
    """The whole point of the drain task: ``publish()`` must return in
    sub-millisecond time even if the DB ``execute()`` would take a
    second. Confirms the cross-pod NOTIFY is genuinely off the request
    path — a regression here would re-introduce the latency the reviewer
    flagged."""
    bus = _FakeListenBus()
    slow_conn = _FakeConn()
    slow_conn.execute_delay = 1.0  # would-block NOTIFY
    bus.next_conns = [slow_conn]
    await bus.start()
    try:
        q = bus.subscribe("dash-1")
        t0 = time.monotonic()
        await bus.publish("dash-1", "panel.updated", {"panelId": "p1"})
        elapsed = time.monotonic() - t0
        # Local fanout + put_nowait should take microseconds. 100ms is
        # generous; a real regression would be on the order of 1s here.
        assert elapsed < 0.1, f"publish() blocked on NOTIFY for {elapsed:.3f}s"
        # Local delivery is still synchronous — message is in the queue
        # before publish() returned.
        msg = q.get_nowait()
        assert msg["data"]["panelId"] == "p1"
    finally:
        await bus.stop()


@pytest.mark.asyncio
async def test_drain_loop_eventually_issues_pg_notify():
    """The drain task must actually drain the outbound queue. Without
    it, cross-pod delivery never happens regardless of how fast the
    request path returns.

    Asserts the function form ``pg_notify($1, $2)`` is used rather
    than the bare ``NOTIFY <channel>, $1`` command — the latter is a
    Postgres syntax error because NOTIFY requires the payload as a
    string literal, not a bind parameter, and would silently break
    cross-pod delivery in production while passing fake-conn tests."""
    bus = _FakeListenBus()
    await bus.start()
    try:
        await bus.publish("dash-1", "panel.updated", {"panelId": "p1"})
        # Yield the loop a few times so the drain task can wake, pull
        # the envelope, and call execute. With execute_delay=0 this
        # completes within microseconds; one short sleep is plenty.
        for _ in range(50):
            if bus.fake_conn.executes:
                break
            await asyncio.sleep(0.01)
        assert len(bus.fake_conn.executes) == 1
        query, args = bus.fake_conn.executes[0]
        # Must use the function form — the bare NOTIFY command would
        # fail at execution time because $1 isn't a valid placeholder
        # for its payload argument.
        assert "pg_notify" in query.lower()
        assert "$1" in query and "$2" in query
        assert args[0] == PG_CHANNEL
        envelope = json.loads(args[1])
        assert envelope["slug"] == "dash-1"
        assert envelope["event"] == "panel.updated"
        assert envelope["data"] == {"panelId": "p1"}
        assert envelope["origin"] == bus._origin_id
    finally:
        await bus.stop()


@pytest.mark.asyncio
async def test_outbound_queue_full_drops_without_blocking_request_path():
    """When the drain task can't keep up, ``publish()`` still returns
    quickly — the cross-pod event is dropped (logged) rather than
    backpressuring the HTTP handler. Same-pod delivery still happens."""
    bus = _FakeListenBus()
    # Pre-fill the outbound queue so the *next* publish overflows. We
    # don't start the drain task — no consumer means anything we put
    # stays put.
    await bus._connect_with_listener()  # populates _conn without starting the drain
    while not bus._outbound.full():
        bus._outbound.put_nowait("filler")

    q = bus.subscribe("dash-1")
    t0 = time.monotonic()
    await bus.publish("dash-1", "panel.updated", {"panelId": "p-overflow"})
    elapsed = time.monotonic() - t0
    assert elapsed < 0.1, f"publish() blocked on overflow path for {elapsed:.3f}s"
    # Local delivery still happened despite the cross-pod path being full.
    msg = q.get_nowait()
    assert msg["data"]["panelId"] == "p-overflow"
    # No drain task means no executes ever fired.
    assert bus.fake_conn.executes == []
    # Sanity check the bound matches the constant — guards against a
    # future "tune the size" change forgetting to update both.
    assert bus._outbound.maxsize == _OUTBOUND_MAXSIZE


# ── Self-NOTIFY suppression ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_self_originated_notify_is_suppressed_in_listener():
    """The publish-path local fanout already delivered the event; the
    LISTEN callback for the same pod's own NOTIFY must not deliver it
    again, or subscribers double-fire (e.g. duplicate panel refetches)."""
    bus = _FakeListenBus()
    await bus.start()
    try:
        q = bus.subscribe("dash-1")
        # Drain the publish-path local delivery first so the queue is empty.
        await bus.publish("dash-1", "panel.updated", {"panelId": "p1"})
        _ = q.get_nowait()
        # Simulate the listener callback firing for the just-published
        # NOTIFY (asyncpg delivers self-issued NOTIFYs back).
        envelope = json.dumps({
            "slug": "dash-1",
            "event": "panel.updated",
            "data": {"panelId": "p1"},
            "origin": bus._origin_id,
        })
        bus._on_notify(None, 0, PG_CHANNEL, envelope)
        # The listener should have skipped local fanout for our own origin.
        assert q.empty()
    finally:
        await bus.stop()


@pytest.mark.asyncio
async def test_peer_originated_notify_is_delivered_to_local_queues():
    """The other half of the origin-id contract: events from *other*
    pods must still fan out locally — that's the whole point of the
    LISTEN side of the bus."""
    bus = _FakeListenBus()
    await bus.start()
    try:
        q = bus.subscribe("dash-1")
        envelope = json.dumps({
            "slug": "dash-1",
            "event": "panel.updated",
            "data": {"panelId": "p-from-peer"},
            "origin": "some-other-pod-id",
        })
        bus._on_notify(None, 0, PG_CHANNEL, envelope)
        msg = q.get_nowait()
        assert msg["data"]["panelId"] == "p-from-peer"
    finally:
        await bus.stop()


# ── Misc invariants ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_postgres_bus_rejects_oversize_payload_wholly():
    """Payloads that would silently truncate at the Postgres NOTIFY cap
    must be rejected for *every* tab — same-pod fanout would otherwise
    create a split-brain where one user sees the event and a coworker
    on another pod doesn't. Nothing delivered anywhere; nothing
    queued for NOTIFY."""
    bus = _FakeListenBus()
    await bus.start()
    try:
        q = bus.subscribe("dash-1")
        huge = {"blob": "x" * (_MAX_PAYLOAD_BYTES + 1)}
        await bus.publish("dash-1", "panel.updated", huge)
        assert q.empty()
        await asyncio.sleep(0.05)  # let the drain task spin once
        assert bus.fake_conn.executes == []
    finally:
        await bus.stop()


@pytest.mark.asyncio
async def test_default_bus_is_in_process():
    """A fresh process boots with an InProcessBus so the SSE surface
    works in tests / smoke runs without a real database."""
    assert isinstance(get_bus(), InProcessBus)


# ── Active heartbeat / reconnect ─────────────────────────────────────


@pytest.mark.asyncio
async def test_probe_reconnects_when_execute_raises(monkeypatch):
    """If the heartbeat probe's ``SELECT 1`` raises, the bus must treat
    the connection as dead and reconnect — even on a pod with zero
    publish traffic (so the drain loop never noticed). Regression test
    for the ``is_closed()``-only check that missed half-open sockets."""
    from app import events_bus
    monkeypatch.setattr(events_bus, "_PROBE_INTERVAL_SECS", 0.05)
    monkeypatch.setattr(events_bus, "_PROBE_TIMEOUT_SECS", 0.5)

    bus = _FakeListenBus()
    # Seed two connections: first one's probe will raise, second is healthy.
    first = _FakeConn()
    first.execute_raises = ConnectionError("simulated dead socket")
    second = _FakeConn()
    bus.next_conns = [first, second]

    await bus.start()
    try:
        # Wait for the probe to fire, fail, and trigger reconnect to #2.
        for _ in range(100):
            if bus.connect_attempts >= 2 and bus._conn is second:
                break
            await asyncio.sleep(0.05)
        assert bus.connect_attempts >= 2, (
            f"expected reconnect; saw {bus.connect_attempts} attempts"
        )
        assert bus._conn is second
        # First connection should have been closed during teardown of the
        # bad one (best-effort close in _close_conn_quietly).
        assert first._closed is True
    finally:
        await bus.stop()


@pytest.mark.asyncio
async def test_probe_reconnects_when_execute_hangs(monkeypatch):
    """The slow-path scenario: the socket accepts writes but never
    replies (half-open). ``is_closed()`` returns False and execute()
    never raises — only the probe timeout catches this. Without the
    timeout the bus would wait the OS TCP keepalive (default 2h on
    Linux) before noticing."""
    from app import events_bus
    monkeypatch.setattr(events_bus, "_PROBE_INTERVAL_SECS", 0.05)
    monkeypatch.setattr(events_bus, "_PROBE_TIMEOUT_SECS", 0.1)

    bus = _FakeListenBus()
    first = _FakeConn()
    first.execute_hangs = True
    second = _FakeConn()
    bus.next_conns = [first, second]

    await bus.start()
    try:
        for _ in range(100):
            if bus.connect_attempts >= 2 and bus._conn is second:
                break
            await asyncio.sleep(0.05)
        assert bus.connect_attempts >= 2, (
            f"expected reconnect on probe timeout; saw {bus.connect_attempts}"
        )
        assert bus._conn is second
    finally:
        await bus.stop()


@pytest.mark.asyncio
async def test_termination_listener_nulls_conn_for_fast_reconnect(monkeypatch):
    """asyncpg's termination callback is the fast-path notification —
    when the read loop notices a closed socket we shouldn't wait for
    the next probe tick. The handler must null ``_conn`` so the
    very next probe (or drain attempt) sees no connection and reconnects."""
    from app import events_bus
    monkeypatch.setattr(events_bus, "_PROBE_INTERVAL_SECS", 0.05)

    bus = _FakeListenBus()
    bus.next_conns = [_FakeConn(), _FakeConn()]
    await bus.start()
    try:
        first = bus.fake_conn
        assert first.termination_callback is not None, (
            "bus must register a termination listener"
        )
        # Fire the termination callback — simulates asyncpg's read loop
        # detecting the socket was closed.
        first.termination_callback(first)
        assert bus._conn is None, "termination callback must null _conn"
        # Probe loop should now reconnect on its next tick.
        for _ in range(100):
            if bus.connect_attempts >= 2:
                break
            await asyncio.sleep(0.05)
        assert bus.connect_attempts >= 2
    finally:
        await bus.stop()


@pytest.mark.asyncio
async def test_healthy_connection_survives_probe_ticks(monkeypatch):
    """A healthy connection must NOT trigger spurious reconnects on
    every probe tick — that would churn the LISTEN connection and
    drop events between every reconnect window."""
    from app import events_bus
    monkeypatch.setattr(events_bus, "_PROBE_INTERVAL_SECS", 0.02)
    monkeypatch.setattr(events_bus, "_PROBE_TIMEOUT_SECS", 1.0)

    bus = _FakeListenBus()
    await bus.start()
    try:
        # Let several probe ticks elapse.
        await asyncio.sleep(0.2)
        assert bus.connect_attempts == 1, (
            f"healthy probes triggered {bus.connect_attempts} reconnects"
        )
        # Each probe should have issued exactly one SELECT 1.
        select_ones = [
            e for e in bus.fake_conn.executes if e[0] == "SELECT 1"
        ]
        assert len(select_ones) >= 3, (
            f"expected multiple probe executes, saw {len(select_ones)}"
        )
    finally:
        await bus.stop()


@pytest.mark.asyncio
async def test_drain_and_probe_serialised_on_same_connection(monkeypatch):
    """asyncpg.Connection can't be used concurrently from two
    coroutines. Drain (NOTIFY) and probe (SELECT 1) must serialise via
    ``_conn_lock`` — concurrent execute() calls would raise inside
    real asyncpg and silently destabilise the connection."""
    from app import events_bus
    monkeypatch.setattr(events_bus, "_PROBE_INTERVAL_SECS", 0.02)
    monkeypatch.setattr(events_bus, "_PROBE_TIMEOUT_SECS", 1.0)

    bus = _FakeListenBus()
    # Slow each execute() so drain + probe windows overlap in wall time.
    conn = _FakeConn()
    conn.execute_delay = 0.05
    bus.next_conns = [conn]

    await bus.start()
    try:
        # Fire several publishes while probes are also running.
        for i in range(5):
            await bus.publish("dash-1", "panel.updated", {"panelId": f"p{i}"})
        await asyncio.sleep(0.5)
        # The fake conn counted the peak in-flight execute count — if
        # the lock works, it never exceeds 1.
        assert conn.max_executes_in_flight == 1, (
            f"lock failed: {conn.max_executes_in_flight} concurrent executes"
        )
    finally:
        await bus.stop()


# ── Drain-timeout / deadlock-resilience ──────────────────────────────


@pytest.mark.asyncio
async def test_hung_drain_does_not_deadlock_probe(monkeypatch):
    """If a NOTIFY hangs on a half-open socket, the drain must time out
    rather than holding ``_conn_lock`` forever. Otherwise the probe
    blocks on lock acquisition and never reaches its timeout path —
    publishes pile up to overflow and cross-pod updates die silently
    until pod restart. Regression test for that deadlock chain."""
    from app import events_bus
    monkeypatch.setattr(events_bus, "_PROBE_INTERVAL_SECS", 0.05)
    monkeypatch.setattr(events_bus, "_PROBE_TIMEOUT_SECS", 0.2)

    bus = _FakeListenBus()
    hung = _FakeConn()
    hung.execute_hangs = True  # NOTIFY will hang forever without the timeout
    healthy = _FakeConn()
    bus.next_conns = [hung, healthy]

    await bus.start()
    try:
        # Trigger a drain attempt; without the timeout the drain task
        # would hold _conn_lock forever and we'd deadlock.
        await bus.publish("dash-1", "panel.updated", {"panelId": "p1"})

        # Wait for the drain to time out (≤ _PROBE_TIMEOUT_SECS), the
        # connection to be closed, and the probe to reconnect.
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            if bus.connect_attempts >= 2 and bus._conn is healthy:
                break
            await asyncio.sleep(0.05)
        assert bus.connect_attempts >= 2, (
            f"deadlock: only {bus.connect_attempts} connection attempts after hung NOTIFY"
        )
        assert bus._conn is healthy
        assert hung._closed, "hung connection should have been closed"
    finally:
        await bus.stop()


@pytest.mark.asyncio
async def test_drain_failure_closes_connection_for_fast_reconnect(monkeypatch):
    """Any execute() failure inside the lock — not just timeouts — must
    close the suspect connection. Retrying on the same conn would burn
    the lock again and only delays the reconnect by one publish-rate
    tick at best."""
    from app import events_bus
    monkeypatch.setattr(events_bus, "_PROBE_INTERVAL_SECS", 0.05)
    monkeypatch.setattr(events_bus, "_PROBE_TIMEOUT_SECS", 1.0)

    bus = _FakeListenBus()
    broken = _FakeConn()
    broken.execute_raises = ConnectionError("server gone")
    healthy = _FakeConn()
    bus.next_conns = [broken, healthy]

    await bus.start()
    try:
        await bus.publish("dash-1", "panel.updated", {"panelId": "p1"})
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            if bus.connect_attempts >= 2 and bus._conn is healthy:
                break
            await asyncio.sleep(0.05)
        assert bus.connect_attempts >= 2
        assert bus._conn is healthy
        assert broken._closed
    finally:
        await bus.stop()


@pytest.mark.asyncio
async def test_stale_termination_callback_does_not_null_fresh_conn(monkeypatch):
    """asyncpg may fire termination on a previous connection after
    we've already replaced it (callbacks are scheduled, not synchronous).
    Without an identity check, that late termination would null the
    fresh, healthy connection and trigger a spurious reconnect — or
    worse, briefly drop traffic during the window."""
    from app import events_bus
    monkeypatch.setattr(events_bus, "_PROBE_INTERVAL_SECS", 0.05)

    bus = _FakeListenBus()
    bus.next_conns = [_FakeConn(), _FakeConn()]
    await bus.start()
    try:
        first = bus.all_conns[0]
        # Force a reconnect: null _conn through the legitimate path.
        first.termination_callback(first)
        # Wait for the reconnect to install the second conn.
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            if bus.connect_attempts >= 2:
                break
            await asyncio.sleep(0.05)
        second = bus._conn
        assert second is bus.all_conns[1]
        # Now simulate the stale callback firing late — should be ignored.
        first.termination_callback(first)
        assert bus._conn is second, (
            "stale termination callback nulled the fresh connection"
        )
    finally:
        await bus.stop()


# ── lifecycle ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stop_is_idempotent_and_cancels_background_tasks():
    """``stop()`` must tear down both background tasks (drain +
    reconnect) and close the connection — and must be safe to call
    even if ``start()`` failed partway through. Catches a regression
    where lifespan-shutdown leaks tasks into the next test."""
    bus = _FakeListenBus()
    await bus.start()
    # Both tasks should be alive.
    assert bus._drain_task is not None and not bus._drain_task.done()
    assert bus._reconnect_task is not None and not bus._reconnect_task.done()
    await bus.stop()
    assert bus._drain_task is None
    assert bus._reconnect_task is None
    assert bus._conn is None
    # Second stop must not raise.
    await bus.stop()


# ── Live LISTEN/NOTIFY end-to-end ────────────────────────────────────
#
# Opt-in: set DT_DATABASE_URL_LIVE to a real DSN to run. CI skips. The
# test simulates two pods on one process by starting *two* PostgresListenBus
# instances pointed at the same DB — publish on one, expect delivery on
# the other through the NOTIFY round-trip.

_LIVE_DSN = os.environ.get("DT_DATABASE_URL_LIVE")


@pytest.mark.asyncio
@pytest.mark.skipif(_LIVE_DSN is None, reason="DT_DATABASE_URL_LIVE not set")
async def test_postgres_bus_cross_instance_delivery():
    """Two PostgresListenBus instances on the same DB simulate two pods.
    A publish on one must reach a subscriber on the other via NOTIFY."""
    bus_a = PostgresListenBus(dsn=_LIVE_DSN)
    bus_b = PostgresListenBus(dsn=_LIVE_DSN)
    await bus_a.start()
    await bus_b.start()
    try:
        q = bus_b.subscribe("dash-cross")
        await bus_a.publish("dash-cross", "panel.updated", {"panelId": "p-cross"})
        msg = await asyncio.wait_for(q.get(), timeout=3.0)
        assert msg["event"] == "panel.updated"
        assert msg["data"]["panelId"] == "p-cross"
    finally:
        await bus_a.stop()
        await bus_b.stop()


@pytest.mark.asyncio
@pytest.mark.skipif(_LIVE_DSN is None, reason="DT_DATABASE_URL_LIVE not set")
async def test_install_postgres_bus_replaces_default_and_self_delivers_locally():
    """install_postgres_bus swaps the module-level bus and start()s it.
    Same-pod publish must still deliver locally — via the synchronous
    publish-path fanout, not the self-NOTIFY (which is now suppressed)."""
    bus = await install_postgres_bus(_LIVE_DSN)
    try:
        assert get_bus() is bus
        q = bus.subscribe("dash-install")
        await bus.publish("dash-install", "panel.updated", {"panelId": "p-install"})
        msg = await asyncio.wait_for(q.get(), timeout=3.0)
        assert msg["data"]["panelId"] == "p-install"
        # Exactly one delivery — no duplicate from the self-NOTIFY echo.
        # Give the NOTIFY round-trip time to arrive before checking.
        await asyncio.sleep(0.3)
        assert q.empty(), "self-NOTIFY suppression failed: duplicate delivery"
    finally:
        await bus.stop()


def test_pg_channel_name_is_a_valid_postgres_identifier():
    """NOTIFY channel names must be valid unquoted identifiers (lowercase
    letters, digits, underscores; <=63 bytes). Catches a future rename
    that would otherwise fail at NOTIFY time."""
    assert PG_CHANNEL.islower()
    assert all(c.isalnum() or c == "_" for c in PG_CHANNEL)
    assert 1 <= len(PG_CHANNEL) <= 63
