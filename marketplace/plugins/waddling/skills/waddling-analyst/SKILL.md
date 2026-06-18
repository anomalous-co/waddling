---
name: waddling-analyst
description: "Use this skill when working with a DuckBase-connected lakehouse: running governed SQL queries, handling structured denials with self-correction, exploring schemas, using time-travel, and understanding ACL constraints. Activates whenever waddling MCP tools are available and the user or task involves querying a lake endpoint."
when_to_use: "Any task that involves reading or writing to a DuckBase endpoint, analyzing lakehouse data, understanding what tables/columns this agent can access, or diagnosing access-denied errors."
allowed-tools: mcp__waddling__waddling_list_endpoints mcp__waddling__waddling_describe mcp__waddling__waddling_connect mcp__waddling__waddling_query mcp__waddling__waddling_explain mcp__waddling__waddling_time_travel mcp__waddling__waddling_whoami
---

# DuckBase Analyst Skill

This skill governs how to use waddling MCP tools correctly and safely for lakehouse analytics.

## Core principle: explain before you query

ALWAYS call `waddling_explain` before `waddling_query` for any query that:
- touches a table you haven't queried in this session
- uses `SELECT *`
- involves a JOIN across schemas
- accesses columns that might be sensitive (names like `ssn`, `email`, `token`, `password`, `secret`, `pii`)

`waddling_explain` is a dry-run: it returns the access decision and row estimate **without auditing** the query. This prevents denial noise in the audit log and gives the agent a chance to rewrite before acting.

```
// Good pattern:
explain_result = waddling_explain({ session_id, sql: "SELECT * FROM sales.customers LIMIT 10" })
if explain_result.allowed:
    result = waddling_query({ session_id, sql: explain_result.rewritten_sql ?? original_sql })
else:
    // self-correct — see Denial Handling below
```

## Session lifecycle

1. Call `waddling_list_endpoints` to find available endpoints.
2. Call `waddling_describe({ endpoint_id })` to see what schemas/tables this agent may access. Note: the response is **already scoped** to your grants — tables you can't access don't appear.
3. Call `waddling_connect({ endpoint_id })` to open a session. Store the `session_id`; it expires in `ttl_seconds` (default 15 minutes).
4. If `waddling_query` or `waddling_explain` returns `{ error: "session_expired" }`, call `waddling_connect` again to renew.

## Handling structured denials (self-correction loop)

DuckBase denials are structured objects, not strings. Read them:

```json
{ "error": "authorization_denied", "table": "sales.customers", "reason": "column_not_granted", "columns": ["ssn"] }
{ "error": "authorization_denied", "table": "events.raw", "reason": "agent_suspended" }
{ "error": "authorization_denied", "table": "orders", "reason": "row_limit_exceeded", "limit": 1000 }
```

Self-correction rules by `reason`:

| reason | Action |
|---|---|
| `column_not_granted` | Remove the denied columns from SELECT. If using `SELECT *`, call `waddling_describe` to get the allowed column list, then rewrite. |
| `row_limit_exceeded` | Add or reduce `LIMIT` to ≤ the stated `limit`. |
| `time_window_denied` | The agent's grant is time-windowed (e.g. business hours). Note the restriction to the user; do not retry until the window opens. |
| `agent_suspended` | Tell the user their agent has been suspended. They need an admin to reinstate it. |
| `table_not_granted` | This table is not in the agent's grants. Call `waddling_describe` to see what IS available, then reroute the query. |
| `session_expired` | Renew via `waddling_connect`. |

NEVER silently swallow a denial and return an empty result. Always surface the denial to the user with context.

## Time travel

Use `waddling_time_travel` for point-in-time reads. Two modes:

```
// By version (DuckLake snapshot integer):
waddling_time_travel({ session_id, table: "sales.orders", at_version: 42 })

// By timestamp (ISO 8601):
waddling_time_travel({ session_id, table: "sales.orders", at_timestamp: "2026-01-01T00:00:00Z" })
```

Use time-travel when:
- The user asks "as of last week / last month / before the migration"
- Debugging unexpected row counts (compare current vs prior snapshot)
- Auditing what data was visible at a specific time

## SELECT * rewriting

DuckBase's gateway enforces column ACLs by rewriting `SELECT *` to the allowed projection. However, prefer explicit column lists in analytical queries anyway — it reduces round-trips and prevents surprises:

```sql
-- Instead of:
SELECT * FROM sales.customers

-- Prefer (after waddling_describe):
SELECT id, name, region, created_at FROM sales.customers
```

## Rate limits and large scans

`waddling_whoami` returns `rateLimitHeadroom`. Check it before bulk scans. For large result sets:
- Use `LIMIT` + `OFFSET` pagination rather than fetching unbounded results
- Check `truncated: true` in `waddling_query` responses — the gateway capped the result set; re-query with stricter limits

## Telemetry and privacy

The DuckBase MCP server sends anonymous usage telemetry (query counts, denial rates — never SQL text, API keys, JWTs, or email addresses). To opt out: set `WADDLING_TELEMETRY=0` in your environment before starting Claude Code.

Events captured by the server (not the plugin): `mcp_connect`, `first_query` (once per agent), `query_executed`, `denial_hit`. See waddling privacy policy for full details.

## Quick reference

```
waddling_whoami          → who am I, what can I access, TTL remaining
waddling_list_endpoints  → available endpoints and status
waddling_describe        → tables/columns scoped to my grants
waddling_explain         → dry-run access check (no audit entry)
waddling_connect         → open session, get attach_sql + session_id
waddling_query           → run governed SQL (audited)
waddling_time_travel     → point-in-time snapshot read
waddling_install_extension → one-liner INSTALL for local birdshot
```
