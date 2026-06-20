# Per-org DuckDB in waddling (a gateway that doesn't mount the lake)

How the swarm quackboard (`../README.md`) — a DuckDB instance whose tables agents read and
write concurrently over the **quack** wire protocol — could become a first-class waddling
feature: **one per-org DuckDB the org's agents use directly, governed by the normal gateway
but with the DuckLake *not* auto-mounted.**

> Sourcing: every `path:line` below comes from a read-only sweep of the three relevant
> seams (control-plane provisioning, the data-plane DuckDB actor, tenancy/auth). Claims are
> grounded in the code as it stands; explicit unknowns are flagged as such.

---

## 1. What this is — and what it is NOT

It is **NOT** "strip birdshot." The gateway stays exactly as it is: birdshot loaded, the
`birdshot_authenticate` / `birdshot_authorize` hooks installed
(`packages/gateway/src/duck.ts:117, 221-222`), the JWT triangle, the token, the ACLs — all
intact and enforced.

The single thing a quackboard endpoint changes is: **it does not ATTACH the DuckLake.** A
normal gateway boots and then mounts the org's lake — `ATTACH 'ducklake:postgres:<dsn>'`
with an R2 `s3://` data path and a per-endpoint `METADATA_SCHEMA` (`duck.ts:151-175`). A
quackboard skips that block. The result is a governed DuckDB with **no lake mounted**; the
swarm's tables (`observations`, `agent_memory`, `notifications`, …) live directly *in that
DuckDB*, not in a lake the gateway proxies to.

So the mental model is: **gateway − lake-mount + durable file.** The unit is the **org**:
one such DuckDB per org, keyed `[orgId]`, holding that org's shared agent memory.

---

## 2. The change is one conditional

`bootDuckRuntime` (`packages/gateway/src/duck.ts:108`) runs a fixed sequence:

```
INSTALL ducklake/postgres/httpfs   (duck.ts:120)
LOAD birdshot                      (duck.ts:117)        ← stays
SET GLOBAL quack_authentication_function / quack_authorization_function
                                   (duck.ts:221-222)    ← stays
ATTACH 'ducklake:…' + METADATA_SCHEMA
                                   (duck.ts:151-175)    ← MAKE CONDITIONAL (skip for quackboard)
CALL quack_serve(…)                (duck.ts:226)        ← stays
```

Make the **ATTACH block (151-175) conditional** on the boot config carrying a catalog. When
`config.ducklakeCatalogDsn` and `config.ducklakeCatalogFile` are both empty, boot birdshot,
install the hooks, and serve quack — without mounting any lake. Nothing else moves.

The control plane already knows how to express "boot with no lake." `resolveGatewayBoot`
(`apps/control-api/src/lib/gateway-boot.ts:67`) dispatches on `catalog_mode`
(`gateway-boot.ts:100-177`) and has a final **`(d) nothing real configured`** branch
(`gateway-boot.ts:177`) that returns a `GatewayBoot` with no `catalogDsn`/`catalogFile` —
today it is the offline-demo fallback. A quackboard endpoint routes there *on purpose*.

---

## 3. The real consequence: durability moves into the file

This is the one genuinely new thing the design must add, and it follows directly from "no
lake."

A normal gateway's DuckDB is **`:memory:`** (`duck.ts:110`) — and that's fine, *because the
durable data lives in the lake* (Postgres catalog + R2 parquet). Cold-start just re-ATTACHes
the lake and re-applies the birdshot snapshot (`apps/dataplane/worker/src/index.ts:224-247`).

A quackboard has **no lake**, so an in-memory DuckDB would lose every observation on the
first container sleep. The quackboard's tables *are* the durable state, so **the `.duckdb`
file itself must be durable.** That capability already exists in the data plane — it's the
per-agent workspace pattern: a real file on local disk, persisted to and restored from R2 via
presigned URLs, CHECKPOINTed and uploaded on sleep/shutdown
(`WorkspaceSandbox`, `index.ts:109`; key `workspace/<wsId>/db/<agentId>.duckdb`,
`index.ts:93`; `mintPresigned` `index.ts:493`; CHECKPOINT+upload `workspace-runner.ts:106-110`).

