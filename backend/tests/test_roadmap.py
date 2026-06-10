from datetime import date
import uuid

import pytest

import importlib
import httpx

from app.database import get_session
from app.main import app
from app.models import FixVersionOverride, Milestone


class FakeScalars:
    def __init__(self, items):
        self._items = items

    def all(self):
        return list(self._items)

    def __iter__(self):
        return iter(self._items)


class FakeResult:
    def __init__(self, items):
        self._items = items

    def scalars(self):
        return FakeScalars(self._items)


class FakeSession:
    def __init__(self, overrides=None, milestones=None, dependencies=None):
        self._overrides = overrides or []
        self._milestones = milestones or []
        self._dependencies = dependencies or []

    async def execute(self, _stmt):
        # Dispatch on the queried table rather than call order — the roadmap
        # endpoint runs several DB queries (fix-version overrides, manual
        # dependency overrides, milestones) and their order/count can change.
        table = str(_stmt.compile().statement.get_final_froms()[0].name)
        if table == "fix_version_overrides":
            items = list(self._overrides)
        elif table == "milestones":
            items = list(self._milestones)
        elif table == "dependency_overrides":
            items = list(self._dependencies)
        else:
            items = []
        params = _stmt.compile().params
        dashboard_id = params.get("dashboard_id_1")
        if dashboard_id:
            items = [item for item in items if str(getattr(item, "dashboard_id", None)) == str(dashboard_id)]
        return FakeResult(items)


