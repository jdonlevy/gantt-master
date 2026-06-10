import asyncio
import logging
import os
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Dict, List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, Request
import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..dependencies import get_current_user
from ..models import User
from ..users import get_jira_token
from ..database import get_session
from ..jira_client import (
    fetch_components,
    fetch_issue_changelog,
    fetch_projects,
    fetch_statuses,
    fetch_versions,
    search_issues,
    search_issues_total,
)
from ..settings import settings
from ..models import DependencyOverride, FixVersionOverride, Milestone
from ..schemas import (
    ComponentOut,
    DependencyOut,
    FixVersionFilterOut,
    FixVersionOut,
    MetricsIssueOut,
    MetricsResponse,
    MilestoneOut,
    ProjectOut,
    RoadmapResponse,
)

router = APIRouter()
logger = logging.getLogger("uvicorn.error")
LOG_PROGRESS_JQL = os.getenv("LOG_PROGRESS_JQL", "").lower() in ("1", "true", "yes", "on")


# ── Changelog cache ─────────────────────────────────────────────────────────
# Jira Cloud's bulk /search/jql endpoint no longer supports `expand=changelog`
# (see docstring on fetch_issue_changelog), so the only way to read an issue's
# history is one HTTP round-trip per issue. For a large dashboard with N done
# stories, an uncached roadmap fetch is N extra calls — and because the
# dashboard re-fetches on every filter toggle, that cost recurs even when the
# underlying stories haven't changed.
#
# We keep a small process-local cache keyed by (issue_key, fields.updated, the
# frozenset of indeterminate status names) so a story's derived dates are only
# re-computed when the story itself has been touched in Jira or the cluster's
# notion of "in progress" statuses changes. TTL is a backstop against the
# cache growing unbounded in long-running workers; keying by `updated` is the
# actual freshness signal. This is not distributed — each replica caches
# independently — which is acceptable for a POC.
#
# Storing the *derived* (first_in_progress, last_resolution_set) tuple rather
# than the raw histories list keeps each cache entry tiny — a busy story's
# changelog can be hundreds of KB and the cap of 2000 entries meant the cache
# alone could account for hundreds of MB of resident memory. The cached tuple
# is ~tens of bytes per entry.
_CHANGELOG_CACHE_TTL_SECONDS = 600
_CHANGELOG_CACHE_MAX_ENTRIES = 2000
# Bound on concurrent in-flight changelog fetches. Also doubles as a bound on
# how many asyncio Tasks we create for the fan-out — see the worker-pool
# block in the roadmap handler.
_CHANGELOG_WORKER_COUNT = 5
# Bound on concurrent fix-version progress fetches (each runs up to 6
# sequential JQL totals internally). Same fan-out shape as the changelog
# pool above.
_PROGRESS_WORKER_COUNT = 5
_ChangelogDates = tuple[Optional[str], Optional[str]]
_ChangelogCacheKey = tuple[str, str, frozenset]
_changelog_cache: Dict[_ChangelogCacheKey, tuple[float, _ChangelogDates]] = {}


def _prune_changelog_cache(now: float) -> None:
    if len(_changelog_cache) <= _CHANGELOG_CACHE_MAX_ENTRIES:
        # Cheap TTL sweep: drop expired entries when we're under the size cap.
        expired = [
            k for k, (ts, _) in _changelog_cache.items()
            if now - ts > _CHANGELOG_CACHE_TTL_SECONDS
        ]
        for k in expired:
            _changelog_cache.pop(k, None)
        return
    # Hard cap exceeded — drop oldest entries until we're under the limit.
    ordered = sorted(_changelog_cache.items(), key=lambda kv: kv[1][0])
    for k, _ in ordered[: len(_changelog_cache) - _CHANGELOG_CACHE_MAX_ENTRIES]:
        _changelog_cache.pop(k, None)


def _extract_changelog_dates(
    histories: List[Dict], indeterminate_status_names: frozenset
) -> _ChangelogDates:
    """Reduce a Jira changelog history list to (first_in_progress, last_resolution_set).

    Histories come back newest-first by default; sort ascending so a single
    pass gives us the FIRST in-progress transition and the LATEST resolution
    set event. An empty `toString` on a `resolution` item means the resolution
    was CLEARED (story reopened) — we only want set-to-a-value events.
    """
    first_in_progress: Optional[str] = None
    last_resolution_set: Optional[str] = None
    for history in sorted(histories, key=lambda h: h.get("created") or ""):
        created = history.get("created")
        for item in history.get("items") or []:
            field = (item.get("field") or "").lower()
            if (
                field == "status"
                and first_in_progress is None
                and indeterminate_status_names
            ):
                to_name = (item.get("toString") or "").strip().lower()
                if to_name in indeterminate_status_names:
                    first_in_progress = created
            elif field == "resolution":
                to_string = (item.get("toString") or "").strip()
                if to_string:
                    last_resolution_set = created
    return first_in_progress, last_resolution_set


async def _cached_story_changelog_dates(
    token: Dict,
    issue_key: str,
    updated: Optional[str],
    indeterminate_status_names: frozenset,
    *,
    client: Optional[httpx.AsyncClient] = None,
) -> _ChangelogDates:
    """Resolve (first_in_progress, last_resolution_set) for one story.

    Wraps fetch_issue_changelog with a (key, updated, status-set) cache. The
    `updated` timestamp is the freshness signal — when Jira bumps it the
    cache misses and we re-fetch. When `updated` is missing we skip the
    cache entirely to avoid serving permanently-stale data under a null key.
    `client` is forwarded to fetch_issue_changelog so a caller-shared
    AsyncClient is reused across the batch.
    """
    import time  # local import — only used by the cache path

    if not updated:
        histories = await fetch_issue_changelog(token, issue_key, client=client)
        return _extract_changelog_dates(histories, indeterminate_status_names)
    cache_key: _ChangelogCacheKey = (issue_key, updated, indeterminate_status_names)
    now = time.monotonic()
    cached = _changelog_cache.get(cache_key)
    if cached is not None:
        ts, dates = cached
        if now - ts <= _CHANGELOG_CACHE_TTL_SECONDS:
            return dates
    histories = await fetch_issue_changelog(token, issue_key, client=client)
    dates = _extract_changelog_dates(histories, indeterminate_status_names)
    _changelog_cache[cache_key] = (now, dates)
    _prune_changelog_cache(now)
    return dates


