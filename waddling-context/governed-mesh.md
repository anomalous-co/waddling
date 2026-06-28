# Governed Mesh — lake ACL + workspace ACL on one quack+birdshot primitive (GCP Cloud Run)

> **Status:** design, for review. Extends the GCP Cloud Run migration (see the migration plan
> and WF-1, which is built + verified live). Grounded in the quack protocol source
> (`github.com/duckdb/duckdb-quack` @ `1693647c`), `birdshot/src/birdshot_extension.cpp`, and the
> existing waddling architecture (`ARCHITECTURE.md`, `agent-auth.md`, `birdshot-dynamic-acl.md`).
> Source-grounded, not experimentally inferred.

## Thesis

There is **one primitive**: a private DuckDB instance running **quack_serve + birdshot**, dialed
into with a JWT. Everything is an instance of it:

- the **shared data lake** (DuckLake on Cloud SQL + GCS) — *lake ACL*;
- each agent's **provisioned workspace** (a durable DuckDB we run for the agent) — *workspace ACL*.

An agent dials **only its own workspace**. The workspace is trusted infra we provision; it holds
the lake credentials and relays governed lake access, and it is itself a quack server other agents
can dial into under ACL. The MCP/control plane *provisions the workspace and brokers the secure
lake hop* — it is **not in the data path**. This is the literal job of the product: *give the agent
a database, and govern its access to the data lake — and to other agents' workspaces.*

## Protocol constraints that DICTATE the architecture (from quack source)

These are not preferences; they are properties of the quack wire protocol, and they decide the
topology.

1. **The auth token rides inside the binary message body, not an HTTP header.** The client sends a
   `ConnectionRequestMessage` whose `auth_string` is serialized as property 1 with DuckDB's
   `BinarySerializer` (`serialize_quack_message.cpp:26`); the server reads it from the raw
   `POST /quack` body (`quack_http_server.cpp:82`, Content-Type `application/vnd.duckdb`).
   **Consequence:** an HTTP edge/proxy/router **cannot read the token** without deserializing
   DuckDB's format. Therefore routing is on **URL/host only**; *per-user authentication is
   birdshot's job, server-side*, via `birdshot_authenticate(sid, token, server_token)`. "Route
   per-user with the same token birdshot uses" resolves as: the edge routes per-*endpoint*;
   birdshot authenticates the per-*user* JWT inside the gateway.

