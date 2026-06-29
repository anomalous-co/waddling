#!/usr/bin/env bash
# ONE-TIME provisioning for the Cloud Run gateway: service account + IAM, a fresh Cloud SQL
# mTLS client cert, the server CA, a GCS HMAC key, and all Secret Manager secrets deploy.sh
# expects. Idempotent-ish; safe to re-read before running. Review before executing.
set -euo pipefail

PROJECT="${PROJECT:-project-bd87157a-f6fd-4d44-830}"
REGION="${REGION:-us-west1}"
INSTANCE="${INSTANCE:-waddling-main}"
SA_NAME="${SA_NAME:-gateway-run}"
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
BUCKET="${BUCKET:-waddling-lake-prod}"
WORK="$(mktemp -d)"

echo "==> service account ${SA}"
gcloud iam service-accounts create "${SA_NAME}" --project="${PROJECT}" \
  --display-name="waddling gateway (Cloud Run)" 2>/dev/null || echo "   (exists)"
for ROLE in roles/cloudsql.client roles/secretmanager.secretAccessor roles/storage.objectAdmin; do
  gcloud projects add-iam-policy-binding "${PROJECT}" \
    --member="serviceAccount:${SA}" --role="${ROLE}" --condition=None --quiet >/dev/null
done

echo "==> mint a fresh Cloud SQL client cert (its private key is returned only now)"
CERT_NAME="gateway-cloudrun-$(date +%Y%m%d%H%M%S)"
gcloud sql ssl client-certs create "${CERT_NAME}" "${WORK}/client-key.pem" \
  --instance="${INSTANCE}" --project="${PROJECT}"
gcloud sql ssl client-certs describe "${CERT_NAME}" --instance="${INSTANCE}" --project="${PROJECT}" \
  --format="value(cert)" > "${WORK}/client-cert.pem"
gcloud sql instances describe "${INSTANCE}" --project="${PROJECT}" \
  --format="value(serverCaCert.cert)" > "${WORK}/server-ca.pem"

echo "==> GCS HMAC key for ${SA}"
HMAC_JSON="$(gcloud storage hmac create "${SA}" --project="${PROJECT}" --format=json)"
HMAC_KEY_ID="$(echo "${HMAC_JSON}"  | python3 -c 'import sys,json;print(json.load(sys.stdin)["metadata"]["accessId"])')"
HMAC_SECRET="$(echo "${HMAC_JSON}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["secret"])')"

put_secret() { # name, value-file-or-stdin
  local name="$1"
  gcloud secrets describe "${name}" --project="${PROJECT}" >/dev/null 2>&1 \
    || gcloud secrets create "${name}" --project="${PROJECT}" --replication-policy=automatic
  gcloud secrets versions add "${name}" --project="${PROJECT}" --data-file=-
}

echo "==> populate Secret Manager (PEMs base64'd single-line)"
base64 < "${WORK}/client-cert.pem" | tr -d '\n' | put_secret gw-pg-sslcert-pem-b64
base64 < "${WORK}/client-key.pem"  | tr -d '\n' | put_secret gw-pg-sslkey-pem-b64
base64 < "${WORK}/server-ca.pem"   | tr -d '\n' | put_secret gw-pg-sslrootcert-pem-b64
printf '%s' "${HMAC_KEY_ID}" | put_secret gcs-hmac-key-id
printf '%s' "${HMAC_SECRET}" | put_secret gcs-hmac-secret
# Server token (birdshot server_token / quack TOKEN). Reuse an existing one if you have it.
printf '%s' "${GW_SERVER_TOKEN:-$(openssl rand -hex 32)}" | put_secret gw-server-token

rm -rf "${WORK}"
echo "==> provisioned. Now run ./deploy.sh"
