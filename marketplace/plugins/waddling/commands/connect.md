---
description: "List your DuckBase endpoints and connect to one, returning the ATTACH SQL and a starter query."
argument-hint: "[endpoint-name-or-id]"
allowed-tools: mcp__waddling__waddling_list_endpoints mcp__waddling__waddling_describe mcp__waddling__waddling_connect mcp__waddling__waddling_explain
---

Connect the agent to a DuckBase endpoint and return ready-to-use SQL.

## Step 1 — List endpoints

Call `waddling_list_endpoints`. Show a numbered list:

```
Your DuckBase endpoints:
  1. prod-lake  [running]  — 3 schemas
  2. staging    [stopped]
```

If no endpoints exist, say: "No endpoints found. Run `/waddling:setup` to create one."

If `$ARGUMENTS` is set, match it against endpoint name or id and skip to Step 2 with that endpoint.

Otherwise, ask the user which endpoint to connect to (number or name).

## Step 2 — Describe the endpoint

Call `waddling_describe` with the chosen `endpoint_id` (no `schema` or `table` — top-level catalog). Show:

```
Schemas you can access:
  - sales: orders, customers, events
  - metrics: daily_rollup
```

If no tables are listed, explain: "Your agent has no active ACL grants. An admin can run `/waddling:status` or use the dashboard → ACL tab to grant access."

## Step 3 — Open a session

Call `waddling_connect` with the chosen `endpoint_id`. From the result:

1. Show the `attach_sql` in a copyable code block:
   ```sql
   -- Paste into your DuckDB session to attach the lake:
   <attach_sql>
   ```

2. Show the session summary:
   - Session ID: `<sessionId>`
   - TTL: `<ttlSeconds>` seconds
   - Granted tables: list `granted.tables[].schema.table`

## Step 4 — First query hint

Call `waddling_explain` with the session_id and a sample query against the first granted table:
```sql
SELECT * FROM <first_schema>.<first_table> LIMIT 5
```

Show the access decision. If `allowed: true`, say:
```sql
-- Try your first query:
SELECT * FROM <first_schema>.<first_table> LIMIT 5
```

If `allowed: false`, show the `reason` and suggest running `/waddling:status`.

## Error handling

- `{ error: "no_active_session" }` — call `waddling_connect` again; sessions last 15 minutes by default.
- `{ error: "authorization_denied" }` — show `reason`, note that an admin can grant access via the dashboard or `/waddling:audit`.
- `{ error: "onboarding_required" }` — run `/waddling:setup` first.
- Never display the raw `session_jwt`; it is security-sensitive.