2. **quack holds sticky, per-connection server-side cursor state → exactly one authoritative
   instance per endpoint.** A `connection_id` maps to a `QuackConnection` holding a live DuckDB
   connection **and an open result cursor** (`duckdb_query_result`, `next_batch_index`,
   `result_uuid` — `quack_server.hpp:23`). `FETCH_REQUEST`s must hit the **same backend** that
   issued the `connection_id` or the server returns "Invalid connection id" / "Result has been
   closed" (`quack_server.cpp:205,329`). There is **no distributed session store.** This is the
   mechanism behind the Cloudflare multi-replica **wrong-cursor** failures: a FETCH landing on a
   peer with no cursor returns "Invalid connection id" / 0-rows / "does not exist". **So each
   [org, endpoint|workspace] = ONE authoritative Cloud Run instance** (`--max-instances=1`); scale
   is across *endpoints*, never replicas of one. (This mechanism returns an *error*, not a hang —
   it is proven from source and is what *mandates* max=1. The separate escalating **hang** that
   prompted the migration is NOT attributed to it; the WF-1 concurrency probe showed the hang
   empirically **gone** on the new stack — zero timeouts under 24-way concurrency — consistent with
   the cold-replica-wedge hypothesis, also eliminated by max=1. Two distinct wins; don't bundle.)

3. **A buffering forwarder is safe.** One HTTP `POST /quack` per protocol message; the server holds
   the cursor between FETCHes. Buffering each request/response independently is correct — only
   connection-pooling across *different* backends breaks it, which max=1 eliminates. The WF-1
   `entrypoint.mjs` forwarder is therefore correct.

4. **quack serves only the server's default catalog** ("a client cannot address an attached server
   catalog"). To relay lake tables, a workspace must re-expose granted lake tables as `memory.main`
   **views** (the pattern `duck.ts`/`restoreLakeViews` already uses on the lake gateway). This is
   the mechanism behind "workspace relays the lake."

5. **Two hooks:** `birdshot_authenticate` once per CONNECTION_REQUEST; `birdshot_authorize(sid,
   query)` per PREPARE_REQUEST (APPEND authorizes a synthesized INSERT). quack server has **no TLS**
   — Cloud Run terminates it at the edge.

## The primitive (parametric gateway)

One image, already built (WF-1). A private Cloud Run service = DuckDB + birdshot + quack_serve +
forwarder, `--no-allow-unauthenticated`, `--min/max-instances=1` per logical endpoint. Parameterized
by what it opens:

- **Lake mode** — ATTACH the org's DuckLake (Cloud SQL PG catalog + GCS data via S3-interop HMAC),
  expose granted tables as `memory.main` views, birdshot enforces *lake* grants. **(WF-1, live.)**
- **Workspace mode** — open a durable per-agent `.duckdb` (the existing "quackboard" path in
  `entrypoint.mjs` already does exactly this), birdshot enforces *workspace* grants. Durability is
  **whole-`.duckdb`-file save/load to GCS** (the workspace's own object) — NOT DuckLake/PG; the file
  is loaded on resume and flushed (CHECKPOINT + upload) on idle-out. (Contrast the lake, whose
  durability IS DuckLake = PG catalog + GCS parquet.)

Same enforcement, same forwarder, same boot. The only difference is the catalog it opens and which
grant set the control plane pushes.

## Topology — the mesh

```
 Claude (agent)
   │  MCP (OAuth / sk_ key)        ── CONTROL path only
   ▼
 control-api ──provision──▶ AGENT WORKSPACE  (Cloud Run, max=1, quack+birdshot)
   │  mint session JWT(s)            │  • quack SERVER  ← other agents dial in (WORKSPACE ACL)
   │  push 2 snapshots               │  • quack CLIENT  → ATTACH 'quack:lake' (TOKEN lakeJWT)
   ▼                                 │      re-exposes granted lake tables as memory.main views
 (lake snapshot)──────────▶ SHARED LAKE GATEWAY (Cloud Run, max=1, quack+birdshot)  ── LAKE ACL
                                     ▲              DuckLake: Cloud SQL PG catalog + GCS parquet
 agent's DuckDB ──quack──▶ its workspace ─────────┘   DATA path (control-api NOT in it)
```

- **One workspace per (agent) — `per-(workspace, agent)`** per the existing data-path decision. The
  workspace holds *that agent's* lake JWT, so "whose identity relays to the lake" is unambiguous:
  the owning agent's. The lake hop is gated by the lake gateway's birdshot under the agent's
  `aud=gw:<lakeEndpoint>` JWT — lake ACL enforced with the real principal.
- **Workspace ↔ workspace:** agent A's client (or A's workspace) dials agent B's workspace; B's
  birdshot gates it against B's *workspace* grants. Cross-workspace sharing is governed dial-in,
  same machinery.
- The agent reaches **only its workspace**; the lake is behind the workspace's relay. Fewer
  endpoints exposed per agent, one connection for the agent, two-hop chain internal.

## Two enforcement domains (both compile to birdshot snapshots)

| Domain | Where enforced | Grant subject | Pushed to |
|--------|----------------|---------------|-----------|
| **Lake ACL** | shared lake gateway | role → `schema.table` (read/write/create/drop/alter/detach) | lake gateway `/ctrl/snapshot` |
| **Workspace ACL** | each workspace | which *other* principals may dial in + which workspace tables they read | that workspace `/ctrl/snapshot` |

Both are `BirdshotSnapshot`s (`userRoles` + `roleGrants` + constraints/policies) — the existing
compiler + `applySnapshot` path. The control plane already owns lake-ACL compilation
(`compileEndpointPolicy`); workspace-ACL is a second compilation over a new "who-can-access-my-
workspace" grant model. **Capability vocabulary already supports DDL** (`create`/`drop`/`alter` are
parse-layer caps — WF-1 found `write` alone denies a CTAS).

### Relay mechanics (the two-hop chain, gated twice)

1. Agent → workspace (quack): the **workspace's** birdshot authenticates the agent's workspace-JWT
   and authorizes the query against *workspace* grants (incl. the relayed lake views).
2. Workspace → lake (quack): when the query touches a relayed lake view, the workspace's ATTACH to
   `quack:lake` fires the **lake's** birdshot under the agent's *lake*-JWT, enforcing *lake* grants.

