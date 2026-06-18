# Claude Code Plugin System — Implementation Reference
<!-- Sources: code.claude.com/docs/en/{plugins,plugins-reference,plugin-marketplaces,discover-plugins,skills}.md — verified 2026-06-12 -->

## 1. Plugin Directory Structure

```
waddling/                         # plugin root
├── .claude-plugin/
│   └── plugin.json               # ONLY file that belongs in this dir
├── skills/onboard/SKILL.md       # → /waddling:onboard
├── commands/status.md            # → /waddling:status  (legacy flat format)
├── agents/signup.md
├── hooks/hooks.json
├── .mcp.json
├── bin/                          # added to Bash tool PATH
├── monitors/monitors.json
└── settings.json                 # only "agent" + "subagentStatusLine" keys used
```

## 2. plugin.json — Full Schema

```json
{
  "$schema": "https://json.schemastore.org/claude-code-plugin-manifest.json",
  "name": "waddling",            // required; sets skill namespace /waddling:*
  "displayName": "DuckBase",
  "version": "0.1.0",           // omit → every commit = new version
  "description": "DuckBase onboarding and query tools",
  "author": { "name": "DuckBase", "email": "hi@waddling.dev" },
  "homepage": "https://docs.waddling.dev",
  "repository": "https://github.com/waddling/claude-plugin",
  "license": "MIT",
  "keywords": ["duckdb", "waddling"],
  "defaultEnabled": false,       // opt-in for plugins calling external services
  "skills": "./skills/",
  "agents": ["./agents/signup.md"],
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./.mcp.json",
  "userConfig": {
    "api_endpoint": {
      "type": "string", "title": "API endpoint",
      "description": "DuckBase endpoint", "default": "https://api.waddling.dev"
    },
    "token": {
      "type": "string", "title": "Auth token",
      "description": "Leave blank — onboard skill will obtain it",
      "sensitive": true           // stored in keychain, not settings.json
    }
  }
}
```

## 3. Marketplace — `.claude-plugin/marketplace.json`

```json
{
  "name": "waddling-plugins",
  "owner": { "name": "DuckBase", "email": "hi@waddling.dev" },
  "plugins": [
    {
      "name": "waddling",
      "source": "./plugins/waddling",           // relative path within repo
      // OR: { "source": "github", "repo": "waddling/claude-plugin", "ref": "v0.1.0", "sha": "<40>" }
      // OR: { "source": "npm", "package": "@waddling/claude-plugin", "version": "^0.1.0" }
      // OR: { "source": "git-subdir", "url": "...", "path": "plugins/waddling" }
      "description": "Device-code signup + DuckBase query tools",
      "category": "databases",
      "defaultEnabled": false
    }
  ]
}
```

**Add / install**:
```shell
/plugin marketplace add waddling/claude-plugins    # GitHub owner/repo
/plugin marketplace add https://gitlab.com/org/p.git  # any git URL
/plugin install waddling@waddling-plugins
```

**Team auto-register** (`.claude/settings.json`):
```json
{
  "extraKnownMarketplaces": {
    "waddling-plugins": { "source": { "source": "github", "repo": "waddling/claude-plugins" }, "autoUpdate": true }
  },
  "enabledPlugins": { "waddling@waddling-plugins": true }
}
```

## 4. MCP Server Bundling (`.mcp.json`)

```json
{
  "mcpServers": {
    "waddling": {
      "command": "npx",
      "args": ["-y", "@waddling/mcp@latest"],
      "cwd": "${CLAUDE_PLUGIN_ROOT}",
      "env": {
        "WADDLING_ENDPOINT": "${user_config.api_endpoint}",
        "WADDLING_TOKEN":    "${user_config.token}",
        "WADDLING_STATE":    "${CLAUDE_PLUGIN_DATA}/state"
      }
    }
  }
}
```

**Variable substitutions** (valid in `.mcp.json`, `hooks.json`, `monitors.json`):

