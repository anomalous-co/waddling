#!/usr/bin/env bash
# infra/gcp/setup.sh — one-time GCP project bootstrapping for waddling.
#
# Prerequisites:
#   gcloud auth login            (run `! gcloud auth login` in Claude Code)
#   gcloud billing accounts list (note your billing account ID)
#
# Usage:
#   BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX bash infra/gcp/setup.sh
#
# The script is idempotent: re-running it after partial failures is safe.
set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
PROJECT_ID="${PROJECT_ID:-waddling-prod}"   # must be globally unique
PROJECT_NAME="waddling"
REGION="${REGION:-us-central1}"
DB_INSTANCE="waddling-db"
DB_TIER="${DB_TIER:-db-f1-micro}"          # Enterprise shared-core; upgrade to db-custom-* for prod
DB_EDITION="${DB_EDITION:-ENTERPRISE}"     # ENTERPRISE_PLUS requires different tier names
ARTIFACT_REPO="waddling"
SA_NAME="waddling-run"                     # Cloud Run service account

# ── Helpers ───────────────────────────────────────────────────────────────────
info()  { echo "[setup] $*"; }
check() { command -v "$1" &>/dev/null || { echo "ERROR: $1 not found"; exit 1; }; }

check gcloud
check openssl

# ── 1. Create project ─────────────────────────────────────────────────────────
info "Creating project ${PROJECT_ID}..."
if gcloud projects describe "${PROJECT_ID}" --format="value(projectId)" &>/dev/null; then
  info "Project ${PROJECT_ID} already exists — skipping create."
else
  gcloud projects create "${PROJECT_ID}" \
    --name="${PROJECT_NAME}" \
    --quiet
fi

gcloud config set project "${PROJECT_ID}" --quiet

# ── 2. Link billing ───────────────────────────────────────────────────────────
if [[ -n "${BILLING_ACCOUNT:-}" ]]; then
  info "Linking billing account ${BILLING_ACCOUNT}..."
  gcloud billing projects link "${PROJECT_ID}" \
    --billing-account="${BILLING_ACCOUNT}" \
    --quiet
else
  echo ""
  echo "  ⚠  BILLING_ACCOUNT not set. Link billing manually:"
  echo "     gcloud billing projects link ${PROJECT_ID} --billing-account=XXXXXX-XXXXXX-XXXXXX"
  echo ""
fi

# ── 3. Enable required APIs ───────────────────────────────────────────────────
info "Enabling APIs (this may take a minute)..."
APIS=(
  run.googleapis.com
  cloudbuild.googleapis.com
  artifactregistry.googleapis.com
  secretmanager.googleapis.com
  sqladmin.googleapis.com
  servicenetworking.googleapis.com
  vpcaccess.googleapis.com
)
for api in "${APIS[@]}"; do
  gcloud services enable "${api}" \
    --project="${PROJECT_ID}" \
    --quiet
done

# ── 4. Artifact Registry repository ──────────────────────────────────────────
info "Creating Artifact Registry repo ${ARTIFACT_REPO}..."
if ! gcloud artifacts repositories describe "${ARTIFACT_REPO}" \
      --location="${REGION}" --project="${PROJECT_ID}" &>/dev/null; then
  gcloud artifacts repositories create "${ARTIFACT_REPO}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="waddling Docker images" \
    --project="${PROJECT_ID}" \
    --quiet
fi

# ── 5. Service account for Cloud Run ─────────────────────────────────────────
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
info "Creating service account ${SA_EMAIL}..."
if ! gcloud iam service-accounts describe "${SA_EMAIL}" \
      --project="${PROJECT_ID}" &>/dev/null; then
  gcloud iam service-accounts create "${SA_NAME}" \
    --display-name="waddling Cloud Run SA" \
    --project="${PROJECT_ID}" \
    --quiet
  # Service account IAM takes a few seconds to propagate.
  sleep 10
fi

