# Metrics Panel: Auto-Populate from Jira

## What we're building

When you open a dashboard, the Metrics panel will automatically show a count of tickets that moved into "Ready for Release" or "Done" in the past 2 weeks — pulled live from Jira. No more manually filling it in each week.

**Before:** Metrics is a blank text box you fill in manually.
**After:** Metrics shows a live count + list of tickets completed this fortnight, with a text box below for any extra commentary.

---

## How it will look

```
┌─────────────────────────────────────┐
│  Metrics                            │
│                                     │
│  ✅ 12 tickets completed            │
│     (past 2 weeks)                  │
│                                     │
│  Awaiting Approval (3)              │
│  • GLOB-123  Player auth fix        │
│  • GLOB-124  Podcast feed update    │
│                                     │
│  Ready for Release (4)              │
│  • A2-99     Rev share fixes        │
│                                     │
│  Done (5)                           │
│  • GFIX-475  Background sync        │
│  ...                                │
│                                     │
│  [ Notes... (optional free text) ]  │
└─────────────────────────────────────┘
```

---

## Jira query that powers it

Based on your actual Jira statuses, the query will be:

```
project in (GLOB, A2, ...)
AND status changed to ("Awaiting Approval", "Ready for Release", "Done")
AFTER -2w
```

These three statuses represent the "dev done or beyond" pipeline stage:

| Status | Meaning |
|--------|---------|
| Awaiting Approval | Dev complete, waiting on sign-off |
| Ready for Release | Approved, queued for deployment |
| Done | Shipped |

The projects are taken from whatever filters are already set on the dashboard — so each dashboard only shows metrics relevant to its own scope.

---

## What needs to change: 3 phases

### Phase 1 — Backend: New metrics endpoint

**File:** `backend/app/routers/roadmap.py`
Add a new API endpoint: `GET /api/metrics`

It accepts:
- `projects[]` — which Jira projects to query (reuses existing dashboard filter)
- `statuses[]` — which statuses count as "done" (defaults to `Awaiting Approval`, `Ready for Release`, `Done`)
- `days` — how far back to look (defaults to 14)

It returns:
```json
{
  "count": 12,
  "issues": [
    { "key": "GLOB-123", "summary": "Player auth fix", "status": "Done", "project": "Global Player" },
    ...
  ]
}
```

**File:** `backend/app/schemas.py`
Add a `MetricsResponse` schema to define the shape of the data above.

No database changes needed — this is purely a live Jira query.

---

### Phase 2 — Frontend: New metrics panel type

**File:** `frontend/src/components/MetricsPanel.tsx` *(new file)*
A new panel component that:
1. Reads the dashboard's project filters
2. Calls `GET /api/metrics?projects[]=...`
3. Displays the count and ticket list
4. Shows a small loading spinner while fetching
5. Has a text box below for optional manual notes

**File:** `frontend/src/pages/DashboardPage.tsx`
Update the panel renderer to show `MetricsPanel` when panel type is `metrics` (currently all panels render as `RichTextPanel`).

---

### Phase 3 — Make new dashboards use the metrics panel type

**File:** `backend/app/routers/dashboards.py`
Update the `DEFAULT_PANELS` list so that when a new dashboard is created, the "Metrics" panel is created with type `metrics` instead of `rich_text`.

```python
# Change this:
{"type": "rich_text", "title": "Metrics", ...}

# To this:
{"type": "metrics", "title": "Metrics", ...}
```

> **Note:** Existing dashboards won't automatically update — their Metrics panels will stay as rich text. A small migration or manual re-creation would be needed for those.

---

## Configuration options (nice-to-have for later)

Once the basics work, these would be good follow-on improvements:

- **Configurable statuses per dashboard** — let users pick which statuses count as "done" (useful if different squads use different workflows)
- **Configurable time window** — "past 1 week" vs "past 2 weeks" vs "past sprint"
- **Breakdown by project** — show counts per project when multiple projects are on one dashboard
- **Story points** — show points delivered, not just ticket count (requires `story_points` field from Jira)

---

## Risks and things to check

| Risk | Detail |
|------|--------|
| Status names vary by project | Some squads might use different status names. We should check all projects before hardcoding. |
| Jira API rate limits | Adding a new query per dashboard load increases API calls. Could cache the result for a few minutes. |
| Existing dashboards | Existing Metrics panels are `rich_text` — they won't auto-upgrade. Manual action needed. |
| JQL `status changed to` availability | This JQL function requires Jira Software — should be fine on your instance. |

---

## Tests to write

The existing repo has a consistent test pattern to follow — new tests should match it closely.

### Backend: `backend/tests/test_metrics.py` *(new file)*

Follows the same style as `test_roadmap.py` — monkeypatched Jira client, fake database session, async pytest.

| Test | What it checks |
|------|---------------|
| `test_metrics_requires_auth` | Returns 401 when no session cookie present |
| `test_metrics_returns_count_and_issues` | Happy path — correct count and issue list returned for given projects |
| `test_metrics_filters_by_project` | Only returns tickets from requested projects, not all of Jira |
| `test_metrics_default_statuses` | Uses Awaiting Approval, Ready for Release, Done when no statuses param provided |
| `test_metrics_custom_statuses` | Respects custom `statuses[]` query param |
| `test_metrics_custom_days` | Respects custom `days` query param (e.g. 7 days instead of 14) |
| `test_metrics_empty_result` | Returns count 0 and empty list when no matching tickets |
| `test_metrics_jira_401` | Propagates 401 correctly when Jira token is expired |

### Frontend: `frontend/src/__tests__/MetricsPanel.test.tsx` *(new file)*

Follows the same style as `Gantt.test.tsx` — Vitest + React Testing Library, full API mock via `vi.mock()`.

| Test | What it checks |
|------|---------------|
| `renders loading state` | Spinner shown while API call is in flight |
| `renders count and grouped issues` | Count, status group headers, and ticket keys/summaries shown correctly |
| `collapses and expands status groups` | Clicking a status header hides/shows its tickets |
| `Done group collapsed by default` | Done section starts closed; Awaiting Approval and Ready for Release start open |
| `renders empty state` | Shows "no tickets" message when count is 0 |
| `notes textarea saves on blur` | Typing in notes box and tabbing away calls the panel content update API |
| `shows error state on API failure` | Displays an error message when the metrics fetch fails |

### E2E: addition to `frontend/e2e/roadmap.spec.ts`

Add one new scenario: mock the `/api/metrics` route alongside the existing mocked routes, load a dashboard, and assert the metrics panel shows the correct count and at least one ticket key.

---

## Suggested build order

1. Add `MetricsResponse` schema to `backend/app/schemas.py`
2. Build and test the backend endpoint (`test_metrics.py` as you go)
3. Build `MetricsPanel.tsx` frontend component
4. Write `MetricsPanel.test.tsx`
5. Wire panel type into `DashboardPage.tsx`
6. Update `DEFAULT_PANELS` in `dashboards.py`
7. Add E2E scenario to `roadmap.spec.ts`
8. Test end-to-end on a new dashboard

---

## Effort estimate

| Phase | Rough effort |
|-------|-------------|
| Backend endpoint + tests | ~3–4 hours |
| Frontend panel component + tests | ~4–5 hours |
| Wiring + E2E test | ~1–2 hours |
| **Total** | **~1.5–2 days** |