def log_progress(message: str, *args) -> None:
    if not LOG_PROGRESS_JQL:
        return
    logger.info(message, *args)


def parse_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value).date()
    except ValueError:
        return None


def parse_uuid(value: str | None) -> uuid.UUID | None:
    if not value:
        return None
    try:
        return uuid.UUID(value)
    except ValueError:
        return None


def within_range(start: date | None, end: date | None, increment_start: date, increment_end: date) -> bool:
    if not end:
        return False
    # Include any fixversion that overlaps the increment window, not just those
    # whose end date falls within it. A version that starts before increment_end
    # and ends after increment_start overlaps the window.
    effective_start = start or end
    return effective_start <= increment_end and end >= increment_start


def jql_list(values: List[str]) -> str:
    return ", ".join(f"\"{value.replace('\"', '\\\"')}\"" for value in values)


def _epic_status_category(status_field: dict | None) -> str | None:
    """Extract Jira's statusCategory key ("new" | "indeterminate" | "done") from
    an issue's status field. Returned as-is so the frontend can decide when to
    force the "Done = blue" colour regardless of the schedule-based status."""
    if not status_field or not isinstance(status_field, dict):
        return None
    category = status_field.get("statusCategory")
    if isinstance(category, dict):
        return category.get("key")
    return None


def _is_story_closed(story: dict) -> bool:
    status = story.get("status") or {}
    name = (status.get("name") or "").strip().lower()
    return name == "closed"


def _is_story_done(story: dict) -> bool:
    status = story.get("status") or {}
    category = status.get("statusCategory") or {}
    return category.get("key") == "done"


def _count_open_stories(stories: list[dict]) -> int:
    """Total story count for epic-level progress, excluding Closed — matches
    the exclusion used by the fix-version progress rollup."""
    return sum(1 for story in stories if not _is_story_closed(story))


def _count_done_stories(stories: list[dict]) -> int:
    """Done (statusCategory == 'done') stories excluding Closed."""
    return sum(
        1 for story in stories if _is_story_done(story) and not _is_story_closed(story)
    )


@router.get("/projects", response_model=List[ProjectOut])
async def list_projects(
    db: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
):
    token = await get_jira_token(db, user)
    try:
        projects = await fetch_projects(token)
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        if status in (401, 403):
            raise HTTPException(status_code=401, detail="Not authenticated") from exc
        logger.error(
            "Jira request failed: %s %s -> %s",
            exc.request.method,
            exc.request.url,
            exc.response.text,
        )
        raise HTTPException(
            status_code=status,
            detail=f"{exc.response.text} (url: {exc.request.url})",
        ) from exc
    return [ProjectOut(**project) for project in projects]


@router.get("/fix-versions", response_model=List[FixVersionFilterOut])
async def list_fix_versions(
    projects: List[str] = Query(alias="projects[]"),
    increment_start: str = Query(alias="increment_start"),
    increment_end: str = Query(alias="increment_end"),
    db: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
):
    token = await get_jira_token(db, user)
    inc_start = parse_date(increment_start) or date.today()
    inc_end = parse_date(increment_end) or date.today()
    versions_out: List[FixVersionFilterOut] = []
    seen = set()

    for project in projects:
        try:
            versions = await fetch_versions(token, project)
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if status in (401, 403):
                raise HTTPException(status_code=401, detail="Not authenticated") from exc
            raise HTTPException(status_code=status, detail=exc.response.text) from exc
        for version in versions:
            start_date = parse_date(version.get("startDate"))
            release_date = parse_date(version.get("releaseDate"))
            if not within_range(start_date, release_date, inc_start, inc_end):
                continue
            version_id = str(version.get("id"))
            if version_id in seen:
                continue
            seen.add(version_id)
            versions_out.append(
                FixVersionFilterOut(
                    id=version_id,
                    projectKey=project,
                    name=version.get("name"),
                    release=version.get("releaseDate"),
                    released=version.get("released"),
                    archived=version.get("archived"),
                )
            )

    versions_out.sort(key=lambda item: parse_date(item.release) or date.max)
    return versions_out


@router.get("/components", response_model=List[ComponentOut])
async def list_components(
    projects: List[str] = Query(alias="projects[]"),
    db: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
):
    token = await get_jira_token(db, user)
    components_out: List[ComponentOut] = []
    seen = set()

    for project in projects:
        try:
            components = await fetch_components(token, project)
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if status in (401, 403):
                raise HTTPException(status_code=401, detail="Not authenticated") from exc
            raise HTTPException(status_code=502, detail="Failed to fetch Jira components.") from exc
        for component in components:
            component_id = component.get("id")
            if component_id in seen:
                continue
            seen.add(component_id)
            components_out.append(ComponentOut(**component))

    components_out.sort(key=lambda item: item.name.lower())
    return components_out


