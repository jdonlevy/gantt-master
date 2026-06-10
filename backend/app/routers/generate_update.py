"""
generate_update.py
POST /api/dashboards/{slug}/generate-update

Fetches live Jira data for the dashboard's active fix versions, applies any
saved overrides (UAT dates, target end, version notes), then calls the OpenAI
API to write prose summaries. Returns structured JSON consumed by WeeklyUpdatePanel.
"""
import asyncio
import html
import json
import logging
import os
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_session
from ..dependencies import require_role
from ..jira_client import fetch_versions, search_issues
from ..models import Dashboard, FixVersionOverride, Role, User
from ..users import get_jira_token

router = APIRouter()
logger = logging.getLogger("uvicorn.error")

# Reads OPENAI_API_KEY or DT_OPENAI_API_KEY fallback
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY") or os.getenv("DT_OPENAI_API_KEY", "")

# ── Helpers ────────────────────────────────────────────────────────────────────

def _fmt_date(d) -> Optional[str]:
    """Format a date/str to 'D Mon YYYY' (e.g. '15 Apr 2026').

    Uses d.day instead of strftime("%-d …") — the %-d GNU extension is
    not available on Windows and raises ValueError there.
    """
    if not d:
        return None
    if isinstance(d, str):
        try:
            d = datetime.fromisoformat(d).date()
        except ValueError:
            return d
    try:
        return f"{d.day} {d.strftime('%b %Y')}"
    except Exception:
        return str(d)


def _fmt_updated_human(iso_ts: str, today: date) -> str:
    """Format an ISO Jira timestamp as a human-readable relative phrase
    like 'today', '3 days ago', '2 weeks ago', '5 months ago'.

    Used in the LLM prompt so the model can reason about stale/stuck tickets
    without having to parse raw timestamps.
    """
    if not iso_ts:
        return "unknown"
    try:
        # Jira returns offsets like "+0100"; fromisoformat accepts them in 3.11+
        parsed = datetime.fromisoformat(iso_ts).date()
    except Exception:
        return "unknown"
    days = (today - parsed).days
    if days <= 0:
        return "today"
    if days == 1:
        return "1 day ago"
    if days < 14:
        return f"{days} days ago"
    if days < 60:
        weeks = days // 7
        return f"{weeks} week{'s' if weeks != 1 else ''} ago"
    months = days // 30
    return f"{months} month{'s' if months != 1 else ''} ago"


def _extract_increment(name: str, description: str) -> str:
    """Try to extract an 'IP\d+' increment label from version name or description."""
    for text in (name, description or ""):
        m = re.search(r"\bIP\s*(\d+)\b", text, re.IGNORECASE)
        if m:
            return f"IP{m.group(1)}"
    return ""


# Status name → (display_label, css_class) for common Jira statuses
_STATUS_BADGE_MAP: Dict[str, tuple] = {
    "qa in progress":      ("QA In Progress", "wu-ibadge--uat"),
    "in qa":               ("QA In Progress", "wu-ibadge--uat"),
    "testing":             ("QA In Progress", "wu-ibadge--uat"),
    "uat":                 ("UAT", "wu-ibadge--uat"),
    "code review":         ("Code Review", "wu-ibadge--review"),
    "peer review":         ("Code Review", "wu-ibadge--review"),
    "dev done":            ("Dev Done", "wu-ibadge--devdone"),
    "development done":    ("Dev Done", "wu-ibadge--devdone"),
    "in progress":         ("In Progress", "wu-ibadge--prog"),
    "in development":      ("In Progress", "wu-ibadge--prog"),
    "development":         ("In Progress", "wu-ibadge--prog"),
    "blocked":             ("Blocked", "wu-ibadge--blocked"),
    "impediment":          ("Blocked", "wu-ibadge--blocked"),
    "awaiting approval":   ("Awaiting Approval", "wu-ibadge--await"),
    "awaiting sign off":   ("Awaiting Approval", "wu-ibadge--await"),
    "ready for dev":       ("Ready for Dev", "wu-ibadge--await"),
    "selected for dev":    ("Ready for Dev", "wu-ibadge--await"),
    "to do":               ("To Do", "wu-ibadge--backlog"),
    "backlog":             ("Backlog", "wu-ibadge--backlog"),
    "open":                ("Backlog", "wu-ibadge--backlog"),
    "done":                ("Done", "wu-ibadge--done"),
    "closed":              ("Closed", "wu-ibadge--closed"),
    "released":            ("Released", "wu-ibadge--released"),
    "won't do":            ("Closed", "wu-ibadge--closed"),
    "duplicate":           ("Closed", "wu-ibadge--closed"),
}

