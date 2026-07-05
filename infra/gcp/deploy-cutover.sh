#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════════
# deploy-cutover.sh — the FULL GCP deployment for the birdshot literal-GRANT/DENY-SQL
# control plane. Runs the whole cutover so nothing gets forgotten. Idempotent.
#
#   ./deploy-cutover.sh all            # everything, in order
#   ./deploy-cutover.sh migrate        # apply control-schema migrations to prod
#   ./deploy-cutover.sh control-api    # build + push + deploy control-api
#   ./deploy-cutover.sh gateway        # build gateway image (bakes birdshot from GCS)
#                                      #   + roll it across ALL gw-*/ws-* services
#                                      #   + repoint the provisioner
#   ./deploy-cutover.sh birdshot-pull  # refresh the staged linux_amd64 extension from GCS
#
# WHY GCS (not R2): all non-UI/non-DNS infra is GCP. The birdshot CI publishes the
# cross-compiled extensions to gs://waddling-ext (see birdshot/.github/workflows), and
# BOTH the gateway image build AND workspaces bake the linux_amd64 binary from there.
# (ext.getwaddling.com — the old Cloudflare R2 CDN — now 404s through the GCP router.)
#
# Auth: `gcloud auth login` (Cloud Run deploy + Artifact Registry) and local docker.
# The prod DB is mTLS-only; we reach it through the Cloud SQL Auth Proxy (IAM-authed,
# ephemeral cert) — NEVER hand-mint a client cert (that path is governed by credops.sh).
# ═══════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── config ───────────────────────────────────────────────────────────────────────
PROJECT="${PROJECT:-project-bd87157a-f6fd-4d44-830}"
REGION="${REGION:-us-west1}"
INSTANCE="${INSTANCE:-waddling-main}"
CONNECTION="${PROJECT}:${REGION}:${INSTANCE}"
AR="${AR:-${REGION}-docker.pkg.dev/${PROJECT}/waddling}"
TAG="${TAG:-store-cutover}"
EXT_BUCKET="${EXT_BUCKET:-gs://waddling-ext}"
EXT_VERSION="${EXT_VERSION:-v1.5.3}"
DB_SECRET="${DB_SECRET:-controlapi-database-url}"   # DATABASE_URL; reused as BIRDSHOT_STORE_DSN
PROXY_PORT="${PROXY_PORT:-5434}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
say() { printf '\n\033[1;36m══ %s\033[0m\n' "$*"; }
ok()  { printf '   \033[32m✓\033[0m %s\n' "$*"; }

# ── the linux_amd64 extension the gateway/workspace images bake ────────────────────
STAGED_EXT="${ROOT}/apps/dataplane/gateway-cloudrun/birdshot/birdshot.duckdb_extension.gz"
birdshot_pull() {
  say "pull birdshot (${EXT_VERSION}/linux_amd64) from ${EXT_BUCKET}"
  gcloud storage cp "${EXT_BUCKET}/${EXT_VERSION}/linux_amd64/birdshot.duckdb_extension.gz" \
    "${STAGED_EXT}" --project="${PROJECT}"
  ok "staged $(du -h "${STAGED_EXT}" | cut -f1) → ${STAGED_EXT}"
}

# ── control-schema migrations against prod (via the Cloud SQL Auth Proxy) ───────────
migrate() {
  say "migrate control-schema → ${INSTANCE}/${CONNECTION}"
  local proxy; proxy="$(command -v cloud-sql-proxy || true)"
  if [ -z "$proxy" ]; then
    proxy="$(mktemp -d)/cloud-sql-proxy"
    local os arch; os="$(uname -s | tr '[:upper:]' '[:lower:]')"; arch="$(uname -m)"
    [ "$arch" = "x86_64" ] && arch=amd64; [ "$arch" = "aarch64" ] && arch=arm64
    curl -sL -o "$proxy" "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.14.3/cloud-sql-proxy.${os}.${arch}"
    chmod +x "$proxy"
  fi
  # IAM-authed ephemeral-cert tunnel (no hand-minted client cert)
  "$proxy" "${CONNECTION}" --port "${PROXY_PORT}" --token "$(gcloud auth print-access-token)" >/tmp/csql-proxy.log 2>&1 &
  local pid=$!; trap 'kill $pid 2>/dev/null || true' RETURN
  sleep 6
  # rewrite the socket DSN from Secret Manager to the local proxy TCP endpoint (creds stay in-shell)
  local url; url="$(gcloud secrets versions access latest --secret="${DB_SECRET}" --project="${PROJECT}" \
    | sed -E "s#@/([^?]+)\?host=[^&]+.*#@localhost:${PROXY_PORT}/\1#")"
  ( cd "${ROOT}" && DATABASE_URL="$url" pnpm run db:migrate )
  ok "migrations applied"
}

# ── control-api: build (local docker, amd64) → push → deploy ────────────────────────
control_api() {
  say "control-api → Cloud Run (${AR}/control-api:${TAG})"
  gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
  docker buildx build --platform linux/amd64 -t "${AR}/control-api:${TAG}" --push "${ROOT}/apps/control-api"
  gcloud run deploy control-api --image="${AR}/control-api:${TAG}" \
    --region="${REGION}" --project="${PROJECT}" \
    --update-secrets="BIRDSHOT_STORE_DSN=${DB_SECRET}:latest" --quiet     # gateway pulls grants using this DSN
  ok "control-api deployed + BIRDSHOT_STORE_DSN wired"
}

# ── gateway/workspace image: build (bakes birdshot) → push → roll to EVERY service ──
gateway() {
  birdshot_pull
  say "gateway image → ${AR}/gateway:${TAG}"
  gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
  docker build --platform=linux/amd64 -t "${AR}/gateway:${TAG}" "${ROOT}/apps/dataplane/gateway-cloudrun"
  docker push "${AR}/gateway:${TAG}"
  ok "image pushed"

  # Workspaces are ALSO birdshot-gated and run the SAME gateway image — roll every
  # gw-* and ws-* service, discovered dynamically so none is forgotten.
  say "roll ${AR}/gateway:${TAG} across all gw-*/ws-* services"
  local svcs; svcs="$(gcloud run services list --project="${PROJECT}" --region="${REGION}" \
    --format='value(metadata.name)' | grep -E '^(gw|ws)-' || true)"
  for svc in $svcs; do
    gcloud run services update "$svc" --image="${AR}/gateway:${TAG}" \
      --region="${REGION}" --project="${PROJECT}" --quiet >/dev/null && ok "rolled $svc"
  done

  # New gateways spawned by the provisioner must use the cutover image too.
  say "repoint provisioner GATEWAY_IMAGE"
  gcloud run services update provisioner \
    --update-env-vars="GATEWAY_IMAGE=${AR}/gateway:${TAG}" \
    --region="${REGION}" --project="${PROJECT}" --quiet >/dev/null
  ok "provisioner → ${AR}/gateway:${TAG}"
}

case "${1:-all}" in
  birdshot-pull) birdshot_pull ;;
  migrate)       migrate ;;
  control-api)   control_api ;;
  gateway)       gateway ;;
  all)           migrate; control_api; gateway
                 say "cutover deploy complete" ;;
  *) echo "usage: $0 {all|migrate|control-api|gateway|birdshot-pull}"; exit 1 ;;
esac
