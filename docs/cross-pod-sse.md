# Cross-pod SSE — current design and swap-to-Redis playbook

## Status

**Active design** — Postgres `LISTEN/NOTIFY`.
This document records why that choice was made and what would trigger
moving to Redis Pub/Sub.

## Why we needed cross-pod SSE

The live cross-user sync feature pushes `panel.updated` events over a
Server-Sent Events stream so co-editors see each other's saves without
polling. The original implementation kept its subscriber registry in
module-level state (`dict[slug, set[Queue]]` in `events_bus.py`). That
worked because `api_replicas` defaulted to 1 — but if anyone ever scaled
the backend horizontally, two users on different pods would silently
stop syncing. No error, no log line.

This was fixed by introducing the Postgres bus. We can now run >1 backend pod
without losing live sync.

## Architecture

Two fanout layers, deliberately separated:

```
       ┌────────────────────────────────────────────────────────┐
       │ Pod A                                                  │
       │                                                        │
       │   HTTP PUT /panels/.../content                         │
       │           │                                            │
       │           ▼                                            │
       │   bus.publish(slug, "panel.updated", {...})            │
       │       │                                                │
       │       ├─►  local fanout: dict[slug, set[Queue]]   ────┐│
       │       │    (same-pod tabs see the event immediately) ││
       │       │                                              ││
       │       └─►  put_nowait on outbound queue              ││
       │            (HTTP response returns here — no DB wait) ││
       │                                                       ││
       │   [background drain task]                            ▼│
       │       │                                                │
       │       ▼                                                │
       │   NOTIFY dashboard_events, '{"slug":...,"origin":...}' │
       │           │                                            │
       └───────────┼────────────────────────────────────────────┘
                   │
                   ▼
           ╔════════════════╗
           ║   PostgreSQL   ║    (single hop, sub-millisecond)
           ╚════════════════╝
                   │
       ┌───────────┼────────────────────────────────────────────┐
       │ Pod B     │                                            │
       │           ▼                                            │
       │   LISTEN dashboard_events  (one long-lived asyncpg     │
       │           │                  connection per pod)       │
       │           ▼                                            │
       │   origin == self  →  skip (already delivered)          │
       │   origin != self  →  local fanout                      │
       │           │                                            │
       │           ▼                                            │
       │   each EventSource gets its message                    │
       └────────────────────────────────────────────────────────┘
```

**Layer 1 — within a pod.** `_LocalFanout` in `events_bus.py` owns the
`dict[slug, set[Queue]]`. Every connected EventSource has its own bounded
queue (`_QUEUE_MAXSIZE = 64`). A slow client gets dropped events rather
than back-pressuring publishers.

**Layer 2 — between pods.** `PostgresListenBus` opens *one* dedicated
`asyncpg` connection per pod, runs `LISTEN dashboard_events` on it, and
queues a `NOTIFY` envelope on every `publish()`. The HTTP request handler
returns as soon as the local queues have the message — the actual NOTIFY
is issued by a background drain task off the request path, so editor
saves are never blocked on the cross-pod hop. The outbound queue is
bounded (`_OUTBOUND_MAXSIZE = 1024`, ~1 s of buffering); overflow drops
with a log line, same philosophy as the per-subscriber bound.

**Self-NOTIFY suppression.** Each bus stamps outbound envelopes with a
per-instance `origin` UUID. asyncpg's LISTEN callback fires for the
pod's own NOTIFYs too, so the listener checks `origin == self` and
skips local re-delivery — the publish-path fanout already populated
the local queues, and re-delivering would cause subscribers to refetch
the panel twice. Cross-pod events always have a different origin and
fan out normally.

## Why Postgres, not Redis (today)

We already have Postgres as a hard dependency. Adding Redis would mean a
second backing service to monitor, patch, and reason about during
incidents — for a feature whose payloads are ~150 bytes and whose peak
volume is "a few co-editors typing into the same dashboard." The
specific benefits Redis would bring (throughput, payload size, isolation
from DB load) don't bind for us at current or near-future scale.

The bus is abstracted (`EventBus` protocol) so swapping transports is a
~50-line change, not an architectural redesign. We can postpone the Redis
introduction until a concrete trigger fires.

## When to swap to Redis

Move when any one of these is true. Don't pre-empt them.

1. **Payload growth.** Events need to carry panel content or other data
   that pushes the envelope past ~1 KB. The Postgres NOTIFY hard cap is
   8000 bytes; we currently reject at 7500 bytes (see `_MAX_PAYLOAD_BYTES`).
   If a feature wants richer events to avoid the receiver-refetch
   round-trip, this is the trigger.
2. **NOTIFY queue pressure.** Surface
   `pg_notification_queue_usage()` in diagnostics and watch it climb at
   peak. Sustained >20% means slow listeners are accumulating queued
   notifies on the Postgres side and you're approaching the point where
   slow SSE consumers can affect ordinary DB writes.
3. **Replica count.** With ~dozens of API pods, each holding a dedicated
   `LISTEN` connection, the share of the Postgres connection budget
   spent on SSE listeners becomes non-trivial. Redis Pub/Sub subscribers
   are cheaper per-pod.
