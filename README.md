# Delivery Tracker

A roadmap and dashboard tool that combines Jira data (Fix Versions / Epics /
Stories / dependencies) with locally-stored UAT, Live and Milestone data, plus
LLM-generated weekly updates. Built as a replacement for the spreadsheets and
hand-curated decks that delivery managers were maintaining alongside Jira.

## Features

### Authentication
- Azure AD (MSAL) sign-in for the app itself
- Per-user Jira linkage via 3LO OAuth — each user authorises their own Jira
  account once and the backend stores the token
- In-app role assignment (admin / editor / viewer)

### Roadmap / Gantt
- Fix Version → Epic → Story nesting with collapse-by-default
- Two chart modes: standard (one bar per row) and swimlane (lanes grouped by
  fix-version IDs); swimlane has a milestone-diamond view as well
- Schedule-aware bar colours (not-started / in-progress / completed / at-risk /
  overdue) plus a "colour by category" override for custom palettes
- UAT and Live point-in-time diamonds anchored to per-fix-version dates
- Dependency arrows (both Jira-sourced and user-created "manual" overrides) with
  source/target bundling, gutter-snapping and a text-aware mask so arrows pass
  cleanly behind labels
- Cross-project external-dependency badge surfacing linked tickets from other
  projects
- Today line, custom bars (single lane or all-lanes overlay), per-fix-version
  notes and overrides

### Dashboards
- Multiple dashboards organised into folders, persisted in Postgres
- Mix of panel types: Gantt, weekly update, metrics, rich text, image
- Filters (projects, fix versions, components, increment dates) saved per
  dashboard
- Live cross-user sync via Server-Sent Events — edits made by one user appear
  in real time on every other user's open session, with safety nets for
  dropped edits

### Weekly update panel
- LLM-generated (currently GPT-5.4) "Done / Doing / To do" summaries per fix
  version, shared RAG status with the Gantt
- Inline image handling, structured HTML output, edit history

### Metrics panel
- Auto-populating issue counts driven by saved JQL fragments

## Architecture

- **Backend**: FastAPI + SQLAlchemy + Postgres, deployed via
  Jenkins + Terraform
- **Frontend**: React + Vite, served from an nginx container
- **Infra**: AWS (Aurora Postgres 16.11, ECR, EKS), Vault for secrets

## Local development
See `LOCAL_DEV.md`.

## Release / deploy
See `docs/release-deploy-checklist.md`.

## Recent changes

| Date       | Summary                                                          |
|------------|------------------------------------------------------------------|
| 2026-05-26 | Live cross-user sync via SSE + dropped-edit safety nets (#76)    |
| 2026-05-15 | Gantt UX improvements, presence via Azure AD, weekly update live sync (#72) |
| 2026-05-11 | Azure AD auth, per-user Jira linkage, in-app role assignment (#67) |
| 2026-05-07 | Custom bars with persistence, inline editing, colour picker (#64)|
| 2026-04-28 | Swimlane dep routing improvements (#63)                          |
| 2026-04-24 | UAT/Live diamonds, external-deps badge, tooltip polish (#62)     |
| 2026-04-22 | Structured AI summaries, shared RAG, inline image handling (#61) |
| 2026-04-20 | Milestone overlay consolidation; weekly update + metrics polish (#58, #59) |
| 2026-04-19 | FixVersion picker, manual dependencies, Gantt polish (#57)       |
| 2026-04-18 | Weekly update summary generation switched to GPT-5.4 (#56)       |
| 2026-04-16 | Weekly update panel, dashboard folders, metrics panel (#52)      |
| 2026-04-10 | Auto-populating Metrics panel for dashboards (#50)               |
| 2026-04-09 | Today line on Gantt chart (#46)                                  |
| 2026-02-24 | Gantt dependencies (#38, #39, #40)                               |
| 2026-02-21 | Swimlane Gantt + dashboard deletion (#24)                        |
| 2026-02-18 | v1 scaffold (FE/BE + Jenkins + Terraform) (#1)                   |
