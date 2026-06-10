"""Pluggable transport for SSE pub/sub.

The SSE feature has two distinct fanout layers:

1. **Within a pod** — every connected EventSource owns an asyncio.Queue.
   When an event arrives (locally or from another pod), the pod walks its
   own ``dict[slug, set[Queue]]`` and ``put_nowait``s the message into
   each matching queue. This layer is the same regardless of transport.

2. **Between pods** — when one pod's HTTP handler mutates a panel, every
   other pod that has subscribers on the same slug must learn about it.
   This is the layer that needs cross-process plumbing.

This module exposes an ``EventBus`` protocol covering both layers, plus
two concrete implementations:

* ``InProcessBus`` — layer 1 only. Used in tests and as a safe default
  before the lifespan has installed a real bus. Equivalent to the old
  module-level ``_subscribers`` dict.
* ``PostgresListenBus`` — adds layer 2 via ``LISTEN/NOTIFY`` on a
  dedicated long-lived asyncpg connection. Chosen because Postgres is
  already a hard dependency, payloads are tiny (~100 bytes), and the
  NOTIFY queue is observable through ``pg_notification_queue_usage()``.
  See ``docs/cross-pod-sse.md`` for the decision record and the
  swap-to-Redis playbook.

The router never imports a concrete bus — it always calls
``get_bus().subscribe(...)`` so swapping transports is a single-line
change in ``main.lifespan``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any, Protocol

logger = logging.getLogger("uvicorn.error")

# Bounded per-subscriber queue. A slow client (frozen tab, paused JS) must
# not back-pressure publishers — we drop events for it and let the
# frontend recover on the next event or reconnect refetch.
_QUEUE_MAXSIZE = 64

# Single Postgres NOTIFY channel for every dashboard. Per-slug channels
# would require dynamic LISTEN/UNLISTEN as users navigate between
# dashboards, which adds churn for no gain — slug filtering on the
# receiving side is one dict lookup.
PG_CHANNEL = "dashboard_events"

# Postgres NOTIFY payloads are capped at 8000 bytes. Our envelopes today
# are ~150 bytes (slug + event name + panelId + ISO timestamp). Reject
# anything that would silently truncate so a future richer-payload change
# can't ship a regression without noticing.
_MAX_PAYLOAD_BYTES = 7500

# Bounded outbound queue for cross-pod NOTIFY. Sized for ~1 s of buffering
# at typical sub-ms NOTIFY round-trips, covering a burst of debounced
# panel saves without dropping. On overflow we drop with a log line —
# same philosophy as ``_QUEUE_MAXSIZE`` for per-subscriber queues. The
# frontend already treats SSE as best-effort and refetches on reconnect.
_OUTBOUND_MAXSIZE = 1024

# Active heartbeat on the LISTEN connection. ``asyncpg.Connection.is_closed()``
# only reflects state observed after the connection is used, so a viewer-
# only pod (no publishes → no execute calls) would never notice a half-
# open socket after a DB failover or NAT timeout. The probe runs a cheap
# ``SELECT 1`` on this interval so failures surface within ~one interval
# regardless of publish traffic. The timeout is what guards against a
# *silent* half-open where the socket accepts writes but never replies —
# without it the probe would hang for the OS TCP keepalive interval
# (default 2 hours on Linux).
_PROBE_INTERVAL_SECS = 5.0
_PROBE_TIMEOUT_SECS = 5.0


class EventBus(Protocol):
    async def start(self) -> None: ...
    async def stop(self) -> None: ...
    def subscribe(self, slug: str) -> asyncio.Queue: ...
    def unsubscribe(self, slug: str, queue: asyncio.Queue) -> None: ...
    async def publish(self, slug: str, event_name: str, payload: dict[str, Any]) -> None: ...
    def subscriber_counts(self) -> dict[str, int]: ...


class _LocalFanout:
    """In-pod fanout shared by every bus implementation.

    Owns the ``dict[slug, set[Queue]]`` that maps a slug to the queues of
    every locally-connected EventSource. Bus implementations call
    ``deliver_local`` whenever an event needs to reach this pod's
    subscribers — whether it originated here (InProcessBus) or arrived
    from another pod (PostgresListenBus).
    """

    def __init__(self) -> None:
        self._subscribers: dict[str, set[asyncio.Queue]] = {}

    def subscribe(self, slug: str) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=_QUEUE_MAXSIZE)
        self._subscribers.setdefault(slug, set()).add(queue)
        return queue

    def unsubscribe(self, slug: str, queue: asyncio.Queue) -> None:
        subs = self._subscribers.get(slug)
        if not subs:
            return
        subs.discard(queue)
        if not subs:
            self._subscribers.pop(slug, None)

    def deliver_local(self, slug: str, event_name: str, payload: dict[str, Any]) -> None:
        subs = self._subscribers.get(slug)
        if not subs:
            return
        message = {"event": event_name, "data": payload}
        # Snapshot the set — disconnect callbacks may unsubscribe during
        # iteration, which would otherwise mutate-during-walk.
        for queue in list(subs):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                logger.warning(
                    "SSE subscriber queue full for slug=%s event=%s; dropping",
                    slug,
                    event_name,
                )

    def subscriber_counts(self) -> dict[str, int]:
        return {slug: len(qs) for slug, qs in self._subscribers.items()}


class InProcessBus:
    """Single-process bus. No cross-pod plumbing.

    Used as the default when no explicit bus has been started — covers
    tests (which never run lifespan) and the local-dev one-process case.
    """

    def __init__(self) -> None:
        self._local = _LocalFanout()

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        return None

    def subscribe(self, slug: str) -> asyncio.Queue:
        return self._local.subscribe(slug)

    def unsubscribe(self, slug: str, queue: asyncio.Queue) -> None:
        self._local.unsubscribe(slug, queue)

    async def publish(self, slug: str, event_name: str, payload: dict[str, Any]) -> None:
        self._local.deliver_local(slug, event_name, payload)

    def subscriber_counts(self) -> dict[str, int]:
        return self._local.subscriber_counts()


class PostgresListenBus:
    """Cross-pod bus using PostgreSQL ``LISTEN/NOTIFY``.

    One dedicated asyncpg connection per pod, owned by the bus for its
    full lifetime. Carved out from the application's connection budget,
    not from the SQLAlchemy pool, because LISTEN holds the connection
    open forever and a pooled checkout would never be returned.

    Publish path: ``publish()`` does the in-pod fanout synchronously
    (sub-microsecond — same-pod tabs see the event without waiting on
    the DB) and queues the cross-pod ``NOTIFY`` for a background drain
    task. The HTTP request handler therefore never awaits the DB on the
    fanout path; it returns as soon as local queues have the message.

    The drain task is the only coroutine that issues ``NOTIFY`` on the
    dedicated connection, so no lock is needed around ``execute`` — the
    asyncpg "no concurrent use" rule is satisfied by construction.

    Self-NOTIFY suppression: asyncpg's LISTEN callback fires for
    self-issued notifies too, which would re-deliver every event to the
    originating pod a second time (the in-pod fanout already delivered
    it on the publish path). Each bus stamps outbound envelopes with a
    per-instance ``origin`` UUID, and the listener callback skips local
    fanout when the envelope's origin matches its own. Cross-pod events
    always have a different origin and fan out normally.

    Auto-reconnect has two complementary triggers:

    * **Termination callback** — asyncpg's read loop fires
      ``add_termination_listener`` when it detects the socket has been
      closed cleanly or with an error. Fast path; flips ``_conn`` to
      None so the next probe tick reconnects immediately.
    * **Active probe** — the maintenance loop ``SELECT 1``s the
      connection on a fixed interval with a tight timeout. Catches
      half-open sockets where the peer has gone away but TCP hasn't
      noticed yet (the read loop's only signal is FIN/RST/EOF, which
      a silent failover may never deliver). Without this, a pod with
      only viewer traffic — no ``execute()`` calls ever — could lose
      its LISTEN connection indefinitely and silently stop receiving
      cross-pod events.

    Events emitted during the disconnect window are lost — the frontend
    already treats SSE as best-effort and refetches dashboard state on
    EventSource reconnect.
    """

    # asyncpg call signatures and error type live behind a deferred import
    # so unit tests that exercise InProcessBus don't need asyncpg present
    # in their isolation environment (it is at runtime — base.txt 0.29.0).
    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._local = _LocalFanout()
        self._conn: Any | None = None
        # Outbound NOTIFY queue, drained off the request path by a
        # background task launched in ``start()``. Bounded so a long DB
        # stall can't grow the queue without limit.
        self._outbound: asyncio.Queue[str] = asyncio.Queue(maxsize=_OUTBOUND_MAXSIZE)
        # Per-instance origin id so the listener can distinguish events
        # this pod just published (already delivered locally on the
        # publish path) from events that arrived from peer pods.
        self._origin_id = uuid.uuid4().hex
        # Serialises connection use by background coroutines (drain task
        # + probe loop). asyncpg.Connection is not safe for concurrent
        # use, and both coroutines now ``execute()`` on it. The lock is
        # NEVER acquired on the HTTP request path — ``publish()`` only
        # touches the in-memory outbound queue — so this doesn't undo
        # the "request path doesn't wait on the DB" property.
        self._conn_lock = asyncio.Lock()
        self._reconnect_task: asyncio.Task | None = None
        self._drain_task: asyncio.Task | None = None
        self._stopped = False

    async def start(self) -> None:
        await self._connect_with_listener()
        # Background drain: pulls NOTIFY envelopes off the outbound queue
        # and issues them on the dedicated connection. This is the only
        # coroutine that calls ``conn.execute("NOTIFY ...")``, so no
        # cross-coroutine lock on the connection is needed.
        self._drain_task = asyncio.create_task(
            self._drain_loop(), name="sse-bus-drain"
        )
        # Background maintenance: re-establishes the LISTEN connection if
        # asyncpg reports it has been lost. Stays running for the lifetime
        # of the bus.
        self._reconnect_task = asyncio.create_task(
            self._reconnect_loop(), name="sse-bus-reconnect"
        )

    async def stop(self) -> None:
        self._stopped = True
        # Cancel the drain task first so it can't try to issue NOTIFY on
        # a connection that's about to close — keeps shutdown clean even
        # if there are queued envelopes that will now be dropped.
        for task_attr in ("_drain_task", "_reconnect_task"):
            task = getattr(self, task_attr)
            if task is not None:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
                setattr(self, task_attr, None)
        if self._conn is not None:
            try:
                await self._conn.close()
            except Exception:
                logger.exception("Error closing SSE LISTEN connection")
            self._conn = None

    def subscribe(self, slug: str) -> asyncio.Queue:
        return self._local.subscribe(slug)

    def unsubscribe(self, slug: str, queue: asyncio.Queue) -> None:
        self._local.unsubscribe(slug, queue)

    async def publish(self, slug: str, event_name: str, payload: dict[str, Any]) -> None:
        # Size-check first so oversize payloads are rejected wholly —
        # delivering same-pod-only would create a split-brain where
        # one tab saw the event and another didn't. Better all-or-nothing.
        envelope = {
            "slug": slug,
            "event": event_name,
            "data": payload,
            "origin": self._origin_id,
        }
        body = json.dumps(envelope, separators=(",", ":"))
        if len(body.encode("utf-8")) > _MAX_PAYLOAD_BYTES:
            # Postgres truncates at 8000 bytes silently. Refuse rather
            # than ship a payload that won't fit. If this ever fires in
            # prod, the right answer is usually to slim the payload and
            # let the receiver fetch the heavy data — or to migrate to
            # Redis (see docs/cross-pod-sse.md).
            logger.error(
                "SSE payload exceeds NOTIFY cap for slug=%s event=%s bytes=%d",
                slug, event_name, len(body.encode("utf-8")),
            )
            return

        # In-pod fanout happens immediately on the request path — never
        # awaits the DB. This is the whole point of the split: HTTP
        # handlers return as soon as same-pod tabs have the message.
        self._local.deliver_local(slug, event_name, payload)

        if self._conn is None:
            # Listener is down. Same-pod delivery happened above; peer
            # pods miss this event and the EventSource refetch on
            # reconnect will pick it up.
            logger.warning(
                "SSE bus not connected; cross-pod NOTIFY skipped for slug=%s event=%s",
                slug, event_name,
            )
            return
        try:
            self._outbound.put_nowait(body)
        except asyncio.QueueFull:
            # The drain task can't keep up with publish rate — usually
            # means Postgres is stalling. Drop with a log line so
            # operators can correlate against pg_notification_queue_usage()
            # and the diagnostics RSS line.
            logger.warning(
                "SSE NOTIFY outbound queue full; dropping cross-pod event "
                "for slug=%s event=%s (same-pod delivery succeeded)",
                slug, event_name,
            )

    def subscriber_counts(self) -> dict[str, int]:
        return self._local.subscriber_counts()

    # ── internals ────────────────────────────────────────────────────

    async def _connect_with_listener(self) -> None:
        import asyncpg

        # Strip the SQLAlchemy driver prefix; asyncpg wants a plain
        # ``postgresql://`` DSN. Anything else we just pass through.
        dsn = self._dsn.replace("postgresql+asyncpg://", "postgresql://", 1)
        conn = await asyncpg.connect(dsn=dsn)
        await conn.add_listener(PG_CHANNEL, self._on_notify)
        # Fast-path notification when asyncpg's read loop notices the
        # connection has been closed (FIN/RST/EOF). The slow-path probe
        # in ``_reconnect_loop`` catches half-open sockets the read loop
        # can't see, but when asyncpg DOES notice we want to know
        # immediately rather than waiting for the next probe tick.
        conn.add_termination_listener(self._on_terminated)
        self._conn = conn
        logger.info("SSE bus connected to Postgres LISTEN channel=%s", PG_CHANNEL)

    def _on_terminated(self, conn) -> None:
        """asyncpg fires this when the connection is closed for any
        reason. Null out ``_conn`` so the next probe tick reconnects
        without waiting to time out a doomed query.

        Identity-checked: a callback registered on a previous connection
        could fire *after* we've already replaced it with a fresh
        connection (asyncpg delivers termination on its read-loop
        scheduling, not synchronously with close()). Without the check
        we'd null a perfectly healthy newly-installed conn."""
        if self._conn is not conn:
            return
        logger.warning("SSE bus: asyncpg signalled LISTEN connection terminated")
        # Don't touch ``_conn_lock`` here — this callback runs on
        # asyncpg's read loop, not as an awaitable, so it can't acquire
        # an asyncio.Lock cleanly. Concurrent reads of ``_conn`` are
        # tolerated; the drain/probe loops re-check before using it.
        self._conn = None

    def _on_notify(self, _conn, _pid, _channel, payload: str) -> None:
        # Called by asyncpg's read loop. Decode + fan out locally.
        # Defensive: a malformed payload (someone NOTIFYing the channel
        # by hand) must not kill the listener.
        try:
            envelope = json.loads(payload)
            slug = envelope["slug"]
            event_name = envelope["event"]
            data = envelope.get("data", {})
            origin = envelope.get("origin")
        except Exception:
            logger.warning("SSE bus: ignoring malformed NOTIFY payload")
            return
        # Skip self-originated notifies — the publish path already fanned
        # this event out to local queues, and re-delivering would cause
        # subscribers to handle (and refetch on) the same event twice.
        if origin is not None and origin == self._origin_id:
            return
        self._local.deliver_local(slug, event_name, data)

    async def _drain_loop(self) -> None:
        """Drain queued envelopes off the request path and onto NOTIFY.

        Loops until ``stop()`` cancels the task. Each ``execute()`` is
        bounded by ``_PROBE_TIMEOUT_SECS`` — without that bound a
        half-open socket could hang the drain forever while still
        holding ``_conn_lock``, starving the probe loop and preventing
        any reconnect (publishes would queue until overflow and
        cross-pod updates would silently die for this pod until pod
        restart). On timeout or other failure inside the locked section
        we close the suspect connection so the probe sees no connection
        on its next tick and triggers an immediate reconnect.
        """
        while not self._stopped:
            body = await self._outbound.get()
            conn = self._conn
            if conn is None or conn.is_closed():
                logger.warning(
                    "SSE bus drain: no connection; dropping queued NOTIFY"
                )
                continue
            try:
                # ``NOTIFY <channel>, $1`` would fail at execution time:
                # the server-side NOTIFY command requires the payload to
                # be a string literal in the SQL text, not a bind
                # parameter. ``pg_notify(text, text)`` is the function
                # form, semantically identical (same LISTEN delivery)
                # but accepts both channel and payload as parameters.
                #
                # Lock serialises with the probe loop in
                # ``_reconnect_loop``: asyncpg.Connection isn't safe for
                # concurrent ``execute()`` calls from two coroutines.
                async with self._conn_lock:
                    await asyncio.wait_for(
                        conn.execute("SELECT pg_notify($1, $2)", PG_CHANNEL, body),
                        timeout=_PROBE_TIMEOUT_SECS,
                    )
            except asyncio.TimeoutError:
                logger.warning(
                    "SSE bus drain: NOTIFY timed out — connection is half-open; "
                    "closing so the probe loop reconnects"
                )
                # Drop the suspect connection immediately so the probe
                # doesn't waste a tick waiting on the lock against a
                # connection we already know is dead.
                await self._close_conn_quietly()
            except Exception:
                logger.exception(
                    "SSE NOTIFY failed in drain loop; peers will not see this event"
                )
                # Defensive: treat any in-lock execute() failure the
                # same as a timeout. The connection has just refused a
                # query — assuming it's still healthy and retrying with
                # the next publish would burn the lock again, and the
                # cost of being wrong (a needless reconnect) is small.
                await self._close_conn_quietly()

    async def _reconnect_loop(self) -> None:
        """Active heartbeat probe + reconnect with capped backoff.

        Every ``_PROBE_INTERVAL_SECS`` we run a cheap ``SELECT 1`` on
        the LISTEN connection under a timeout. Any of:

          * ``_conn`` is None (we never connected, or the termination
            callback nulled it)
          * ``is_closed()`` returns True (asyncpg already knows)
          * ``execute()`` raises (asyncpg now knows)
          * ``execute()`` exceeds ``_PROBE_TIMEOUT_SECS`` (half-open
            socket — peer is gone but TCP hasn't noticed)

        triggers a reconnect with exponential backoff capped at 30s.
        The probe catches the failure mode the previous ``is_closed()``
        poll missed: viewer-only pods with no publish traffic never
        called ``execute()`` themselves, so a half-open socket after a
        failover would never surface until the OS TCP keepalive
        eventually fired (default 2h on Linux).
        """
        backoff = 1.0
        while not self._stopped:
            await asyncio.sleep(_PROBE_INTERVAL_SECS)
            if self._stopped:
                break
            healthy = await self._probe_connection()
            if healthy:
                backoff = 1.0
                continue
            logger.warning(
                "SSE bus: LISTEN connection unhealthy; reconnecting in %.1fs",
                backoff,
            )
            # Tear down the (possibly half-open) old connection before
            # opening a fresh one — don't let it leak.
            await self._close_conn_quietly()
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)
            try:
                await self._connect_with_listener()
            except Exception:
                logger.exception("SSE bus: reconnect failed; will retry")

    async def _probe_connection(self) -> bool:
        """Return True iff the LISTEN connection answers a ``SELECT 1``
        within ``_PROBE_TIMEOUT_SECS``. False covers None / closed /
        raised / timed out — all "treat as dead, reconnect" cases."""
        conn = self._conn
        if conn is None or conn.is_closed():
            return False
        try:
            async with self._conn_lock:
                # Re-check inside the lock — termination callback or a
                # concurrent drain failure may have nulled ``_conn``
                # while we waited for the lock.
                conn = self._conn
                if conn is None or conn.is_closed():
                    return False
                await asyncio.wait_for(
                    conn.execute("SELECT 1"),
                    timeout=_PROBE_TIMEOUT_SECS,
                )
            return True
        except asyncio.TimeoutError:
            logger.warning("SSE bus: probe timed out — connection is half-open")
            return False
        except Exception:
            logger.warning("SSE bus: probe raised — connection is dead", exc_info=True)
            return False

    async def _close_conn_quietly(self) -> None:
        """Best-effort close of the current connection; swallow errors.
        Used by the reconnect path where the connection is already
        suspect and we just want it out of the way."""
        conn = self._conn
        self._conn = None
        if conn is None:
            return
        try:
            await conn.close()
        except Exception:
            logger.debug("SSE bus: error closing stale connection (ignored)", exc_info=True)


# ── module-level bus selection ───────────────────────────────────────
#
# A single bus instance per process. The lifespan installs the real bus
# at startup; until then ``get_bus()`` returns an InProcessBus so the
# pre-lifespan window (and tests that never run lifespan) still work.

_bus: EventBus = InProcessBus()


def get_bus() -> EventBus:
    return _bus


def set_bus(bus: EventBus) -> None:
    global _bus
    _bus = bus


async def install_postgres_bus(dsn: str) -> EventBus:
    """Replace the active bus with a started PostgresListenBus.

    Called from ``main.lifespan``. Returns the new bus so lifespan can
    stop it on shutdown. Idempotent in spirit — calling it twice would
    leak the previous bus's LISTEN connection, so don't.
    """
    bus = PostgresListenBus(dsn)
    await bus.start()
    set_bus(bus)
    return bus
