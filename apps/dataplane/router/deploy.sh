#!/usr/bin/env bash
# Build + deploy the public quack router. PUBLIC (--allow-unauthenticated) by design: it is the
# one internet-facing ingress; it does no auth and reads nothing — it only mints a Google identity
# token and forwards to the PRIVATE birdshot-gated gateways, which reject any request without a
# valid JWT. Build is LOCAL docker (Cloud Build's compute SA lacks storage.objects.get here).
set -euo pipefail

PROJECT="${PROJECT:-project-bd87157a-f6fd-4d44-830}"
REGION="${REGION:-us-west1}"
AR="${AR:-${REGION}-docker.pkg.dev/${PROJECT}/waddling}"
TAG="${TAG:-router-$(git -C "$(dirname "$0")" rev-parse --short HEAD 2>/dev/null || echo latest)}"
IMAGE="${AR}/router:${TAG}"
SA="${SA:-waddling-router@${PROJECT}.iam.gserviceaccount.com}"
HERE="$(cd "$(dirname "$0")" && pwd)"

# The fixed bring-up target: the live private lake gateway. Host-based routing (gw-/ws- subdomains)
# is used when ROUTER_HOST_SUFFIX is set and the Host matches; otherwise everything goes here.
TARGET_SERVICE_URL="${TARGET_SERVICE_URL:-$(gcloud run services describe gw-bringup --project="${PROJECT}" --region="${REGION}" --format='value(status.url)')}"

echo "==> building ${IMAGE} (linux/amd64, local docker)"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
docker build --platform=linux/amd64 --provenance=false --sbom=false -t "${IMAGE}" "${HERE}"
docker push "${IMAGE}"

echo "==> deploying waddling-router (public) → target ${TARGET_SERVICE_URL}"
gcloud run deploy waddling-router \
  --project="${PROJECT}" --region="${REGION}" --image="${IMAGE}" \
  --service-account="${SA}" \
  --allow-unauthenticated \
  --port=8080 --cpu=1 --memory=512Mi \
  --min-instances=1 --max-instances=4 --timeout=600 \
  --set-env-vars="TARGET_SERVICE_URL=${TARGET_SERVICE_URL},GCP_PROJECT=${PROJECT},GCP_REGION=${REGION},ROUTER_HOST_SUFFIX=${ROUTER_HOST_SUFFIX:-}"

echo "==> done"
gcloud run services describe waddling-router --project="${PROJECT}" --region="${REGION}" --format='value(status.url)'
