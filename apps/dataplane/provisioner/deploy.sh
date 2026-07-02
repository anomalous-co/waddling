#!/usr/bin/env bash
# Deploy the gateway provisioner (private, holds run.admin via provisioner-run@).
# Prereqs (one-time, done out of band): provisioner-run@ has roles/run.admin +
# roles/iam.serviceAccountUser on gateway-run@; control-api-run@ gets run.invoker on THIS service.
set -euo pipefail
PROJECT=project-bd87157a-f6fd-4d44-830
REGION=us-west1
TAG="${1:-v1}"
IMG="us-west1-docker.pkg.dev/${PROJECT}/waddling/provisioner:${TAG}"
GATEWAY_IMAGE="us-west1-docker.pkg.dev/${PROJECT}/waddling/gateway:wsmesh-p6"
GATEWAY_SA="gateway-run@${PROJECT}.iam.gserviceaccount.com"
CONTROL_API_SA="control-api-run@${PROJECT}.iam.gserviceaccount.com"
ROUTER_SA="waddling-router@${PROJECT}.iam.gserviceaccount.com"

docker build --platform=linux/amd64 --provenance=false --sbom=false -t "$IMG" .
docker push "$IMG"

gcloud run deploy provisioner --project="$PROJECT" --region="$REGION" --image="$IMG" \
  --service-account="provisioner-run@${PROJECT}.iam.gserviceaccount.com" \
  --no-allow-unauthenticated \
  --set-env-vars="GCP_PROJECT=${PROJECT},GCP_REGION=${REGION},GATEWAY_IMAGE=${GATEWAY_IMAGE},GATEWAY_SA=${GATEWAY_SA},CONTROL_API_SA=${CONTROL_API_SA},ROUTER_SA=${ROUTER_SA},CLOUDSQL_INSTANCE=${PROJECT}:${REGION}:waddling-main" \
  --cpu=1 --memory=512Mi --min-instances=0 --max-instances=2 --timeout=300

# Let control-api call the provisioner.
gcloud run services add-iam-policy-binding provisioner --project="$PROJECT" --region="$REGION" \
  --member="serviceAccount:${CONTROL_API_SA}" --role=roles/run.invoker
