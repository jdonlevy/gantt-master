#!/bin/sh
set -e

if [ "${DT_RUN_MIGRATIONS:-true}" != "false" ]; then
  echo "Running alembic migrations..."
  alembic upgrade head
fi

exec "$@"
