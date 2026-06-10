#!/bin/sh
set -e

cat > /usr/share/nginx/html/env.js <<EOF_ENV
window.__ENV__ = {
  VITE_API_BASE_URL: "${VITE_API_BASE_URL}",
};
EOF_ENV

exec "$@"
