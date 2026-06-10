# Release & Deployment Checklist

Use this checklist for every release to reduce avoidable build and deployment failures.

## Pre-PR
- Verify the branch name starts with `codex/` and the PR title is semantic (`feat:`, `fix:`, `chore:`, etc.).
- Pull latest `main` and rebase before raising the PR to avoid drift.
- If a previous PR for the same work was already merged, create a fresh branch and open a new PR (do not reuse the merged PR).
- Before pushing new commits, verify the target PR is still open (`gh pr view <id>`). If merged, create a new branch/PR.
- If backend schema changes are included:
  - Add an Alembic migration and confirm it runs locally.
  - Note the migration requirement in the PR description.
- If release notes are required for this change:
  - Add the new version in `frontend/public/release-notes/vX.html`.
  - Update `frontend/src/pages/ReleaseNotesList.tsx`.
  - Update `frontend/src/__tests__/ReleaseNotes.test.tsx` if the list order changes.

## Build & Test
- Frontend:
  - Run `npm test` and ensure `npm run build` succeeds (catches TS issues like filter typing).
- Backend:
  - Run `python -m pytest -q` if Python is available in the shell.
- Verify no TypeScript errors remain in `frontend/src/pages/DashboardList.tsx` (common build failure point).
## Release Check Quality Gate
- PR description must be executive summary style (3 concise bullets max) plus a short testing list.
- No raw logs in the PR body. Verify by viewing the PR body after editing.

## Environment / Config
- CORS:
  - Ensure `DT_CORS_ORIGINS` includes the UI URL and the backend falls back to `DT_UI_BASE_URL` if unset.
- Required vars:
  - Confirm `DT_UI_BASE_URL` and `DT_CORS_ORIGINS` are set in the deployment environment (prod requires them).
- Auth/session:
  - Confirm `/api/session` responds and that auth redirects still work after changes.
- If using `gh` for PRs, unset `GITHUB_TOKEN` if it overrides your keyring auth.

## Pre-Deploy
- Confirm the deployment target and kube context are correct (dev vs prod).
- Migrations run on backend startup; ensure no long-running migrations are pending.
- If a migration is expected, verify the backend starts cleanly and `/health` returns 200.

## Post-Deploy Smoke Checks
- `GET /health` returns 200.
- Dashboard page loads without CORS errors.
- Save filters + swimlanes succeeds (no preflight failures).
- `/api/roadmap` returns 200 for an authenticated dashboard.

## Rollback Readiness
- Confirm the previous version tag is available in ECR and can be rolled back quickly if needed.
