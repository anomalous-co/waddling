# gateway-rivet-poc

A proof of concept: run the **waddling native gateway** (DuckDB + the native
`birdshot.duckdb_extension` + `quack_serve`) **inside a Rivet actor**, one actor
per endpoint — and prove birdshot actually *enforces* ACLs in that environment.

This exists because the earlier idea — DuckDB *in a Cloudflare Durable Object* —
**cannot load birdshot**. See "Why not Workers/DO" below.

---

## How the gateway scales in production today (the thing we're re-platforming)

From `waddling-context/ARCHITECTURE.md` + `packages/gateway`:

- **One DuckDB gateway per org/endpoint.** "Orgs connect their lakehouses
  (DuckLake on R2/S3) to waddling-managed DuckDB gateway endpoints." The catalog
  models it explicitly: `endpoint.status ∈ provisioning|running|stopped|error`,
  and `waddling_admin_provision_endpoint` "spins up a new endpoint."
- **Each gateway is a long-lived native process** (`packages/gateway`, run as
  `Dockerfile.gateway`): boots in-memory DuckDB, `LOAD`s birdshot, creates the
  S3/R2 secret, `ATTACH`es the org's DuckLake, and runs `quack_serve` so agents
  steer **their own** DuckDB to `ATTACH` over the quack wire. birdshot enforces
  per-agent ACLs via quack's auth/authz hooks.
- **Maintenance is per-endpoint** (`Lakekeeper`, §10): a nightly Cloudflare Cron
  Trigger per endpoint.

So the production unit is already a **per-endpoint, long-lived, stateful
process**. That is precisely an actor. Rivet gives you the addressing
(`getOrCreate([org, endpoint])`), lifecycle, hibernation, and routing you would
otherwise hand-build around the container.

---

## Why **not** Workers / Durable Objects (why this PoC pivoted)

| Requirement | Workers/DO (workerd) |
|---|---|
| Run native `@duckdb/node-api` | ❌ V8 isolate, no native addons |
| `LOAD` native `birdshot.duckdb_extension` | ❌ can't load native code; would need a WASM rebuild of birdshot |
| `quack_serve` (listening socket + thread) | ❌ workerd forbids listeners/threads |

DuckDB-**WASM** *can* run in a DO (`@ducklings/workers`), but its extensions are
statically compiled with **no runtime `LOAD`**, and there is no quack. So
"load the birdshot extension" rules out the isolate entirely.

A Rivet actor in **Runner mode** is a real Node process → all three rows above
become ✅, and the existing `bootDuckRuntime()` runs **unchanged**.

---

## Architecture this PoC implements

```
            Rivet client / control plane
                       │  actions (boot, applyPolicy, quackPort, …)
                       ▼
   ┌─────────────────────────────────────────────────────────┐
   │  Rivet actor  key = [orgId, endpointId]   (Runner mode)   │
   │  ─ c.vars.rt: DuckRuntime  (native, ephemeral)            │
   │       └ bootDuckRuntime():  DuckDB + LOAD birdshot        │
   │                              + ATTACH lake (DuckLake)     │
   │                              + quack_serve :<free port>   │
   └─────────────────────────────────────────────────────────┘
                       ▲
        agent's OWN DuckDB  ──ATTACH 'quack:host:port' (TOKEN <jwt>)──┘
        (verify.ts plays this role over loopback)
```

- The actor **reuses the real gateway code** — it imports `bootDuckRuntime`,
  `applySnapshot`, `birdshotStatus` from `packages/gateway/src/duck.ts`. No fork.
- The non-serializable `DuckRuntime` lives in `c.vars` (rebuilt on wake); the
  lake (DuckLake on disk locally, **R2 in prod**) is the source of truth.
- Each actor gets its **own quack port** (the gateway env hardcodes 9500; many
  actors per runner would collide).

---

## Fork B status: tunnel PROVEN; per-agent-actor DuckDB BLOCKED

**Fork B transport works.** quack is HTTP request/response, so the agent's DuckDB
tunnels through Rivet with an `onRequest` reverse-proxy (no WebSocket needed):

```
agent DuckDB ──quack:127.0.0.1:7800──▶ proxy ──RivetKit.fetch──▶
   gatewayActor.onRequest ──▶ loopback http://localhost:<quackPort> ──▶ quack/birdshot
```

`npm run verify:b` (external, standalone DuckDB) passes end-to-end:
```
[4] external DuckDB ATTACHed via proxy quack:127.0.0.1:7800 (through Rivet)
[5] SELECT allowed → [{id:1,val:'ok'},{id:2,val:'fine'}]
[6] SELECT secret  → DENIED: Authorization failed
✅ quack tunnelled through Rivet; birdshot enforced end-to-end
```
The hop log shows multiple `POST /quack → 200` (handshake + queries) — quack's
request/response wire tunnels cleanly, **no session-affinity breakage**, so the
WebSocket fallback is unnecessary.

