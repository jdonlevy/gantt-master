"""Regression guards for the roadmap Jira fan-out.

In prod the backend pod was OOMKilled because /api/roadmap fanned out one
asyncio Task per Done story (the diagnostic counter reached `tasks=1442`)
and one Task per fix version on a second unbounded gather. The fix
restructures both sites to a queue + fixed worker count, shares a single
httpx.AsyncClient across the changelog batch, and slims the changelog
cache to just the two derived dates.

These tests cover the contract — not the implementation shape — so they
remain valid if the worker pool is later replaced with another bounded
primitive (e.g. anyio task group with a capacity limiter).
"""

import asyncio
import importlib
import uuid

import httpx
import pytest

from app.database import get_session
from app.main import app


@pytest.fixture(autouse=True)
def _reset_changelog_cache():
    roadmap = importlib.import_module("app.routers.roadmap")
    roadmap._changelog_cache.clear()
    yield
    roadmap._changelog_cache.clear()


@pytest.mark.asyncio
async def test_cached_story_changelog_dates_caches_dates_not_raw_histories(monkeypatch):
    """Fix C: the cache must hold the derived (start, end) tuple, not the
    full histories list. Storing raw histories was the dominant contributor
    to warm-cache RSS — a busy story's history can be hundreds of KB and
    the cap of 2000 entries meant the cache alone could account for
    hundreds of MB.
    """
    roadmap = importlib.import_module("app.routers.roadmap")

    histories = [
        {
            "created": "2026-01-05T10:00:00.000+0000",
            "items": [
                {"field": "status", "toString": "In Progress"},
            ],
        },
        {
            "created": "2026-01-10T12:00:00.000+0000",
            "items": [
                {"field": "resolution", "toString": "Done"},
            ],
        },
    ]

    async def fake_fetch(_token, _issue_key, *, client=None):
        return histories

    monkeypatch.setattr(roadmap, "fetch_issue_changelog", fake_fetch)

    token = {"access_token": "x", "cloud_id": "y"}
    indeterminate = frozenset({"in progress"})

    dates = await roadmap._cached_story_changelog_dates(
        token, "GPO-1", "2026-01-10T12:00:00", indeterminate
    )

    assert dates == ("2026-01-05T10:00:00.000+0000", "2026-01-10T12:00:00.000+0000")

    cache_key = ("GPO-1", "2026-01-10T12:00:00", indeterminate)
    assert cache_key in roadmap._changelog_cache
    _ts, cached_value = roadmap._changelog_cache[cache_key]
    # The cache must hold the derived 2-tuple, not the raw histories list.
    assert cached_value == dates
    assert isinstance(cached_value, tuple)
    assert len(cached_value) == 2
    # Guard against accidentally caching the histories list itself.
    assert cached_value is not histories
    assert all(not isinstance(v, list) for v in cached_value)


@pytest.mark.asyncio
async def test_cached_story_changelog_dates_skips_cache_when_updated_missing(monkeypatch):
    """Without an `updated` timestamp the cache freshness signal is gone,
    so we must not write an entry (otherwise we'd serve permanently-stale
    data under a null key).
    """
    roadmap = importlib.import_module("app.routers.roadmap")

    async def fake_fetch(_token, _issue_key, *, client=None):
        return []

    monkeypatch.setattr(roadmap, "fetch_issue_changelog", fake_fetch)

    assert roadmap._changelog_cache == {}
    await roadmap._cached_story_changelog_dates(
        {"access_token": "x", "cloud_id": "y"},
        "GPO-1",
        None,
        frozenset({"in progress"}),
    )
    assert roadmap._changelog_cache == {}