@pytest.mark.asyncio
async def test_roadmap_filters_and_sort(client, monkeypatch):
    roadmap_module = importlib.import_module("app.routers.roadmap")
    async def fake_get_jira_token(_db, _user):
        return {"access_token": "x", "cloud_id": "y", "resource_url": "https://example.atlassian.net"}

    monkeypatch.setattr(roadmap_module, "get_jira_token", fake_get_jira_token)

    async def fake_fetch_projects(_token):
        return [{"key": "GPO", "name": "GPO"}]

    async def fake_fetch_versions(_token, _project):
        return [
            {"id": "1", "name": "Release A", "startDate": "2025-12-01", "releaseDate": "2026-02-01"},
            {"id": "2", "name": "Release B", "startDate": "2025-10-01", "releaseDate": "2026-01-20"},
            {"id": "3", "name": "Release C", "startDate": "2026-07-01", "releaseDate": "2026-08-01"},
        ]

    jql_calls = []
    jql_total_calls = []

    async def fake_search_issues(_token, jql, _fields=None, **_kwargs):
        jql_calls.append(jql)
        if "issuetype = Epic" in jql:
            return [
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
        if "issuetype in (Epic, Story, Task, Bug)" in jql:
            return [
                {
                    "id": "e1",
                    "key": "GPO-1",
                    "fields": {
                        "fixVersions": [{"id": "1"}],
                        "status": {"name": "Done", "statusCategory": {"key": "done"}},
                        "issuetype": {"name": "Epic"},
                    },
                },
                {
                    "id": "s0",
                    "key": "GPO-0",
                    "fields": {
                        "fixVersions": [{"id": "1"}],
                        "status": {"name": "Done - Released", "statusCategory": {"key": "done"}},
                        "issuetype": {"name": "Task"},
                    },
                },
                {
                    "id": "s1",
                    "key": "GPO-2",
                    "fields": {
                        "fixVersions": [{"id": "1"}],
                        "status": {"name": "Done", "statusCategory": {"key": "done"}},
                        "issuetype": {"name": "Story"},
                    },
                },
                {
                    "id": "s2",
                    "key": "GPO-3",
                    "fields": {
                        "fixVersions": [{"id": "1"}],
                        "status": {"name": "Closed", "statusCategory": {"key": "done"}},
                        "issuetype": {"name": "Bug"},
                    },
                },
            ]
        return []

    # Regression test: progress counts epic children + direct (non-epic,
    # parentless) items, excludes Closed, and supports multiple Done variants.
    # Children are queried via `parent in (...)`; direct items via
    # `fixVersion = ... AND parent is EMPTY`. Epics themselves are not counted.
    async def fake_search_issues_total(_token, jql):
        jql_total_calls.append(jql)
        has_status_filter = "status in (" in jql
        is_done = "\"Done\"" in jql  # done_clause lists "Done", "Done - Released"
        if "parent in (" in jql:  # epic-children rollup
            if not has_status_filter:
                return 3  # total children
            return 2 if is_done else 1  # done / in-progress children
        if "parent is EMPTY" in jql:  # direct non-epic items
            if not has_status_filter:
                return 3  # total direct
            return 1  # done / in-progress direct
        return 0

    async def fake_fetch_statuses(_token):
        return [
            {"name": "Done", "category": "done"},
            {"name": "Done - Released", "category": "done"},
            {"name": "Closed", "category": "done"},
            {"name": "In Progress", "category": "indeterminate"},
        ]

    monkeypatch.setattr(roadmap_module, "fetch_projects", fake_fetch_projects)
    monkeypatch.setattr(roadmap_module, "fetch_versions", fake_fetch_versions)
    monkeypatch.setattr(roadmap_module, "search_issues", fake_search_issues)
    monkeypatch.setattr(roadmap_module, "search_issues_total", fake_search_issues_total)
    monkeypatch.setattr(roadmap_module, "fetch_statuses", fake_fetch_statuses)

    dashboard_id = uuid.UUID("00000000-0000-0000-0000-000000000001")
    override = FixVersionOverride(
        fix_version_id="1",
        uat_start=date(2026, 2, 5),
        uat_end=date(2026, 2, 6),
        live_start=None,
        live_end=None,
        dashboard_id=dashboard_id,
    )
    milestone = Milestone(
        label="Launch",
        date=date(2026, 3, 1),
        color="#22c55e",
        project_scope=None,
        show_label=True,
        dashboard_id=dashboard_id,
    )

    async def override_session():
        yield FakeSession([override], [milestone])

    app.dependency_overrides[get_session] = override_session

    response = await client.get(
        "/api/roadmap",
        params={
            "projects[]": "GPO",
            "fixVersions[]": "1",
            "components[]": "Core",
            "increment_start": "2026-01-19",
            "increment_end": "2026-06-30",
            "dashboard_id": str(dashboard_id),
        },
    )

    app.dependency_overrides.clear()

    assert response.status_code == 200
    payload = response.json()

    assert [item["id"] for item in payload["fixVersions"]] == ["1"]
    assert payload["fixVersions"][0]["uatStart"] == "2026-02-05"
    assert payload["fixVersions"][0]["uatEnd"] == "2026-02-06"
    assert payload["fixVersions"][0]["progressTotal"] == 6
    assert payload["fixVersions"][0]["progressDone"] == 3
    assert payload["milestones"][0]["label"] == "Launch"
    assert any("component in" in jql and "issuetype = Epic" in jql for jql in jql_calls)
    assert any("component in" in jql for jql in jql_total_calls)
    assert any("fixVersion" in jql for jql in jql_total_calls)
    assert any("status in" in jql for jql in jql_total_calls)
    assert all("status != \"Closed\"" in jql for jql in jql_total_calls)


@pytest.mark.asyncio
async def test_progress_includes_epics_children_direct_and_excludes_closed(client, monkeypatch):
    roadmap_module = importlib.import_module("app.routers.roadmap")

    async def fake_get_jira_token(_db, _user):
        return {"access_token": "x", "cloud_id": "y", "resource_url": "https://example.atlassian.net"}

    monkeypatch.setattr(roadmap_module, "get_jira_token", fake_get_jira_token)

    async def fake_fetch_projects(_token):
        return [{"key": "GPO", "name": "GPO"}]

    async def fake_fetch_versions(_token, _project):
        return [
            {"id": "17773", "name": "IP10 - The Sweep - BYO", "startDate": "2025-10-01", "releaseDate": "2026-01-19"},
        ]

    async def fake_search_issues(_token, jql, _fields=None, **_kwargs):
        # Only the Epic search needs to return epics so we can build epic keys.
        if "issuetype = Epic" in jql:
            return [
                {
                    "id": "e1",
                    "key": "GPO-6335",
                    "fields": {
                        "summary": "IP10 - Bugs Jan",
                        "created": "2026-01-10",
                        "duedate": "2026-02-10",
                        "fixVersions": [{"id": "17773"}],
                        "status": {"name": "In Progress", "statusCategory": {"key": "indeterminate"}},
                    },
                },
                {
                    "id": "e2",
                    "key": "GPO-6296",
                    "fields": {
                        "summary": "Sweep Foundation",
                        "created": "2026-01-11",
                        "duedate": "2026-02-11",
                        "fixVersions": [{"id": "17773"}],
                        "status": {"name": "In Progress", "statusCategory": {"key": "indeterminate"}},
                    },
                },
            ]
        return []

    jql_total_calls = []

    async def fake_search_issues_total(_token, jql):
        jql_total_calls.append(jql)
        # Epics are excluded from the rollup; total = children + direct.
        # children=4, direct=2 -> total 6; done children=2, done direct=1 -> 3.
        has_status_filter = "status in (" in jql
        is_done = "\"Done\"" in jql
        if "parent in (" in jql:  # epic-children rollup
            if not has_status_filter:
                return 4  # total children
            return 2 if is_done else 1  # done / in-progress children
        if "parent is EMPTY" in jql:  # direct non-epic items
            if not has_status_filter:
                return 2  # total direct
            return 1  # done / in-progress direct
        return 0

    async def fake_fetch_statuses(_token):
        # /rest/api/3/status returns one row per status *definition* across
        # every workflow, so names recur. Include duplicates here to lock in the
        # de-dupe in roadmap.py — without it the `status in (...)` clause would
        # repeat each name and balloon the JQL (Jira then 500s).
        return [
            {"name": "Done", "category": "done"},
            {"name": "Done", "category": "done"},
            {"name": "Done - Released", "category": "done"},
            {"name": "Done - Toggled", "category": "done"},
            {"name": "Closed", "category": "done"},
            {"name": "In Progress", "category": "indeterminate"},
            {"name": "In Progress", "category": "indeterminate"},
            {"name": "in progress", "category": "indeterminate"},
        ]

    monkeypatch.setattr(roadmap_module, "fetch_projects", fake_fetch_projects)
    monkeypatch.setattr(roadmap_module, "fetch_versions", fake_fetch_versions)
    monkeypatch.setattr(roadmap_module, "search_issues", fake_search_issues)
    monkeypatch.setattr(roadmap_module, "search_issues_total", fake_search_issues_total)
    monkeypatch.setattr(roadmap_module, "fetch_statuses", fake_fetch_statuses)

    async def override_session():
        yield FakeSession([], [])

    app.dependency_overrides[get_session] = override_session

    response = await client.get(
        "/api/roadmap",
        params={
            "projects[]": "GPO",
            "increment_start": "2026-01-19",
            "increment_end": "2026-06-30",
        },
    )
    app.dependency_overrides.clear()

    assert response.status_code == 200
    payload = response.json()
    assert payload["fixVersions"][0]["progressTotal"] == 6
    assert payload["fixVersions"][0]["progressDone"] == 3
    assert any("fixVersion = \"IP10 - The Sweep - BYO\"" in jql for jql in jql_total_calls)
    assert all("status != \"Closed\"" in jql for jql in jql_total_calls)

    # Duplicate status definitions must be collapsed before they reach the
    # `status in (...)` clause, otherwise the JQL balloons and Jira 500s.
    status_in_jqls = [jql for jql in jql_total_calls if "status in (" in jql]
    assert status_in_jqls
    for jql in status_in_jqls:
        clause = jql.split("status in (", 1)[1].split(")", 1)[0]
        names = [name.strip().strip('"') for name in clause.split(",")]
        assert len(names) == len({name.lower() for name in names}), jql


@pytest.mark.asyncio
async def test_roadmap_returns_401_for_unauthorized(client, monkeypatch):
    roadmap_module = importlib.import_module("app.routers.roadmap")

    async def fake_get_jira_token(_db, _user):
        return {"access_token": "x", "cloud_id": "y"}

    monkeypatch.setattr(roadmap_module, "get_jira_token", fake_get_jira_token)

    async def fake_fetch_projects(_token):
        request = httpx.Request("GET", "https://api.atlassian.com")
        response = httpx.Response(401, request=request)
        raise httpx.HTTPStatusError("unauthorized", request=request, response=response)

    monkeypatch.setattr(roadmap_module, "fetch_projects", fake_fetch_projects)

    response = await client.get(
        "/api/roadmap",
        params={
            "projects[]": "GPO",
            "increment_start": "2026-01-19",
            "increment_end": "2026-06-30",
        },
    )

    assert response.status_code == 401


def test_within_range_overlap_semantics():
    from app.routers.roadmap import within_range

    inc_start = date(2026, 1, 19)
    inc_end = date(2026, 6, 30)

    # Fully inside the window.
    assert within_range(date(2026, 2, 1), date(2026, 3, 1), inc_start, inc_end)

    # Starts before window, ends inside it (overlap).
    assert within_range(date(2025, 10, 1), date(2026, 2, 1), inc_start, inc_end)

    # Spans the whole window (starts before, ends after).
    assert within_range(date(2025, 10, 1), date(2026, 8, 1), inc_start, inc_end)

    # Starts inside, ends beyond the window (the original bug case).
    assert within_range(date(2026, 3, 1), date(2026, 9, 1), inc_start, inc_end)

    # Ends exactly on inc_start (boundary inclusive).
    assert within_range(date(2025, 10, 1), date(2026, 1, 19), inc_start, inc_end)

    # Starts exactly on inc_end (boundary inclusive).
    assert within_range(date(2026, 6, 30), date(2026, 7, 15), inc_start, inc_end)

    # Entirely before the window — excluded.
    assert not within_range(date(2025, 1, 1), date(2026, 1, 18), inc_start, inc_end)

    # Entirely after the window — excluded.
    assert not within_range(date(2026, 7, 1), date(2026, 8, 1), inc_start, inc_end)

    # No end date — excluded regardless.
    assert not within_range(date(2026, 2, 1), None, inc_start, inc_end)

    # No start date — falls back to end for effective_start.
    assert within_range(None, date(2026, 2, 1), inc_start, inc_end)

    # No start date, end before window — excluded.
    assert not within_range(None, date(2026, 1, 18), inc_start, inc_end)
