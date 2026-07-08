---
name: waddling-analyst
description: "Use when querying a waddling-governed data lake: connect a session, run governed SQL against the lake.schema.table namespace, keep results in the workspace, and self-correct on structured denials. Activates whenever waddling MCP tools are available and the task involves reading lake data."
when_to_use: "Any task that reads a waddling data lake, explores what an agent can access, or diagnoses an access denial."
allowed-tools: mcp__waddling__waddling_list_datalakes mcp__waddling__waddling_whoami mcp__waddling__waddling_connect mcp__waddling__waddling_query
---

# waddling — querying a governed lake

How to read a waddling data lake correctly and safely.

## Orient before you connect

1. `waddling_whoami` — your identity and the **literal grant SQL** you hold. This
   is the reliable way to see what you can touch WITHOUT triggering a denial. Do
   this first.
2. `waddling_list_datalakes` — the lakes you can reach (`{ id, name, slug, status }`).
   Only `status: "running"` lakes are connectable.

Rely on `waddling_whoami` for the tables and columns you're granted — it's the
authoritative view of your access.

## Session lifecycle

3. `waddling_connect({ datalake_id })` → `{ session_id, ttl_seconds, granted }`.
   Keep `session_id`. The lake is attached server-side as `lake` — you do NOT run
   `ATTACH` yourself.
4. `waddling_query({ session_id, sql })` — reference tables as
   `lake.<schema>.<table>` (e.g. `SELECT id, amount FROM lake.sales.orders LIMIT 100`).
5. If a call returns `{ error: "needs_configure" }` (or the session went cold), call
   `waddling_connect` again and retry. On the local `@waddling/mcp` server this
   happens automatically — you won't normally see it.

## Query well

- Prefer explicit column lists over `SELECT *` — clearer intent, and you won't ask
  for columns you aren't granted.
- Materialize anything you want to reuse as a table in your workspace's `main`
  schema — it persists across sessions: `CREATE TABLE main.x AS SELECT …`. Loose
  files and non-`main` schemas are scratch.

## Handle structured denials — never swallow them

Denials are objects, not strings: `{ error: "authorization_denied", table, reason }`.
Read `reason` and self-correct:

| reason mentions | Action |
|---|---|
| a column not granted | Remove that column from the SELECT. Check `waddling_whoami` for the allowed set. |
| a table not granted | Not in your grants. Use the `waddling-access` skill to request it, or pick a granted table. |
| row cap / `truncated: true` | Your grant caps rows; the result was truncated. Narrow with WHERE/LIMIT. |
| suspended / revoked | Your agent's access was pulled. Tell the user; an owner must restore it. |

Always surface a denial to the user with context — do not return an empty result as
if it were the answer.