@pytest.mark.asyncio
async def test_fetch_issue_changelog_reuses_injected_client(monkeypatch):
    """Fix B: when a client is passed in, fetch_issue_changelog must use it
    and NOT construct a new httpx.AsyncClient. The previous shape opened a
    fresh SSL context + connection pool per call, which is allocation-
    heavy when called in a tight loop.
    """
    jira_client = importlib.import_module("app.jira_client")

    constructions = 0
    original_init = httpx.AsyncClient.__init__

    def counting_init(self, *args, **kwargs):
        nonlocal constructions
        constructions += 1
        return original_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", counting_init)

    class FakeClient:
        def __init__(self):
            self.calls = 0

        async def get(self, _url, headers=None, params=None):
            self.calls += 1
            request = httpx.Request("GET", "https://example.com")
            return httpx.Response(
                200,
                json={"values": [], "isLast": True},
                request=request,
            )

    fake_client = FakeClient()
    token = {"access_token": "x", "cloud_id": "y"}

    before = constructions
    histories = await jira_client.fetch_issue_changelog(
        token, "GPO-1", client=fake_client
    )
    assert histories == []
    assert fake_client.calls == 1
    # The whole point: passing in a client must not construct a new one.
    assert constructions == before


@pytest.mark.asyncio
async def test_fetch_issue_changelog_constructs_client_when_omitted(monkeypatch):
    """Companion to the test above: omit `client` and we should fall back
    to a request-scoped AsyncClient. Keeps the contract for non-batch
    callers intact.
    """
    jira_client = importlib.import_module("app.jira_client")

    constructed = []

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            constructed.append(self)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        async def get(self, _url, headers=None, params=None):
            request = httpx.Request("GET", "https://example.com")
            return httpx.Response(
                200,
                json={"values": [], "isLast": True},
                request=request,
            )

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)

    token = {"access_token": "x", "cloud_id": "y"}
    await jira_client.fetch_issue_changelog(token, "GPO-1")

    assert len(constructed) == 1


# ── Endpoint-level fan-out bounds ───────────────────────────────────────────
# These drive the /api/roadmap endpoint with intentionally many done stories
# and fix versions, and instrument the leaf-most Jira calls to record the
# peak number of concurrent in-flight requests. The contract: peak must
# never exceed the worker-pool sizes (_CHANGELOG_WORKER_COUNT,
# _PROGRESS_WORKER_COUNT) regardless of input size.


class _ConcurrencyTracker:
    """Records the peak number of overlapping ``track()`` contexts.

    Used as ``async with tracker.track(): ...`` inside an instrumented
    fake. Sleeps zero-time on entry to force the scheduler to interleave
    coroutines, so a buggy fan-out actually surfaces overlap rather than
    serialising by accident.
    """

    def __init__(self) -> None:
        self.in_flight = 0
        self.peak = 0
        self.total_calls = 0

    def track(self):  # pragma: no cover — helper
        tracker = self

        class _Ctx:
            async def __aenter__(self):
                tracker.in_flight += 1
                tracker.total_calls += 1
                tracker.peak = max(tracker.peak, tracker.in_flight)
                # Let other coroutines run so genuine concurrency materialises.
                await asyncio.sleep(0)
                return self

            async def __aexit__(self, *_):
                tracker.in_flight -= 1
                return False

        return _Ctx()


def _install_minimal_roadmap_fakes(monkeypatch, *, epics, stories, statuses):
    """Patch out every Jira-touching function used by /api/roadmap with
    inert fakes that just return the supplied fixtures. Returns the
    roadmap module for further per-test patching (e.g. instrumented
    `search_issues_total` / `fetch_issue_changelog`).
    """
    roadmap = importlib.import_module("app.routers.roadmap")

    async def fake_get_jira_token(_db, _user):
        return {"access_token": "x", "cloud_id": "y", "resource_url": "https://ex.atlassian.net"}

    async def fake_fetch_projects(_token):
        return [{"key": "GPO", "name": "GPO"}]

    async def fake_fetch_versions(_token, _project):
        return [
            {
                "id": "1",
                "name": "Release A",
                "startDate": "2025-12-01",
                "releaseDate": "2026-02-01",
            }
        ]

    async def fake_search_issues(_token, jql, _fields=None, **_):
        if "issuetype = Epic" in jql:
            return epics
        if "parent in" in jql:
            return stories
        return []

    async def fake_fetch_statuses(_token):
        return statuses

    async def fake_fetch_components(_token, _project):
        return []

    monkeypatch.setattr(roadmap, "get_jira_token", fake_get_jira_token)
    monkeypatch.setattr(roadmap, "fetch_projects", fake_fetch_projects)
    monkeypatch.setattr(roadmap, "fetch_versions", fake_fetch_versions)
    monkeypatch.setattr(roadmap, "search_issues", fake_search_issues)
    monkeypatch.setattr(roadmap, "fetch_statuses", fake_fetch_statuses)
    monkeypatch.setattr(roadmap, "fetch_components", fake_fetch_components)

    return roadmap