# Ordered buckets for grouping statuses into sub-sections
_BUCKET_ORDER = ["uat", "review", "prog", "blocked", "await", "todo", "done"]

def _classify_status(status_name: str) -> str:
    """Map a status name to one of the display buckets."""
    key = status_name.lower()
    if any(k in key for k in ("qa", "uat", "testing", "test")):
        return "uat"
    if any(k in key for k in ("review", "dev done", "development done")):
        return "review"
    if any(k in key for k in ("block", "impediment")):
        return "blocked"
    if any(k in key for k in ("await", "approval", "sign off")):
        return "await"
    if any(k in key for k in ("progress", "development", "in dev")):
        return "prog"
    if any(k in key for k in ("done", "closed", "released", "won't", "duplicate")):
        return "done"
    # fallback: map by status category later
    return "todo"


def _status_badge(status_name: str) -> tuple:
    mapped = _STATUS_BADGE_MAP.get(status_name.lower())
    if mapped:
        return mapped
    return (status_name, "wu-ibadge--prog")


# ── Jira fetching ──────────────────────────────────────────────────────────────

def _escape_jql_string(s: str) -> str:
    """Escape a string for safe use inside a JQL quoted value.

    JQL quoted strings only need backslash and double-quote escaped.
    """
    return s.replace("\\", "\\\\").replace('"', '\\"')


async def _fetch_tickets(token: dict, project_key: str, version_name: str) -> Optional[List[Dict]]:
    """Fetch all non-Epic tickets for a fix version.

    Returns None (not an empty list) on failure so callers can distinguish
    "fetch failed" from "no tickets exist".
    """
    jql = (
        f'project = "{_escape_jql_string(project_key)}" '
        f'AND fixVersion = "{_escape_jql_string(version_name)}" '
        f'AND issuetype != Epic '
        f'ORDER BY updated DESC'
    )
    try:
        issues = await search_issues(
            token, jql,
            fields=["summary", "status", "issuetype", "updated"],
        )
    except Exception as exc:
        logger.warning("Ticket fetch failed for %s / %s: %s", project_key, version_name, exc)
        return None

    result = []
    for issue in issues:
        fields = issue.get("fields", {})
        status = fields.get("status", {})
        status_cat = (status.get("statusCategory") or {}).get("key", "new")
        result.append({
            "key": issue.get("key", ""),
            "summary": fields.get("summary", ""),
            "status_name": status.get("name", ""),
            "status_category": status_cat,  # "new" | "indeterminate" | "done"
            "type": (fields.get("issuetype") or {}).get("name", ""),
            "updated": fields.get("updated", ""),  # ISO timestamp from Jira
        })
    return result


# ── Structured-summary → HTML renderer ────────────────────────────────────────
#
# The LLM returns a structured object per fix version:
#   { intro: str, done: [...], doing: [...], toDo: [...] }
# Each bullet is { workstream: str, text: str, blocked?: bool }.
#
# We render this to safe HTML here on the backend so the frontend can just
# innerHTML the result into a contentEditable container. All LLM-provided
# strings pass through html.escape() to prevent HTML injection — the only
# tags in the output come from this renderer.

_BUCKET_HEADINGS = [("done", "Done"), ("doing", "Doing"), ("toDo", "To Do")]


def _coerce_bullet(raw: Any) -> Optional[Dict[str, Any]]:
    """Normalise a single bullet from the LLM output.

    Accepts either the expected object shape or a bare string (which older /
    off-spec responses sometimes use), and returns a dict with consistent
    keys. Returns None if the bullet has no usable text.
    """
    if isinstance(raw, str):
        text = raw.strip()
        return {"workstream": "", "text": text, "blocked": False} if text else None
    if not isinstance(raw, dict):
        return None
    text = str(raw.get("text") or "").strip()
    if not text:
        return None
    # Normalise "blocked" rather than blindly bool()-ing it. The LLM
    # sometimes returns the string "false" / "no", which `bool()` would
    # treat as truthy (any non-empty string is True) and incorrectly
    # flag the bullet as blocked.
    blocked_raw = raw.get("blocked", False)
    if isinstance(blocked_raw, str):
        blocked = blocked_raw.strip().lower() in {"true", "1", "yes", "on"}
    elif isinstance(blocked_raw, (bool, int, float)):
        blocked = bool(blocked_raw)
    else:
        blocked = False
    return {
        "workstream": str(raw.get("workstream") or "").strip(),
        "text": text,
        "blocked": blocked,
    }


