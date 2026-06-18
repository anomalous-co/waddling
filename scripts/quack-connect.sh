#!/usr/bin/env bash
# quack-connect — ATTACH to the waddling gateway via quack and run SQL.
# Usage: ./scripts/quack-connect.sh [--analyst|--etlbot] "SQL"
#
# First gets a fresh session JWT from the MCP server, then connects via
# DuckDB's quack extension and runs the provided SQL.
#
# TABLE NAMING: The gateway's catalog is 'lake' with schema 'sales'.
# Queries MUST use the full server-side path 'lake.sales.orders'.
# The script wraps your SQL in lake.query(...) automatically — just write
# the SQL as you would on the server:
#   ./scripts/quack-connect.sh 'FROM lake.sales.orders LIMIT 5'
#   ./scripts/quack-connect.sh 'SELECT * FROM lake.sales.customers LIMIT 3'

set -euo pipefail

MCP_URL="${MCP_URL:-http://localhost:8810}"
ENDPOINT_ID="${ENDPOINT_ID:-a4c3cb44-640c-44b7-a8da-62795496c922}"

AGENT="analyst"
SQL="${@}"
if [[ "${1:-}" == "--analyst" ]]; then
    AGENT="analyst"
    SQL="${@:2}"
elif [[ "${1:-}" == "--etlbot" ]]; then
    AGENT="etl-bot"
    SQL="${@:2}"
fi

if [[ -z "${SQL:-}" ]]; then
    echo "Usage: $0 [--analyst|--etlbot] '<SQL>'"
    echo "  e.g.: $0 'SELECT * FROM sales.orders LIMIT 5'"
    echo "  e.g.: $0 --etlbot 'SELECT * FROM sales.events LIMIT 3'"
    exit 1
fi

# ── Resolve API key ───────────────────────────────────────────────────────────
case "$AGENT" in
    analyst) API_KEY="${WADDLING_ANALYST_KEY:-sk_agent_analyst_demo}" ;;
    etl-bot) API_KEY="${WADDLING_ETLBOT_KEY:-sk_agent_etlbot_demo}" ;;
    *)       echo "unknown agent: $AGENT"; exit 1 ;;
esac

>&2 echo "==> quack-connect as ${AGENT}"

# ── Get a fresh session JWT via MCP waddling_connect ─────────────────────────
>&2 echo -n "==> getting session... "
SESSION_RESP=$(curl -sf -X POST "$MCP_URL/" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"waddling_connect\",\"arguments\":{\"endpoint_id\":\"${ENDPOINT_ID}\"}},\"id\":1}") || {
    echo "FAILED"
    exit 1
}

JWT=$(echo "$SESSION_RESP" | python3 -c "
import json, sys
lines = sys.stdin.read()
# streamable HTTP wraps result in event:..\ndata:...\n\n
for line in lines.split('\n'):
    if line.startswith('data: '):
        data = json.loads(line[6:])
        sc = data.get('result', {}).get('structuredContent', {})
        print(sc.get('session_jwt', ''))
        break
" 2>/dev/null)

if [[ -z "${JWT}" ]]; then
    echo "FAILED (could not extract JWT)"
    echo "$SESSION_RESP" | head -5
    exit 1
fi

SESSION_ID=$(echo "$SESSION_RESP" | python3 -c "
import json, sys
for line in sys.stdin.read().split('\n'):
    if line.startswith('data: '):
        sc = json.loads(line[6:]).get('result', {}).get('structuredContent', {})
        print(sc.get('session_id', ''))
        break
")
GRANTED=$(echo "$SESSION_RESP" | python3 -c "
import json, sys
for line in sys.stdin.read().split('\n'):
    if line.startswith('data: '):
        sc = json.loads(line[6:]).get('result', {}).get('structuredContent', {})
        print(json.dumps(sc.get('granted', {}), indent=2))
        break
")

>&2 echo "session: ${SESSION_ID:-unknown}"
>&2 echo "granted:"
>&2 echo "$GRANTED" | sed 's/^/> /'

# ── Run the SQL via quack ATTACH ─────────────────────────────────────────────
# The gateway's USE lake means its default catalog is 'lake'.
# The client ATTACH alias is also 'lake', which shadows the server-side catalog.
# So we route through lake.query() to pass SQL verbatim to the server.
>&2 echo -n "==> connecting via quack... "

duckdb -json <<DUCKDB
LOAD httpfs;
LOAD quack;
CREATE SECRET (TYPE quack, TOKEN '${JWT}', SCOPE 'quack:localhost:9500');
ATTACH 'quack:localhost:9500' AS lake (disable_ssl true);
FROM lake.query('${SQL}');
DUCKDB
