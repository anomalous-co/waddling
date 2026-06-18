#!/usr/bin/env bash
# mc-setup.sh — Creates the waddling-lake bucket in MinIO.
# Run inside the minio container or any container with the mc CLI on PATH.
#
# Usage:
#   MC_HOST_local=http://minioadmin:minioadmin@minio:9000 bash mc-setup.sh
#
# Or called directly by the seed script via exec/child_process.
set -euo pipefail

MINIO_ENDPOINT="${S3_ENDPOINT:-http://minio:9000}"
MINIO_ACCESS_KEY="${S3_ACCESS_KEY:-minioadmin}"
MINIO_SECRET_KEY="${S3_SECRET_KEY:-minioadmin}"
BUCKET="${LAKE_BUCKET:-waddling-lake}"

echo "[mc-setup] Configuring MinIO client alias 'waddling-minio'..."
mc alias set waddling-minio "${MINIO_ENDPOINT}" "${MINIO_ACCESS_KEY}" "${MINIO_SECRET_KEY}"

echo "[mc-setup] Checking bucket '${BUCKET}'..."
if mc ls "waddling-minio/${BUCKET}" &>/dev/null; then
  echo "[mc-setup] Bucket '${BUCKET}' already exists — skipping creation."
else
  mc mb "waddling-minio/${BUCKET}"
  echo "[mc-setup] Bucket '${BUCKET}' created."
fi

# Set anonymous read policy so DuckDB/DuckLake can reach objects via S3 URL
# (only needed for dev/demo; in prod, use IAM-scoped credentials)
mc anonymous set download "waddling-minio/${BUCKET}" || true

echo "[mc-setup] Done. Bucket '${BUCKET}' is ready."
