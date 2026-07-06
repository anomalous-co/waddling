#!/usr/bin/env bash
# Build the Qwen3-Embedding-4B TEI image (linux/amd64, local docker) and deploy it as a
# PRIVATE, scale-to-zero Cloud Run L4 GPU service.
#
# Region split (deliberate): the image lives in the us-west1 Artifact Registry alongside every
# other waddling image, but the SERVICE runs in us-central1 — Cloud Run GPU (nvidia-l4) is only
# offered in {asia-southeast1, europe-west4, europe-west1, us-central1, us-east4}, and us-west1
# (where the control-api / gateways / Cloud SQL live) is NOT one of them. Cloud Run pulls the
# image cross-region fine, and the only callers are async embed jobs, so the ~cross-region hop
# is immaterial. Keep AR in us-west1; keep the GPU service in us-central1.
#
# Build runs on GCP CLOUD BUILD, never locally: the image bakes ~8GB of weights (→ ~10GB image)
# and building that on a laptop fills the OS disk. Cloud Build workers are native linux/amd64 with
# a 100GB disk and fast HF egress — see cloudbuild.yaml. Output → Artifact Registry (us-west1).
set -euo pipefail

PROJECT="${PROJECT:-project-bd87157a-f6fd-4d44-830}"
AR_REGION="${AR_REGION:-us-west1}"                 # image registry region (shared repo)
GPU_REGION="${GPU_REGION:-us-central1}"            # service region — MUST be a Cloud Run GPU region
AR="${AR:-${AR_REGION}-docker.pkg.dev/${PROJECT}/waddling}"
TAG="${TAG:-$(git -C "$(dirname "$0")" rev-parse --short HEAD 2>/dev/null || echo latest)}"
IMAGE="${AR}/embeddings:${TAG}"
SERVICE="${SERVICE:-embeddings}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "==> building ${IMAGE} on Cloud Build (bakes ~8GB weights → ~10GB image; NOTHING runs locally)"
gcloud builds submit "${HERE}" \
  --project="${PROJECT}" \
  --config="${HERE}/cloudbuild.yaml" \
  --substitutions="_IMAGE=${IMAGE}"

# PRIVATE (--no-allow-unauthenticated): only callers with roles/run.invoker + a Google ID token
# reach it (the gateway SA and control-api SA get invoker when Phase 3 wires the embed pipeline).
# GPU: --gpu=1 --gpu-type=nvidia-l4. Scale-to-zero: --min-instances=0. --no-gpu-zonal-redundancy
# is the cheaper best-effort mode AND the one auto-granted 3 GPUs of quota on first use in a
# region (no quota request needed). GPU forces gen2 execution env. --cpu=8/--memory=32Gi are the
# recommended L4 sizings; --no-cpu-throttling keeps the model resident while an instance is warm.
# --concurrency: TEI batches internally; keep it modest so one instance isn't oversubscribed.
echo "==> deploying ${SERVICE} → ${GPU_REGION} (L4, scale-to-zero, private)"
# TEI args are passed here via --args (authoritative — overrides the image CMD), so runtime args
# change without a rebuild. --dtype float16: this TEI build accepts only {float16,float32}.
gcloud run deploy "${SERVICE}" \
  --project="${PROJECT}" --region="${GPU_REGION}" --image="${IMAGE}" \
  --args="--model-id,/models/qwen3-embed,--dtype,float16,--auto-truncate,--port,8080" \
  --gpu=1 --gpu-type=nvidia-l4 --no-gpu-zonal-redundancy \
  --cpu=8 --memory=32Gi \
  --min-instances=0 --max-instances=3 --concurrency=16 \
  --port=8080 --timeout=300 --no-cpu-throttling \
  --no-allow-unauthenticated

echo "==> done"
gcloud run services describe "${SERVICE}" --project="${PROJECT}" --region="${GPU_REGION}" \
  --format="value(status.url)"
