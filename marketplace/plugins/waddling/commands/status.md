---
description: "Show identity, active sessions, granted tables, TTL, and usage headroom for this DuckBase agent."
allowed-tools: mcp__waddling__waddling_whoami mcp__waddling__waddling_list_endpoints
---

Show a full status snapshot for the current DuckBase agent.

## Step 1 — Identity and grants

Call `waddling_whoami` (no session_id — identity query, no session needed). Show:

```
DuckBase Status
───────────────────────────────────
Agent:    <agent.name>  (<agent.id>)
Org:      <org.name>
Plan:     <plan>        (Free / Pro / Enterprise)
API Key:  sk_agent_...  (last 6 chars only)
```

## Step 2 — Active grants

From the `whoami` response, show the grants table:

```
Granted access:
  Schema    Table        Verbs         Row limit   Columns
  sales     orders       read          10,000      all
  sales     customers    read          1,000       id, name (2 of 7)
  events    raw          read, write   —           all
```

If no grants: "No active ACL grants. An admin can create grants at https://app.getwaddling.com/dashboard/acl"

## Step 3 — Session TTL

If `whoami` returns an active session context, show:
```
Active session: <session_id>
  Endpoint:   <endpoint.name>
  Expires in: <ttl_seconds>s
  Started:    <started_at>
```

If no active session, show: "No active session — run `/waddling:connect` to open one."

## Step 4 — Rate-limit headroom

From `whoami.rateLimitHeadroom` (if present):
```
Rate limits:
  Queries remaining (this window): <n>
  Resets in: <seconds>s
```

## Step 5 — Endpoint list

Call `waddling_list_endpoints`. Show one-line per endpoint:
```
Endpoints:
  prod-lake  [running]   quack:gw.getwaddling.com:9501
  staging    [stopped]   —
```

## Error handling

- `{ error: "onboarding_required" }` — show: "Not signed in. Run `/waddling:setup` to get started."
- `{ error: "unauthorized" }` — show: "Session expired or API key invalid. Run `/waddling:setup` to re-authenticate."
- Never display full API keys, JWTs, or passwords.
