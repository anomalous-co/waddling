#!/usr/bin/env bash
# infra/r2/setup-r2.sh — Set up the Cloudflare R2 bucket for birdshot extensions.
#
# Creates the `waddling-ext` bucket, applies a CORS policy (required so the
# DuckDB-Wasm loader can fetch .wasm extensions from a browser), and prints the
# steps to wire up the public custom domain (ext.getwaddling.com).
#
# Prerequisites:
#   npx wrangler login   (or CLOUDFLARE_API_TOKEN set in environment)
#   A Cloudflare zone for getwaddling.com must already exist.
#   For CORS via the S3 API: R2 token creds in R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY.
#
# Usage:
#   CLOUDFLARE_ACCOUNT_ID=xxx bash infra/r2/setup-r2.sh
set -euo pipefail

BUCKET_NAME="waddling-ext"
CUSTOM_DOMAIN="ext.getwaddling.com"
DUCKDB_VERSION="${DUCKDB_VERSION:-v1.5.3}"

info() { echo "[setup-r2] $*"; }
check() { command -v "$1" &>/dev/null || { echo "ERROR: $1 not found"; exit 1; }; }

# wrangler can be invoked via npx if not globally installed.
WRANGLER="${WRANGLER:-npx wrangler@latest}"
check npx

info "Creating R2 bucket: ${BUCKET_NAME}"
${WRANGLER} r2 bucket create "${BUCKET_NAME}" || true

info "Making bucket publicly accessible..."
${WRANGLER} r2 bucket dev-url enable "${BUCKET_NAME}" || true

# ── CORS (required for DuckDB-Wasm browser fetches) ───────────────────────────
# WASM extensions are LOADed by the browser via fetch(); without CORS the
# browser blocks the cross-origin read. Native (non-browser) DuckDB doesn't need
# this, but it's harmless for those requests.
CORS_FILE="$(mktemp)"
cat > "${CORS_FILE}" <<'JSON'
{
  "CORSRules": [
    {
      "AllowedOrigins": ["*"],
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["Content-Length", "Content-Range", "ETag"],
      "MaxAgeSeconds": 3600
    }
  ]
}
JSON

if [[ -n "${R2_ACCESS_KEY_ID:-}" && -n "${R2_SECRET_ACCESS_KEY:-}" && -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]] && command -v aws &>/dev/null; then
  info "Applying CORS policy via S3 API..."
  AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}" \
  AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}" \
  AWS_DEFAULT_REGION=auto \
  aws s3api put-bucket-cors \
    --bucket "${BUCKET_NAME}" \
    --cors-configuration "file://${CORS_FILE}" \
    --endpoint-url "https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com" \
    && info "CORS applied." || info "CORS apply failed — set it in the dashboard (rules below)."
else
  info "Skipping automated CORS (need aws + R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/CLOUDFLARE_ACCOUNT_ID)."
  info "Apply this CORS policy in the R2 dashboard → ${BUCKET_NAME} → Settings → CORS:"
  cat "${CORS_FILE}"
fi
rm -f "${CORS_FILE}"

cat <<EOF

════════════════════════════════════════════════════════════════
R2 bucket ready: ${BUCKET_NAME}
════════════════════════════════════════════════════════════════

Next steps in the Cloudflare dashboard:
  1. R2 → waddling-ext → Settings → Custom Domains
     Add: ${CUSTOM_DOMAIN}
     (This requires a Cloudflare zone for getwaddling.com)

  2. Create an R2 API token for CI uploads (if not done):
     Account → R2 → Manage R2 API Tokens → Create Token
     Permissions: Object Write, Bucket: waddling-ext

  3. birdshot repo GitHub secrets (used by build-birdshot.yml):
       R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY

Layout published by CI:
  Native:  ${CUSTOM_DOMAIN}/${DUCKDB_VERSION}/<platform>/birdshot.duckdb_extension.gz
           (linux_amd64, linux_arm64, osx_amd64, osx_arm64,
            windows_amd64, windows_amd64_mingw)
  WASM:    ${CUSTOM_DOMAIN}/duckdb-wasm/${DUCKDB_VERSION}/<platform>/birdshot.duckdb_extension.wasm
           (wasm_mvp, wasm_eh, wasm_threads)

Verify after first CI publish:
  curl -I https://${CUSTOM_DOMAIN}/${DUCKDB_VERSION}/linux_amd64/birdshot.duckdb_extension.gz
  curl -I https://${CUSTOM_DOMAIN}/duckdb-wasm/${DUCKDB_VERSION}/wasm_eh/birdshot.duckdb_extension.wasm

Install (native):
  SET allow_unsigned_extensions = true;
  INSTALL birdshot FROM 'https://${CUSTOM_DOMAIN}';
  LOAD birdshot;

Load (DuckDB-Wasm):
  SET custom_extension_repository = 'https://${CUSTOM_DOMAIN}';
  LOAD birdshot;   -- fetched from the duckdb-wasm/ path automatically
════════════════════════════════════════════════════════════════
EOF
