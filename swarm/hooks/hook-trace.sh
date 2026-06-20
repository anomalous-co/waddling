#!/usr/bin/env bash
# SessionStart/SessionEnd hook: catalog each agent run into the straces table.
# Role/model come from the parent env (the orchestrator exports them);
# session_id comes from the hook's stdin JSON.
#
# NOTE: this only fires for sessions launched with --settings pointing at
# hooks/settings.json. Workflow-tool subagents do NOT inherit --settings hooks,
# so straces stays empty under Workflow orchestration. See HOOKS.md.
phase="${1:-start}"            # start | end
IN=$(cat)
ROLE="${BB_ROLE:-unknown}"
MODEL="${BB_MODEL:-unknown}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BBQ="$(cd "$HERE/../bin" && pwd)/bbq"
SID=$(printf '%s' "$IN" | jq -r '.session_id // ""')

dq () { for i in 1 2 3 4 5; do "$BBQ" "$1" >/dev/null 2>&1 && return 0; sleep 0.15; done; }

if [ "$phase" = start ]; then
  dq "INSERT INTO straces(session_id, agent_role, model, status) VALUES ('$SID','$ROLE','$MODEL','running');"
else
  dq "UPDATE straces SET status='ended', ended_at=current_timestamp WHERE session_id='$SID' AND status='running';"
fi
exit 0