Result: lake access from a workspace is enforced **at the lake**, with the agent's identity, while
the workspace independently governs who may use the workspace at all. No trust is placed in the
agent process — it never holds PG/GCS creds; the workspace (provisioned, trusted) does.

**Caveat — the relay inherits the Form-A single-streaming-scan JOIN limit (load-bearing).**
Re-exposing lake tables as `memory.main` views and querying them is **Form A** (ATTACH+scan) from
the lake. quack Form A is single-table-only; a JOIN across **two** lake tables inside a workspace is
two concurrent Form-A streaming scans — the exact failure hit on Cloudflare (see
`quack-form-a-vs-form-b-joins`, `governed-query-streaming-scan-join-limit`; ANO-104/105/106). It is
a quack protocol property, so it almost certainly still applies; **verify on the new stack.** Since
governed analytics implies JOINs, the relay needs the **Form-B mitigation**: route multi-table/JOIN
queries through `quack_query` (server-side execution on the lake gateway) rather than client-side
ATTACH+scan — i.e. the workspace issues the JOIN as a Form-B call to the lake, still birdshot-gated.
This is a workspace-relay implementation requirement, not a birdshot change.

## Routing & ingress (WF-2)

- A **router** maps `host/path` (encoding `[org, endpointId|workspaceId]`) → the authoritative
  instance. It routes on URL only (token unreadable, per constraint 1) and **must not pool a
  client's successive requests across backends** (constraint 2) — trivially satisfied because each
  endpoint is a single max=1 instance; the router's job is *address the right instance*, not load-
  balance one.
- **Gateways stay private.** Only the router's (or workspace's) Google service identity reaches a
  gateway over the internal hop; external agents never hit a gateway directly. Network privacy =
  Cloud Run IAM on the internal hop; per-user privacy = birdshot.
- Cloud Run reverse-proxy hygiene the quack docs require carries over to the router config: HTTP/1.1
  keep-alive, large `client_max_body_size` (APPEND/PREPARE carry data), long read timeouts
  (long-running queries sit between FETCHes), **no response buffering games that reorder messages**.

## Control plane (out of the data path)

- **Provision:** create/boot the per-agent workspace instance (Cloud Run service or a pooled
  warm instance keyed by [org, agent]); ensure the lake gateway for the org endpoint exists (WF-1
  lazy-boot/activation already does this).
- **Mint:** session JWT(s) — at minimum the lake-JWT (`aud=gw:<lakeEndpoint>`) the workspace uses to
  relay, plus the workspace-JWT(s) for agent→workspace and cross-workspace dial-in
  (`aud=gw:<workspaceId>`). Same RS256/JWKS triangle as today (`sessions.ts`).
- **Compile + push both snapshots** before the JWTs are usable (the existing ordering invariant:
  snapshot installs the JWKS + grants birdshot validates against).
- **Stays out of the data path:** once the workspace is configured, agent SQL flows agent→workspace
  (→lake) over quack; control-api records usage/audit by draining birdshot's log, not by proxying
  SQL. This is the "drop the MCP/proxy middleman" the user asked for.

## Workspace scale & lifecycle (resolving the per-agent-instance question)

The load-bearing decision, resolved here at design altitude (not deferred):

- **Invariant (from quack stickiness):** exactly **one** authoritative quack_serve per *live*
  workspace; the router addresses that one instance. A logical workspace is keyed `[org, agentId]`;
  its entire state is a single `.duckdb` file in GCS. **At most one physical instance is active per
  logical workspace at a time** — never a shared multi-tenant DuckDB, so per-agent identity (and
  "whose lake-JWT relays") is *never* ambiguous: each instance opens that agent's file and holds
  that agent's lake-JWT.
- **Decouple logical from physical + scale-to-zero with GCS rehydrate.** Idle workspaces hibernate:
  CHECKPOINT + upload `.duckdb` to GCS, free the instance (idle-out, **never** hard-destroy — see
  the no-hard-destroy rule). Next dial-in rehydrates: download file → open → push snapshot → serve.
  Cold-resume ≈ WF-1 boot (~1.9 s) + file download.
