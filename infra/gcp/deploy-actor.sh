#!/usr/bin/env bash
# infra/gcp/deploy-actor.sh — Build and deploy the waddling gateway Rivet actor
# to GCP Cloud Run.
#
# Prerequisites:
#   - gcloud auth login (or gcloud auth activate-service-account)
#   - infra/gcp/setup.sh has been run (project, Artifact Registry, secrets exist)
#   - birdshot Linux amd64 extension built (or downloaded from R2)
#
# Usage:
#   PROJECT_ID=waddling-prod bash infra/gcp/deploy-actor.sh
#
# The script:
#   1. Downloads the Linux amd64 birdshot extension from R2 (if not already present).
#   2. Builds the Docker image and pushes to Artifact Registry.
#   3. Deploys to Cloud Run with Rivet env vars from Secret Manager.
#   4. Prints the Cloud Run URL to register in the Rivet dashboard.
set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
PROJECT_ID="${PROJECT_ID:-waddling-prod}"
REGION="${REGION:-us-central1}"
ARTIFACT_REPO="waddling"
SERVICE_NAME="waddling-gateway-actor"
SA_NAME="waddling-run"
DUCKDB_VERSION="${DUCKDB_VERSION:-v1.5.3}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}/${SERVICE_NAME}"
# Prefer linux_amd64 (default Cloud Run). Fall back to linux_arm64 (gen2 + arm support).
BIRDSHOT_AMD64="birdshot/build-linux-amd64/birdshot.duckdb_extension"
BIRDSHOT_ARM64="birdshot/build-linux/birdshot.duckdb_extension"
BIRDSHOT_LOCAL=""
ARCH=""

if [[ -f "${BIRDSHOT_AMD64}" ]]; then
  BIRDSHOT_LOCAL="${BIRDSHOT_AMD64}"
  ARCH="amd64"
elif [[ -f "${BIRDSHOT_ARM64}" ]]; then
  BIRDSHOT_LOCAL="${BIRDSHOT_ARM64}"
  ARCH="arm64"
fi

R2_AMD64="https://ext.getwaddling.com/${DUCKDB_VERSION}/linux_amd64/birdshot.duckdb_extension.gz"
R2_ARM64="https://ext.getwaddling.com/${DUCKDB_VERSION}/linux_arm64/birdshot.duckdb_extension.gz"

# ── Helpers ───────────────────────────────────────────────────────────────────
info() { echo "[deploy-actor] $*"; }
check() { command -v "$1" &>/dev/null || { echo "ERROR: $1 not found"; exit 1; }; }

check gcloud
check docker

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${REPO_ROOT}"

SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# ── 1. Ensure a Linux birdshot binary is present ──────────────────────────────
if [[ -z "${BIRDSHOT_LOCAL}" ]]; then
  # Try to download from R2 (requires ext.getwaddling.com CDN to be live + CI to have run).
  info "No local Linux build found. Trying R2 (amd64)..."
  mkdir -p birdshot/build-linux-amd64
  GZ_TMP="$(mktemp)"
  if curl -fsSL "${R2_AMD64}" -o "${GZ_TMP}" 2>/dev/null; then
    gunzip -c "${GZ_TMP}" > "${BIRDSHOT_AMD64}"
    BIRDSHOT_LOCAL="${BIRDSHOT_AMD64}"
    ARCH="amd64"
    info "  Downloaded: ${BIRDSHOT_LOCAL}"
  elif curl -fsSL "${R2_ARM64}" -o "${GZ_TMP}" 2>/dev/null; then
    mkdir -p birdshot/build-linux
    gunzip -c "${GZ_TMP}" > "${BIRDSHOT_ARM64}"
    BIRDSHOT_LOCAL="${BIRDSHOT_ARM64}"
    ARCH="arm64"
    info "  Downloaded arm64 fallback: ${BIRDSHOT_LOCAL}"
  else
    echo "ERROR: No local birdshot Linux build found and R2 download failed."
    echo "       Options:"
    echo "         1. Push the birdshot repo to GitHub and let CI build it."
    echo "         2. Build in Docker: docker run --rm -v \$(pwd)/birdshot:/birdshot ubuntu:24.04 bash -c 'cd /birdshot && apt-get install -y cmake ninja-build gcc g++ && make release'"
    echo "         3. Place a pre-built linux_amd64 binary at: ${BIRDSHOT_AMD64}"
    exit 1
  fi
  rm -f "${GZ_TMP}"