4. **Second-consumer integrations.** If we want to fan SSE events out
   to anything *other* than the API pods (a worker, an analytics tap, a
   CDC sink), Redis handles multi-subscriber Pub/Sub cleanly while
   adding more `LISTEN`ers to Postgres compounds (2).
5. **Multi-region.** Postgres logical replication does not carry
   `NOTIFY`. If a region split ever lands, the NOTIFY topology breaks
   before Redis would.

## Swap playbook (Redis)

Order matters: the goal is zero-downtime cutover with no event drops.

### Phase 0 — measurement (before any code change)
1. Add `pg_notification_queue_usage()` to the diagnostics log line in
   `app/diagnostics.py`. Run for a week. Confirm whichever trigger above
   is actually firing — don't migrate on a hunch.

### Phase 1 — infra
2. Add a Redis (ElastiCache or equivalent) module to the platform
   Terraform root. One node, no replicas needed for Pub/Sub. Output the
   endpoint into the same `kubernetes_secret` projection used elsewhere
   (`terraform-platform-secrets-contract`).
3. Add `DT_REDIS_URL` to `backend/app/settings.py` and the workload's
   env var contract. Empty string = "use the existing Postgres bus."

### Phase 2 — code
4. Implement `RedisPubSubBus(EventBus)` in `app/events_bus.py`
   alongside the existing `PostgresListenBus`. Same protocol — `start`,
   `stop`, `subscribe`, `unsubscribe`, `publish`, `subscriber_counts`.
   The local fanout (`_LocalFanout`) is reused as-is. Use
   `redis.asyncio` (the `redis-py` package, already widely deployed).
5. In `main.lifespan`, branch on `settings.redis_url`:
   - Empty → install `PostgresListenBus` (current behaviour).
   - Set → install `RedisPubSubBus`.

   Keep this branch — don't delete the Postgres path yet.

### Phase 3 — dual-publish cutover (optional, recommended)
6. Add a transient `DualPublishBus(EventBus)` that holds both a Postgres
   and a Redis transport, publishes through both, and subscribes via
   Redis only (so receivers get a single copy). Deploy with this
   enabled. Pods on the new build deliver via Redis; if anything goes
   wrong, flip a feature flag to fall back to Postgres.
7. After ~1 week of clean operation: switch lifespan to install only
   `RedisPubSubBus` and drop `DualPublishBus` + `PostgresListenBus`.

### Phase 4 — cleanup
8. Delete `PostgresListenBus`, `PG_CHANNEL`, the NOTIFY-payload byte cap
   check, and the related tests.
9. Update this document — move "Postgres" into a *historical* section
   and promote Redis to *current design*. Future-you will thank you.

## Operational notes for the current Postgres bus

- The `LISTEN` connection is *not* drawn from the SQLAlchemy pool. It's
  a dedicated `asyncpg.connect()` owned by `PostgresListenBus` for the
  lifetime of the pod. Confirm pool budget headroom: every pod consumes
  `pool_size + 1` Postgres connections.
- The LISTEN connection's health is checked two ways:
  - **Fast path:** asyncpg's `add_termination_listener` fires when the
    read loop notices the socket has closed (FIN/RST/EOF). The handler
    nulls `_conn` so the next probe tick reconnects immediately.
  - **Slow path:** `_reconnect_loop` runs `SELECT 1` every
    `_PROBE_INTERVAL_SECS` (5 s) under a `_PROBE_TIMEOUT_SECS` (5 s)
    timeout. This catches *half-open* sockets where the peer is gone
    but TCP hasn't noticed — common after a NAT timeout or silent
    failover. Without this probe, a viewer-only pod (no publish
    traffic → no `execute()` calls) could lose cross-pod updates
    until the OS TCP keepalive fired, which defaults to 2 hours on Linux.
  Either failure mode reconnects with capped exponential backoff
  (1 s → 30 s). Events during the disconnect window are lost — the
  frontend treats SSE as best-effort and refetches on EventSource reconnect.
- `subscriber_counts()` in diagnostics reports *this pod's* local
  subscribers only. There is no global count under the LISTEN model
  without an extra round-trip — accept that the metric is per-pod.
- The `dashboard_events` channel name is a Postgres identifier and a
  test guards its validity (`test_pg_channel_name_is_a_valid_postgres_identifier`).
  Don't rename it without updating the test.

## Related code

- `backend/app/events_bus.py` — bus abstraction, `InProcessBus`,
  `PostgresListenBus`, module-level `get_bus()` / `set_bus()` /
  `install_postgres_bus()`.
- `backend/app/events.py` — thin facade preserving the legacy
  `subscribe`/`unsubscribe`/`publish`/`format_sse` surface.
- `backend/app/main.py` — `lifespan` installs the Postgres bus and
  stops it on shutdown.
- `backend/app/diagnostics.py` — reads `get_bus().subscriber_counts()`
  every 30s.
- `backend/tests/test_events.py` — facade behaviour against `InProcessBus`.
- `backend/tests/test_events_bus.py` — bus-level coverage; live
  end-to-end gated on `DT_DATABASE_URL_LIVE`.
