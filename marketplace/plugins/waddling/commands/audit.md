---
description: "Admin: summarize recent access denials and live sessions. Requires WADDLING_ADMIN_TOKEN. If not set, explains how to upgrade."
argument-hint: "[org-id] [--since 1h]"
allowed-tools: mcp__waddling__waddling_admin_audit mcp__waddling__waddling_admin_list_sessions mcp__waddling__waddling_admin_usage mcp__waddling__waddling_admin_endpoint_status mcp__waddling__waddling_whoami
---

Show recent audit events and live session state. Admin tools require `WADDLING_ADMIN_TOKEN` in the environment.

## Step 1 — Check admin access

Call `waddling_whoami` (no session_id). If the response includes `plan: "free"` or there is no admin capability field, show:

```
The /waddling:audit command requires a Pro or Enterprise plan and WADDLING_ADMIN_TOKEN.

  - Upgrade at: https://app.getwaddling.com/dashboard/billing
  - Once upgraded, set WADDLING_ADMIN_TOKEN in your shell and re-run this command.

On the Free plan you can still view audit logs directly at:
  https://app.getwaddling.com/dashboard/audit
```

Stop here if no admin token is available. Do not attempt admin tool calls if WADDLING_ADMIN_TOKEN is not set.

## Step 2 — Parse arguments

From `$ARGUMENTS`:
- If an org-id is present (looks like a UUID or slug), use it as `org_id` in queries
- If `--since <duration>` is present (e.g. `--since 2h`, `--since 30m`), convert to an ISO timestamp (now minus duration) for the `since` param
- Default: last 1 hour of events

## Step 3 — Recent denials

Call `waddling_admin_audit` with:
- `decision: "deny"`
- `since: <computed>` (default: 1 hour ago as ISO string)
- `limit: 25`
- `org_id` if provided

Show a table:

```
Recent denials (last 1h):
  Agent           Table                    Reason               When
  analyst         sales.customers          column_not_granted   14:32:01
  etl-bot         events.raw               agent_suspended      14:28:44
```

If none, show: "No denials in the last <window>. All queries allowed."

## Step 4 — Live sessions

Call `waddling_admin_list_sessions` with `status: "active"` and optional `org_id`.

Show:
```
Live sessions:
  Agent           Endpoint      Started      Expires In
  analyst         prod-lake     14:30:00     8m
  etl-bot         prod-lake     14:29:15     10m
```

If none, show: "No active sessions."

## Step 5 — Usage snapshot

Call `waddling_admin_usage` with `period: "today"` and optional `org_id`. Show:
- Queries today / this month
- Rows scanned today
- Active session count

## Step 6 — Endpoint health

Call `waddling_admin_endpoint_status` (no endpoint_id = all endpoints). Show status for each: running/stopped, birdshot policy size, session count, audit buffer depth.

## Error handling

- If any admin tool call returns `{ error: "forbidden" }` or `{ error: "upgrade_required" }` — show the upgrade message from Step 1.
- If `{ error: "unauthorized" }` — say: "WADDLING_ADMIN_TOKEN is set but invalid. Check that it matches an admin user's token."
- Never display raw tokens or credentials.
