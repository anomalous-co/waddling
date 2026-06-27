#!/usr/bin/env bash
# Rotate the waddling Cloud SQL mTLS CLIENT certificate (the cert+key the control
# plane and the gateway containers present to authenticate to the shared instance).
#
# WHY: Cloud SQL is TRUSTED_CLIENT_CERTIFICATE_REQUIRED over a public IP. ONE shared
# client cert (`waddling-client`) authenticates two consumers:
#   1. control-api → Cloud SQL via Hyperdrive (the cert is a Cloudflare mTLS-cert object
#      referenced by the Hyperdrive config; workerd can't present a client cert itself).
#   2. gateway containers → Cloud SQL via direct libpq (the PEMs ride as dataplane Worker
#      secrets GW_PG_SSL{CERT,KEY,ROOTCERT}_PEM, materialized to files at boot).
# Both must move together or one side breaks (same failure shape as a DB password change:
# control-api 503s on a stale Hyperdrive cert; gateways throw on the catalog ATTACH).
#
# This rotates the CLIENT cert+key only. The SERVER CA (server-ca.pem) is Google-managed
# and rotates via a separate add→verify→complete flow (`gcloud sql instances
# rotate-server-ca`); push the new CA to the same CF CA-cert object + GW_PG_SSLROOTCERT_PEM
# secret BEFORE completing it.
#
# Strategy is ADD-BEFORE-DELETE (zero-downtime): mint a new cert, wire it everywhere,
# verify, and only THEN retire the old one — and only after warm gateway replicas have
# rolled onto the new cert (they cache cert files at boot; let them idle out, ~10m, rather
# than hard-destroying live containers).
#
# Usage:
#   infra/gcp/rotate-mtls.sh                 # mint + wire + verify (leaves OLD cert active)
#   DELETE_OLD=waddling-client infra/gcp/rotate-mtls.sh   # ALSO retire the named old cert
#
# Prereqs: gcloud authed to the project; wrangler authed to the CF account.

set -euo pipefail

# ── Config (override via env) ────────────────────────────────────────────────────
PROJECT="${PROJECT:-project-bd87157a-f6fd-4d44-830}"
INSTANCE="${INSTANCE:-waddling-main}"
HYPERDRIVE_ID="${HYPERDRIVE_ID:-7e4d9fdb2407458780268e8a529a2c80}"
CF_CA_CERT_ID="${CF_CA_CERT_ID:-24dd5caf-275a-4f84-bb05-79f6830f1a6d}"   # server CA (unchanged here)
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTROL_API_DIR="${REPO_ROOT}/apps/control-api"
DATAPLANE_DIR="${REPO_ROOT}/apps/dataplane/worker"
API_BASE="${API_BASE:-https://api.getwaddling.com}"
NEW_CN="${NEW_CN:-waddling-client-$(date +%Y%m%d-%H%M%S)}"

# ── Scratch dir for key material (700, shredded on exit) ──────────────────────────
WORK="$(mktemp -d)"; chmod 700 "$WORK"
cleanup() { find "$WORK" -type f -exec sh -c 'dd if=/dev/zero of="$1" bs=1k count=4 conv=notrunc 2>/dev/null || true' _ {} \; ; rm -rf "$WORK"; }
trap cleanup EXIT
KEY="$WORK/client-key.pem"; CERT="$WORK/client-cert.pem"

echo "→ [1/6] minting new client cert '$NEW_CN' on $INSTANCE …"
gcloud sql ssl client-certs create "$NEW_CN" "$KEY" \
  --instance="$INSTANCE" --project="$PROJECT" --quiet >/dev/null
chmod 600 "$KEY"
# The public cert isn't in the create payload's key file; fetch it from the API.
gcloud sql ssl client-certs describe "$NEW_CN" \
  --instance="$INSTANCE" --project="$PROJECT" --format='value(cert)' > "$CERT"
grep -q "BEGIN CERTIFICATE" "$CERT" || { echo "✘ cert PEM not retrieved"; exit 1; }
grep -q "BEGIN .*PRIVATE KEY" "$KEY"  || { echo "✘ private key not written"; exit 1; }
echo "  ✓ cert + key materialized (CN=$NEW_CN)"

