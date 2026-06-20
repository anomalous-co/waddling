#!/usr/bin/env bash
# Planner-led swarm on a FRESH blackboard. A single planner decomposes the
# objective into non-overlapping boundaries; explorers then each TAKE a distinct
# boundary (1:1), eliminating the semantic overlap of free-form claims.
set -uo pipefail
export PATH="/tmp/bin:$PATH"
export BB_URI="quack:127.0.0.1:9494" BB_TOKEN="bb-dev-token"
REPO=/Users/orchid/mirrir/waddling
SETTINGS=/tmp/hooks/settings.json
LOG=/tmp/swarm-planned.log
: > "$LOG"

# bare-number query helper (server holds the lock → go through quack)
q1(){ duckdb -noheader -list -c "INSTALL quack; LOAD quack; FROM quack_query('$BB_URI','$1', token => '$BB_TOKEN');" 2>/dev/null | tr -d '[:space:]'; }

/tmp/bb-serve.sh stop 2>/dev/null; sleep 0.4
/tmp/bb-init.sh                       # FRESH db every run
/tmp/bb-serve.sh start || { echo "server failed"; exit 1; }

run_agent () {
  local model="$1" role="$2" prompt="$3"
  export BB_ROLE="$role" BB_MODEL="$model"
  claude -p "${prompt/ROLE_X/$role}" --model "$model" \
    --add-dir /tmp --add-dir "$REPO" \
    --allowedTools "Bash(/tmp/bin/bb:*)" "Read" "Grep" "Glob" \
    --settings "$SETTINGS" --output-format json </dev/null \
    | jq -r '"['"$role"'] "+ .result' >> "$LOG" 2>&1
}

PLANNER_PROMPT='You are the PLANNER for a swarm that will explore and qualify the waddling API architecture. Read the shared objective with /tmp/bin/bb objective and /tmp/bin/bb help. Survey ONLY the repo STRUCTURE at '"$REPO"' (Glob/Grep/Read over apps/control-api/src — routes/, lib/, index.ts, mcp/ — plus apps/dataplane and apps/waddling) enough to identify distinct subsystems. Then decompose the work into EXACTLY 6 boundaries that are mutually exclusive and collectively exhaustive (MECE): partition by FILE OWNERSHIP and CONCERN so that no two explorers would ever need to read the same files. For each boundary call: /tmp/bin/bb plan "<short name>" "<scope: precisely what is IN, and explicitly what is OUT/owned by other boundaries>" <representative path> <path>... Do NOT investigate deeply and do NOT record observations — your ONLY job is a clean partition. When done, print the 6 boundaries you created.'

echo ">> PLANNER (sonnet) — laying down a MECE partition"
run_agent sonnet planner "$PLANNER_PROMPT"

echo ">> PLANNER's BOUNDARIES:"; bbq "SELECT id, name, scope FROM boundaries ORDER BY id;"
N=$(q1 "SELECT count(*) FROM boundaries WHERE status=''open''")
[ -z "$N" ] && N=6
[ "$N" -gt 8 ] && N=8
echo ">> launching $N explorers (haiku), one per boundary, concurrently"

EXPLORER_PROMPT='You are autonomous explorer ROLE_X. A PLANNER has partitioned the work into non-overlapping boundaries. Do exactly this: (1) /tmp/bin/bb help; (2) /tmp/bin/bb objective; (3) /tmp/bin/bb boundaries — choose ONE with status OPEN; (4) /tmp/bin/bb take <id> — if it says ALREADY TAKEN, run bb boundaries again and take a different OPEN one; repeat until you hold exactly one; (5) investigate ONLY within your boundary scope/paths by reading the repo at '"$REPO"' (Read/Grep/Glob) — do NOT read files owned by other boundaries; (6) record each concrete finding with /tmp/bin/bb observe "<specific, evidence-based finding>" <path:line>, qualifying the architecture (risks, boundaries, failure modes); (7) /tmp/bin/bb subscribe "<keywords>" --fts for a cross-cutting concern, and check /tmp/bin/bb inbox to fold in peers; (8) when done, /tmp/bin/bb note all "<one-line summary>" and stop. Stay strictly inside your boundary.'

for n in $(seq 1 "$N"); do run_agent haiku "explorer-$n" "$EXPLORER_PROMPT" & done
wait

SYNTH_PROMPT='You are the synthesizer for a swarm that explored the waddling API architecture. Gather findings with /tmp/bin/bb recall "<query>" across topics (auth, jwt, secret credential, ACL grant, session, control data plane, multi-tenant isolation, failure). Record a synthesis: /tmp/bin/bb observe "SYNTHESIS: <theme> — <conclusion>" <refs> for each of the ~5 strongest themes/risks. Then print a concise architectural qualification: shape, the 3-5 top risks (with file refs), and a maturity rating. Be grounded strictly in recalled findings.'
echo ">> SYNTHESIS (sonnet)"
run_agent sonnet synthesizer "$SYNTH_PROMPT"

echo "===== AGENT OUTPUTS ====="; cat "$LOG"
echo "===== THE PARTITION: each boundary taken by exactly ONE explorer (1:1) ====="
bbq "SELECT id, status, COALESCE(owner,'-') AS owner, name FROM boundaries ORDER BY id;"
echo "===== overlap check: any boundary with >1 owner, or any explorer holding >1? ====="
bbq "SELECT 'boundaries owned' AS k, count(*) AS n FROM boundaries WHERE owner IS NOT NULL
     UNION ALL SELECT 'distinct owners', count(DISTINCT owner) FROM boundaries WHERE owner IS NOT NULL;"
echo "===== observations per agent ====="
bbq "SELECT agent_role, count(*) AS observations FROM observations WHERE agent_role NOT IN ('system') GROUP BY agent_role ORDER BY agent_role;"
echo "===== cross-agent notifications delivered (pub/sub) ====="
bbq "SELECT count(*) AS notifications, count(DISTINCT to_role) AS distinct_subscribers_notified FROM notifications;"
echo "===== straces: planner → concurrent explorers → synthesizer ====="
bbq "SELECT agent_role, model, started_at, ended_at FROM straces ORDER BY started_at;"

/tmp/bb-serve.sh stop
