# waddling-marketplace

DuckBase plugin marketplace for Claude Code and Claude Desktop.

## Claude Code (CLI / Code desktop) — Plugin install

```shell
# Step 1: Add this marketplace
/plugin marketplace add waddling/waddling-marketplace

# Step 2: Install the plugin
/plugin install waddling@waddling

# Step 3: Walk through signup (creates an account + links this device)
/waddling:setup

# Step 4: Connect to your lake
/waddling:connect
```

That's it. No API key required up front — the plugin runs in onboarding mode and the MCP server persists credentials automatically on first use.

### One-liner (add + install in one step)

```shell
claude mcp add waddling -- npx -y @waddling/mcp@latest
```

This installs the MCP server directly without the marketplace plugin. You won't get the `/waddling:*` commands or the analyst skill, but all data-plane tools work immediately.

## Claude Desktop — .mcpb double-click install

Download the latest `.mcpb` from [releases](https://github.com/waddling/claude-plugin/releases) and double-click it.

Or build from source (requires the repo):

```bash
pnpm --filter @waddling/mcp build
bash marketplace/mcpb/build.sh
# → marketplace/mcpb/waddling-0.1.0.mcpb
```

Then double-click the `.mcpb` file — Claude Desktop installs it automatically.

## Remote connector (coming soon)

A hosted `mcp.getwaddling.com` MCP connector is planned. Once available, no local install will be needed — Claude can connect directly over HTTP.

Watch [https://app.getwaddling.com/docs](https://app.getwaddling.com/docs) for announcements.

## Commands

| Command | Description |
|---|---|
| `/waddling:setup` | Walk through signup → device link → endpoint creation → verify |
| `/waddling:connect` | List endpoints, connect to one, get ATTACH SQL + starter query |
| `/waddling:audit` | Admin: summarize recent denials + live sessions (requires `WADDLING_ADMIN_TOKEN`) |
| `/waddling:status` | Identity, active session, grants, TTL, rate-limit headroom |

## Skills

The `waddling-analyst` skill activates automatically when DuckBase tools are available. It teaches the agent to:
- Call `waddling_explain` before every query (dry-run, no audit entry)
- Self-correct on structured denials (`column_not_granted`, `row_limit_exceeded`, etc.)
- Use time-travel for point-in-time reads
- Rewrite `SELECT *` to the granted column projection

## Privacy and telemetry

The **plugin itself captures no telemetry** — no code runs in the manifest files. Usage telemetry (anonymous query counts, denial rates, onboarding funnel) is sent by the `@waddling/mcp` server process using PostHog. **SQL text, API keys, JWTs, and email addresses are never captured.**

Opt out at any time:
```bash
export WADDLING_TELEMETRY=0
```

The `plugin_installed` event is inferred server-side on the first onboarding tool call (`$set_once source: 'plugin'`).

Event taxonomy (canonical names used server-side): `plugin_installed`, `mcp_onboarding_started`, `device_link_created`, `device_link_claimed`, `signup_completed`, `org_created`, `endpoint_created`, `agent_created`, `mcp_connect`, `first_query`, `query_executed`, `denial_hit`, `upgrade_viewed`, `checkout_started`, `checkout_completed`, `agent_revoked`.

Identity: device is tracked as `device:<uuid>` (persisted to `~/.waddling/device.json`); aliased to `userId` at signup. Every org-scoped event includes `groups: { organization: orgId }`. See [Privacy Policy](https://app.getwaddling.com/privacy) for full details.
