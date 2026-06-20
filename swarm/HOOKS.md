# Claude Code hook requirements for swarm cataloging

What Claude Code must provide for agents to be **independently ordered, cataloged, and
coordinated** through the shared quackboard — and, honestly, where it currently can't.

The quackboard captures three kinds of agent telemetry, each into its own table:

| Table   | One row per…                  | Written by                          |
|---------|-------------------------------|-------------------------------------|
| `straces` | agent session (start→end)     | `hooks/hook-trace.sh` on SessionStart/SessionEnd |
| `tool`    | tool call (pre + post)        | `hooks/hook-tool.sh` on PreToolUse/PostToolUse   |
| `observations` (+ `notifications`) | qualified finding, fanned out to subscribers | `bb observe` → `hooks/hook-notify.sh` |

## The headline finding: `--settings` hooks do NOT reach Workflow subagents

This is the central requirement and the central limitation. There are **two ways** to
launch swarm agents, and they have **opposite** hook behavior:

1. **Headless CLI** (`claude -p --settings swarm/hooks/settings.json …`): the session and
   every tool call DO fire the configured `SessionStart`/`SessionEnd`/`PreToolUse`/`PostToolUse`
   hooks. `straces` and `tool` populate correctly.

2. **The Workflow tool's `agent()` subagents** (what actually produced this run's
   `quackboard.duckdb`): subagents **do not inherit `--settings` hooks.** Only
   session-level/project settings hooks apply to them. With Workflow orchestration,
   `hook-trace.sh` and `hook-tool.sh` **never fire** — so `straces` and `tool` came out
   **empty (0 rows)** in the shipped DB, even though 8 agents ran and made many tool calls.

That empty `straces`/`tool` pair is not a bug in the scripts; it is the requirement made
visible. **Per-agent session/tool cataloging via `--settings` hooks is available for
CLI-launched agents and unavailable for Workflow subagents.**

### The workaround we shipped: fold the post-hook inline into the verb

Because `observations`/`notifications` are the actual deliverable, we could not let
pub/sub depend on a hook that wouldn't fire. So `bb observe` **calls `hook-notify.sh`
itself**, inline, after every insert (`swarm/bin/bb`, the `observe)` case). It is also
registered as a real `PostToolUse` hook in `settings.json` (scoped with
`if: "Bash(*/bin/bb observe*)"`) — and the matcher is idempotent (rebuilds the FTS index
with `overwrite=1`, dedups notifications with `NOT EXISTS`), so the two paths can both
fire harmlessly. Under Workflow only the inline path runs; under CLI both run; the
result is identical. **160 cross-agent notifications were delivered this way.**

The generalizable rule: **anything that must work under Workflow orchestration belongs
inside the toolkit verb, not in a `--settings` hook.** Hooks are a CLI-only enhancement
layer (catalog/telemetry), not a dependency the coordination protocol can rely on.

## What Claude Code provides that the hooks depend on

For the CLI path, the cataloging hooks rely on these guarantees, all of which hold:

- **Hook events**: `SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`
  (`hooks/settings.json`). `PreToolUse` captures `tool_input` before the call; `PostToolUse`
  adds `tool_response` + `duration_ms`.
- **Stdin JSON payload**: hooks receive a JSON object on stdin with `session_id`,
  `tool_name`, `tool_use_id`, `tool_input`, `tool_response`, `duration_ms`. The scripts parse
  it with `jq` (`hook-tool.sh`). `session_id` is what gives each agent an independent,
  orderable identity in `straces`.
- **Permission-rule `if` scoping**: a `PostToolUse` handler can be gated with
  `if: "Bash(*/bin/bb observe*)"` so the pub/sub matcher fires only on `observe` calls, not
  on every Bash tool use (`hooks/settings.json`).
- **Env inheritance into hook subprocesses**: hooks run as child processes that inherit the
  agent's environment. The cataloging relies on `BB_ROLE` (who is acting), and the quack
  client relies on `BB_URI` / `BB_TOKEN` / `BB_PORT`. **If those aren't exported into the
  agent's env, rows are misattributed to `anon`/`unknown`.** This is a hard requirement: the
  orchestrator must export `BB_ROLE=<role>` (and the connection vars) for every agent, and —
  for CLI agents — pass them through so the hook subprocess sees them. Workflow agents get
  `BB_ROLE` by prefixing each `bb` call (`BB_ROLE=explorer-3 bb observe …`), which is why the
  inline path attributes correctly even with no hooks.

## What the orchestrator must supply (independent of which launch path)

1. **A distinct role name per agent** (`BB_ROLE`). This is the ordering/catalog key. With
   the Workflow tool, the agent prompt instructs each agent to prefix every `bb` invocation
   with `BB_ROLE=<role>`; with the CLI, export it before `claude -p`.
2. **The connection triple** (`BB_URI`/`BB_TOKEN`, optionally `BB_PORT`) so `bbq` reaches the
   served quackboard. Defaults are baked into `bin/bbq` so they survive the
   claude→Bash→hook subprocess boundary, but a non-default port/token must be exported.
3. **Read-only-plus-toolkit tool scoping**: agents get `Read`, `Grep`, `Glob`, and
   `Bash(<swarm>/bin/bb:*)` — not raw `duckdb`/`bbq` — so the only way they touch the
   quackboard is through the documented verbs. (`bypassPermissions` is rejected by the
   nested-agent classifier; use scoped `--allowedTools`.)

## settings.json portability caveat

`hooks/settings.json` is the **one file that cannot self-locate by `dirname`** — hook
commands in JSON are literal strings, so the paths are absolute. Every other script in
`swarm/` resolves its own location at runtime via `${BASH_SOURCE[0]}` and works from any
checkout. If you relocate `swarm/`, regenerate the four absolute paths in `settings.json`
(or template them at setup time).

## Summary: the requirement in one sentence

To add agents *through the swarm*, Claude Code must (a) fire Pre/PostToolUse and
SessionStart/End hooks with a stdin JSON payload and inherited env — which it does **for
CLI-launched agents only** — and (b) for Workflow-orchestrated agents, where those hooks
do **not** fire, the coordination logic (pub/sub) must live inside the toolkit verb
itself; only the optional `straces`/`tool` telemetry is lost, and recovering it would
require Claude Code to extend `--settings` (or an equivalent per-subagent hook surface) to
Workflow subagents.
