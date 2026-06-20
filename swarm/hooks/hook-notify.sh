#!/usr/bin/env bash
# PostToolUse pub/sub matcher. Fires only on `bb observe ...` (scoped via the
# hook's `if` in settings.json) AND is also invoked inline by `bb observe`
# itself (because Workflow subagents don't fire --settings hooks — see HOOKS.md).
# Rebuilds the FTS index (non-incremental in DuckDB) so the just-written
# observation is searchable, then matches it against every foreign subscription —
# FTS/BM25 for ranked topics, ILIKE/regex for cheap patterns — and drops a
# notification in each subscriber's inbox. Author role comes from $BB_ROLE
# (inherited from the agent's env); stdin JSON is unused.
ROLE="${BB_ROLE:-anon}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BBQ="$(cd "$HERE/../bin" && pwd)/bbq"
cat >/dev/null 2>&1   # drain hook stdin

SQL="
PRAGMA create_fts_index('observations','id','content', stemmer='porter', overwrite=1);
WITH newobs AS (SELECT id, content FROM observations WHERE agent_role='$ROLE' ORDER BY id DESC LIMIT 1)
INSERT INTO notifications(to_role, source_id, sub_id, snippet)
SELECT s.agent_role, n.id, s.id, left(n.content,160)
FROM subscriptions s, newobs n
WHERE s.agent_role <> '$ROLE'
  AND ( (s.match_type='fts'   AND fts_main_observations.match_bm25(n.id, s.pattern) IS NOT NULL)
     OR (s.match_type='ilike' AND n.content ILIKE '%' || s.pattern || '%')
     OR (s.match_type='regex' AND regexp_matches(n.content, s.pattern)) )
  AND NOT EXISTS (SELECT 1 FROM notifications x
                  WHERE x.to_role=s.agent_role AND x.source_id=n.id AND x.sub_id=s.id);
"
# retry: concurrent observes => concurrent index rebuilds can transiently conflict
for i in 1 2 3 4 5; do
  "$BBQ" "$SQL" >/dev/null 2>&1 && break
  sleep 0.2
done
exit 0
