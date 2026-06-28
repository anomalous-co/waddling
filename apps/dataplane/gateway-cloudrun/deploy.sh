#!/usr/bin/env bash
# Build the gateway image LOCALLY (linux/amd64) and deploy the bring-up gateway Cloud Run
# service. One authoritative gateway per [org,endpoint] serves BOTH reads and writes over
# quack — external agents `ATTACH 'quack:<service-host>:443'` and birdshot gates every query
# from the session JWT. Repeatable. One-time provisioning (secrets, IAM, GCS HMAC, mTLS cert)
# is in provision.sh.
#
# Build is LOCAL docker (not `gcloud builds submit`): the default Cloud Build compute SA lacks
# storage.objects.get on the source bucket in this project, and a local build needs no extra
# IAM — just `gcloud auth configure-docker`.
set -euo pipefail

PROJECT="${PROJECT:-project-bd87157a-f6fd-4d44-830}"
REGION="${REGION:-us-west1}"
AR="${AR:-${REGION}-docker.pkg.dev/${PROJECT}/waddling}"
TAG="${TAG:-$(git -C "$(dirname "$0")" rev-parse --short HEAD 2>/dev/null || echo latest)}"
IMAGE="${AR}/gateway:${TAG}"
SERVICE="${SERVICE:-gw-bringup}"
SA="${SA:-gateway-run@${PROJECT}.iam.gserviceaccount.com}"
CLOUDSQL="${CLOUDSQL:-${PROJECT}:${REGION}:waddling-main}"
HERE="$(cd "$(dirname "$0")" && pwd)"

# Secret names in Secret Manager (created by provision.sh). Each maps env -> secret:latest.
SECRETS="\
GW_PG_SSLCERT_PEM_B64=gw-pg-sslcert-pem-b64:latest,\
GW_PG_SSLKEY_PEM_B64=gw-pg-sslkey-pem-b64:latest,\
GW_PG_SSLROOTCERT_PEM_B64=gw-pg-sslrootcert-pem-b64:latest,\
S3_KEY_ID=gcs-hmac-key-id:latest,\
S3_SECRET=gcs-hmac-secret:latest,\
DUCKLAKE_CATALOG_DSN=${CATALOG_DSN_SECRET:-gw-bringup-catalog-dsn}:latest,\
GW_SERVER_TOKEN=gw-server-token:latest"

# Lake storage = GCS via DuckDB S3 interop. DUCKLAKE_DATA_PATH / DUCKLAKE_CATALOG_DSN /
# DUCKLAKE_METADATA_SCHEMA are per-endpoint and set by the control plane on the actual
# request/runtime; the values here are deployment-wide defaults for a single-endpoint bring-up.
COMMON_ENV="\
S3_ENDPOINT=storage.googleapis.com,\
S3_REGION=${REGION},\
S3_USE_SSL=true,\
S3_URL_STYLE=path,\
DUCKLAKE_DATA_PATH=${DUCKLAKE_DATA_PATH:-s3://waddling-lake-prod/_bringup/},\
DUCKLAKE_METADATA_SCHEMA=${DUCKLAKE_METADATA_SCHEMA:-dl_bringup}"

echo "==> building ${IMAGE} (linux/amd64, local docker)"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
docker build --platform=linux/amd64 -t "${IMAGE}" "${HERE}"
echo "==> pushing ${IMAGE}"
docker push "${IMAGE}"

echo "==> deploying ${SERVICE}"
# PRIVATE service (--no-allow-unauthenticated): the gateway is never anonymously reachable. Two
# auth layers stack:
#   • network: only callers with a Google identity (the WF-2 per-user router's service account,
#     or a developer via `gcloud run services proxy`) reach the container;
#   • application: birdshot validates the session JWT presented as the quack TOKEN and enforces
#     the per-agent ACL. The SAME birdshot JWT is the agent's single dial-in credential — the
#     router authenticates the user with it, then forwards over the internal Google-identity hop.
gcloud run deploy "${SERVICE}" \
  --project="${PROJECT}" --region="${REGION}" --image="${IMAGE}" \
  --service-account="${SA}" \
  --execution-environment=gen2 --no-cpu-throttling \
  --add-cloudsql-instances="${CLOUDSQL}" \
  --set-secrets="${SECRETS}" \
  --set-env-vars="${COMMON_ENV}" \
  --port=8080 --timeout=3600 --cpu=2 --memory=2Gi \
  --min-instances=1 --max-instances=1 --concurrency=40 \
  --no-allow-unauthenticated

echo "==> done"
gcloud run services list --project="${PROJECT}" --region="${REGION}" --format="table(metadata.name,status.url)"