class _NoMilestoneSession:
    """Session stub that returns empty rows for every query the roadmap
    handler issues. Avoids the unrelated Milestone-schema failure that's
    already on main."""

    async def execute(self, _stmt):
        class _Result:
            def scalars(self):
                class _S:
                    def all(self):
                        return []

                    def __iter__(self):
                        return iter([])

                return _S()

        return _Result()


@pytest.mark.asyncio
async def test_changelog_fan_out_is_bounded(client, monkeypatch):
    """Fix A: even with N done stories far exceeding the worker count, the
    number of *concurrent* in-flight fetch_issue_changelog calls must not
    exceed _CHANGELOG_WORKER_COUNT. Previously a Semaphore inside each
    coroutine bounded HTTP concurrency, but asyncio.gather still scheduled
    one live Task per story — driving the in-prod `tasks=1442` spike.
    """
    story_count = 200
    stories = [
        {
            "id": f"s{i}",
            "key": f"GPO-{100 + i}",
            "fields": {
                "summary": f"Story {i}",
                "fixVersions": [{"id": "1"}],
                "status": {"name": "Done", "statusCategory": {"key": "done"}},
                "issuetype": {"name": "Story"},
                "updated": f"2026-01-{(i % 28) + 1:02d}T00:00:00.000+0000",
                "parent": {"key": "GPO-1"},
            },
        }
        for i in range(story_count)
    ]
    epics = [
        {
            "id": "e1",
            "key": "GPO-1",
            "fields": {
                "summary": "Epic One",
                "created": "2026-01-10",
                "duedate": "2026-02-10",
                "fixVersions": [{"id": "1"}],
                "status": {"name": "In Progress", "statusCategory": {"key": "indeterminate"}},
            },
        }
    ]
    statuses = [
        {"name": "Done", "category": "done"},
        {"name": "In Progress", "category": "indeterminate"},
    ]
    roadmap = _install_minimal_roadmap_fakes(
        monkeypatch, epics=epics, stories=stories, statuses=statuses
    )

    async def fake_search_issues_total(_token, _jql):
        return 0

    monkeypatch.setattr(roadmap, "search_issues_total", fake_search_issues_total)

    tracker = _ConcurrencyTracker()

    async def instrumented_fetch_issue_changelog(_token, _issue_key, *, client=None):
        async with tracker.track():
            return []

    monkeypatch.setattr(
        roadmap, "fetch_issue_changelog", instrumented_fetch_issue_changelog
    )

    async def override_session():
        yield _NoMilestoneSession()

    app.dependency_overrides[get_session] = override_session
    try:
        response = await client.get(
            "/api/roadmap",
            params={
                "projects[]": "GPO",
                "increment_start": "2026-01-19",
                "increment_end": "2026-06-30",
            },
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    # Every Done story should have been processed exactly once.
    assert tracker.total_calls == story_count
    # The whole point of the fix: no more than _CHANGELOG_WORKER_COUNT in
    # flight concurrently regardless of input size.
    assert tracker.peak <= roadmap._CHANGELOG_WORKER_COUNT, (
        f"Changelog fan-out peaked at {tracker.peak} concurrent calls; "
        f"expected <= {roadmap._CHANGELOG_WORKER_COUNT}"
    )


@pytest.mark.asyncio
async def test_changelog_batch_uses_single_shared_httpx_client(client, monkeypatch):
    """Fix B: the changelog batch must construct exactly one
    httpx.AsyncClient and pass the same instance to every
    fetch_issue_changelog call. Previously each call instantiated its own
    client (SSL ctx + connection pool churn).
    """
    story_count = 12
    stories = [
        {
            "id": f"s{i}",
            "key": f"GPO-{200 + i}",
            "fields": {
                "summary": f"Story {i}",
                "fixVersions": [{"id": "1"}],
                "status": {"name": "Done", "statusCategory": {"key": "done"}},
                "issuetype": {"name": "Story"},
                "updated": "2026-01-10T00:00:00.000+0000",
                "parent": {"key": "GPO-1"},
            },
        }
        for i in range(story_count)
    ]
    epics = [
        {
            "id": "e1",
            "key": "GPO-1",
            "fields": {
                "summary": "Epic One",
                "created": "2026-01-10",
                "duedate": "2026-02-10",
                "fixVersions": [{"id": "1"}],
                "status": {"name": "In Progress", "statusCategory": {"key": "indeterminate"}},
            },
        }
    ]
    statuses = [
        {"name": "Done", "category": "done"},
        {"name": "In Progress", "category": "indeterminate"},
    ]
    roadmap = _install_minimal_roadmap_fakes(
        monkeypatch, epics=epics, stories=stories, statuses=statuses
    )

    async def fake_search_issues_total(_token, _jql):
        return 0

    monkeypatch.setattr(roadmap, "search_issues_total", fake_search_issues_total)

    clients_seen: list[object] = []

    async def instrumented_fetch_issue_changelog(_token, _issue_key, *, client=None):
        clients_seen.append(client)
        return []

    monkeypatch.setattr(
        roadmap, "fetch_issue_changelog", instrumented_fetch_issue_changelog
    )

    async def override_session():
        yield _NoMilestoneSession()

    app.dependency_overrides[get_session] = override_session
    try:
        response = await client.get(
            "/api/roadmap",
            params={
                "projects[]": "GPO",
                "increment_start": "2026-01-19",
                "increment_end": "2026-06-30",
            },
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert len(clients_seen) == story_count
    # All calls must have received a client (i.e. not None) — confirming the
    # batch creates one and forwards it.
    assert all(c is not None for c in clients_seen), clients_seen
    # And it must be the SAME client for every call in the batch.
    assert len(set(id(c) for c in clients_seen)) == 1


@pytest.mark.asyncio
async def test_progress_fan_out_is_bounded(client, monkeypatch):
    """Fix D: even with many fix versions, the number of *concurrent*
    fetch_progress_counts invocations (proxied by search_issues_total)
    must not exceed _PROGRESS_WORKER_COUNT. Previously the per-fix-version
    gather was unbounded — a 30-fix-version dashboard could schedule 30
    parallel rollups, each firing up to 6 sequential JQL totals.
    """
    fix_version_count = 30
    fix_versions = [
        {
            "id": str(i + 1),
            "name": f"Release {i + 1}",
            "startDate": "2025-12-01",
            "releaseDate": "2026-02-01",
        }
        for i in range(fix_version_count)
    ]
    epics = []
    statuses = [
        {"name": "Done", "category": "done"},
        {"name": "In Progress", "category": "indeterminate"},
    ]
    roadmap = _install_minimal_roadmap_fakes(
        monkeypatch, epics=epics, stories=[], statuses=statuses
    )

    async def fake_fetch_versions(_token, _project):
        return fix_versions

    monkeypatch.setattr(roadmap, "fetch_versions", fake_fetch_versions)

    tracker = _ConcurrencyTracker()

    async def instrumented_search_issues_total(_token, _jql):
        async with tracker.track():
            return 0

    monkeypatch.setattr(
        roadmap, "search_issues_total", instrumented_search_issues_total
    )

    async def override_session():
        yield _NoMilestoneSession()

    app.dependency_overrides[get_session] = override_session
    try:
        response = await client.get(
            "/api/roadmap",
            params={
                "projects[]": "GPO",
                "increment_start": "2026-01-19",
                "increment_end": "2026-06-30",
            },
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    # Each fix version triggers at least 3 totals (direct total / done /
    # in_progress when there are no epic keys), so we expect >= one call
    # per fix version.
    assert tracker.total_calls >= fix_version_count
    assert tracker.peak <= roadmap._PROGRESS_WORKER_COUNT, (
        f"Progress fan-out peaked at {tracker.peak} concurrent calls; "
        f"expected <= {roadmap._PROGRESS_WORKER_COUNT}"
    )
