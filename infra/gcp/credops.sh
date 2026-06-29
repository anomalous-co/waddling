#!/usr/bin/env bash
# waddling — interactive Cloud SQL credential operations.
#
# One menu-driven tool for every mTLS / password operation against the shared
# `waddling-main` instance, so none of it has to be hand-run command-by-command.
# Each consumer of these credentials:
#   • control-api → Cloud SQL via Hyperdrive (CF mTLS-cert object + the DB password
#     baked into the Hyperdrive config; workerd can't present a client cert itself).
#   • gateway containers → Cloud SQL via direct libpq (PEMs ride as the dataplane
#     Worker secrets GW_PG_SSL{CERT,KEY,ROOTCERT}_PEM, materialized to files at boot,
#     carried base64-encoded because the startProcess env channel indents raw PEM).
#
# Every mutation is confirmed; destructive steps (delete cert, complete a CA rotation,
# discard the dual password) are gated behind an explicit yes. Rotations are
# add-before-delete / dual-credential so a half-finished run never locks anyone out.
#
# Secrets never hit stdout or argv where avoidable: passwords use gcloud
# --prompt-for-password / read -s; PEMs/keys live in a 700 tmpdir shredded on exit;
# Worker secrets are piped to `wrangler secret put` over stdin.
#
# Requires: gcloud (authed to the project) + wrangler (authed to the CF account),
# and psql for the optional direct-libpq verification.
#
#   infra/gcp/credops.sh            # interactive menu
#   infra/gcp/credops.sh <1-5>      # jump straight to one operation

set -euo pipefail

# ── Config (override via env) ────────────────────────────────────────────────────
PROJECT="${PROJECT:-project-bd87157a-f6fd-4d44-830}"
INSTANCE="${INSTANCE:-waddling-main}"
HYPERDRIVE_ID="${HYPERDRIVE_ID:-8a86652d8cbb439c911033f8d29dd573}"
DB_USER="${DB_USER:-waddling_app}"
DB_NAME="${DB_NAME:-waddling_control}"
DB_HOST="${DB_HOST:-34.168.85.164}"
DB_PORT="${DB_PORT:-5432}"
API_BASE="${API_BASE:-https://api.getwaddling.com}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTROL_API_DIR="${REPO_ROOT}/apps/control-api"
DATAPLANE_DIR="${REPO_ROOT}/apps/dataplane/worker"
ROTATE_CERT_SH="${REPO_ROOT}/infra/gcp/rotate-mtls.sh"

GA=( --project="$PROJECT" )          # gcloud common args
SQLA=( --instance="$INSTANCE" "${GA[@]}" )

