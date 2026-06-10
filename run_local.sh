#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ROOT_DIR/.env"
  set +a
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found. Install Python 3.12+ first." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found. Install Node.js first." >&2
  exit 1
fi

if [ ! -d "$BACKEND_DIR/.venv" ]; then
  echo "Creating virtualenv..."
  python3 -m venv "$BACKEND_DIR/.venv"
fi

# shellcheck disable=SC1091
source "$BACKEND_DIR/.venv/bin/activate"

echo "Installing backend dependencies..."
python -m pip install -r "$BACKEND_DIR/requirements/dev.txt"

if [ -z "${DT_DATABASE_URL:-}" ]; then
  export DT_DATABASE_URL="postgresql+asyncpg://postgres:postgres@localhost:5433/delivery_tracker"
fi

if [ -f "$ROOT_DIR/docker-compose.yml" ] && [ "${DT_START_DB:-1}" = "1" ]; then
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    echo "Starting local Postgres via docker compose..."
    docker compose -f "$ROOT_DIR/docker-compose.yml" up -d db
  elif command -v docker-compose >/dev/null 2>&1; then
    echo "Starting local Postgres via docker-compose..."
    docker-compose -f "$ROOT_DIR/docker-compose.yml" up -d db
  else
    echo "Docker Compose not available; skipping DB startup."
  fi
fi

if [ -n "${DT_DATABASE_URL:-}" ]; then
  echo "Running migrations..."
  (cd "$BACKEND_DIR" && python -m alembic upgrade head) || \
    echo "Alembic failed (is Postgres running?). Continuing..."
else
  echo "DT_DATABASE_URL not set; skipping migrations."
fi

if [ -z "${DT_SESSION_SECRET:-}" ]; then
  export DT_SESSION_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
fi

# Start backend
(
  cd "$BACKEND_DIR"
  python -m uvicorn app.main:app --reload --port 8000
) &
BACKEND_PID=$!

# Start frontend
(
  cd "$FRONTEND_DIR"
  if [ ! -d "node_modules" ]; then
    echo "Installing frontend dependencies..."
    npm install
  fi
  npm run dev -- --host 0.0.0.0
) &
FRONTEND_PID=$!

# Open browser
sleep 2
if command -v open >/dev/null 2>&1; then
  open "http://localhost:3000"
else
  echo "Open http://localhost:3000 in your browser."
fi

cleanup() {
  echo "Stopping..."
  kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
}
trap cleanup EXIT

wait