else
  info "Using local birdshot: ${BIRDSHOT_LOCAL} (${ARCH})"
fi

# Verify it's a Linux ELF binary, not a macOS Mach-O.
file_type="$(file "${BIRDSHOT_LOCAL}" | grep -o 'ELF\|Mach-O\|unknown' || true)"
if [[ "${file_type}" != "ELF" ]]; then
  echo "ERROR: ${BIRDSHOT_LOCAL} is not a Linux ELF binary (got: ${file_type})."
  echo "       Do not use a macOS Mach-O binary — it will fail to dlopen in the container."
  exit 1
fi

# ── 2. Authenticate Docker with Artifact Registry ─────────────────────────────
info "Configuring Docker auth for Artifact Registry..."
gcloud auth configure-docker "${REGION}-docker.pkg.dev" \
  --project="${PROJECT_ID}" \
  --quiet

# ── 3. Build and push Docker image ────────────────────────────────────────────
GIT_SHA="${GITHUB_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo manual)}"
FULL_IMAGE="${IMAGE}:${GIT_SHA}"
LATEST_IMAGE="${IMAGE}:latest"

DOCKER_PLATFORM="linux/${ARCH}"
info "Building Docker image (${DOCKER_PLATFORM}): ${FULL_IMAGE}"

# Stage birdshot under the expected path for the Dockerfile COPY instruction.
if [[ "${ARCH}" == "amd64" ]]; then
  mkdir -p birdshot/build-linux
  [[ "${BIRDSHOT_LOCAL}" != "${BIRDSHOT_ARM64}" ]] && cp "${BIRDSHOT_LOCAL}" "${BIRDSHOT_ARM64}"
fi

docker build \
  --platform="${DOCKER_PLATFORM}" \
  -f gateway-rivet-poc/Dockerfile \
  -t "${FULL_IMAGE}" \
  -t "${LATEST_IMAGE}" \
  .

info "Pushing image to Artifact Registry..."
docker push "${FULL_IMAGE}"
docker push "${LATEST_IMAGE}"

# ── 4. Deploy to Cloud Run ────────────────────────────────────────────────────
info "Deploying ${SERVICE_NAME} to Cloud Run in ${REGION}..."

# Resolve the Cloud SQL connection name (for the Cloud SQL Auth Proxy)
CLOUD_SQL_CONN="$(gcloud sql instances describe waddling-db \
  --project="${PROJECT_ID}" \
  --format='value(connectionName)' 2>/dev/null || echo '')"

CLOUD_SQL_FLAG=""
if [[ -n "${CLOUD_SQL_CONN}" ]]; then
  CLOUD_SQL_FLAG="--add-cloudsql-instances=${CLOUD_SQL_CONN}"
fi

# gen2 is required for arm64 images; harmless for amd64.
EXEC_ENV="gen2"

gcloud run deploy "${SERVICE_NAME}" \
  --image="${FULL_IMAGE}" \
  --region="${REGION}" \
  --platform=managed \
  --execution-environment="${EXEC_ENV}" \
  --service-account="${SA_EMAIL}" \
  --min-instances=1 \
  --max-instances=10 \
  --concurrency=1000 \
  --cpu=2 \
  --memory=2Gi \
  --timeout=3600 \
  --port=8080 \
  --no-cpu-throttling \
  --allow-unauthenticated \
  --set-secrets="\
RIVET_ENDPOINT=rivet-endpoint:latest,\
RIVET_PUBLIC_ENDPOINT=rivet-public-endpoint:latest,\
GW_SERVER_TOKEN=gw-server-token:latest" \
  ${CLOUD_SQL_FLAG} \
  --project="${PROJECT_ID}" \
  --quiet

# ── 5. Print the Cloud Run URL ────────────────────────────────────────────────
SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --format='value(status.url)')"

cat <<EOF

════════════════════════════════════════════════════════════════
✅  Gateway actor deployed
════════════════════════════════════════════════════════════════

Service URL:  ${SERVICE_URL}
Image:        ${FULL_IMAGE}

Next step — register with Rivet:
  Paste this URL in the Rivet dashboard → Connect → GCP Cloud Run:

    ${SERVICE_URL}/api/rivet

Verify the actor is reachable:
  curl -sf "${SERVICE_URL}/api/rivet/metadata" | jq .

Run fork B verification against the deployed actor:
  REGISTRY_URL=${SERVICE_URL} npm run verify:b --prefix gateway-rivet-poc
════════════════════════════════════════════════════════════════
EOF