@router.get("/roadmap", response_model=RoadmapResponse)
async def get_roadmap(
    projects: List[str] = Query(alias="projects[]"),
    fix_versions_filter: List[str] = Query(default=[], alias="fixVersions[]"),
    components: List[str] = Query(default=[], alias="components[]"),
    dashboard_id: str | None = Query(default=None, alias="dashboard_id"),
    increment_start: str = Query(alias="increment_start"),
    increment_end: str = Query(alias="increment_end"),
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
):
    token = await get_jira_token(session, user)
    inc_start = parse_date(increment_start) or date.today()
    inc_end = parse_date(increment_end) or date.today()
    dashboard_uuid = parse_uuid(dashboard_id)

    try:
        all_projects = await fetch_projects(token)
        project_rows = [ProjectOut(**project) for project in all_projects if project["key"] in projects]

        fix_versions = []
        for project in projects:
            versions = await fetch_versions(token, project)
            for version in versions:
                start_date = parse_date(version.get("startDate"))
                release_date = parse_date(version.get("releaseDate"))
                if not within_range(start_date, release_date, inc_start, inc_end):
                    continue
                fix_versions.append(
                    {
                        "id": str(version.get("id")),
                        "projectKey": project,
                        "name": version.get("name"),
                        "start": version.get("startDate"),
                        "release": version.get("releaseDate"),
                        "released": version.get("released"),
                        "archived": version.get("archived"),
                    }
                )
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        if status in (401, 403):
            raise HTTPException(status_code=401, detail="Not authenticated") from exc
        logger.error(
            "Jira request failed: %s %s -> %s",
            exc.request.method,
            exc.request.url,
            exc.response.text,
        )
        raise HTTPException(
            status_code=status,
            detail=f"{exc.response.text} (url: {exc.request.url})",
        ) from exc

    if fix_versions_filter:
        allowed = set(fix_versions_filter)
        fix_versions = [item for item in fix_versions if item["id"] in allowed or item["name"] in allowed]

    if not fix_versions:
        return RoadmapResponse(
            projects=project_rows,
            fixVersions=[],
            milestones=[],
            dependencies=[],
            updatedAt=datetime.now(timezone.utc).isoformat(),
        )

    # Sort fix versions by start date if set, otherwise fall back to release
    # date. Keeps unscheduled items in a sensible spot rather than clumping.
    def _fix_sort_key(item: Dict) -> date:
        start = parse_date(item.get("start"))
        if start:
            return start
        return parse_date(item.get("release")) or date.max

    fix_versions.sort(key=_fix_sort_key)

    fix_version_ids = [fv["id"] for fv in fix_versions]
    fix_version_names = [fv["name"] for fv in fix_versions if fv.get("name")]
    components = [value for value in components if value and value.lower() != "all components"]
    component_clause = f" AND component in ({jql_list(components)})" if components else ""
    fix_version_jql = jql_list(fix_version_names) if fix_version_names else ", ".join(fix_version_ids)

    try:
        epics = await search_issues(
            token,
            jql=f"project in ({', '.join(projects)}) AND issuetype = Epic AND fixVersion in ({fix_version_jql}){component_clause}",
            fields=["summary", "fixVersions", "customfield_10749", "customfield_10776", "created", "duedate", "status", "issuelinks"],
        )
        progress_issues = []
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        if status in (401, 403):
            raise HTTPException(status_code=401, detail="Not authenticated") from exc
        logger.error(
            "Jira request failed: %s %s -> %s",
            exc.request.method,
            exc.request.url,
            exc.response.text,
        )
        raise HTTPException(
            status_code=status,
            detail=f"{exc.response.text} (url: {exc.request.url})",
        ) from exc

    epic_map = {}
    for epic in epics:
        epic_map[epic["id"]] = {
            "id": epic["id"],
            "key": epic["key"],
            "summary": epic["fields"].get("summary"),
            "start": epic["fields"].get("customfield_10749") or epic["fields"].get("created"),
            "end": epic["fields"].get("customfield_10776") or epic["fields"].get("duedate"),
            "status": epic["fields"].get("status"),
            "stories": [],
            "fixVersions": [str(fv["id"]) for fv in epic["fields"].get("fixVersions", [])],
        }

    if epic_map:
        epic_keys = ", ".join([epic["key"] for epic in epics])
        try:
            stories = await search_issues(
                token,
                # `parent in (...)` is Atlassian's current JQL for querying
                # child issues of a set of epics. The older `"Epic Link" in (...)`
                # still works today but is on Atlassian's deprecation list
                # (see: upcoming-changes-epic-link-replaced-with-parent).
                jql=f"parent in ({epic_keys}){component_clause}",
                # `parent` is where team-managed Jira projects store the story's
                # epic link; `customfield_10014` is the legacy "Epic Link" custom
                # field used by company-managed projects. Request both so the
                # same code path works across both project styles.
                # `statuscategorychangedate` is Jira's auto-maintained timestamp
                # of the last time the issue changed status category — for
                # In Progress / QA / Done stories this is effectively "when
                # work started" and is a much better "start" than `created`.
                # `updated` is requested so the changelog cache
                # (_cached_story_changelog_dates) can key on it for freshness
                # and avoid re-fetching changelogs for unchanged issues.
                fields=[
                    "summary",
                    "created",
                    "updated",
                    "duedate",
                    "parent",
                    "customfield_10014",
                    "status",
                    "statuscategorychangedate",
                    "resolutiondate",
                    "issuelinks",
                ],
            )
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if status in (401, 403):
                raise HTTPException(status_code=401, detail="Not authenticated") from exc
            raise HTTPException(status_code=status, detail=exc.response.text) from exc
    else:
        stories = []

    epic_key_lookup = {epic["key"]: epic["id"] for epic in epics}

    def _story_end_date(created: Optional[str], duedate: Optional[str]) -> Optional[str]:
        """Return a story's end date for the Gantt.

        Stories don't always have a Jira `duedate` set, which would otherwise
        leave the bar with no right-hand edge. When there's no due date we
        default the end to the start + 1 day so every story renders as a
        visible single-day bar.
        """
        if duedate:
            return duedate
        if not created:
            return None
        # Jira's `created` is a full ISO datetime (e.g. "2025-11-05T13:49:..."),
        # take just the date portion to compute start + 1 day.
        try:
            start_date = date.fromisoformat(created[:10])
        except ValueError:
            return None
        return (start_date + timedelta(days=1)).isoformat()

    def _story_epic_key(story: Dict) -> Optional[str]:
        """Return a story's parent epic key.

        Team-managed Jira projects put the relationship on `parent`;
        company-managed projects use `customfield_10014` (legacy Epic Link).
        Prefer parent, fall back to the custom field.
        """
        fields = story.get("fields") or {}
        parent = fields.get("parent") or {}
        parent_key = parent.get("key")
        if parent_key:
            return parent_key
        return fields.get("customfield_10014")

    # Release date per fix version — used as a fallback anchor for To Do
    # stories when their epic has no end date set.
    fix_end_lookup: Dict[str, Optional[str]] = {
        fv["id"]: fv.get("release") for fv in fix_versions
    }

    # Build the set of Jira status NAMES whose category is "indeterminate"
    # (e.g. "In Progress", "In Dev", "In QA"). We use this to identify the
    # first time a Done story transitioned into "actively being worked on",
    # from its changelog. Status names are compared case-insensitively.
    try:
        _all_statuses = await fetch_statuses(token)
    except httpx.HTTPStatusError:
        _all_statuses = []
    indeterminate_status_names = {
        (s.get("name") or "").strip().lower()
        for s in _all_statuses
        if s.get("category") == "indeterminate"
    }

    # For Done stories we want two things from the changelog, extracted in
    # one pass:
    #   1. First transition into an "indeterminate" status (In Progress / In
    #      Dev / In QA, etc.) — used as the bar's START. Jira's
    #      `statuscategorychangedate` only records the LAST category
    #      transition (move to Done), so it's useless as a start date here.
    #   2. Most recent Resolution-field change to a non-null value — used as
    #      the bar's END. Mirrors what shows in the Jira activity log
    #      ("updated the Resolution: None -> Done 13 March 2026 at 14:51")
    #      so the bar ends when the story actually wrapped up, not when the
    #      status category last flipped.
    #
    # Costs one extra API call per Done story; we run those calls through a
    # fixed-size worker pool (see below) so that a dashboard with thousands
    # of Done stories doesn't fan out to thousands of live asyncio Tasks.
    indeterminate_status_names_set = frozenset(indeterminate_status_names)

    async def _story_changelog_dates(
        story: Dict, http_client: Optional[httpx.AsyncClient]
    ) -> tuple[str, Optional[str], Optional[str]]:
        """Return (story_id, first_in_progress_date, last_resolution_set_date).

        Either date may be None when the corresponding event isn't present in
        the changelog — the caller falls back to other Jira fields in that
        case.
        """
        issue_key = story.get("key")
        if not issue_key:
            return story["id"], None, None
        updated = story["fields"].get("updated")
        try:
            first_in_progress, last_resolution_set = (
                await _cached_story_changelog_dates(
                    token,
                    issue_key,
                    updated,
                    indeterminate_status_names_set,
                    client=http_client,
                )
            )
        except Exception:  # noqa: BLE001 — changelog is best-effort
            logger.exception(
                "Failed to fetch changelog for story %s; falling back.", issue_key
            )
            return story["id"], None, None
        return story["id"], first_in_progress, last_resolution_set

    # Closed stories are hidden from the Gantt entirely (consistent with the
    # progress-count exclusion). Don't waste a changelog API call on them.
    done_stories = [
        story
        for story in stories
        if _epic_status_category(story["fields"].get("status")) == "done"
        and not _is_story_closed(story["fields"])
    ]
    done_story_first_progress: Dict[str, Optional[str]] = {}
    done_story_resolution_set: Dict[str, Optional[str]] = {}
    if done_stories:
        # Worker-pool fan-out, not asyncio.gather over a generator.
        #
        # gather(*(coro for ... in N)) eagerly schedules N live Task objects
        # before any of them run. A bounding `Semaphore` (the previous shape)
        # only throttles the *HTTP call* — the parked tasks all sit in
        # memory, each holding a closure over its story dict. On a dashboard
        # with ~1.4k done stories that was driving the diagnostics counter
        # to `tasks=1442` and contributing to the 1Gi OOMKill.
        #
        # With a queue + fixed worker count we only ever have
        # `_CHANGELOG_WORKER_COUNT` live Tasks regardless of input size.
        queue: asyncio.Queue = asyncio.Queue()
        for story in done_stories:
            queue.put_nowait(story)

        async def _changelog_worker(http_client: httpx.AsyncClient) -> None:
            while True:
                try:
                    story = queue.get_nowait()
                except asyncio.QueueEmpty:
                    return
                try:
                    story_id, first_progress, resolution_set = (
                        await _story_changelog_dates(story, http_client)
                    )
                    done_story_first_progress[story_id] = first_progress
                    done_story_resolution_set[story_id] = resolution_set
                finally:
                    queue.task_done()

        worker_count = min(_CHANGELOG_WORKER_COUNT, len(done_stories))
        try:
            # One shared AsyncClient across every changelog call in this
            # batch — no per-call SSL context / connection pool churn.
            async with httpx.AsyncClient(timeout=30) as http_client:
                await asyncio.gather(
                    *(_changelog_worker(http_client) for _ in range(worker_count))
                )
        except Exception:  # noqa: BLE001
            logger.exception(
                "Failed to resolve changelog dates for done stories"
            )

    def _story_end_cap(epic_id: str) -> Optional[str]:
        """Upper-bound date for a story bar.

        Done stories sometimes resolve after their parent epic's scheduled end
        (or the fix version release). Letting the bar extend past the parent
        makes the chart look wrong — the parent has "finished" but a child is
        still hanging off the end. Cap to the parent's end so a late-resolving
        story collapses onto the parent's closing date.

        Preference: epic.end, falling back to the earliest available release
        date across the epic's fix versions. Returns None when neither is set,
        in which case the caller should leave the story dates untouched.
        """
        epic = epic_map.get(epic_id, {})
        cap = epic.get("end")
        if cap:
            return cap
        # Use the EARLIEST non-null release across the epic's fix versions —
        # Jira doesn't guarantee `fixVersions` ordering, so picking the first
        # non-null entry could silently extend a story past an earlier
        # committed release date.
        candidate_ends: list[date] = []
        for fv_id in epic.get("fixVersions", []):
            fv_end = fix_end_lookup.get(fv_id)
            if not fv_end:
                continue
            try:
                candidate_ends.append(date.fromisoformat(fv_end[:10]))
            except ValueError:
                continue
        if candidate_ends:
            return min(candidate_ends).isoformat()
        return None

    def _apply_end_cap(
        start: Optional[str], end: Optional[str], cap: Optional[str]
    ) -> tuple[Optional[str], Optional[str]]:
        """Clamp start/end so the bar never extends past ``cap``.

        If the end is past the cap, pull it back. If the start is ALSO past
        the cap (story resolved entirely after the parent finished) collapse
        both to the cap so the bar becomes a single-day marker sitting on the
        parent's end date. We keep things as plain YYYY-MM-DD strings — the
        frontend treats start/end as dates and doesn't care about the
        timestamp portion.
        """
        if not cap:
            return start, end
        try:
            cap_date = date.fromisoformat(cap[:10])
        except ValueError:
            return start, end
        cap_iso = cap_date.isoformat()

        def _past_cap(value: Optional[str]) -> bool:
            if not value:
                return False
            try:
                return date.fromisoformat(value[:10]) > cap_date
            except ValueError:
                return False

        if _past_cap(end):
            end = cap_iso
        if _past_cap(start):
            start = cap_iso
            end = cap_iso
        return start, end

    def _todo_story_dates(epic_id: str) -> tuple[Optional[str], Optional[str]]:
        """Start/end for a To Do story.

        To Do stories don't have a meaningful "start" date — they haven't been
        picked up yet. To visualise remaining work pressure, pin them to the
        end of their container: start = anchor - 1 day, end = anchor. Anchor
        is the parent epic's end date, falling back to the fix version's
        release date, falling back to None so the caller can decide what to
        do with unscheduled stories.
        """
        epic = epic_map.get(epic_id, {})
        anchor = epic.get("end")
        if not anchor:
            # Earliest non-null release across the epic's fix versions. Jira
            # doesn't guarantee `fixVersions` ordering, so picking the first
            # non-null entry would risk under-anchoring To Do stories past a
            # later release when an earlier one exists.
            candidate_anchors: list[date] = []
            for fv_id in epic.get("fixVersions", []):
                fv_end = fix_end_lookup.get(fv_id)
                if not fv_end:
                    continue
                try:
                    candidate_anchors.append(date.fromisoformat(fv_end[:10]))
                except ValueError:
                    continue
            if candidate_anchors:
                anchor = min(candidate_anchors).isoformat()
        if not anchor:
            return None, None
        try:
            anchor_date = date.fromisoformat(anchor[:10])
        except ValueError:
            return None, None
        start = (anchor_date - timedelta(days=1)).isoformat()
        end = anchor_date.isoformat()
        return start, end

    for story in stories:
        epic_key = _story_epic_key(story)
        epic_id = epic_key_lookup.get(epic_key)
        if not epic_id:
            continue
        # Hide Closed stories from the Gantt. In this org's Jira workflow
        # "Closed" means cancelled / won't fix — not completed work — so it
        # shouldn't render as a bar. This also matches the existing exclusion
        # baked into the epic/fix-version progress counts.
        if _is_story_closed(story["fields"]):
            continue
        created = story["fields"].get("created")
        duedate = story["fields"].get("duedate")
        resolutiondate = story["fields"].get("resolutiondate")
        status_category = _epic_status_category(story["fields"].get("status"))
        status_change = story["fields"].get("statuscategorychangedate")

        if status_category == "done":
            # Done: span from "first moved to In Progress" → "Resolution last
            # set to Done" (both harvested from the changelog above). This
            # mirrors what the user sees in Jira's activity log so the bar
            # ends on the same timestamp as the "updated the Resolution"
            # event. Fallback order if changelog data is missing:
            #   end: resolution-change → resolutiondate field → last status
            #        category change → start + 1 day.
            first_progress = done_story_first_progress.get(story["id"])
            resolution_set = done_story_resolution_set.get(story["id"])
            start = first_progress or status_change or created
            end = (
                resolution_set
                or resolutiondate
                or status_change
                or _story_end_date(start, duedate)
            )
            # Guarantee a visible bar if start and end collapsed to the same
            # day — fall back to the +1 day default end.
            if start and end:
                try:
                    if date.fromisoformat(end[:10]) <= date.fromisoformat(start[:10]):
                        end = _story_end_date(start, None)
                except ValueError:
                    pass
            # Cap to the parent epic's end (falling back to fix version
            # release). If the story resolved after the parent finished, we'd
            # rather show the bar stuck on the parent's end than floating past
            # it — the parent's timeline is the commitment, not the story's.
            start, end = _apply_end_cap(start, end, _story_end_cap(epic_id))
        elif status_category == "indeterminate":
            # In Progress / QA: statuscategorychangedate is the moment the
            # story left the "To Do" category, which is the dev start date
            # for stories that haven't been reopened.
            start = status_change or created
            end = _story_end_date(start, duedate)
        else:
            # To Do: pin to the end of the epic/fix version so the bar
            # visualises outstanding work against the deadline.
            start, end = _todo_story_dates(epic_id)
            if start is None:
                # No epic/fix anchor available — keep the old behaviour so
                # the story still renders somewhere rather than vanishing.
                start = created
                end = _story_end_date(created, duedate)

        status_field = story["fields"].get("status") or {}
        epic_map[epic_id]["stories"].append(
            {
                "id": story["id"],
                "key": story["key"],
                "summary": story["fields"].get("summary"),
                "start": start,
                "end": end,
                # Collapse Jira's nested status object down to the category key
                # ("new" | "indeterminate" | "done") — that's all the frontend
                # needs to colour the bar.
                "status": status_category,
                # Full status name (e.g. "In Progress", "Done - Released") for
                # the hover tooltip — users want to see the specific Jira
                # workflow state, not just the rolled-up category.
                "statusName": status_field.get("name") if isinstance(status_field, dict) else None,
            }
        )

    # Epic-level progress counts.
    #
    # The `stories` list above is filtered by the dashboard's component filter,
    # which is right for DISPLAY (stories on a component-filtered board should
    # only show that component's work). But it gives the wrong answer for the
    # epic's % complete: a story that's not in the current component but IS
    # under this epic should still reduce the epic's completion. This matches
    # the fix-version rollup convention at fetch_progress_counts — that also
    # counts children via `"Epic Link" in (...)` without the component filter.
    #
    # If there IS no component filter, the `stories` list already contains
    # everything we need and we skip the extra Jira call.
    progress_source = stories
    if epic_map and component_clause:
        try:
            progress_source = await search_issues(
                token,
                jql=f"\"Epic Link\" in ({epic_keys})",
                # Request both parent (team-managed) and customfield_10014
                # (company-managed) so _story_epic_key below can resolve the
                # epic link on either project style.
                fields=["parent", "customfield_10014", "status"],
            )
        except httpx.HTTPStatusError as exc:
            # If this fails we fall back to the component-filtered stories —
            # the counts will under-report but the page still loads.
            logger.warning(
                "Failed to fetch unfiltered epic children for progress counts: %s",
                exc.response.text,
            )
            progress_source = stories

    epic_progress: dict[str, dict[str, int]] = {
        epic_id: {"done": 0, "total": 0} for epic_id in epic_map
    }
    for story in progress_source:
        epic_key = _story_epic_key(story)
        epic_id = epic_key_lookup.get(epic_key)
        if not epic_id:
            continue
        status_field = story["fields"].get("status") or {}
        status_name = (status_field.get("name") or "").strip().lower()
        if status_name == "closed":
            continue
        epic_progress[epic_id]["total"] += 1
        category = (status_field.get("statusCategory") or {}).get("key")
        if category == "done":
            epic_progress[epic_id]["done"] += 1

    for epic_id, counts in epic_progress.items():
        epic_map[epic_id]["progressDone"] = counts["done"]
        epic_map[epic_id]["progressTotal"] = counts["total"]

    issue_ids = {epic["id"] for epic in epics}
    issue_ids.update({story["id"] for story in stories})
    issue_key_by_id = {epic["id"]: epic["key"] for epic in epics}
    issue_key_by_id.update({story["id"]: story["key"] for story in stories})

    dependencies: List[DependencyOut] = []
    dependency_seen = set()

    def add_dependency(from_id: str, to_id: str, link_type: str) -> None:
        if from_id not in issue_ids or to_id not in issue_ids:
            return
        key = (from_id, to_id, link_type)
        if key in dependency_seen:
            return
        dependency_seen.add(key)
        dependencies.append(
            DependencyOut(
                fromId=from_id,
                toId=to_id,
                type=link_type,
                fromKey=issue_key_by_id.get(from_id),
                toKey=issue_key_by_id.get(to_id),
                source="jira",
            )
        )

    for issue in [*epics, *stories]:
        issue_id = issue["id"]
        for link in issue.get("fields", {}).get("issuelinks", []) or []:
            link_type = link.get("type") or {}
            outward_desc = (link_type.get("outward") or "").lower()
            inward_desc = (link_type.get("inward") or "").lower()
            outward_issue = link.get("outwardIssue")
            inward_issue = link.get("inwardIssue")

            if outward_issue and "block" in outward_desc:
                add_dependency(issue_id, outward_issue.get("id"), "blocks")
            if inward_issue and "block" in inward_desc:
                add_dependency(inward_issue.get("id"), issue_id, "blocks")

    try:
        override_query = select(FixVersionOverride)
        if dashboard_uuid:
            override_query = override_query.where(FixVersionOverride.dashboard_id == dashboard_uuid)
        overrides = await session.execute(override_query)
        override_map = {row.fix_version_id: row for row in overrides.scalars()}
    except Exception:
        override_map = {}

    # Manual dependencies — layered on top of whatever Jira returned. Scoped
    # to the dashboard so unrelated dashboards don't leak dependencies into
    # each other. Only include ones whose endpoints are still in the visible
    # roadmap so we don't render dangling arrows.
    visible_fix_ids = {str(fv["id"]) for fv in fix_versions}
    visible_epic_ids = set(epic_map.keys())

    def _node_visible(node_id: str, node_type: str) -> bool:
        if node_type == "fix":
            return node_id in visible_fix_ids
        if node_type == "epic":
            return node_id in visible_epic_ids
        return False

    try:
        manual_query = select(DependencyOverride)
        if dashboard_uuid:
            manual_query = manual_query.where(
                DependencyOverride.dashboard_id == dashboard_uuid
            )
        manual_rows = (await session.execute(manual_query)).scalars().all()
        for manual in manual_rows:
            if not _node_visible(manual.from_id, manual.from_type):
                continue
            if not _node_visible(manual.to_id, manual.to_type):
                continue
            key = (manual.from_id, manual.to_id, "blocks")
            if key in dependency_seen:
                continue
            dependency_seen.add(key)
            dependencies.append(
                DependencyOut(
                    fromId=manual.from_id,
                    toId=manual.to_id,
                    type="blocks",
                    source="manual",
                    id=str(manual.id),
                )
            )
    except Exception:
        # Log but don't re-raise — the Jira-sourced dependencies above are
        # still valid, and we'd rather ship a partial graph than 500 the whole
        # roadmap view if the manual-deps table has a transient issue.
        logger.exception("Failed to load manual DependencyOverride rows")

    base_url = token.get("resource_url")
    try:
        statuses = await fetch_statuses(token)
        # /rest/api/3/status returns one entry per status *definition* across
        # every workflow in the instance, so the same status name (e.g. "In
        # Progress") recurs dozens of times. De-dupe case-insensitively (keeping
        # first-seen casing) before these names go into a `status in (...)`
        # clause — otherwise the JQL balloons to hundreds of repeated values and
        # Jira 500s on the oversized query.
        done_statuses: List[str] = []
        in_progress_statuses: List[str] = []
        seen_done: set[str] = set()
        seen_in_progress: set[str] = set()
        for status in statuses:
            name = status.get("name") or ""
            if not name or name.lower() == "closed":
                continue
            category = status.get("category")
            if category == "done" and name.lower() not in seen_done:
                seen_done.add(name.lower())
                done_statuses.append(name)
            elif category == "indeterminate" and name.lower() not in seen_in_progress:
                seen_in_progress.add(name.lower())
                in_progress_statuses.append(name)
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        if status in (401, 403):
            raise HTTPException(status_code=401, detail="Not authenticated") from exc
        logger.error(
            "Jira request failed: %s %s -> %s",
            exc.request.method,
            exc.request.url,
            exc.response.text,
        )
        raise HTTPException(
            status_code=status,
            detail=f"{exc.response.text} (url: {exc.request.url})",
        ) from exc
    progress_by_fix = {
        fix_id: {"total": 0, "done": 0, "in_progress": 0} for fix_id in fix_version_ids
    }
    component_progress_clause = f" AND component in ({jql_list(components)})" if components else ""

    epic_keys_by_fix: dict[str, list[str]] = {}
    for fix in fix_versions:
        epic_keys_by_fix[fix["id"]] = [
            epic["key"] for epic in epic_map.values() if fix["id"] in epic["fixVersions"]
        ]

    async def fetch_progress_counts(fix_version: dict) -> tuple[str, int, int, int]:
        project_key = fix_version.get("projectKey")
        project_clause = f'project = "{project_key}"' if project_key else f"project in ({', '.join(projects)})"
        fix_id = fix_version.get("id")
        fix_name = fix_version.get("name")
        if fix_name:
            fix_clause = f"fixVersion = {jql_list([fix_name])}"
        else:
            fix_clause = f"fixVersion = {fix_id}"

        if done_statuses:
            done_clause = f"status in ({jql_list(done_statuses)})"
        else:
            done_clause = "statusCategory = Done"

        if in_progress_statuses:
            in_progress_clause = f"status in ({jql_list(in_progress_statuses)})"
        else:
            in_progress_clause = "statusCategory = \"In Progress\""

        epic_keys = epic_keys_by_fix.get(str(fix_id), [])
        total = 0
        done = 0
        in_progress = 0

        if epic_keys:
            epic_key_jql = jql_list(epic_keys)
            # Epics themselves are intentionally excluded from the rollup —
            # we only count their child stories/tasks so the fix-version %
            # reflects delivery work, not the epic container's status.
            # Use `parent in (...)` rather than the deprecated
            # "Epic Link" field so this rollup stays consistent with
            # the story-fetch path above. On team-managed projects
            # the story→epic relationship lives on parent, and Jira
            # is phasing out the "Epic Link" JQL field.
            total_children_jql = (
                f"{project_clause} AND parent in ({epic_key_jql}) AND status != \"Closed\""
            )
            total_children = await search_issues_total(token, total_children_jql)
            total += total_children

            done_children_jql = (
                f"{project_clause} AND parent in ({epic_key_jql}) AND {done_clause} AND status != \"Closed\""
            )
            done_children = await search_issues_total(token, done_children_jql)
            done += done_children

            in_progress_children_jql = (
                f"{project_clause} AND parent in ({epic_key_jql}) AND {in_progress_clause} AND status != \"Closed\""
            )
            in_progress_children = await search_issues_total(token, in_progress_children_jql)
            in_progress += in_progress_children
        else:
            total_children_jql = None
            done_children_jql = None
            in_progress_children_jql = None
            total_children = 0
            done_children = 0
            in_progress_children = 0

        if epic_keys:
            direct_clause = f"{project_clause} AND {fix_clause} AND issuetype != Epic AND parent is EMPTY"
        else:
            direct_clause = f"{project_clause} AND {fix_clause} AND issuetype != Epic"

        total_direct_jql = f"{direct_clause} AND status != \"Closed\"{component_progress_clause}"
        done_direct_jql = f"{direct_clause} AND {done_clause} AND status != \"Closed\"{component_progress_clause}"
        in_progress_direct_jql = (
            f"{direct_clause} AND {in_progress_clause} AND status != \"Closed\"{component_progress_clause}"
        )
        total_direct = await search_issues_total(token, total_direct_jql)
        done_direct = await search_issues_total(token, done_direct_jql)
        in_progress_direct = await search_issues_total(token, in_progress_direct_jql)
        total += total_direct
        done += done_direct
        in_progress += in_progress_direct

        log_progress(
            "Progress JQL fix=%s name=%s totals: children=%s direct=%s done: children=%s direct=%s in_progress: children=%s direct=%s",
            fix_id,
            fix_name,
            total_children,
            total_direct,
            done_children,
            done_direct,
            in_progress_children,
            in_progress_direct,
        )
        if total_children_jql:
            log_progress("Progress JQL fix=%s total_children=%s", fix_id, total_children_jql)
        log_progress("Progress JQL fix=%s total_direct=%s", fix_id, total_direct_jql)
        if done_children_jql:
            log_progress("Progress JQL fix=%s done_children=%s", fix_id, done_children_jql)
        log_progress("Progress JQL fix=%s done_direct=%s", fix_id, done_direct_jql)
        if in_progress_children_jql:
            log_progress("Progress JQL fix=%s in_progress_children=%s", fix_id, in_progress_children_jql)
        log_progress("Progress JQL fix=%s in_progress_direct=%s", fix_id, in_progress_direct_jql)

        return str(fix_id), total, done, in_progress

    # Worker-pool fan-out (see the changelog block above for the rationale).
    # On a busy dashboard `fix_versions` can be 20-30 items; each
    # fetch_progress_counts call internally fires up to 6 sequential JQL
    # totals. The previous shape — gather() over a generator gated by an
    # inner Semaphore — still scheduled one live Task per fix version.
    # A queue + fixed worker count caps Task creation at _PROGRESS_WORKER_COUNT.
    progress_queue: asyncio.Queue = asyncio.Queue()
    for fix in fix_versions:
        progress_queue.put_nowait(fix)
    progress_results: List[tuple[str, int, int, int]] = []
    worker_errors: List[BaseException] = []

    async def _progress_worker() -> None:
        while True:
            try:
                fix = progress_queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            try:
                progress_results.append(await fetch_progress_counts(fix))
            except BaseException as exc:  # noqa: BLE001 — bubble up after join
                worker_errors.append(exc)
            finally:
                progress_queue.task_done()

    progress_worker_count = min(_PROGRESS_WORKER_COUNT, len(fix_versions))
    if progress_worker_count:
        await asyncio.gather(
            *(_progress_worker() for _ in range(progress_worker_count))
        )
    if worker_errors:
        # Preserve the previous behaviour: the first HTTPStatusError is
        # surfaced as a 401 (auth) or its own status; anything else
        # re-raises as-is so the outer handler / FastAPI default kicks in.
        first = worker_errors[0]
        if isinstance(first, httpx.HTTPStatusError):
            status = first.response.status_code
            if status in (401, 403):
                raise HTTPException(status_code=401, detail="Not authenticated") from first
            raise HTTPException(status_code=status, detail=first.response.text) from first
        raise first

    for fix_id, total, done, in_progress in progress_results:
        progress_by_fix[fix_id] = {
            "total": total,
            "done": done,
            "in_progress": in_progress,
        }

    # Sort key used for epics and stories. Items without a start sort to the
    # end so dated work leads. Strings compare ISO-lexicographically, which is
    # the same as chronological for "YYYY-MM-DD..." values.
    def _start_sort_key(item: Dict) -> str:
        return item.get("start") or "9999-12-31"

    # ── Cross-project link collection ─────────────────────────────────────
    # For each fix version, walk every epic + story inside it and collect
    # the keys of linked tickets whose project key differs from the source
    # ticket's. This drives the "external dependencies" exclamation badge on
    # the Gantt bar. Dedupe per fix version + keep the order stable (sorted)
    # so the tooltip reads deterministically.
    def _project_of(issue_key: Optional[str]) -> str:
        if not issue_key or "-" not in issue_key:
            return ""
        return issue_key.split("-", 1)[0]

    external_links_by_fix: Dict[str, set] = {}

    def _collect_external_links(issue: Dict, fix_ids: List[str]) -> None:
        source_project = _project_of(issue.get("key"))
        links = issue.get("fields", {}).get("issuelinks") or []
        for link in links:
            for side in (link.get("outwardIssue"), link.get("inwardIssue")):
                if not side:
                    continue
                target_key = side.get("key")
                if not target_key:
                    continue
                target_project = _project_of(target_key)
                if not target_project or target_project == source_project:
                    continue
                for fix_id in fix_ids:
                    external_links_by_fix.setdefault(fix_id, set()).add(target_key)

    for epic in epics:
        epic_info = epic_map.get(epic["id"])
        if not epic_info:
            continue
        _collect_external_links(epic, epic_info.get("fixVersions") or [])

    for story in stories:
        parent_key = _story_epic_key(story)
        if not parent_key:
            continue
        parent_epic_id = epic_key_lookup.get(parent_key)
        if not parent_epic_id:
            continue
        parent_info = epic_map.get(parent_epic_id)
        if not parent_info:
            continue
        _collect_external_links(story, parent_info.get("fixVersions") or [])

    fix_outputs: List[FixVersionOut] = []
    for fix in fix_versions:
        fix_epics = sorted(
            [
                epic
                for epic in epic_map.values()
                if fix["id"] in epic["fixVersions"]
            ],
            key=_start_sort_key,
        )
        override = override_map.get(fix["id"])
        progress_counts = progress_by_fix.get(
            fix["id"], {"total": 0, "done": 0, "in_progress": 0}
        )
        progress_total = progress_counts["total"]
        progress_done = progress_counts["done"]
        progress_in_progress = progress_counts.get("in_progress", 0)
        fix_url = (
            f"{base_url}/projects/{fix['projectKey']}/versions/{fix['id']}/tab/release-report-all-issues"
            if base_url
            else None
        )
        fix_outputs.append(
            FixVersionOut(
                id=fix["id"],
                projectKey=fix.get("projectKey"),
                name=fix["name"],
                start=fix.get("start"),
                release=fix.get("release"),
                released=fix.get("released"),
                archived=fix.get("archived"),
                url=fix_url,
                progressDone=progress_done,
                progressInProgress=progress_in_progress,
                progressTotal=progress_total,
                uatStart=override.uat_start.isoformat() if override and override.uat_start else None,
                uatEnd=override.uat_end.isoformat() if override and override.uat_end else None,
                liveStart=override.live_start.isoformat() if override and override.live_start else None,
                liveEnd=override.live_end.isoformat() if override and override.live_end else None,
                notes=override.notes if override else None,
                externalLinks=sorted(external_links_by_fix.get(fix["id"], set())),
                epics=[
                    {
                        "id": epic["id"],
                        "key": epic["key"],
                        "summary": epic["summary"],
                        "start": epic.get("start"),
                        "end": epic.get("end"),
                        "url": f"{base_url}/browse/{epic['key']}" if base_url else None,
                        "status": _epic_status_category(epic.get("status")),
                        # Counts are always attached earlier (see the
                        # epic_progress loop) — fall back to 0 defensively so
                        # we never call a helper eagerly here. The helpers
                        # expected full Jira status dicts, but stories in
                        # epic_map now carry just the category key string.
                        "progressDone": epic.get("progressDone", 0),
                        "progressTotal": epic.get("progressTotal", 0),
                        "stories": [
                            {
                                **story,
                                "url": f"{base_url}/browse/{story['key']}" if base_url else None,
                            }
                            for story in sorted(epic.get("stories", []), key=_start_sort_key)
                        ],
                    }
                    for epic in fix_epics
                ],
            )
        )

    try:
        milestone_query = select(Milestone)
        if dashboard_uuid:
            milestone_query = milestone_query.where(Milestone.dashboard_id == dashboard_uuid)
        milestone_rows = await session.execute(milestone_query)
        milestone_outputs = [
            MilestoneOut(
                id=str(item.id),
                label=item.label,
                date=item.date.isoformat(),
                color=item.color,
                projectScope=item.project_scope,
                showLabel=item.show_label,
                dashboardId=str(item.dashboard_id) if item.dashboard_id else None,
            )
            for item in milestone_rows.scalars().all()
        ]
    except Exception:
        milestone_outputs = []

    return RoadmapResponse(
        projects=project_rows,
        fixVersions=fix_outputs,
        milestones=milestone_outputs,
        dependencies=dependencies,
        updatedAt=datetime.now(timezone.utc).isoformat(),
        jiraBaseUrl=token.get("resource_url"),
    )


