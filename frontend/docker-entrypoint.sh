#!/bin/sh
set -e

cat > /usr/share/nginx/html/env.js <<EOF_ENV
window.__ENV__ = {
  VITE_API_BASE_URL: "${VITE_API_BASE_URL}",
  VITE_AZURE_AD_CLIENT_ID: "${VITE_AZURE_AD_CLIENT_ID}",
  VITE_AZURE_AD_TENANT_ID: "${VITE_AZURE_AD_TENANT_ID}",
  VITE_AZURE_AD_AUTHORITY: "${VITE_AZURE_AD_AUTHORITY}",
};
EOF_ENV

exec "$@"
