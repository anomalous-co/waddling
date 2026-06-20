# swarm — a multi-agent quackboard on a quack-served DuckDB

An experimental substrate for orchestrating many Claude agents that coordinate **only**
through a shared DuckDB file served over the **quack** wire protocol. One long-lived
`duckdb` process holds the file's single-writer lock and serves it; every agent reads and
writes concurrently through a tiny CLI (`bb`) that routes stateless `quack_query` calls to
that server. DuckDB MVCC gives real concurrent reads *and* writes with no lock contention
on the client side.

This directory was lifted out of `/tmp` (where it was built and proven) into the repo,
with all hardcoded `/tmp` paths rewritten to be relocatable. **It is a research artifact —
not wired into the waddling app.** For how this maps onto waddling's data plane as a
per-org feature, see [`docs/per-org-duckdb.md`](docs/per-org-duckdb.md). For the Claude
Code hook story (and why `straces`/`tool` are empty), see [`HOOKS.md`](HOOKS.md).

## What's here

```
swarm/
├── quackboard.duckdb         # the RESULT of one full run (read-only artifact, see below)
├── bin/
│   ├── bbq                   # stateless quack client: routes one SQL string to the server
│   └── bb                    # the agent toolkit — documented verbs over the quackboard
├── hooks/
│   ├── settings.json         # Claude Code --settings: Session/Pre/PostToolUse hooks
│   ├── hook-trace.sh         # SessionStart/End  -> straces (CLI-launched agents only)
│   ├── hook-tool.sh          # Pre/PostToolUse   -> tool    (CLI-launched agents only)
│   └── hook-notify.sh        # FTS pub/sub matcher: new observation -> subscribers' inboxes
├── bb-init.sh                # (re)create a FRESH quackboard with schema + objective + FTS
├── bb-serve.sh               # start|stop the long-lived quack server
├── waddling-arch-swarm.workflow.js  # the Workflow script that produced quackboard.duckdb
├── HOOKS.md                  # report: Claude Code hook requirements for the swarm
└── docs/per-org-duckdb.md    # report: hosting this per-org in waddling's data plane
```

## The toolkit (`bb`)

Agents are given `Read`/`Grep`/`Glob` + `Bash(swarm/bin/bb:*)` and nothing else; the
quackboard is reachable only through these verbs. Run `bin/bb help` for the full guide.

- **Orient**: `bb objective`, `bb help`
- **Coordinate**: `bb boundaries` / `bb take <id>` (work a planner's MECE partition) or
  `bb claim "<area>"` (ad-hoc, race-safe via a `PRIMARY KEY`)
- **Recall**: `bb recall "<query>"` — BM25-ranked full-text search over every peer's
  observations (run FIRST to build on what's known)
- **Record**: `bb observe "<finding>" <ref>…` — a qualified finding with `path:line` refs;
  this is the deliverable, and each one fans out to subscribers
- **Private memory**: `bb remember <key> "<txt>"` / `bb mine [q]`
- **Pub/sub**: `bb subscribe "<pattern>" [--fts|--ilike|--regex]` then `bb inbox`
- **Talk**: `bb note <role|all> "<msg>"`

`BB_ROLE` scopes everything an agent writes; it must be set per agent (the Workflow agents
prefix every call with `BB_ROLE=<role>`).

## Run it

```bash
cd swarm

# 1. fresh quackboard (optional objective arg; destroys prior data)
./bb-init.sh "Your objective here"

# 2. start the quack server (defaults: 127.0.0.1:9494, token bb-dev-token)
./bb-serve.sh start
#    use a non-default port to avoid clashing with other projects:
#    BB_PORT=9495 BB_URI=quack:127.0.0.1:9495 ./bb-serve.sh start

# 3. drive agents. The proven path is the Workflow tool — see
#    waddling-arch-swarm.workflow.js (planner -> parallel explorers -> synthesizer),
#    each agent prefixing  BB_ROLE=<role> swarm/bin/bb …
#    (Set BB_URI/BB_PORT in the agents' env if you changed them above.)

# 4. inspect / teardown
BB_ROLE=me ./bin/bb recall "auth"
./bb-serve.sh stop
```

The orchestrator is the **Workflow tool**, not a background `claude -p` swarm — the
included `.workflow.js` is the exact script that produced `quackboard.duckdb`. (Two earlier
bash orchestrators are preserved verbatim under `legacy/`; they reference `/tmp` paths and
are superseded.)

## The shipped artifact: `quackboard.duckdb`

A clean, WAL-folded snapshot of one complete run against the objective *"explore and
qualify the architecture of the waddling API."* It is self-consistent — open it directly:

```bash
duckdb swarm/quackboard.duckdb "SELECT agent_role, left(content,80), refs FROM observations ORDER BY id"
```

Contents:

| Table           | Rows | Notes |
|-----------------|------|-------|
| `observations`  | 122  | qualified findings with `path:line` refs — the corpus |
| `boundaries`    | 6    | the planner's MECE partition, each owned 1:1 by one explorer |
| `notifications` | 160  | cross-agent pub/sub deliveries (proof the FTS matcher fired) |
| `subscriptions` | 7    | topic/pattern subscriptions agents registered |
| `messages`      | 6    | direct `bb note` messages |
| `straces`       | **0** | empty by design — see HOOKS.md (Workflow subagents don't fire `--settings` hooks) |
| `tool`          | **0** | same reason |

The empty `straces`/`tool` are not a defect; they are the central finding of
[`HOOKS.md`](HOOKS.md).

## Notes / known beta-quirks

- **quack `ATTACH` is broken** in this DuckDB beta ("Catalog does not exist") — `bbq` uses
  stateless `quack_query`, which works for reads *and* writes, including multi-statement.
- **FTS is non-incremental**: `hook-notify.sh` and `bb-init.sh` rebuild the index with
  `PRAGMA create_fts_index(..., overwrite=1)` after writes (N is small).
- **macOS dual-stack**: pin both server and client to explicit `127.0.0.1` (a `localhost`
  server binds `::1` and a `127.0.0.1` client misses it).
- The server must `LOAD fts` at startup or `match_bm25` won't forward through `quack_query`.
- Single static dev token, allow-all authorization — **local experiment only.** Real
  per-org tenancy is exactly what `docs/per-org-duckdb.md` addresses.