echo "→ [2/6] uploading new client cert to Cloudflare as an mTLS-cert object …"
UP="$(cd "$CONTROL_API_DIR" && npx wrangler cert upload mtls-certificate \
  --name "$NEW_CN" --cert "$CERT" --key "$KEY" 2>&1)"
NEW_MTLS_ID="$(printf '%s\n' "$UP" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
[ -n "$NEW_MTLS_ID" ] || { echo "✘ could not parse new mTLS cert id from:"; printf '%s\n' "$UP"; exit 1; }
echo "  ✓ new CF mTLS cert id: $NEW_MTLS_ID"

echo "→ [3/6] pointing Hyperdrive ($HYPERDRIVE_ID) at the new client cert …"
# Re-pass the CA id + sslmode EVERY update — a bare update drops the client cert and its
# validation connection fails (SQLSTATE 28000 / 'requires a valid client certificate').
( cd "$CONTROL_API_DIR" && npx wrangler hyperdrive update "$HYPERDRIVE_ID" \
    --mtls-certificate-id "$NEW_MTLS_ID" \
    --ca-certificate-id "$CF_CA_CERT_ID" \
    --sslmode verify-ca >/dev/null )
echo "  ✓ Hyperdrive updated"

echo "→ [4/6] updating dataplane gateway secrets (raw PEM; base64 happens at boot) …"
( cd "$DATAPLANE_DIR" && npx wrangler secret put GW_PG_SSLCERT_PEM < "$CERT" >/dev/null )
( cd "$DATAPLANE_DIR" && npx wrangler secret put GW_PG_SSLKEY_PEM  < "$KEY"  >/dev/null )
echo "  ✓ GW_PG_SSLCERT_PEM / GW_PG_SSLKEY_PEM rotated (warm replicas roll on next cold boot)"

echo "→ [5/6] verifying …"
# (a) Hyperdrive/control-api path:
sleep 4
DB_OK=""; for i in 1 2 3 4 5; do
  if curl -s --max-time 25 "$API_BASE/probe/db" | grep -q '"ok":true'; then DB_OK=1; break; fi
  sleep 5
done
[ -n "$DB_OK" ] && echo "  ✓ control-api /probe/db green (Hyperdrive presents the new cert)" \
                || { echo "  ✘ control-api /probe/db still failing — investigate before deleting the old cert"; exit 1; }
# (b) Direct libpq path (what the gateway does): authenticate to Cloud SQL with the new cert.
if command -v psql >/dev/null 2>&1 && [ -n "${PGHOST:-}" ] && [ -f "${PGSSLROOTCERT:-/nonexistent}" ]; then
  if PGSSLCERT="$CERT" PGSSLKEY="$KEY" PGSSLMODE=verify-ca \
     psql -q -At -c "SELECT 'gw-cert-ok'" >/dev/null 2>&1; then
    echo "  ✓ direct libpq auth with the new cert succeeds (gateway path)"
  else
    echo "  ⚠ direct libpq check skipped/failed (set PGHOST/PGUSER/PGDATABASE/PGPASSWORD/PGSSLROOTCERT to enable)"
  fi
else
  echo "  ⚠ psql verify skipped (set PGHOST/PGUSER/PGDATABASE/PGPASSWORD/PGSSLROOTCERT to enable the gateway-path check)"
fi

echo "→ [6/6] retiring the old cert …"
if [ -n "${DELETE_OLD:-}" ]; then
  echo "  deleting old client cert '$DELETE_OLD' (ONLY safe once warm gateways have rolled, ~10m idle) …"
  gcloud sql ssl client-certs delete "$DELETE_OLD" \
    --instance="$INSTANCE" --project="$PROJECT" --quiet
  echo "  ✓ old cert '$DELETE_OLD' deleted"
else
  echo "  (skipped) old cert left ACTIVE as a fallback. After warm gateways roll onto the"
  echo "  new cert (~10m), retire it:  DELETE_OLD=<old-cn> infra/gcp/rotate-mtls.sh   — or:"
  echo "    gcloud sql ssl client-certs delete <old-cn> --instance=$INSTANCE --project=$PROJECT"
fi

echo "✅ client mTLS cert rotated → CN=$NEW_CN, CF mTLS id=$NEW_MTLS_ID"
