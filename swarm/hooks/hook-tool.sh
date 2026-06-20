#!/usr/bin/env bash
# PreToolUse/PostToolUse hook: catalog every tool call into the tool table.
# phase 'pre' captures tool_input before the call; 'post' adds tool_response.
#
# NOTE: only fires for sessions launched with --settings pointing at
# hooks/settings.json. Workflow-tool subagents do NOT inherit --settings hooks,
# so the tool table stays empty under Workflow orchestration. See HOOKS.md.
phase="${1:-pre}"             # pre | post
IN=$(cat)
ROLE="${BB_ROLE:-unknown}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BBQ="$(cd "$HERE/../bin" && pwd)/bbq"
SID=$(printf '%s'  "$IN" | jq -r '.session_id // ""')
TOOL=$(printf '%s' "$IN" | jq -r '.tool_name // ""')
TUID=$(printf '%s' "$IN" | jq -r '.tool_use_id // ""')
TIN=$(printf '%s'  "$IN" | jq -c '.tool_input // {}')
TRESP=$(printf '%s' "$IN" | jq -c '.tool_response // null')
DUR=$(printf '%s'  "$IN" | jq -r '.duration_ms // 0')

esc () { printf '%s' "$1" | sed "s/'/''/g"; }     # double single-quotes for SQL
dq ()  { for i in 1 2 3 4 5; do "$BBQ" "$1" >/dev/null 2>&1 && return 0; sleep 0.15; done; }

if [ "$TRESP" = null ]; then RESP_SQL=NULL; else RESP_SQL="'$(esc "$TRESP")'"; fi
dq "INSERT INTO tool(session_id, agent_role, phase, tool_name, tool_use_id, tool_input, tool_response, duration_ms)
    VALUES ('$SID','$ROLE','$phase','$(esc "$TOOL")','$TUID','$(esc "$TIN")', $RESP_SQL, $DUR);"
exit 0