**Per-agent resumable DuckDB-as-actor is blocked by a rivetkit-runtime issue.**
`src/registry.ts`'s `agent` actor (one per agent, own DuckDB in vars, durable
`c.state`) demonstrates the resumable lifecycle correctly — `npm run verify:resumable`
shows real hibernation and re-establish:
```
[agent agent-demo] WAKE — durable queries so far: 0
[agent agent-demo] cold — rebuilding DuckDB + re-ATTACH from state
[agent agent-demo] SLEEP — dropping in-memory DuckDB, keeping state
```
…but the in-actor DuckDB's quack **scan** fails with `Invalid Input Error:
Missing hostname` (the ATTACH handshake succeeds — proxy logs 5× `POST /quack
→ 200` — then the scan fails *client-side*). This is **specific to running
DuckDB's quack client inside the rivetkit actor runtime**, proven by two
controls:
- `npm run verify:b` — same client, same proxy, **normal process** → works.
- `npm run diag:same-process` — quack client **and** server in one plain process
  (no Rivet) → works. So it is **not** a quack same-process collision and **not**
  the transport; it's the rivetkit execution context vs DuckDB's native httpfs.

**Implication for "resumable independent DuckDB per agent":** the durable
per-agent actor (state, hibernate/wake, resume) is sound; the agent's *DuckDB*
should run where its native httpfs works — as a **separate process** the actor
supervises (sidecar/pool), or fix the rivetkit-runtime networking interaction.
The cross-Rivet transport itself is done. (In production, agent and gateway are
separate pools/processes anyway — which `verify:b` already models.)

### Limits to note (not solved here)

`onRequest` has no streaming responses yet and a 20 MiB response cap (Rivet
issue #3529), so large result sets need pagination or a lower-level transport.
PoC-sized queries are fine. "Resumable" = the actor durably re-establishes
(re-create DuckDB, re-ATTACH from `c.state`) on wake; the in-memory working set
(temp tables, loaded data) is **not** preserved — that needs the DB file
persisted to actor storage, a separate spike.

## Managed, resumable per-agent DuckDB — WORKS via a sidecar split

The fix for the in-actor DuckDB failure: don't run DuckDB *in* the actor. The
agent actor **supervises a DuckDB sidecar** (a plain child process, where native
httpfs works — proven `spawn`able + reachable from actor context) and owns
durability. `src/registry.ts` `agentSidecar` + `src/sidecar.ts`:

```
agentSidecar actor (rivetkit)              sidecar (plain child process)
  ├─ spawn(tsx src/sidecar.ts) ───────────▶ DuckDB on a persistent file
  ├─ query(sql) ──node fetch loopback────▶   /query, /run, /attach
  ├─ on cold start: restore DB file from c.kv (chunked) → local disk
  └─ on hibernate:  CHECKPOINT+exit sidecar → read file → persist to c.kv
```

`npm run verify:managed` passes, including the honesty check (it **wipes the
local DB file** so the data can only return via Rivet KV):

```
[2] agent wrote a PRIVATE table → [{id:1,body:'remember this'},{id:2,body:'and this'}]
[3] hibernated: persisted to Rivet KV + WIPED local file → { chunks: 5, localWiped: true }
[4] queried after wake (DB had to come from KV) → [{id:1,...},{id:2,...}]
✅ managed per-agent DuckDB survived eviction via Rivet actor KV
```

So **yes — Rivet maintains the db.** A per-agent DuckDB's private working set
survives a reschedule, and the agent runs nothing locally. Mechanics:
- DuckDB file is split into 120 KiB chunks across `c.kv` (per-value cap 128 KiB),
  `db:meta` holds {count,size}; `npm run diag:chunk` proves chunk→KV→reassemble
  is sha256-identical and reopens as a valid DB.
- The sidecar `DETACH`es the lake + `CHECKPOINT`s and exits before snapshotting,
  so the file is consistent and self-contained (WAL folded in, no stale attach).
- The same sidecar `ATTACH`es the gateway through Rivet (`/attach`, reusing the
  `verify-b` path) — so the agent's managed DuckDB also reaches the governed lake.

`npm run verify:full` (needs engine + `dev` + `proxy`) shows the whole thing in
one run for a single agent:

```
[2] PRIVATE table written → [{id:1, body:'private note'}]
[3] GOVERNED lake query (through Rivet) → [{id:1,val:'ok'},{id:2,val:'fine'}]
[4] ungranted lake.secret denied by birdshot: true
[5] hibernated: { persisted: true, chunks: 5, localWiped: true }
[6] PRIVATE table after wake (from KV) → [{id:1, body:'private note'}]
[7] GOVERNED lake after wake (session auto-resumed) → [{id:1,val:'ok'},{id:2,val:'fine'}]
[8] ungranted still denied after wake: true
```

The session token + proxy live in the actor's durable `c.state`, so after
hibernation the gateway attach is re-established automatically on the next query
(best-effort: a gateway outage doesn't block the agent's own private DB).

**Scope honesty:** the lake data is already durable in R2; what KV persistence
buys is the agent's **private/scratch tables** surviving across sessions — a real
capability, but frame it as "private working set survives," not "the database"
generically. The in-memory working set during a live session is bounded by the
sidecar's RAM, and persistence happens at hibernate/checkpoint (not per-write).

## Two forks — keep them separate

- **(A) Can the native stack run *inside* a Rivet actor, with birdshot
  enforcing?**  ← **this PoC.** Answered by `verify.ts`: a TOKEN'd quack client
  runs a granted query (✓) and an ungranted query (denied ✓).
- **(B) Can an *external* agent `ATTACH` to quack *through Rivet's gateway*?**
  ← **the next spike, unproven.** waddling's pitch is "agents steer their own
  DuckDB to ATTACH." Through Rivet that means tunnelling quack's wire over
  `onWebSocket` → `localhost:<port>`. If it doesn't tunnel cleanly, agents send
  SQL over a Rivet **action** while the actor holds an internal per-agent quack
  client (the loopback pattern here becomes the production design — and the
  agent UX changes from "ATTACH" to "call an MCP/HTTP query API").

**Success on (A) is not "Rivet validated."** It's validated when (B) is answered.

---

## Run it (local dev)

```bash
cd gateway-rivet-poc
npm install            # rivetkit + jose + tsx  (does NOT touch the pnpm workspace)

