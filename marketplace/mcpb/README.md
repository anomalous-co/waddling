# DuckBase Claude Desktop Extension (.mcpb)

A Claude Desktop Extension (`.mcpb`) that bundles the `@waddling/mcp` server for one-click install in Claude Desktop (consumer app).

## What it does

Installs the DuckBase MCP server into Claude Desktop. The server exposes governed DuckLake query tools to Claude: connect to an endpoint, run ACL-gated SQL, check grants, handle structured denials. No API key is required at install time — the server runs in onboarding mode and guides you through device-link signup on first use.

## Build

```bash
# 1. Build the MCP server first (from repo root):
pnpm --filter @waddling/mcp build

# 2. Pack the .mcpb bundle:
bash marketplace/mcpb/build.sh
# → marketplace/mcpb/waddling-0.1.0.mcpb
```

## Install

**Double-click** `waddling-<version>.mcpb` in Finder (macOS) or Explorer (Windows).

Or drag the file into **Claude Desktop → Settings → Extensions**.

After install, the DuckBase tools appear in Claude's tool list. Type "connect to my waddling lake" or "set up waddling" to begin.

## Configuration

The install dialog shows two optional fields:

| Field | Default | Notes |
|---|---|---|
| DuckBase URL | `https://app.getwaddling.com` | Change only if self-hosting. |
| Disable telemetry | _(empty)_ | Set to `0` to opt out of anonymous usage telemetry. SQL, API keys, JWTs, and emails are NEVER captured. |

## Telemetry

The MCP server sends anonymous events (query counts, denial rates, onboarding funnel) using PostHog. Event names follow the canonical taxonomy (`mcp_connect`, `query_executed`, `denial_hit`, etc.). No SQL text, no API keys, no JWTs, no email addresses are ever captured. To opt out globally, set `WADDLING_TELEMETRY=0` in your environment or set it in the extension configuration screen.

`plugin_installed` is inferred server-side on the first onboarding tool call (`$set_once source: 'plugin'`); no telemetry code runs in the plugin manifest itself.

## Remote connector (coming soon)

A hosted `mcp.getwaddling.com` remote MCP connector is planned. Once available, Claude Desktop users will be able to connect without installing any local extension. See the dashboard for status.