- **Addressing — the one thing to VALIDATE in WF-2/3, pick per measured density:**
  - **(a) service-per-agent, `min-instances=0`** — simplest stickiness (one Cloud Run service = one
    logical instance), scale-to-zero for cost. Bounded by Cloud Run's per-project/region service
    quota (low thousands; request increase) — viable to mid-hundreds of workspaces/org, not
    millions. **Recommended for WF-2/3 bring-up.**
  - **(b) multiplexed runner pool** — a small fleet of runner services, each hosting many workspaces
    (one DuckDB+quack_serve per workspace on distinct internal ports); a stateful placement
    coordinator (backed by control-plane Postgres) maps `workspaceId → (runner, instance)` and pins
    every request for that key there. The hard part is *strong* instance-addressable routing: Cloud
    Run's session affinity is best-effort, not a stickiness guarantee, so (b) needs a substrate with
    **stable per-instance identity** — a GKE StatefulSet (stable pod DNS) is the Cloud-Run-adjacent
    option. (Rivet's "one addressable actor per key" solves this natively, but it was **explicitly
    ruled out** as the substrate — Fork-B unverified e2e, per-agent DuckDB "Missing hostname" — so it
    is not the path; noted only as the shape (b) reimplements.)
- **Recommendation:** bring the mesh up end-to-end on **(a)** — it's pure Cloud Run, no new
  substrate, and proves the whole mesh. Only if measured workspace density per org blows past Cloud
  Run's service quota do we build (b) on a stable-identity substrate (GKE). Either way the per-agent
  identity invariant holds.

## Migration mapping (CF → Cloud Run)

| Today (Cloudflare) | Governed mesh (Cloud Run) | Status |
|---|---|---|
| Lake gateway = Container behind GatewayPoolDO (multi-replica pool) | Lake gateway = private Cloud Run service, max=1 per endpoint | **WF-1 done, live** |
| WorkspaceSandbox (per-agent DuckDB, holds quack client, `/configure` ATTACH lake) | Workspace = same parametric gateway in workspace mode, max=1 per (org, agent) | WF-3 |
| `interceptHttps` / Fork-B quack-over-443 / containerFetch | native Cloud Run TLS + the buffering forwarder | obsolete |
| control-api on workerd, `/query` proxies SQL to sandbox | control-api on Node/Cloud Run; **out of data path**, agent dials workspace directly | WF-4 |
| GatewayPoolDO `pickReplica`/keep-warm | URL-based router to single authoritative instances | WF-2 |
| R2 lake data | GCS (`gs://waddling-lake-prod`) via S3-interop HMAC | done |

## Revised workstreams

- **WF-2 — Router + workspace-mode gateway.** URL→instance routing; bring up a workspace-mode
  instance; prove agent→workspace dial-in (birdshot workspace ACL) + workspace→lake relay (granted
  lake views, gated at the lake). Re-measure concurrency router-side.
- **WF-3 — Workspace plane + dual-domain control.** Per-(org,agent) workspace provisioning +
  lifecycle (warm pool / idle-out, per the no-hard-destroy rule), durable workspace `.duckdb` on
  GCS, cross-workspace grant model + compiler, both snapshots pushed on connect.
- **WF-4 — control-api → Node on Cloud Run**, out of the data path (provision + mint + push only).
- **WF-5 — Cutover + CF decommission.**

## Open questions / risks

1. **Form-A JOIN limit on the relay (highest).** See the relay caveat above — JOINs across two lake
   tables through `memory.main` views fail (two concurrent Form-A scans); needs the Form-B
   (`quack_query`) mitigation. Verify on the new stack and build the mitigation into the relay.
2. **Two-hop latency.** Agent→workspace→lake is two quack round-trips + two birdshot passes per lake
   query. WF-1's single hop was ~60 q/s/instance through the proxy; measure the relay overhead.
3. **JWT count & TTL.** The workspace holds a lake-JWT (15m today) for relay; long-lived workspaces
   need refresh without dropping the quack connection (re-ATTACH drops the cursor — constraint 2).
   Decide refresh strategy (re-mint + re-ATTACH on idle, or longer-lived relay JWT with revocation).
4. **Column ACL on relayed lake views.** The known lake-read column-ACL fail-closed issue applies at
   the lake hop; relaying through views may interact — verify.
5. **Cross-workspace discovery & grant UX.** How an owner grants another agent access to their
   workspace (control-plane surface) is new product surface, not just plumbing.
