#!/usr/bin/env bash
# run-local.sh — Run the full waddling demo mostly host-native (one Docker dep).
#
# Brings up the whole stack:
#   0. lake-catalog Postgres (Docker, postgres:16) — DuckLake catalog, so the
#      gateway + ingest jobs can write the lake CONCURRENTLY / LIVE.
#   1. PGlite socket server  (control-plane Postgres, pure JS, open port)
#   2. migrate control DB
#   3. seed                  (control DB on PGlite; lake schema in the PG catalog
#                             + local data dir for the parquet — no MinIO)
#   4. gateway               (DuckDB + the macOS birdshot extension + quack :9500,
#                             ctrl :9510)
#   5. waddling landing page (control plane + dashboard on :3100)
#   6. web app instance A    (PGlite federated analytics on :3000)
#   7. web app instance B    (PGlite federated analytics on :3001)
#   8. external MCP server   (streamable HTTP on :8810)
#
# Then prints the login + URLs. Pass --demo to also run the scripted §8 agent
# walkthrough at the end and exit.
#
# The lake uses a real Postgres catalog (not a single-writer DuckDB file), so
# ingest (e.g. scripts/waddling-demo/load-hn.ts) runs while the gateway is up.
#
# Usage:
#   bash scripts/waddling-demo/run-local.sh          # bring up, stay running
#   bash scripts/waddling-demo/run-local.sh --demo   # bring up + run walkthrough
#
# Ctrl-C tears everything down.
set -euo pipefail
set -m  # job control: each background job gets its own process group (PGID=PID)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
LOCAL_DIR="${SCRIPT_DIR}/.local"
LOG_DIR="${LOCAL_DIR}/logs"
mkdir -p "${LOG_DIR}"

# free_port — print an OS-assigned free TCP port. Both Postgres instances bind an
# OPEN port by default so dev never collides with a stale/old instance (fixed
# 5470/5432 was a recurring foot-gun). Override by exporting PG_PORT/LAKE_PG_PORT.
free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>process.stdout.write(String(p)));});'
}

# ── Config (override via env) ────────────────────────────────────────────────
PG_PORT="${PG_PORT:-$(free_port)}"   # PGlite control-plane port (open by default)
LAKE_PG_CONTAINER="${LAKE_PG_CONTAINER:-waddling-lake-pg}"
# LAKE_PG_PORT is resolved in step 0 (reuse a running container's port, else open).
QUACK_PORT="${QUACK_PORT:-9500}"
CTRL_PORT="${CTRL_PORT:-9510}"
APP_PORT="${APP_PORT:-3100}"
MCP_PORT="${MCP_PORT:-8810}"

# Web app (federated analytics) ─────────────────────────────────────────────────
WEB_A_PORT="${WEB_A_PORT:-3000}"
WEB_A_PG_PORT="${WEB_A_PG_PORT:-5432}"
WEB_A_AUTH_PG_PORT="${WEB_A_AUTH_PG_PORT:-5442}"
WEB_A_QUACK_PORT="${WEB_A_QUACK_PORT:-9494}"
WEB_A_DATA_DIR="${WEB_A_DATA_DIR:-${REPO_ROOT}/pgdata-a}"

WEB_B_PORT="${WEB_B_PORT:-3001}"
WEB_B_PG_PORT="${WEB_B_PG_PORT:-5433}"
WEB_B_AUTH_PG_PORT="${WEB_B_AUTH_PG_PORT:-5443}"
WEB_B_QUACK_PORT="${WEB_B_QUACK_PORT:-9495}"
WEB_B_DATA_DIR="${WEB_B_DATA_DIR:-${REPO_ROOT}/pgdata-b}"

# 127.0.0.1 (not 'localhost') forces IPv4 → our PGlite socket server, side-stepping
# any leftover Docker proxy that may be bound to the same port over IPv6.
export DATABASE_URL="postgres://waddling:waddling@127.0.0.1:${PG_PORT}/waddling"
# DUCKLAKE_CATALOG_DSN is exported in step 0 once LAKE_PG_PORT is resolved.
export DUCKLAKE_DATA_PATH="${LOCAL_DIR}/lake/files/"
export BIRDSHOT_EXTENSION_PATH="${REPO_ROOT}/birdshot/build/release/extension/birdshot/birdshot.duckdb_extension"
export GW_SERVER_TOKEN="demo-server-token-change-in-prod"
export BETTER_AUTH_SECRET="demo-better-auth-secret-change-in-prod"
export BETTER_AUTH_URL="http://localhost:${APP_PORT}"
export JWT_ISSUER="http://localhost:${APP_PORT}"
# OAuth/MCP delegated auth: the resource URL Claude binds its token audience to
# (RFC 8707). Control plane verifies against this; mcp-external advertises it.
export WADDLING_MCP_RESOURCE="http://localhost:${MCP_PORT}"
export SKIP_ENV_VALIDATION=1

