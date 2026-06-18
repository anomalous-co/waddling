---
description: "Walk through DuckBase signup: create an account, link this device, create an endpoint, and verify everything is working."
argument-hint: "[email]"
allowed-tools: Bash Read mcp__waddling__waddling_signup mcp__waddling__waddling_signup_status mcp__waddling__waddling_whoami mcp__waddling__waddling_list_endpoints
---

Walk the user through DuckBase onboarding end-to-end.

## Step 1 — Start signup

Call `waddling_signup` with the user's email (use `$ARGUMENTS` if provided, otherwise ask for their email). The tool returns a `device_code` and a `verification_url`.

Show the user:
```
Open this URL to verify your device:
  <verification_url>

Your device code is: <device_code>
(It expires in 15 minutes)
```

## Step 2 — Poll for completion

Call `waddling_signup_status` every 5 seconds until `status` is one of:
- `"completed"` — proceed to Step 3
- `"expired"` — tell the user to run `/waddling:setup` again
- `"error"` — show the `reason` field and stop

While polling, show a one-line status: "Waiting for you to verify in the browser... (<N>s elapsed)"

## Step 3 — Confirm identity

Call `waddling_whoami` (no session_id needed for identity-only queries). Show:
- Agent name and org
- Plan tier
- Any active grants

## Step 4 — Create an endpoint

Endpoint creation requires the dashboard (it provisions a dedicated DuckDB gateway). Tell the user:

```
Next: create your first endpoint in the dashboard.

  https://app.getwaddling.com/dashboard/endpoints/new

Once the endpoint status shows "running", come back and run:
  /waddling:connect
```

## Step 5 — Verify

After the user returns, call `waddling_list_endpoints` and show the list. If any endpoint has `status: "running"`, say: "You're all set. Run `/waddling:connect` to attach to your lake."

If none are running yet, tell them to wait ~30 seconds and try `/waddling:connect` again.

## Error handling

- If any tool call returns `{ error: "onboarding_required" }` — that means no credentials yet; restart from Step 1.
- If any tool call returns `{ error: "unauthorized" }` — tell the user their session may have expired and to run `/waddling:setup` again.
- Never log or display API keys, JWTs, or credential file contents.
