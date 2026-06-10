#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to run backend tests in a container" >&2
  exit 1
fi

docker run --rm \
  -v "${ROOT_DIR}:/app" \
  -w /app/backend \
  python:3.12-slim \
  bash -lc "pip install --no-cache-dir -r requirements/dev.txt && python -m pytest -q"