# terminal 1 — start the actor runtime (local dev server on :6420)
npm run dev

# terminal 2 — prove enforcement
npm run verify
```

> Local dev needs the Rivet engine running too. `registry.start()` connects to
> an engine on :6420 (it does **not** embed one). Start it first:
> `./node_modules/@rivetkit/engine-cli-*/rivet-engine start` (the
> platform binary npm installed), then `npm run dev`, then `npm run verify`.

**Actual output of a passing run (executed):**

```
[1] actor booted: { booted: true, quackPort: 50686 }
[3] birdshot_status() in-actor: { raw: 'mode=rs256 issuer=poc-issuer roles=1 users=1 jwks=1 ...' }
[6] agent ATTACHed to quack:localhost:50686
[7] SELECT allowed → [ { id: 1, val: 'ok' }, { id: 2, val: 'fine' } ]
[8] SELECT secret → DENIED: Invalid Input Error: Authorization failed
✅ PASS — birdshot enforced ACLs inside the Rivet actor (allowed ✓, denied ✓)
```

The `Authorization failed` on `secret` (vs. rows from `allowed`) is birdshot's
authz hook firing on a real TOKEN'd quack connection — enforcement, not just load.

> Uses your existing **arm64 macOS** `birdshot.duckdb_extension` as-is — fine for
> local dev. Override with `BIRDSHOT_EXTENSION_PATH=...`.

### Empirical finding worth keeping: quack's serving connection

`bootDuckRuntime()` runs `USE lake` on **its** connection, but `quack_serve`
answers federated scans on a **different** connection that defaults to
`memory.main`. A federated scan also arrives as a **bare table name** (quack
strips catalog + schema: `lake.demo.allowed` → `allowed`). So a scan only
resolves if the table is reachable unqualified on the serving connection.

For this PoC the demo tables are seeded in `memory.main` so the scan resolves;
birdshot gates by `schema.table` name regardless of catalog, so enforcement is
unaffected. **For tables in the actual DuckLake**, the gateway must make the
lake the serving connection's default catalog/schema (or expose a uniquely
named lake schema). This is a quack-config detail — orthogonal to Rivet and to
birdshot — but it's the thing to nail before fork (B).

---

## Honest caveats (deploy-time, not PoC blockers)

1. **Runner mode, not serverless.** Serverless migrates actors between function
   invocations and rebuilds from `ctx.state`; that would thrash a native
   runtime that takes seconds to boot (LOAD birdshot, ATTACH, quack_serve). Use
   `registry.startEnvoy()` on a container you control. (Local dev uses
   `registry.start()`, which is fine.)
2. **Linux + glibc image for deploy.** `@duckdb/node-api` prebuilds are glibc —
   use `node:24` (Debian), **not** `node:24-alpine` (musl). And you need a
   **Linux** birdshot build matching the container arch (current build is
   Mach-O arm64).
3. **Per-actor quack port** (done here via `freePort()`) — the gateway's fixed
   `QUACK_PORT=9500` collides when one runner hosts many actors.
4. **Result size / timeouts.** Rivet HTTP: 20 MiB request/response, 5-min
   request, 60 s action timeout (configurable); WebSocket messages ≤ 32 MiB.
   Large scans need pagination or a WS stream. (Memory is bounded by the
   container — **not** the 128 MB Workers cap; a real win over the WASM path.)
5. **birdshot policy is in-memory**, so it must be re-pushed on every (re)boot.
   The lake catalog persists (disk/R2); the DuckDB instance is a cache.
6. **R2:** flip `ducklakeDataPath` to `s3://bucket/prefix/` and fill `s3{}`
   (`useSsl:true`, `urlStyle:"vhost"`, `region:"auto"`) — `bootDuckRuntime`
   already creates the R2 secret. Local PoC uses the no-R2 local-file path.
