#!/usr/bin/env bash
# infra/gcp/deploy-app.sh — Build and deploy the waddling control-plane (Next.js)
# and MCP servers to GCP Cloud Run.
#
# Prerequisites:
#   - infra/gcp/setup.sh completed
#   - Docker, gcloud authenticated
#
# Usage:
#   PROJECT_ID=waddling-prod bash infra/gcp/deploy-app.sh
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-waddling-prod}"
REGION="${REGION:-us-central1}"
ARTIFACT_REPO="waddling"
SA_NAME="waddling-run"
IMAGE_BASE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

info() { echo "[deploy-app] $*"; }
check() { command -v "$1" &>/dev/null || { echo "ERROR: $1 not found"; exit 1; }; }

check gcloud
check docker

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${REPO_ROOT}"

GIT_SHA="${GITHUB_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo manual)}"

CLOUD_SQL_CONN="$(gcloud sql instances describe waddling-db \
  --project="${PROJECT_ID}" \
  --format='value(connectionName)' 2>/dev/null || echo '')"

gcloud auth configure-docker "${REGION}-docker.pkg.dev" \
  --project="${PROJECT_ID}" \
  --quiet

# ── Build + push Next.js app ─────────────────────────────────────────────────
APP_IMAGE="${IMAGE_BASE}/waddling-app:${GIT_SHA}"
info "Building Next.js app image..."
docker build \
  -f scripts/waddling-demo/Dockerfile.app \
  -t "${APP_IMAGE}" \
  -t "${IMAGE_BASE}/waddling-app:latest" \
  --build-arg SKIP_ENV_VALIDATION=1 \
  .
docker push "${APP_IMAGE}"
docker push "${IMAGE_BASE}/waddling-app:latest"

# ── Build + push MCP external server ─────────────────────────────────────────
MCP_IMAGE="${IMAGE_BASE}/waddling-mcp-external:${GIT_SHA}"
info "Building MCP-external image..."
docker build \
  -f scripts/waddling-demo/Dockerfile.mcp-external \
  -t "${MCP_IMAGE}" \
  -t "${IMAGE_BASE}/waddling-mcp-external:latest" \
  .
docker push "${MCP_IMAGE}"
docker push "${IMAGE_BASE}/waddling-mcp-external:latest"

# ── Deploy Next.js app ────────────────────────────────────────────────────────
info "Deploying waddling-app to Cloud Run..."

CLOUD_SQL_FLAG=""
[[ -n "${CLOUD_SQL_CONN}" ]] && CLOUD_SQL_FLAG="--add-cloudsql-instances=${CLOUD_SQL_CONN}"

# The Next.js app needs DATABASE_URL (Cloud SQL), BETTER_AUTH_SECRET, and the
# gateway actor URL (set after deploy-actor.sh completes).
APP_URL_PLACEHOLDER="${APP_URL:-https://waddling-app-placeholder.run.app}"

gcloud run deploy waddling-app \
  --image="${APP_IMAGE}" \
  --region="${REGION}" \
  --platform=managed \
  --service-account="${SA_EMAIL}" \
  --min-instances=1 \
  --max-instances=20 \
  --port=3100 \
  --allow-unauthenticated \
  --set-secrets="\
DATABASE_URL=database-url:latest,\
BETTER_AUTH_SECRET=better-auth-secret:latest" \
  --set-env-vars="\
NODE_ENV=production,\
PORT=3100,\
NEXT_PUBLIC_APP_URL=${APP_URL_PLACEHOLDER},\
BETTER_AUTH_URL=${APP_URL_PLACEHOLDER},\
JWT_ISSUER=${APP_URL_PLACEHOLDER},\
JWT_AUDIENCE_PREFIX=gw,\
SKIP_ENV_VALIDATION=1" \
  ${CLOUD_SQL_FLAG} \
  --project="${PROJECT_ID}" \
  --quiet

APP_URL="$(gcloud run services describe waddling-app \
  --region="${REGION}" --project="${PROJECT_ID}" --format='value(status.url)')"

# Update env vars now that we know the real URL.
gcloud run services update waddling-app \
  --region="${REGION}" \
  --update-env-vars="\
NEXT_PUBLIC_APP_URL=${APP_URL},\
BETTER_AUTH_URL=${APP_URL},\
JWT_ISSUER=${APP_URL}" \
  --project="${PROJECT_ID}" \
  --quiet

# ── Deploy MCP external server ────────────────────────────────────────────────
info "Deploying waddling-mcp-external to Cloud Run..."
gcloud run deploy waddling-mcp-external \
  --image="${MCP_IMAGE}" \
  --region="${REGION}" \
  --platform=managed \
  --service-account="${SA_EMAIL}" \
  --min-instances=0 \
  --max-instances=10 \
  --port=8810 \
  --allow-unauthenticated \
  --set-env-vars="\
NODE_ENV=production,\
WADDLING_URL=${APP_URL},\
MCP_HTTP_PORT=8810" \
  --project="${PROJECT_ID}" \
  --quiet

MCP_URL="$(gcloud run services describe waddling-mcp-external \
  --region="${REGION}" --project="${PROJECT_ID}" --format='value(status.url)')"

cat <<EOF

════════════════════════════════════════════════════════════════
✅  Control plane deployed
════════════════════════════════════════════════════════════════

App URL:         ${APP_URL}
MCP URL:         ${MCP_URL}

After deploying the gateway actor (deploy-actor.sh), update the app:
  gcloud run services update waddling-app \\
    --region=${REGION} \\
    --update-env-vars=GATEWAY_INTERNAL_URL=<actor-url>/api/rivet \\
    --project=${PROJECT_ID} --quiet

Health checks:
  curl -sf ${APP_URL}/api/healthz
  curl -sf ${MCP_URL}/mcp
════════════════════════════════════════════════════════════════
EOF
