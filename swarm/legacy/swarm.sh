#!/usr/bin/env bash
# Autonomous swarm: seed ONE objective, launch waves of identical agents that
# self-organize entirely through the bb toolkit (claim / observe / recall /
# subscribe / inbox). No per-agent instructions, no pre-partitioning.
set -uo pipefail
export PATH="/tmp/bin:$PATH"
export BB_URI="quack:127.0.0.1:9494" BB_TOKEN="bb-dev-token"
REPO=/Users/orchid/mirrir/waddling
SETTINGS=/tmp/hooks/settings.json
LOG=/tmp/swarm-agents.log
: > "$LOG"

/tmp/bb-serve.sh start || { echo "server failed"; exit 1; }
# fresh coordination state; keep the objective + FTS sentinel
bbq "DELETE FROM claims; DELETE FROM subscriptions; DELETE FROM notifications; DELETE FROM agent_memory; DELETE FROM messages; DELETE FROM observations WHERE agent_role<>'system';" >/dev/null

EXPLORER_PROMPT='You are autonomous agent ROLE_X in a swarm. You and your peers share ONE objective and coordinate ONLY through the bb toolkit — there is no other channel. Do exactly this: (1) run /tmp/bin/bb help to learn your tools; (2) /tmp/bin/bb objective; (3) /tmp/bin/bb claims and /tmp/bin/bb recall "<keywords>" to see what is already claimed/known — do NOT repeat it; (4) /tmp/bin/bb claim "<an unclaimed sub-area of the waddling API>" (if TAKEN, pick another); (5) investigate that area by reading the repo at '"$REPO"' with the Read/Grep/Glob tools; (6) record each concrete finding with /tmp/bin/bb observe "<specific, evidence-based finding>" <path:line> — qualify the architecture (auth boundaries, secrets, ACL enforcement, control/data split, failure modes, isolation), do not just describe; (7) /tmp/bin/bb subscribe "<keywords>" --fts --topic <t> for a cross-cutting concern in your area, and check /tmp/bin/bb inbox to fold in peers; (8) when no unclaimed area is left and your inbox is quiet, /tmp/bin/bb note all "<one-line summary>" and stop. Favor depth and exact file references.'

run_agent () {
  local model="$1" role="$2" prompt="$3"
  export BB_ROLE="$role" BB_MODEL="$model"
  claude -p "${prompt/ROLE_X/$role}" --model "$model" \
    --add-dir /tmp --add-dir "$REPO" \
    --allowedTools "Bash(/tmp/bin/bb:*)" "Read" "Grep" "Glob" \
    --settings "$SETTINGS" --output-format json </dev/null \
    | jq -r '"['"$role"'] "+ .result' >> "$LOG" 2>&1
}

echo ">> WAVE 1: explorer-1..4 (haiku) concurrent"
for n in 1 2 3 4; do run_agent haiku "explorer-$n" "$EXPLORER_PROMPT" & done
wait
echo ">> WAVE 2: explorer-5..7 (haiku) concurrent — they build on wave-1 recall/inbox"
for n in 5 6 7; do run_agent haiku "explorer-$n" "$EXPLORER_PROMPT" & done
wait

SYNTH_PROMPT='You are the synthesizer for a swarm that explored the waddling API architecture. Gather the swarm'\''s findings with /tmp/bin/bb recall "<query>" across topics (auth, jwt, secret credential, ACL grant, session, control data plane, multi-tenant isolation, failure). Then record a synthesis: call /tmp/bin/bb observe "SYNTHESIS: <theme> — <conclusion>" <key refs> for each of the ~5 strongest themes and top risks. Finally, print to me a concise architectural qualification: the system'\''s shape, the 3-5 most important risks (with file refs), and a maturity rating. Be grounded strictly in recalled findings.'
echo ">> SYNTHESIS: synthesizer (sonnet)"
run_agent sonnet "synthesizer" "$SYNTH_PROMPT"

echo "===== AGENT OUTPUTS ====="; cat "$LOG"
echo "===== EMERGENT PARTITION (claims the orchestrator never dictated) ====="
bbq "SELECT area, agent_role AS owner FROM claims ORDER BY ts;"
echo "===== observations per agent ====="
bbq "SELECT agent_role, count(*) AS observations FROM observations WHERE agent_role<>'system' GROUP BY agent_role ORDER BY agent_role;"
echo "===== cross-agent notifications delivered (pub/sub proof) ====="
bbq "SELECT n.to_role AS notified, o.agent_role AS about_obs_by, left(n.snippet,80) AS snippet FROM notifications n JOIN observations o ON o.id=n.source_id ORDER BY n.ts LIMIT 20;"
echo "===== straces: agent concurrency (overlapping intervals) ====="
bbq "SELECT agent_role, model, started_at, ended_at FROM straces ORDER BY started_at;"

/tmp/bb-serve.sh stop