| Variable | Value |
|----------|-------|
| `${CLAUDE_PLUGIN_ROOT}` | Plugin cache dir — changes on update |
| `${CLAUDE_PLUGIN_DATA}` | `~/.claude/plugins/data/<id>/` — persistent |
| `${CLAUDE_PROJECT_DIR}` | CWD where Claude Code was launched |
| `${user_config.KEY}` | Value from `userConfig`; sensitive goes to keychain |
| `${ENV_VAR}` | Passthrough from shell |

**Secrets handling**: `userConfig` with `"sensitive": true` → stored in system keychain (not `settings.json`); ~2 KB total limit. Also exported as `CLAUDE_PLUGIN_OPTION_<KEY>` env var to the MCP subprocess.

**Device-code flow**: `userConfig.token` can be blank at install. The MCP server persists the obtained token to `${CLAUDE_PLUGIN_DATA}/state/` after the agent drives the device-code exchange. `userConfig` only needs to seed the endpoint.

## 5. Skills (`SKILL.md`) & Commands

### `skills/onboard/SKILL.md`
```markdown
---
name: onboard
description: Onboard a new DuckBase user via device-code signup. Use when user wants to connect, sign up, or authenticate with DuckBase.
disable-model-invocation: true   # user-only; no auto-trigger
argument-hint: [email]
allowed-tools: Bash Read
---

Walk the user through DuckBase device-code signup:
1. Call `waddling_signup_start` MCP tool with email $ARGUMENTS
2. Display the device code and verification URL
3. Poll `waddling_signup_poll` every 5 s until token received
4. Confirm connection with `waddling_status`
```

### SKILL.md frontmatter — key fields:

| Field | Notes |
|-------|-------|
| `description` | How Claude decides to use skill; truncated at 1536 chars |
| `when_to_use` | Additional trigger context, appended to description |
| `disable-model-invocation` | `true` = user-invoked only |
| `user-invocable` | `false` = Claude-only, hidden from `/` menu |
| `argument-hint` | Autocomplete hint, e.g. `[email]` |
| `allowed-tools` | Pre-approved tools for this skill |
| `model` / `effort` | Override for this skill's turn |
| `context: fork` | Run in isolated subagent |
| `paths` | Glob patterns — auto-load only for matching files |

Commands (`commands/*.md`) use the same frontmatter; prefer `skills/` for new plugins.

## 6. Claude Desktop vs Claude Code — Distribution Matrix

| Surface | Format | Key difference |
|---------|--------|---------------|
| **Claude Code** (CLI + Code desktop GUI) | Plugin via marketplace | `.claude-plugin/plugin.json`; fetched from git/npm; `/plugin install` |
| **Consumer Claude Desktop** (claude.ai app) | `.mcpb` Desktop Extension | Zip with `manifest.json`; Node.js runtime bundled; one-click install |

`.mcpb` (MCP Bundle) supersedes `.dxt` — both still accepted. `manifest.json` declares `server.command/args/env` and `user_config` (generates install-time UI for secrets). Node.js ships with Claude Desktop so no separate runtime needed.

**For DuckBase**: ship a Claude Code plugin (this doc) for developer users; ship a separate `.mcpb` bundle for consumer Claude Desktop. These are independent artifacts.

## 7. Versioning & Update Flow

**Version resolution** (first match wins):
1. `version` in `plugin.json`
2. `version` in marketplace entry (`plugin.json` always wins if both set)
3. Git commit SHA

**Rules**: Omit `version` → every commit = new version (recommended for active dev). Set `version` → must bump manually on every release. Pin exact commit: set `sha` in source.

```shell
/plugin marketplace update waddling-plugins   # refresh catalog
/plugin update waddling@waddling-plugins       # update plugin
/reload-plugins                                # apply in running session

claude plugin validate ./waddling-plugin           # pre-publish check
claude plugin validate ./waddling-plugin --strict  # warnings → errors (CI)
```

Auto-update: `"autoUpdate": true` in `extraKnownMarketplaces`. Disable all: `DISABLE_AUTOUPDATER=1`. Keep plugin auto-updates only: also set `FORCE_AUTOUPDATE_PLUGINS=1`.

Release channels: two marketplace files pointing to different `ref`s (`stable`/`latest`) of the same repo, assigned via managed `extraKnownMarketplaces`.