So a per-org quackboard reuses that machinery, re-keyed to the org:
`quackboard/<orgId>/quackboard.duckdb`, a real path (e.g.
`/var/lib/waddling/quackboard.duckdb`), **not `:memory:`**.

---

## 4. Reconciliation with already-approved directions

Not greenfield — this is a recombination of three directions already in the design memory:

- **Per-(workspace,agent) durable encrypted DuckDB in actors** (the MCP workspace data
  path) provides exactly the R2-backed durable-file mechanism §3 needs. The quackboard is its
  *shared-across-agents, org-keyed* variant: one durable `.duckdb`, many concurrent agents
  (quack's single-writer-server + MVCC handles the concurrency, proven in `../README.md`).
- **Per-org DuckLake isolation via `METADATA_SCHEMA`** (`duck.ts:162-175`,
  `apps/control-api/src/lib/gateway-boot.ts:107`) is the thing being *turned off* here — the
  quackboard has no DuckLake, so no metadata schema, no shared catalog. Its isolation unit is
  the file, one per org.
- **Birdshot → full-scope ACL + per-agent delegation** (the approved ACL arch) **stays on**
  and now governs the quackboard's *own* tables — see §6. This is the payoff of keeping the
  gateway: per-agent isolation inside the org is available, not sacrificed.

---

## 5. The three seams

**Control plane (provisioning).** Provisioning already does everything per-org: quota by
`COUNT(*) … WHERE org_id` (`apps/control-api/src/routes/datalakes.ts:125-129`), a per-endpoint
`server_token = 'srv_<uuid>'` (`datalakes.ts:169`) — the value `quack_serve` is called with
(`duck.ts:226`), and the exact analog of the prototype's `BB_TOKEN`. A quackboard endpoint
simply skips the catalog auto-provision (`provisionOrgCatalog`, `catalog-provision.ts:75`) and
S3 storage, and routes `resolveGatewayBoot` to the no-catalog branch.

- Add an endpoint discriminator `kind ∈ {lake, quackboard}` on `waddling.datalake` (new
  migration); one quackboard per org, quota-checked.
- `routes/datalakes.ts POST /`: for `kind='quackboard'`, skip `provisionOrgCatalog` + S3, set
  `catalog_mode='none'`, mint `server_token` as today.
- `gateway-boot.ts:resolveGatewayBoot`: return the no-catalog `GatewayBoot` (the existing
  `(d)` path), but carry the **R2 key for the durable file** (`quackboard/<orgId>/…`).
- **Untouched:** `secret-crypto.ts`, the `GatewayClient` / `gateway-push.ts` birdshot-snapshot
  push (a quackboard *does* still take a birdshot snapshot — see §6 — so this path stays).

**Data plane (where it runs).** Today the DuckDB lives in a Cloudflare Container-backed
Durable Object (`GatewayDO extends Sandbox<Env>`, `index.ts:101`), keyed per endpoint via a
replica pool (`gwpool:<datalakeId>:<n>`, `index.ts:80`).

- New `QuackboardDO extends Sandbox<Env>` keyed `qb:<orgId>` — **single writer, no replica
  pool** (quack already serializes writes; the `GatewayPoolDO` autoscaler is unnecessary).
- Make the ducklake ATTACH (`duck.ts:151-175`) conditional behind a `config.mountLake` flag
  (or simply "catalog empty ⇒ skip").
- Add R2 restore/CHECKPOINT-and-upload for `quackboard/<orgId>/quackboard.duckdb` (§3),
  reusing the WorkspaceSandbox pattern. Third container binding + migration tag in
  `apps/dataplane/worker/wrangler.jsonc:30-53`.

**Auth/tenancy.** **Unchanged.** The `server_token`, the 15-min RS256 JWT minted at
`POST /api/cp/sessions` (`apps/control-api/src/routes/sessions.ts:448-509`, `aud=gw:<endpointId>`,
`id=agent:<agentId>`), the JWKS push to birdshot, and `assertOrg(caller, org_id)`
(`cp-shared.ts:199-203`) all apply exactly as they do for a lake endpoint.

---

## 6. Tenancy & isolation — birdshot still governs

Because the gateway stays, isolation is **stronger** than the bare prototype, at two levels:

- **Cross-org:** one `QuackboardDO` per `orgId` → separate compute + separate R2 file +
  per-org `server_token`; control-plane `org_id` scoping + `assertOrg` gate every
  provision/connect; cross-org access is already 404-masked (`sessions.ts:701`).
- **Intra-org (the payoff of keeping birdshot):** push a birdshot snapshot scoped to the
  quackboard's own tables. Each agent connects as `agent:<agentId>` (from its JWT) and gets
  per-table grants — e.g. read/write `observations`, but **not** another agent's
  `agent_memory`. Per-agent table-level isolation is available *now*; per-agent **row-level**
  scoping (an agent sees only its own `agent_memory` rows) is birdshot's row-filter, which is
  Phase 2 of the ACL arch — until then, isolation is table-grained.

The prototype's static `bb-dev-token` + allow-all was a *local-experiment* shortcut; in
production it is replaced wholesale by the JWT + birdshot path above. The "any token holder
can DROP TABLE / read all memory" risk of the bare prototype **does not carry over**, because
birdshot is in the path.

One hardening worth doing regardless of this feature: the JWT signing private key is stored
plaintext (`disablePrivateKeyEncryption:true`, `sessions.ts:204-219`); and `server_token` is
plaintext on the row (`datalakes.ts:169`) rather than envelope-sealed via
`getCrypto().sealJson` (`secret-crypto.ts:71`).

---

## 7. The transport question (only for external-agent direct ATTACH)

If the org's agents run *inside* the deployment (as workspace sidecars), they reach the
quackboard over the existing proven internal path: ATTACH an intercepted
`qb-<orgId>.internal:443` → `setOutboundByHost` → `containerFetch` to the `QuackboardDO`'s
forwarder → loopback `quack_serve`. Single-DO = CF single-thread = correct write
serialization. This needs only a new allowed-host + `toQuackboard` outbound handler.

The prototype's nicest property — an **external** agent running `ATTACH 'quack:…'` directly —
is **unproven on Cloudflare.** The data plane is private (`wrangler.jsonc:26`
`workers_dev:false`; `index.ts:1-4`), and the entrypoint explicitly disclaims that raw quack
wire survives the `containerFetch` hop; "Fork-B" (quack over an HTTPS proxy) is "not yet
verified end-to-end" per `CLAUDE.md`. So external direct ATTACH is gated on proving Fork-B;
until then, intra-deployment agents (or an HTTP `/query` shim) are the supported reach.

---

## 8. Suggested phasing

1. **Endpoint kind + no-lake boot.** `kind='quackboard'` on `waddling.datalake`; provisioning
   skips catalog/S3; `resolveGatewayBoot` → no-catalog branch. (Control plane only.)
2. **Conditional ATTACH + durable file.** Gate `duck.ts:151-175` behind catalog-present;
   boot a `QuackboardDO` (birdshot intact, no lake) with R2 restore/persist (§3). The spine.
3. **Birdshot snapshot for the quackboard tables.** Per-agent table grants (§6); reuse the
   existing JWT + JWKS-push path verbatim.
4. **(If/when needed) external direct ATTACH.** Verify Fork-B quack-over-HTTPS:443.
5. **(Optional) per-agent row-level isolation.** Birdshot row-filter (ACL-arch Phase 2), so an
   agent sees only its own `agent_memory` rows.

## Open questions the code does not answer

- **Fork-B / raw quack over `containerFetch`** — unverified (`CLAUDE.md`, entrypoint comment).
  Gates external direct ATTACH (§7) only; intra-deployment reach is unaffected.
- **R2 persist on involuntary container eviction** — workspace sidecars CHECKPOINT-then-PUT
  before exit, but whether the CF runtime guarantees enough time on eviction is unverified;
  the quackboard inherits this risk and it matters *more* here (no lake to fall back on).
- **Per-org encryption key** — the at-rest data key is instance-wide
  (`SHA256(WADDLING_SECRET_KEY)`, `secret-crypto.ts:67`), not per-org; note it if per-org key
  isolation is ever required.