TSX="npx tsx"
PIDS=()

cleanup() {
  echo ""
  echo "==> shutting down (${#PIDS[@]} processes)"
  for pid in "${PIDS[@]:-}"; do
    [ -n "${pid}" ] && kill -- -"${pid}" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# wait_http <url> <name> [attempts] — poll until HTTP 200 (or any reachable code for /gw/health).
wait_ready() {
  local probe="$1" name="$2" attempts="${3:-40}"
  for ((i=1; i<=attempts; i++)); do
    if eval "${probe}" >/dev/null 2>&1; then
      echo "==> ${name} ready"
      return 0
    fi
    sleep 1
  done
  echo "!! ${name} did not become ready (see ${LOG_DIR})" >&2
  exit 1
}

# Pre-flight: the macOS birdshot extension must exist (built via `make -C birdshot`).
if [ ! -f "${BIRDSHOT_EXTENSION_PATH}" ]; then
  echo "!! birdshot extension not found at ${BIRDSHOT_EXTENSION_PATH}" >&2
  echo "   Build it first:  make -C birdshot" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "!! docker is required for the DuckLake catalog Postgres (container ${LAKE_PG_CONTAINER})." >&2
  exit 1
fi

cd "${REPO_ROOT}"

# Clean-slate boot (FRESH=1, via `pnpm dev:fresh`): wipe the control-plane PGlite
# data dir + the local lake files, and drop the lake-catalog container + its volume
# so step 0 recreates an empty catalog. Everything then reseeds from scratch.
if [ "${FRESH:-}" = "1" ]; then
  echo "==> [fresh] wiping control DB + lake + web app data for a clean-slate boot"
  rm -rf "${LOCAL_DIR}/pgdata" "${LOCAL_DIR}/lake"
  rm -rf "${WEB_A_DATA_DIR}" "${WEB_A_DATA_DIR}-auth" "${WEB_A_DATA_DIR}-private"
  rm -rf "${WEB_B_DATA_DIR}" "${WEB_B_DATA_DIR}-auth" "${WEB_B_DATA_DIR}-private"
  docker rm -f "${LAKE_PG_CONTAINER}" >/dev/null 2>&1 || true
  docker volume rm waddling_lake_pg >/dev/null 2>&1 || true
fi

# 0. Lake-catalog Postgres (real, Dockerized) ──────────────────────────────────
# DuckLake's catalog lives here so the gateway and ingest jobs write concurrently.
# Persisted in a named volume; left running across restarts (not torn down).
# Port: reuse a running container's mapped host port; otherwise bind an OPEN one.
if [ -n "$(docker ps -q -f name="^${LAKE_PG_CONTAINER}$")" ]; then
  LAKE_PG_PORT="$(docker port "${LAKE_PG_CONTAINER}" 5432/tcp | head -1 | sed 's/.*://')"
  echo "==> [0/8] lake-catalog Postgres (reusing running ${LAKE_PG_CONTAINER} :${LAKE_PG_PORT})"
else
  LAKE_PG_PORT="${LAKE_PG_PORT:-$(free_port)}"
  echo "==> [0/8] lake-catalog Postgres (new ${LAKE_PG_CONTAINER} :${LAKE_PG_PORT})"
  docker rm -f "${LAKE_PG_CONTAINER}" >/dev/null 2>&1 || true
  docker run -d --name "${LAKE_PG_CONTAINER}" \
    -e POSTGRES_USER=waddling -e POSTGRES_PASSWORD=waddling -e POSTGRES_DB=ducklake \
    -p "${LAKE_PG_PORT}:5432" -v waddling_lake_pg:/var/lib/postgresql/data \
    postgres:16 >/dev/null
fi
# DuckLake catalog = REAL Postgres (Docker) so the gateway + ingest jobs write the
# lake concurrently/live (a local DuckDB-file catalog is single-writer).
export DUCKLAKE_CATALOG_DSN="dbname=ducklake host=127.0.0.1 port=${LAKE_PG_PORT} user=waddling password=waddling"
wait_ready "docker exec ${LAKE_PG_CONTAINER} pg_isready -U waddling" "lake-postgres"

# 1. PGlite control-plane Postgres ────────────────────────────────────────────
echo "==> [1/8] PGlite control-plane Postgres on :${PG_PORT}"
PGDATA_DIR="${LOCAL_DIR}/pgdata" PG_PORT="${PG_PORT}" \
  ${TSX} "${SCRIPT_DIR}/local/pg-server.ts" >"${LOG_DIR}/pg-server.log" 2>&1 &
PIDS+=($!)
wait_ready "node -e \"require('net').connect(${PG_PORT},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))\"" "postgres"

# 2. Migrate control DB BEFORE anything reads it: waddling schema + every
#    migrations-NNN-*.sql + Better Auth getMigrations (creates the OAuth/mcp
#    tables). Idempotent; runs against the just-started control-plane port.
echo "==> [2/8] migrating control DB (schema + migrations + better-auth/oauth)"
${TSX} "${REPO_ROOT}/scripts/migrate.ts" >"${LOG_DIR}/migrate.log" 2>&1 || {
  echo "!! migrate failed — tail:"; tail -20 "${LOG_DIR}/migrate.log"; exit 1; }
echo "==> migrate complete"

# 3. Seed (runs to completion, then EXITS so the gateway can open the lake) ─────
echo "==> [3/8] seeding control DB + local DuckLake"
GATEWAY_HOST=localhost \
  ${TSX} "${SCRIPT_DIR}/seed.ts" >"${LOG_DIR}/seed.log" 2>&1 || {
    echo "!! seed failed — tail:"; tail -20 "${LOG_DIR}/seed.log"; exit 1; }
echo "==> seed complete"

# 4. Gateway (DuckDB + birdshot + quack) ───────────────────────────────────────
echo "==> [4/8] gateway (quack :${QUACK_PORT}, ctrl :${CTRL_PORT})"
QUACK_PORT="${QUACK_PORT}" CTRL_PORT="${CTRL_PORT}" \
JWKS_URL="http://localhost:${APP_PORT}/api/auth/jwks" \
  ${TSX} "${REPO_ROOT}/packages/gateway/src/index.ts" >"${LOG_DIR}/gateway.log" 2>&1 &
PIDS+=($!)
wait_ready "curl -sf http://localhost:${CTRL_PORT}/gw/health" "gateway"

# 5. Next.js app / control plane ───────────────────────────────────────────────
# DATABASE_URL is passed inline → it's in process.env, which Next.js will NOT
# override from .env.local, so the app always uses the freshly-seeded control DB.
echo "==> [5/8] waddling landing page on :${APP_PORT}"
( cd "${REPO_ROOT}/apps/waddling" && \
  DATABASE_URL="${DATABASE_URL}" PORT="${APP_PORT}" \
  GATEWAY_INTERNAL_URL="http://localhost:${CTRL_PORT}" \
  WADDLING_MCP_RESOURCE="${WADDLING_MCP_RESOURCE}" \
  npx next dev -p "${APP_PORT}" ) >"${LOG_DIR}/app.log" 2>&1 &
PIDS+=($!)
wait_ready "curl -sf http://localhost:${APP_PORT}/api/auth/jwks" "app" 90

# 6. Web app instance A (federated analytics, PGlite + DuckDB + quack) ────────
echo "==> [6/8] web app instance A on :${WEB_A_PORT}"
( cd "${REPO_ROOT}/apps/web" && \
  NEXT_DIST_DIR=.next-a \
  PORT="${WEB_A_PORT}" \
  PG_PORT="${WEB_A_PG_PORT}" \
  AUTH_PG_PORT="${WEB_A_AUTH_PG_PORT}" \
  BASE_URL="http://localhost:${WEB_A_PORT}" \
  BETTER_AUTH_SECRET="instance-a-secret-0123456789abcdef" \
  BIRDSHOT_EXTENSION_PATH="${BIRDSHOT_EXTENSION_PATH}" \
  DATA_DIR="${WEB_A_DATA_DIR}" \
  INSTANCE=A \
  QUACK_PORT="${WEB_A_QUACK_PORT}" \
  QUACK_TOKEN="token-a" \
  PEER_QUACK_PORT="${WEB_B_QUACK_PORT}" \
  PEER_QUACK_TOKEN="token-b" \
  npx next dev -p "${WEB_A_PORT}" ) >"${LOG_DIR}/web-a.log" 2>&1 &
PIDS+=($!)
wait_ready "curl -sf http://localhost:${WEB_A_PORT}/api/auth/jwks" "web-a" 90

# 7. Web app instance B ────────────────────────────────────────────────────────
echo "==> [7/8] web app instance B on :${WEB_B_PORT}"
( cd "${REPO_ROOT}/apps/web" && \
  NEXT_DIST_DIR=.next-b \
  PORT="${WEB_B_PORT}" \
  PG_PORT="${WEB_B_PG_PORT}" \
  AUTH_PG_PORT="${WEB_B_AUTH_PG_PORT}" \
  BASE_URL="http://localhost:${WEB_B_PORT}" \
  BETTER_AUTH_SECRET="instance-b-secret-fedcba9876543210" \
  BIRDSHOT_EXTENSION_PATH="${BIRDSHOT_EXTENSION_PATH}" \
  DATA_DIR="${WEB_B_DATA_DIR}" \
  INSTANCE=B \
  QUACK_PORT="${WEB_B_QUACK_PORT}" \
  QUACK_TOKEN="token-b" \
  PEER_QUACK_PORT="${WEB_A_QUACK_PORT}" \
  PEER_QUACK_TOKEN="token-a" \
  npx next dev -p "${WEB_B_PORT}" ) >"${LOG_DIR}/web-b.log" 2>&1 &
PIDS+=($!)
wait_ready "curl -sf http://localhost:${WEB_B_PORT}/api/auth/jwks" "web-b" 90

# 8. External MCP server ────────────────────────────────────────────────────────
echo "==> [8/8] external MCP server on :${MCP_PORT}"
WADDLING_URL="http://localhost:${APP_PORT}" MCP_HTTP_PORT="${MCP_PORT}" WADDLING_TELEMETRY=0 \
  WADDLING_MCP_RESOURCE="${WADDLING_MCP_RESOURCE}" WADDLING_MCP_OAUTH=1 \
  ${TSX} "${REPO_ROOT}/packages/mcp-external/src/index.ts" --http >"${LOG_DIR}/mcp-external.log" 2>&1 &
PIDS+=($!)
wait_ready "curl -sf http://localhost:${MCP_PORT}/healthz" "mcp-external"

echo ""
echo "════════════════════════════════════════════════════════════"
echo " waddling demo is UP (host-native, no Docker)"
echo "════════════════════════════════════════════════════════════"
echo "  Waddling landing  : http://localhost:${APP_PORT}"
echo "  Login             : admin@acme.test  /  waddling-demo"
echo "  MCP (HTTP)        : http://localhost:${MCP_PORT}   (Bearer = agent API key)"
echo "  Agent keys: analyst  sk_agent_analyst_demo"
echo "              etl-bot  sk_agent_etlbot_demo"
echo "              admin    sk_agent_admin_demo"
echo ""
echo "  Web app instance A : http://localhost:${WEB_A_PORT}"
echo "  Web app instance B : http://localhost:${WEB_B_PORT}"
echo "  Logs               : ${LOG_DIR}/"
echo "════════════════════════════════════════════════════════════"

if [ "${1:-}" = "--demo" ]; then
  echo ""
  echo "==> running scripted §8 walkthrough"
  WADDLING_URL="http://localhost:${APP_PORT}" \
  MCP_EXTERNAL_URL="http://localhost:${MCP_PORT}" \
  WADDLING_API_KEY="sk_agent_analyst_demo" \
  WADDLING_ADMIN_TOKEN="sk_agent_admin_demo" \
  ETLBOT_API_KEY="sk_agent_etlbot_demo" \
    ${TSX} "${SCRIPT_DIR}/agent/index.ts"
  echo ""
  echo "==> walkthrough done; tearing down."
  exit 0
fi

echo ""
echo "Ctrl-C to tear down. (Run with --demo to auto-run the 6-step walkthrough.)"
wait