# Grant Secret Manager accessor role so Cloud Run services can read secrets.
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor" \
  --quiet

# Grant Cloud SQL client role.
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/cloudsql.client" \
  --quiet

# ── 6. Cloud SQL (Postgres 16) ────────────────────────────────────────────────
info "Creating Cloud SQL instance ${DB_INSTANCE} (this takes 5-10 min)..."
if ! gcloud sql instances describe "${DB_INSTANCE}" \
      --project="${PROJECT_ID}" &>/dev/null; then
  gcloud sql instances create "${DB_INSTANCE}" \
    --database-version=POSTGRES_16 \
    --edition="${DB_EDITION}" \
    --tier="${DB_TIER}" \
    --region="${REGION}" \
    --storage-auto-increase \
    --backup-start-time=03:00 \
    --project="${PROJECT_ID}" \
    --quiet
fi

DB_PASSWORD="$(openssl rand -hex 24)"
gcloud sql users set-password postgres \
  --instance="${DB_INSTANCE}" \
  --password="${DB_PASSWORD}" \
  --project="${PROJECT_ID}" \
  --quiet

gcloud sql databases create waddling \
  --instance="${DB_INSTANCE}" \
  --project="${PROJECT_ID}" \
  --quiet 2>/dev/null || true

CLOUD_SQL_CONN_NAME="$(gcloud sql instances describe "${DB_INSTANCE}" \
  --project="${PROJECT_ID}" \
  --format='value(connectionName)')"

DATABASE_URL="postgresql://postgres:${DB_PASSWORD}@localhost/waddling?host=/cloudsql/${CLOUD_SQL_CONN_NAME}"

# ── 7. Secret Manager secrets ─────────────────────────────────────────────────
info "Creating Secret Manager secrets..."

create_secret() {
  local name="$1" value="$2"
  if ! gcloud secrets describe "${name}" --project="${PROJECT_ID}" &>/dev/null; then
    printf '%s' "${value}" \
      | gcloud secrets create "${name}" \
          --data-file=- \
          --replication-policy=automatic \
          --project="${PROJECT_ID}" \
          --quiet
    info "  Created secret: ${name}"
  else
    info "  Secret already exists: ${name} (skipped)"
  fi
}

BETTER_AUTH_SECRET="$(openssl rand -hex 32)"

create_secret "database-url"           "${DATABASE_URL}"
create_secret "better-auth-secret"     "${BETTER_AUTH_SECRET}"
create_secret "rivet-endpoint"         "REPLACE_WITH_RIVET_ENDPOINT"
create_secret "rivet-public-endpoint"  "REPLACE_WITH_RIVET_PUBLIC_ENDPOINT"
create_secret "gw-server-token"        "$(openssl rand -hex 32)"

info ""
info "⚠  Update the Rivet secrets before deploying:"
info "   gcloud secrets versions add rivet-endpoint --data-file=<(echo \"\$RIVET_ENDPOINT\")"
info "   gcloud secrets versions add rivet-public-endpoint --data-file=<(echo \"\$RIVET_PUBLIC_ENDPOINT\")"
info ""

# ── 8. Print next steps ───────────────────────────────────────────────────────
cat <<EOF

════════════════════════════════════════════════════════════════
✅  GCP project setup complete
════════════════════════════════════════════════════════════════

Project:            ${PROJECT_ID}
Region:             ${REGION}
Artifact Registry:  ${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPO}
Cloud SQL:          ${CLOUD_SQL_CONN_NAME}
Service account:    ${SA_EMAIL}

Next steps:
  1. Update Rivet secrets (see warning above).
  2. Configure GitHub Actions secrets:
       GCP_PROJECT_ID=${PROJECT_ID}
       GCP_REGION=${REGION}
       GCP_SA_KEY=<json key for ${SA_EMAIL}>
  3. Configure R2 secrets in the birdshot repo:
       R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
  4. Run:  bash infra/gcp/deploy-actor.sh
════════════════════════════════════════════════════════════════
EOF