# ── Scratch dir (700, shredded on exit) ──────────────────────────────────────────
WORK="$(mktemp -d)"; chmod 700 "$WORK"
cleanup() { find "$WORK" -type f -exec sh -c 'dd if=/dev/zero of="$1" bs=1k count=8 conv=notrunc 2>/dev/null||true' _ {} \; 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

# ── UI helpers ───────────────────────────────────────────────────────────────────
if [ -t 1 ]; then B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; X=$'\033[0m'; else B=; D=; G=; Y=; R=; X=; fi
say()  { printf '%s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$X" "$*"; }
warn() { printf '  %s⚠%s %s\n' "$Y" "$X" "$*"; }
die()  { printf '  %s✘ %s%s\n' "$R" "$*" "$X" >&2; exit 1; }
confirm() { local a; read -r -p "  ${B}$1${X} [y/N] " a; [[ "$a" =~ ^[Yy] ]]; }

# CF cert ids currently bound to the Hyperdrive config (read live — they change on rotation).
# `wrangler hyperdrive get` prints a banner before the JSON, so slice from the first `{`.
hd_field() { ( cd "$CONTROL_API_DIR" && npx wrangler hyperdrive get "$HYPERDRIVE_ID" 2>/dev/null ) | sed -n '/^{/,$p' | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('mtls',{}).get('$1',''))" 2>/dev/null; }

# Fetch the active server CA PEM (for libpq verification — it always matches the live server).
fetch_server_ca() { gcloud sql ssl server-ca-certs list "${SQLA[@]}" --format='value(cert)' 2>/dev/null | sed -n '1,/END CERTIFICATE/p' > "$WORK/server-ca.pem"; }

verify_hyperdrive() {
  local i; for i in 1 2 3 4 5 6; do
    curl -s --max-time 25 "$API_BASE/probe/db" | grep -q '"ok":true' && { ok "control-api /probe/db green (Hyperdrive path)"; return 0; }
    sleep 5
  done
  warn "control-api /probe/db NOT green yet — Hyperdrive may still be propagating, or the change is bad"; return 1
}

# ── State banner ─────────────────────────────────────────────────────────────────
show_state() {
  say "${B}=== waddling mTLS / Cloud SQL credential ops ===${X}"
  say "  instance ${B}${INSTANCE}${X}  (${PROJECT})   db ${DB_NAME}  user ${DB_USER}"
  say "  ${D}client certs:${X}"
  gcloud sql ssl client-certs list "${SQLA[@]}" --format='value(commonName,expirationTime)' 2>/dev/null \
    | while read -r cn exp; do printf "    • %s  ${D}(exp %s)${X}\n" "$cn" "$exp"; done
  local ca_id mtls_id; ca_id="$(hd_field ca_certificate_id)"; mtls_id="$(hd_field mtls_certificate_id)"
  say "  ${D}hyperdrive ${HYPERDRIVE_ID}: ca=${ca_id:-?} mtls=${mtls_id:-?}${X}"
  say ""
}

# ── 1) Rotate client cert ────────────────────────────────────────────────────────
# Delegates the proven add→wire→verify flow to rotate-mtls.sh (leaves the old cert
# active), then offers to retire the old one.
op_rotate_client_cert() {
  say "${B}[1] Rotate client cert${X} — mint → CF → Hyperdrive → gateway secrets → verify"
  [ -x "$ROTATE_CERT_SH" ] || die "missing $ROTATE_CERT_SH"
  confirm "Proceed with a client-cert rotation?" || { warn "cancelled"; return; }
  # Pass through PG* if the operator exported a working cert/key, so rotate-mtls.sh can run
  # its direct-libpq check; otherwise it self-skips that leg.
  PROJECT="$PROJECT" INSTANCE="$INSTANCE" HYPERDRIVE_ID="$HYPERDRIVE_ID" API_BASE="$API_BASE" \
    bash "$ROTATE_CERT_SH"
  say ""
  if confirm "Retire an OLD client cert now?"; then op_retire_old_cert; fi
}

# ── 2) Retire an old client cert ─────────────────────────────────────────────────
op_retire_old_cert() {
  say "${B}[2] Retire an old client cert${X}"
  mapfile -t CNS < <(gcloud sql ssl client-certs list "${SQLA[@]}" --format='value(commonName)' 2>/dev/null)
  [ "${#CNS[@]}" -gt 0 ] || { warn "no client certs found"; return; }
  local i; for i in "${!CNS[@]}"; do printf '    %d) %s\n' "$((i+1))" "${CNS[$i]}"; done
  local pick; read -r -p "  ${B}which to DELETE${X} (number, blank=cancel)> " pick
  [[ "$pick" =~ ^[0-9]+$ ]] && [ "$pick" -ge 1 ] && [ "$pick" -le "${#CNS[@]}" ] || { warn "cancelled"; return; }
  local cn="${CNS[$((pick-1))]}"
  warn "Deleting a cert is IRREVERSIBLE. Any WARM gateway container still holding it breaks"
  warn "until it cold-boots. Confirm warm replicas have rolled (idle ~10m) — do NOT .destroy() them."
  confirm "Delete client cert '${cn}' now?" || { warn "cancelled"; return; }
  gcloud sql ssl client-certs delete "$cn" "${SQLA[@]}" --quiet && ok "deleted '$cn'"
  # Deleting a cert can poison Hyperdrive's data-plane (opaque "Internal error." on every
  # query even though validation passes). Re-check, and point at the recreate remedy (op 6).
  say "  re-checking Hyperdrive data-plane after delete…"
  verify_hyperdrive || warn "Hyperdrive likely poisoned — run option 6 (Recreate Hyperdrive config) to recover."
}

# ── 3) Rotate DB password (dual-password, zero-downtime) ──────────────────────────
# Only affects control-api (via Hyperdrive). Gateways connect as per-org orguser_* roles,
# not this user, so they are untouched.
op_rotate_password() {
  say "${B}[3] Rotate DB password for '${DB_USER}'${X} (dual-password → update Hyperdrive → discard old)"
  local pw
  if confirm "Auto-generate a strong password? (else you'll be prompted to type one)"; then
    pw="$(openssl rand -base64 30 | tr -d '/+=' | cut -c1-32)"; ok "generated (32 chars)"
  else
    local p2; read -r -s -p "  new password: " pw; echo; read -r -s -p "  confirm: " p2; echo
    [ -n "$pw" ] && [ "$pw" = "$p2" ] || die "empty or mismatch"
  fi
  # 1) Set new password but RETAIN the old (Postgres dual-password) so nothing breaks mid-rotation.
  say "  setting new password (retaining old as dual-password)…"
  gcloud sql users set-password "$DB_USER" "${SQLA[@]}" --password="$pw" --retain-password --quiet \
    || die "set-password failed"
  ok "new password active; old still valid (dual)"
  # 2) Point Hyperdrive at the new password (re-pass the cert ids + sslmode or validation drops the client cert).
  say "  updating Hyperdrive…"
  ( cd "$CONTROL_API_DIR" && npx wrangler hyperdrive update "$HYPERDRIVE_ID" \
      --origin-password "$pw" \
      --ca-certificate-id "$(hd_field ca_certificate_id)" \
      --mtls-certificate-id "$(hd_field mtls_certificate_id)" \
      --sslmode verify-ca >/dev/null ) || die "hyperdrive update failed (old password still works — safe)"
  ok "Hyperdrive updated"
  # 3) Verify the new password works end-to-end BEFORE discarding the old.
  verify_hyperdrive || { warn "leaving the OLD password valid (dual) so you're not locked out — re-run after fixing"; pw=; return; }
  # 4) Offer to write the new value somewhere safe (never echoed to the terminal).
  local out; read -r -p "  write new password to a file? (path, blank=skip) > " out
  if [ -n "$out" ]; then ( umask 077; printf '%s' "$pw" > "$out" ); ok "written to $out (chmod 600)"; fi
  # 5) Discard the old password to COMPLETE the rotation.
  if confirm "Verified. DISCARD the old password now (completes rotation)?"; then
    gcloud sql users set-password "$DB_USER" "${SQLA[@]}" --password="$pw" --discard-dual-password --quiet \
      && ok "old password discarded — rotation complete"
  else
    warn "old password left valid (dual). Discard later with --discard-dual-password."
  fi
  pw=
}

# ── 4) Re-push gateway PEM secrets ───────────────────────────────────────────────
# For when the dataplane GW_PG_SSL*_PEM secrets are stale/corrupt and you want to re-seed
# them from known-good material WITHOUT minting a new cert (e.g. the env-channel PEM bug).
op_repush_gw_secrets() {
  say "${B}[4] Re-push gateway PEM secrets${X} (raw PEM in; base64 happens at boot)"
  local cert key root
  read -r -p "  client cert PEM path (blank=fetch active from gcloud) > " cert
  read -r -p "  client key  PEM path (required — cannot be fetched) > " key
  read -r -p "  server CA   PEM path (blank=fetch active from gcloud) > " root
  if [ -z "$cert" ]; then
    local acn; acn="$(gcloud sql ssl client-certs list "${SQLA[@]}" --format='value(commonName)' 2>/dev/null | head -1)"
    gcloud sql ssl client-certs describe "$acn" "${SQLA[@]}" --format='value(cert)' > "$WORK/c.pem"; cert="$WORK/c.pem"
    ok "fetched active client cert ($acn)"
  fi
  if [ -z "$root" ]; then fetch_server_ca; root="$WORK/server-ca.pem"; ok "fetched active server CA"; fi
  [ -f "$cert" ] && grep -q "BEGIN CERTIFICATE" "$cert" || die "client cert missing/invalid"
  [ -f "$key" ]  && grep -q "BEGIN .*PRIVATE KEY" "$key" || die "client key missing/invalid (required)"
  [ -f "$root" ] && grep -q "BEGIN CERTIFICATE" "$root" || die "server CA missing/invalid"
  confirm "Push GW_PG_SSL{CERT,KEY,ROOTCERT}_PEM to the dataplane?" || { warn "cancelled"; return; }
  ( cd "$DATAPLANE_DIR" && npx wrangler secret put GW_PG_SSLCERT_PEM     < "$cert" >/dev/null )
  ( cd "$DATAPLANE_DIR" && npx wrangler secret put GW_PG_SSLKEY_PEM      < "$key"  >/dev/null )
  ( cd "$DATAPLANE_DIR" && npx wrangler secret put GW_PG_SSLROOTCERT_PEM < "$root" >/dev/null )
  ok "gateway PEM secrets re-pushed (warm replicas pick them up on next cold boot)"
}

# ── 5) Rotate server CA (add → distribute → cutover, with rollback) ───────────────
op_rotate_server_ca() {
  say "${B}[5] Rotate server CA${X} — additive create → distribute new+old → cutover → (rollback if needed)"
  warn "verify-ca clients must TRUST the new CA before the server cuts over to it."
  if confirm "Step A: create a new upcoming server CA (additive, safe)?"; then
    gcloud sql ssl server-ca-certs create "${SQLA[@]}" --quiet && ok "upcoming CA created"
  fi
  # Build a bundle of ALL current server CAs (old + upcoming) so verify-ca passes before AND after cutover.
  gcloud sql ssl server-ca-certs list "${SQLA[@]}" --format='value(cert)' > "$WORK/ca-bundle.pem"
  grep -qc "BEGIN CERTIFICATE" "$WORK/ca-bundle.pem" || die "could not read server CAs"
  say "  CA bundle (old+new) assembled: $(grep -c "BEGIN CERTIFICATE" "$WORK/ca-bundle.pem") cert(s)"
  if confirm "Step B: distribute the bundle to clients (CF CA object + Hyperdrive + GW rootcert secret)?"; then
    local up; up="$(cd "$CONTROL_API_DIR" && npx wrangler cert upload certificate-authority --name "waddling-ca-$(date +%Y%m%d-%H%M%S)" --ca-cert "$WORK/ca-bundle.pem" 2>&1)"
    local newca; newca="$(printf '%s\n' "$up" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
    [ -n "$newca" ] || { printf '%s\n' "$up"; die "could not parse new CA id"; }
    ( cd "$CONTROL_API_DIR" && npx wrangler hyperdrive update "$HYPERDRIVE_ID" \
        --ca-certificate-id "$newca" --mtls-certificate-id "$(hd_field mtls_certificate_id)" --sslmode verify-ca >/dev/null )
    ( cd "$DATAPLANE_DIR" && npx wrangler secret put GW_PG_SSLROOTCERT_PEM < "$WORK/ca-bundle.pem" >/dev/null )
    ok "new CA id $newca bound; rootcert secret updated"
    verify_hyperdrive || warn "verify the distribution before cutover"
  fi
  warn "Step C cuts the server over to the new cert. If clients then fail, run rollback immediately."
  if confirm "Step C: COMPLETE the rotation (server-ca-certs rotate)?"; then
    gcloud sql ssl server-ca-certs rotate "${SQLA[@]}" --quiet && ok "server now presents the new cert"
    if ! verify_hyperdrive; then
      warn "post-cutover verify FAILED."
      if confirm "ROLL BACK to the previous server CA?"; then
        gcloud sql ssl server-ca-certs rollback "${SQLA[@]}" --quiet && ok "rolled back"
      fi
    fi
  fi
  warn "Roll warm gateways (idle ~10m) so they re-read the new rootcert; then you may trim the bundle to new-only."
}

# ── 6) Recreate the Hyperdrive config (recover a poisoned data-plane) ─────────────
# After a client-cert rotation + old-cert deletion, the Hyperdrive config can get stuck
# returning opaque "Internal error." on every query while `hyperdrive update` validation
# passes and direct libpq works — its data-plane connection pool is poisoned and an update
# does NOT flush it. The fix is to recreate the config fresh (same origin + cert objects),
# repoint apps/control-api/wrangler.jsonc, and redeploy.
op_recreate_hyperdrive() {
  say "${B}[6] Recreate Hyperdrive config${X} — recover a poisoned data-plane (new id → wrangler.jsonc → deploy)"
  local ca mtls; ca="$(hd_field ca_certificate_id)"; mtls="$(hd_field mtls_certificate_id)"
  [ -n "$ca" ] && [ -n "$mtls" ] || die "could not read current CA/mTLS cert ids from $HYPERDRIVE_ID"
  say "  reusing cert objects: ca=$ca mtls=$mtls"
  local pw p2; read -r -s -p "  ${DB_USER} DB password (not stored — paste it): " pw; echo
  read -r -s -p "  confirm: " p2; echo
  [ -n "$pw" ] && [ "$pw" = "$p2" ] || die "empty or mismatch"
  confirm "Create a fresh Hyperdrive config against ${DB_HOST}/${DB_NAME} and repoint+deploy control-api?" || { warn "cancelled"; pw=; return; }
  local name="waddling-cloudsql-$(date +%Y%m%d-%H%M%S)"
  local out id
  out="$(cd "$CONTROL_API_DIR" && npx wrangler hyperdrive create "$name" \
    --origin-host "$DB_HOST" --origin-port "$DB_PORT" --database "$DB_NAME" --origin-user "$DB_USER" \
    --origin-password "$pw" --ca-certificate-id "$ca" --mtls-certificate-id "$mtls" \
    --sslmode verify-ca --caching-disabled 2>&1)"; pw=
  id="$(printf '%s\n' "$out" | grep -oE '[0-9a-f]{32}' | head -1)"
  [ -n "$id" ] || { printf '%s\n' "$out"; die "could not parse new Hyperdrive id (create may have failed)"; }
  ok "new Hyperdrive config: $id"
  # Repoint the binding + this script's default, then deploy.
  sed -i '' "s/${HYPERDRIVE_ID}/${id}/g" "$CONTROL_API_DIR/wrangler.jsonc" "${BASH_SOURCE[0]}"
  ok "wrangler.jsonc + credops.sh repointed ${HYPERDRIVE_ID} → ${id}"
  HYPERDRIVE_ID="$id"
  if confirm "Deploy control-api now?"; then
    ( cd "$CONTROL_API_DIR" && npx wrangler deploy >/dev/null ) && ok "deployed"
    verify_hyperdrive && ok "recovered — /probe/db green on the fresh config" \
      || warn "still failing — check the origin/cert/password"
  else
    warn "not deployed. Run: (cd apps/control-api && npx wrangler deploy)"
  fi
  warn "The OLD config ($HYPERDRIVE_ID is now the new one) is abandoned; delete it later with: wrangler hyperdrive delete <old-id>"
}

# ── Menu ─────────────────────────────────────────────────────────────────────────
run_one() {
  case "$1" in
    1) op_rotate_client_cert ;;
    2) op_retire_old_cert ;;
    3) op_rotate_password ;;
    4) op_repush_gw_secrets ;;
    5) op_rotate_server_ca ;;
    6) op_recreate_hyperdrive ;;
    *) warn "unknown option: $1" ;;
  esac
}

if [ "$#" -ge 1 ]; then show_state; run_one "$1"; exit 0; fi

while true; do
  show_state
  say "  1) Rotate client cert        4) Re-push gateway PEM secrets"
  say "  2) Retire an old client cert 5) Rotate server CA"
  say "  3) Rotate DB password        6) Recreate Hyperdrive (recover poisoned data-plane)"
  say "                               q) quit"
  read -r -p "select> " choice
  case "$choice" in
    [1-6]) say ""; run_one "$choice"; say ""; read -r -p "  ${D}press enter to return to the menu${X}" _ ;;
    q|Q|"") say "bye."; exit 0 ;;
    *) warn "pick 1-6 or q" ;;
  esac
done
