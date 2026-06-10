# Local Development

## Backend

```
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements/dev.txt

# Run migrations
alembic upgrade head

# Start API
uvicorn app.main:app --reload --port 8000
```

Backend tests (use Docker if local Python is 3.14+; `psycopg2-binary` is not yet available):

```
cd backend
./scripts/test_docker.sh
```

Required env vars:
- `DT_DATABASE_URL`
- `DT_JIRA_OAUTH_CLIENT_ID`
- `DT_JIRA_OAUTH_CLIENT_SECRET`
- `DT_JIRA_OAUTH_REDIRECT_URI`
- `DT_SESSION_SECRET`
- `DT_UI_BASE_URL`

Note: Jira access tokens are stored in an in-memory session store for local dev.
For production, replace with Redis or database-backed sessions.

You can place these in `/Users/roman.rock/workspace/delivery-tracker/.env` (see `.env.example`).

## Frontend

```
cd frontend
npm install
npm run dev
```

Frontend expects backend at `http://localhost:8000`.

## OAuth

Set redirect URI in Atlassian console to:

```
http://localhost:8000/api/callback
```

## Postgres (Docker)

If you don't have Postgres running locally, you can use Docker:

```
cd /Users/roman.rock/workspace/delivery-tracker
docker compose up -d db
```

`run_local.sh` will auto-start Postgres unless `DT_START_DB=0` is set.