DEFAULT_METRICS_STATUSES = ["Awaiting Approval", "Done - Released", "Done - Unreleased", "Done"]
DEFAULT_METRICS_DAYS = 14


@router.get("/metrics", response_model=MetricsResponse)
async def get_metrics(
    projects: List[str] = Query(alias="projects[]"),
    statuses: List[str] = Query(default=[], alias="statuses[]"),
    fix_versions: List[str] = Query(default=[], alias="fixVersions[]"),
    days: int = Query(default=DEFAULT_METRICS_DAYS),
    db: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
):
    token = await get_jira_token(db, user)
    resolved_statuses = statuses if statuses else DEFAULT_METRICS_STATUSES
    status_jql = jql_list(resolved_statuses)
    projects_jql = jql_list(projects)
    # Fix version IDs are expected to be numeric strings — safe to pass unquoted
    # in JQL. Anything else gets run through jql_list() so it's properly quoted
    # and escaped, matching how the rest of this router handles JQL fragments.
    # If none are supplied, skip the clause entirely so the endpoint keeps
    # working for dashboards that haven't selected any fix versions.
    fix_version_clause = ""
    if fix_versions:
        fix_versions_jql = (
            ", ".join(fix_versions)
            if all(value.isdigit() for value in fix_versions)
            else jql_list(fix_versions)
        )
        fix_version_clause = f" AND fixVersion in ({fix_versions_jql})"
    jql = (
        f"project in ({projects_jql})"
        f"{fix_version_clause}"
        f" AND status changed to ({status_jql})"
        f" AFTER -{days}d"
        f" ORDER BY updated DESC"
    )
    resource_url = token.get("resource_url", "")
    headers = {"Authorization": f"Bearer {token['access_token']}", "Accept": "application/json"}
    url = f"{settings.jira_base_url}/ex/jira/{token['cloud_id']}/rest/api/3/search/jql"
    params = {"jql": jql, "maxResults": 200, "fields": "summary,status,project"}

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url, headers=headers, params=params)
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail="Jira API error fetching metrics")
        data = resp.json()
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"Network error contacting Jira: {exc}")

    issues = []
    for item in data.get("issues", []):
        fields = item.get("fields", {})
        issues.append(
            MetricsIssueOut(
                key=item["key"],
                summary=fields.get("summary", ""),
                status=fields.get("status", {}).get("name", ""),
                project=fields.get("project", {}).get("key", ""),
                url=f"{resource_url}/browse/{item['key']}",
            )
        )

    return MetricsResponse(count=data.get("total", len(issues)), issues=issues)