def _render_structured_summary(raw: Any) -> Optional[str]:
    """Convert a structured LLM summary object into HTML.

    Returns None if the payload is empty / malformed so callers can fall back
    to the default summary. The HTML shape is:
        <p class="wu-sum-intro">…</p>
        <p class="wu-sum-head"><strong>Done</strong></p>
        <ul class="wu-sum-list">
          <li><em>Workstream:</em> bullet text <span class="wu-blocked">blocked</span></li>
        </ul>
        …repeat for doing / toDo.
    Empty buckets are omitted entirely.
    """
    if not isinstance(raw, dict):
        return None

    intro = str(raw.get("intro") or "").strip()
    parts: List[str] = []
    if intro:
        parts.append(f'<p class="wu-sum-intro">{html.escape(intro)}</p>')

    for key, heading in _BUCKET_HEADINGS:
        bullets_raw = raw.get(key) or []
        if not isinstance(bullets_raw, list):
            continue
        bullets = [b for b in (_coerce_bullet(x) for x in bullets_raw) if b]
        if not bullets:
            continue
        lis: List[str] = []
        for b in bullets:
            ws = b["workstream"]
            text_html = html.escape(b["text"])
            prefix = f'<em class="wu-sum-ws">{html.escape(ws)}:</em> ' if ws else ""
            blocked = (
                ' <span class="wu-sum-blocked">blocked</span>'
                if b["blocked"]
                else ""
            )
            lis.append(f"<li>{prefix}{text_html}{blocked}</li>")
        parts.append(f'<p class="wu-sum-head"><strong>{heading}</strong></p>')
        parts.append(f'<ul class="wu-sum-list">{"".join(lis)}</ul>')

    if not parts:
        return None
    return "".join(parts)


# ── OpenAI summary generation ──────────────────────────────────────────────────

_CONCISENESS_INSTRUCTIONS = {
    1: "Be VERY BRIEF: 1 sentence intro max, and no more than 2 bullets total across all buckets. Ruthlessly cut anything that isn't critical.",
    2: "Be BRIEF: 1-2 sentence intro, and aim for 1-2 bullets per bucket. Prefer concise groupings over individual bullet points.",
    3: "Use STANDARD length: 1-2 sentence intro, 1-3 bullets per bucket. Group related work where possible.",
    4: "Be DETAILED: 2-3 sentence intro, up to 4 bullets per bucket. Include more granularity on individual workstreams.",
    5: "Be VERY DETAILED: thorough intro, up to 6 bullets per bucket. Include sub-workstream specifics and individual ticket themes.",
}

def _conciseness_instruction(level: int) -> str:
    return _CONCISENESS_INSTRUCTIONS.get(level, _CONCISENESS_INSTRUCTIONS[3])


async def _generate_summaries(sections: List[Dict], conciseness: int = 3) -> Dict[str, str]:
    """
    Call the OpenAI Responses API (gpt-5.4) to generate a prose summary per
    fix version. Returns {version_id: summary_str}. Falls back silently if
    the API key is missing or the call fails.

    Keyed by version ID (not name) so that multi-project dashboards with
    identically-named fix versions don't collide.

    conciseness: 1 = very brief, 3 = standard, 5 = very detailed.
    """
    if not OPENAI_API_KEY:
        logger.info("No OPENAI_API_KEY set — skipping summary generation")
        return {}

    # Build a compact description of each version for the prompt. Every ticket
    # in the fix version is included (done, active, backlog) so the model has
    # full context — no per-bucket caps.
    #
    # Jira's `done` statusCategory includes "Closed", "Won't Do" and "Duplicate",
    # which in this project mean the work was NOT delivered (the ticket was
    # dropped, rejected, or subsumed by another). We tag these explicitly in the
    # per-ticket line so the LLM doesn't describe them as shipped work.
    CLOSED_NOT_DELIVERED = {"closed", "won't do", "duplicate"}

    sections_text = ""
    for s in sections:
        is_released = s.get("_is_released", False)
        version_key = s["id"]  # stable key used in the JSON response
        all_tickets: List[Dict] = s.get("_all_tickets", [])

        ticket_lines = []
        for t in all_tickets:
            status_name = t.get('status_name') or '?'
            status_label = status_name
            if status_name.lower() in CLOSED_NOT_DELIVERED:
                status_label = f"{status_name} (NOT DELIVERED — work was dropped, rejected, or duplicate)"
            ticket_lines.append(
                f"  [{t.get('type') or '?'} | {status_label} | updated {t.get('updated_human') or 'unknown'}] {t.get('summary') or ''}"
            )
        ticket_block = "\n".join(ticket_lines) or "  (no tickets)"

        if is_released:
            sections_text += (
                f"VERSION_ID: {version_key} (name: {s['name']}) [RELEASED on {s.get('releasedDate') or 'unknown date'}]\n"
                f"- All tickets in this fix version ({len(all_tickets)}):\n{ticket_block}\n\n"
            )
        else:
            sections_text += (
                f"VERSION_ID: {version_key} (name: {s['name']}) [IN PROGRESS]\n"
                f"- Target end: {s.get('targetEnd') or 'not set'}\n"
                f"- UAT start: {s.get('uatStart') or 'not set'}\n"
                f"- All tickets in this fix version ({len(all_tickets)}):\n{ticket_block}\n\n"
            )

    instructions = (
        "You are writing a concise fortnightly delivery status update for a software team. "
        "Each fix version below lists every ticket it contains, each tagged with its "
        "type (Story / Task / Bug), status, and when it was last updated.\n"
        "For each fix version, return a structured object with four fields:\n"
        "  intro  — 1-2 short lines (concise) giving an overarching summary of what this fix\n"
        "           version is delivering as a whole: the main features, outcomes, or value to\n"
        "           the business/users. Focus on the WHAT and WHY, not the current status. It\n"
        "           should read like a one-liner an exec could skim to understand the purpose\n"
        "           of this release. Examples of tone: 'Delivers end-to-end production-only\n"
        "           ordering for media sales, including automated fulfilment and reporting.'\n"
        "           or 'Ships the first cut of Digital Fillers — SF integration, order-line\n"
        "           booking, and gAllocate fulfilment.'\n"
        "           Do NOT describe ticket state (in progress / blocked / done) here — the\n"
        "           buckets below carry that. Do NOT mention target or release dates.\n"
        "  done   — array of items for work that has landed / shipped.\n"
        "  doing  — array of items for work actively in progress (including blocked items).\n"
        "  toDo   — array of items for work still in backlog / not yet started.\n"
        "Each array item is an object: { workstream: string, text: string, blocked?: boolean }.\n"
        "  workstream — a short label (1-3 words) grouping the bullet by theme/epic, e.g. "
        "'Report', 'Fulfilment Automation', 'UI enhancements'. Leave empty string if a grouping\n"
        "  label would feel forced.\n"
        "  text — a single short line describing the work (no trailing period needed). Do NOT\n"
        "  include ticket keys or 'Jira' references. Group related tickets into one bullet where\n"
        "  possible (e.g. combine three QA-stage report stories into one 'Report work in QA').\n"
        "  blocked — set to true ONLY if the underlying ticket(s) are in a 'Blocked' status.\n"
        f"{_conciseness_instruction(conciseness)}\n"
        "Omit a bucket entirely (empty array) when there's no genuine content — don't pad.\n"
        "Guidelines:\n"
        "- CRITICAL: Tickets with status 'Closed', 'Won't Do' or 'Duplicate' (tagged 'NOT DELIVERED' in the "
        "data below) represent work that was explicitly NOT addressed — the ticket was dropped, rejected, "
        "or subsumed by another. Silently EXCLUDE these tickets from every bucket: do not put them in done, "
        "do not mention them at all, do not flag them as dropped, do not comment on their non-delivery. "
        "Only tickets with status 'Done' or 'Released' belong in the done bucket.\n"
        "- For RELEASED versions: the intro describes what was delivered; put shipped work under done and "
        "any follow-up work in doing / toDo. No celebratory language. Do not mention ticket counts.\n"
        "- For IN PROGRESS versions: the intro names the overall state; done lists what has already landed "
        "in this version, doing covers in-flight work (flag tickets that haven't been updated in several "
        "weeks as potentially stuck via workstream label, e.g. 'workstream: \"Stale\"'), toDo covers "
        "backlog. Do not mention target or release dates — those are shown separately.\n"
        "- Use direct, confident language. Each 'text' should read naturally to a non-engineer.\n"
        "Respond with ONLY a valid JSON object mapping VERSION_ID → { intro, done, doing, toDo }."
    )

    user_input = (
        f"{sections_text}\n"
        "Respond with ONLY a JSON object mapping VERSION_ID → summary object. Example:\n"
        '{"12345": {"intro": "Delivering X across three workstreams.", '
        '"done": [{"workstream": "Report", "text": "Panel spares shipped"}], '
        '"doing": [{"workstream": "Report", "text": "Excel export in code review"}, '
        '{"workstream": "Additional Scenarios", "text": "Reason-for-order field", "blocked": true}], '
        '"toDo": [{"workstream": "Report", "text": "Prod Only report tests"}]}}'
    )

    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            "https://api.openai.com/v1/responses",
            headers={
                "Authorization": f"Bearer {OPENAI_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": "gpt-5.4",
                "instructions": instructions,
                "input": user_input,
                "text": {"format": {"type": "json_object"}},
            },
        )
        if not resp.is_success:
            raise Exception(f"OpenAI {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
        # output_text is an SDK convenience field; raw HTTP responses may omit it,
        # so fall back to output[].content[].text if absent.
        text = (data.get("output_text") or "").strip()
        if not text:
            chunks: List[str] = []
            for item in data.get("output", []):
                if item.get("type") != "message":
                    continue
                for content in item.get("content", []):
                    if content.get("type") == "output_text":
                        chunks.append(content.get("text", ""))
            text = "".join(chunks).strip()
        if not text:
            raise ValueError("OpenAI response did not include output text")
        return json.loads(text)


# ── Main endpoint ──────────────────────────────────────────────────────────────

@router.post("/dashboards/{slug}/generate-update")
async def generate_update(
    slug: str,
    body: Optional[Dict[str, Any]] = Body(default=None),
    session: AsyncSession = Depends(get_session),
    user: User = Depends(require_role(Role.editor)),
):
    token = await get_jira_token(session, user)

    # 1. Load dashboard and its project filters
    result = await session.execute(select(Dashboard).where(Dashboard.slug == slug))
    dashboard = result.scalar_one_or_none()
    if not dashboard:
        raise HTTPException(status_code=404, detail="Dashboard not found")

    filters: Dict = dashboard.filters_json or {}
    projects: List[str] = filters.get("projects", [])

    # Optional fix-version filter from the caller's current UI state. When the
    # user changes filters without saving defaults, the dashboard record still
    # reflects the stored filters — this body-level override lets the panel
    # regenerate using whatever is currently active in the UI so the AI
    # summaries match what the user sees on screen.
    fix_version_filter: Optional[set[str]] = None
    requested_fix_versions = (body or {}).get("fixVersions") if isinstance(body, dict) else None
    if isinstance(requested_fix_versions, list) and requested_fix_versions:
        fix_version_filter = {str(v) for v in requested_fix_versions}
    # Conciseness: 1 = very brief, 3 = standard, 5 = very detailed
    conciseness: int = int((body or {}).get("conciseness", 3)) if isinstance(body, dict) else 3
    conciseness = max(1, min(5, conciseness))

    # Optional custom "released" window from the UI. When provided, released fix
    # versions are included only if their release date falls within
    # [released_from, released_to]; otherwise the default last-two-weeks window
    # (computed below) applies. Bad dates are ignored so a malformed value never
    # 500s the whole update.
    def _parse_body_date(key: str) -> Optional[date]:
        raw = (body or {}).get(key) if isinstance(body, dict) else None
        if not raw:
            return None
        try:
            return date.fromisoformat(str(raw))
        except ValueError:
            return None

    released_from = _parse_body_date("releasedFrom")
    released_to = _parse_body_date("releasedTo")
    if not projects:
        raise HTTPException(
            status_code=400,
            detail="Dashboard has no projects configured. Add a project in the Filters bar first.",
        )

    # 2. Load fix version overrides for this dashboard (and global ones as fallback)
    ov_res = await session.execute(
        select(FixVersionOverride).where(FixVersionOverride.dashboard_id == dashboard.id)
    )
    overrides: Dict[str, FixVersionOverride] = {
        str(o.fix_version_id): o for o in ov_res.scalars().all()
    }
    global_ov_res = await session.execute(
        select(FixVersionOverride).where(FixVersionOverride.dashboard_id.is_(None))
    )
    global_overrides: Dict[str, FixVersionOverride] = {
        str(o.fix_version_id): o for o in global_ov_res.scalars().all()
    }

    jira_base: str = (token.get("resource_url") or "https://globalradio.atlassian.net").rstrip("/")
    today = date.today()
    # Released-version window: custom range from the UI when supplied, else the
    # default trailing fortnight. window_end bounds the upper edge so a custom
    # "released to" in the past excludes newer releases.
    window_start = released_from or (today - timedelta(days=14))
    window_end = released_to or today

    # 3. Fetch fix versions for each project
    all_versions: List[Dict] = []
    for proj in projects:
        try:
            versions = await fetch_versions(token, proj)
            for v in versions:
                v["_project"] = proj
            all_versions.extend(versions)
        except Exception as exc:
            logger.warning("fetch_versions failed for %s: %s", proj, exc)

    # 4. Process each version concurrently (semaphore = 4 to avoid Jira rate limits)
    sem = asyncio.Semaphore(4)

    async def process_version(v: Dict) -> Optional[Dict[str, Any]]:
        async with sem:
            version_id = str(v.get("id", ""))
            # Skip versions that aren't in the active fix-version filter (if one
            # was supplied). Early-return avoids the expensive _fetch_tickets()
            # call for versions the user has already hidden on the dashboard.
            if fix_version_filter is not None and version_id not in fix_version_filter:
                return None
            version_name: str = v.get("name", "")
            project_key: str = v.get("_project", projects[0])
            is_released: bool = bool(v.get("released", False))
            release_date_str: Optional[str] = v.get("releaseDate")
            description: str = v.get("description") or ""

            # Resolve override (dashboard-level > global)
            ov = overrides.get(version_id) or global_overrides.get(version_id)

            # Target end: override live_end > Jira releaseDate
            target_end: Optional[date] = None
            if ov and ov.live_end:
                target_end = ov.live_end
            elif release_date_str:
                try:
                    target_end = datetime.fromisoformat(release_date_str).date()
                except ValueError:
                    pass

            # For unreleased versions, require both startDate and an end date,
            # with startDate <= today. Versions missing either date are excluded.
            if not is_released:
                if not target_end:
                    return None
                start_date_str: Optional[str] = v.get("startDate")
                if not start_date_str:
                    return None
                try:
                    start_date = datetime.fromisoformat(start_date_str).date()
                    if start_date > today:
                        return None
                except ValueError:
                    return None

            # Released filter: only include if released within the active window
            # (custom range from the UI, or the default trailing fortnight).
            if is_released:
                if not release_date_str:
                    return None
                try:
                    rel_date = datetime.fromisoformat(release_date_str).date()
                except ValueError:
                    return None
                if rel_date < window_start or rel_date > window_end:
                    return None

            # Fetch tickets (excluding epics)
            tickets = await _fetch_tickets(token, project_key, version_name)

            # None means the fetch failed — skip this version rather than silently
            # showing it with zero tickets, which would look like an empty release.
            if tickets is None:
                return None

            # Skip unreleased versions with no tickets at all
            if not tickets and not is_released:
                return None

            # Skip unreleased versions where ALL tickets are still in To Do
            # (i.e., no active development has started) — these are deferred/backlog
            todo_tix = [t for t in tickets if t["status_category"] == "new"]
            active_tix = [t for t in tickets if t["status_category"] == "indeterminate"]
            done_tix = [t for t in tickets if t["status_category"] == "done"]
            # "Delivered" excludes Closed/Won't Do/Duplicate — Jira treats these
            # as statusCategory=done, but they represent work that was
            # dropped, rejected, or subsumed rather than shipped. The
            # frontend-visible Done sub-section, the delivered counts in the
            # default summary, and the "is there anything real to show?" guard
            # below all key off this filtered list so headline numbers match
            # what users actually see.
            CLOSED_NOT_DELIVERED = {"closed", "won't do", "duplicate"}
            delivered_tix = [
                t for t in done_tix
                if t["status_name"].lower() not in CLOSED_NOT_DELIVERED
            ]

            # Skip unreleased versions with no active work AND no actually-
            # delivered tickets. A version that only has dropped/rejected
            # items isn't interesting for a weekly update, and counting those
            # would keep stale versions alive in the panel forever.
            if not is_released and tickets and not active_tix and not delivered_tix:
                return None

            total = len(tickets)
            todo_count = len(todo_tix)

            # Group non-done, non-todo tickets by status name for sub-sections
            by_status: Dict[str, List[Dict]] = {}
            for t in tickets:
                if t["status_category"] in ("indeterminate",):
                    by_status.setdefault(t["status_name"], []).append(t)

            # Build sub-sections by bucket order
            bucket_to_items: Dict[str, List[Dict]] = {b: [] for b in _BUCKET_ORDER}
            for sname, tix in by_status.items():
                bucket = _classify_status(sname)
                for t in tix:
                    label, css = _status_badge(sname)
                    bucket_to_items[bucket].append({
                        "text": t["summary"],
                        "badge": label,
                        "badgeClass": css,
                    })

            sub_sections = []
            bucket_labels = {
                "uat": "In QA",
                "review": "Dev done / code review",
                "prog": "In progress",
                "blocked": "Blocked",
                "await": "Awaiting",
                # "todo" catches indeterminate tickets whose status name is not
                # recognised by _classify_status — show them rather than drop them.
                # The subsection ID uses "unmapped" (not "todo") to avoid colliding
                # with the explicit "Not yet started" section below whose ID is
                # {version_id}-todo.
                "todo": "In progress",
            }
            bucket_id_override = {"todo": "unmapped"}
            for bucket in ["uat", "review", "prog", "blocked", "await", "todo"]:
                items = bucket_to_items[bucket]
                if not items:
                    continue
                shown = items[:10]
                rest = len(items) - 10
                if rest > 0:
                    shown.append({"text": f"+ {rest} more", "badge": "More", "badgeClass": "wu-ibadge--backlog"})
                section_id = bucket_id_override.get(bucket, bucket)
                sub_sections.append({
                    "id": f"{version_id}-{section_id}",
                    "label": f"{bucket_labels[bucket]} ({len(items)})",
                    "items": shown,
                })

            # Not Yet Started sub-section (active versions only) — one row per ticket.
            # done_count is the "delivered" count (excluding dropped/rejected work)
            # used by the fallback summary and the released-version message below,
            # so numbers stay consistent with the Done sub-section.
            done_count = len(delivered_tix)
            if not is_released and todo_count > 0:
                cap = 15
                shown_todos = todo_tix[:cap]
                todo_items = [
                    {"text": t["summary"], "badge": "To Do", "badgeClass": "wu-ibadge--backlog"}
                    for t in shown_todos
                ]
                rest = todo_count - len(shown_todos)
                if rest > 0:
                    todo_items.append({"text": f"+ {rest} more", "badge": "More", "badgeClass": "wu-ibadge--backlog"})
                sub_sections.append({
                    "id": f"{version_id}-todo",
                    "label": f"Not yet started ({todo_count})",
                    "items": todo_items,
                })

            # Done sub-section (active versions only — released sections omit this).
            # Uses the pre-computed delivered_tix so inclusion, counts, and the
            # "+ N more" tail all share a single view of what counts as
            # delivered work.
            if not is_released and delivered_tix:
                cap = 15
                shown_done = delivered_tix[:cap]
                done_items = []
                for t in shown_done:
                    label, css = _status_badge(t["status_name"])
                    done_items.append({
                        "text": t["summary"],
                        "badge": label,
                        "badgeClass": css,
                    })
                rest = len(delivered_tix) - len(shown_done)
                if rest > 0:
                    done_items.append({
                        "text": f"+ {rest} more",
                        "badge": "More",
                        "badgeClass": "wu-ibadge--backlog",
                    })
                sub_sections.append({
                    "id": f"{version_id}-done",
                    "label": f"Done ({len(delivered_tix)})",
                    "items": done_items,
                })

            # Build the section dict — use a sensible per-state default that is
            # overwritten by the AI summary when available.  Released versions must
            # not show "in active development" language.
            if is_released:
                default_summary = (
                    f"{done_count} stories delivered in {version_name}."
                )
            else:
                default_summary = (
                    f"{len(active_tix)} stories in active development, "
                    f"{todo_count} not yet started, {done_count} done "
                    f"({total} total). Target: {_fmt_date(target_end) or 'not set'}."
                )

            # Build a compact list of every ticket in the fix version, enriched
            # with a humanised "updated X ago" string. Fed to the LLM prompt so
            # the model sees full context (done + active + backlog).
            all_tickets_for_prompt = [
                {
                    "summary": t["summary"],
                    "status_name": t["status_name"],
                    "type": t.get("type", ""),
                    "updated_human": _fmt_updated_human(t.get("updated", ""), today),
                }
                for t in tickets
            ]

            section: Dict[str, Any] = {
                "id": version_id,
                "name": version_name,
                "href": f"{jira_base}/projects/{project_key}/versions/{version_id}",
                "increment": _extract_increment(version_name, description),
                "ticketTodo": todo_count,
                "ticketTotal": total,
                "uatStart": _fmt_date(ov.uat_start if ov else None),
                "targetEnd": _fmt_date(target_end),
                "targetEndUrgent": bool(target_end and target_end <= today + timedelta(days=3)),
                "versionNote": (ov.notes if ov else None) or (description.strip() or None),
                "summary": default_summary,
                "subSections": sub_sections,
                # Internal fields (stripped before response)
                "_by_status": by_status,
                "_is_released": is_released,
                "_release_date": release_date_str,
                "_start_date": v.get("startDate") or "",
                # ISO (YYYY-MM-DD) so lexical sort == chronological sort.
                # Used to order active sections by target release date.
                "_target_end_iso": target_end.isoformat() if target_end else "",
                "_all_tickets": all_tickets_for_prompt,
            }

            if is_released:
                section["releasedDate"] = _fmt_date(
                    datetime.fromisoformat(release_date_str).date() if release_date_str else None
                )
                section["statusLabel"] = "Released"
                section["statusClass"] = "wu-badge--released"
            else:
                # All tickets done but version not yet released → "Pending release"
                # This keeps the statusLabel consistent with the frontend badge logic
                # (WeeklyUpdatePanel checks ticketTodo == 0 to render the pending badge).
                if total > 0 and todo_count == 0 and not active_tix:
                    section["statusLabel"] = "Pending release"
                    section["statusClass"] = "wu-badge--pending-rel"
                elif target_end and target_end == today:
                    section["statusLabel"] = "Releasing today"
                    section["statusClass"] = "wu-badge--today"
                elif target_end and target_end < today:
                    section["statusLabel"] = "Overdue"
                    section["statusClass"] = "wu-badge--today"
                else:
                    section["statusLabel"] = "In Progress"
                    section["statusClass"] = "wu-badge--in-progress"

            return section

    tasks = [process_version(v) for v in all_versions]
    raw_results = await asyncio.gather(*tasks, return_exceptions=True)

    released_sections: List[Dict] = []
    active_sections: List[Dict] = []

    for v, res in zip(all_versions, raw_results):
        if isinstance(res, Exception):
            logger.warning("Error processing version %s: %s", v.get("name"), res)
            continue
        if res is None:
            continue
        if res["_is_released"]:
            released_sections.append(res)
        else:
            active_sections.append(res)

    # Sort by release date:
    #   released  — most recent release first (descending by actual release date)
    #   active    — earliest target release first (ascending by target end date),
    #               so nearest upcoming releases appear at the top
    released_sections.sort(key=lambda s: s.get("_release_date") or "", reverse=True)
    active_sections.sort(key=lambda s: s.get("_target_end_iso") or "9999-12-31")

    # 5. Generate summaries
    all_sections = released_sections + active_sections

    summaries: dict = {}
    if all_sections:
        try:
            summaries = await _generate_summaries(all_sections, conciseness=conciseness)
        except Exception as exc:
            logger.warning("Summary generation failed: %s", exc)

    for s in all_sections:
        raw_summary = summaries.get(s["id"])
        if raw_summary is None:
            continue
        # New structured shape → render to HTML. Falls back to the default
        # summary (set earlier in process_version) if the payload is malformed
        # or empty. Old string-shape responses are accepted verbatim for
        # backwards compatibility with previously-cached LLM outputs.
        if isinstance(raw_summary, dict):
            rendered = _render_structured_summary(raw_summary)
            if rendered:
                s["summary"] = rendered
                s["summaryFormat"] = "html"
        elif isinstance(raw_summary, str) and raw_summary.strip():
            s["summary"] = raw_summary

    # 6. Strip internal fields
    for s in all_sections:
        s.pop("_by_status", None)
        s.pop("_is_released", None)
        s.pop("_release_date", None)
        s.pop("_start_date", None)
        s.pop("_target_end_iso", None)
        s.pop("_all_tickets", None)

    # 7. Build and return response
    # Avoid %-d (GNU extension, unavailable on Windows); use .day instead.
    date_from = f"{window_start.day} {window_start.strftime('%b')}"
    date_to = f"{window_end.day} {window_end.strftime('%b %Y')}"

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "dateRange": f"{date_from} – {date_to}",
        "project": ", ".join(projects),
        "released": released_sections,
        "active": active_sections,
    }
