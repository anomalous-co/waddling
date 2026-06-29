# Birdshot: Dynamic ACL Management & Near-Instant Access Reverts

This document traces the complete runtime lifecycle of access control in birdshot — from an ACL change in the control plane through to enforcement on the next agent query. Two independent revocation paths exist, explained below.

---

## Data model

### `BirdshotSnapshot` (the atomic policy unit)

**`packages/control-schema/src/types.ts:78–123`**

```typescript
interface BirdshotSnapshot {
  roleGrants: { role: string; tableRef: string; action: BirdshotCatalogCapability }[];
  userRoles:  { userId: string; role: string }[];
  roleConstraints?: {
    role: string; tableRef: string;
    columns?: string[];
    window?: { start: string; end: string };  // UTC HH:MM
  }[];
  policies?: {
    role: string;
    kind: 'source' | 'dest' | 'extension' | 'attach';
    pattern: string;
  }[];
}
type BirdshotCatalogCapability = 'read' | 'write' | 'create' | 'drop' | 'alter' | 'detach';
```

- **roleGrants** — per-agent table-level grants. `tableRef` is `schema.table`. One entry per (role, table, verb).
- **userRoles** — maps JWT `sub` principal `agent:<agentId>` to the synthetic role `agent_<agentId>`.
- **roleConstraints** — column allow-lists + UTC time-of-day windows enforced by birdshot's bind-walk. Omitting = no constraint.
- **policies** — non-catalog resource allowlists (S3/R2 source URIs, extension names, ATTACH paths).

### Postgres source tables

| Table | Purpose |
|---|---|
| `waddling.acl_rule` | Per-agent or per-user table/verb grants and denies; `expires_at`, `priority`, `effect` |
| `waddling.acl_policy` | Non-catalog allowlists (read_source, copy_to, attach, install/load) |
| `waddling.delegation` | User-granted delegation scope that constrains derived per-agent grants |
| `waddling.datalake` | Endpoint state; `policy_version` + `policy_compiled_at` for cache validation |

---

## Revocation path A — instant denylist

Used when an **agent is deleted/revoked** (not just an ACL rule change). Skips full recompile; adds the principal to an in-memory denylist that is checked on every single query.

### 1. Control-plane trigger

`DELETE /api/cp/agents/:id` in `apps/control-api/src/routes/agents.ts`:

```typescript
// For every running endpoint in the org:
await gatewayClient.revoke({
  datalakeId: ep.id,
  kind: 'user',
  id: `agent:${id}`,
  expiresUs: 0,   // 0 = permanent
});
await query(`UPDATE waddling.agent SET status='revoked' WHERE id=$1`, [id]);
```

Fires fan-out: one `POST /gw/revoke` per running endpoint, best-effort.

### 2. Gateway ctrl-server receives

`packages/gateway/src/ctrl-server.ts:94–99` (shipped copy: `apps/dataplane/gateway/gateway/gateway-src/ctrl-server.ts`):

```typescript
if (method === "POST" && url === "/gw/revoke") {
  const body = await readJson<RevokeBody>(req);
  await birdshotRevoke(runtime, body.kind, body.id, body.reason ?? "", body.expiresUs);
  return send(res, 200, { ok: true });
}
```

### 3. Birdshot denylist update (C++)

`birdshot/src/birdshot_extension.cpp:171–177`:

```cpp
void State::Revoke(const std::string &kind, const std::string &id, int64_t expires_us) {
  std::lock_guard<std::mutex> lk(mtx_);
  if (kind == "user") deny_user_[id] = expires_us;  // 0 = never expires
  else if (kind == "jti") deny_jti_[id] = expires_us;
}
```

`deny_user_` and `deny_jti_` are `std::unordered_map<string, int64_t>` living in `birdshot_state.hpp:201–283`.

### 4. Every subsequent query denied

`birdshot_extension.cpp:629–809` — the `birdshot_authorize` quack hook:

```cpp
} else if (st.IsRevoked(id.user_id, id.jti, now)) {   // line 654
  reason = "revoked";
```

`IsRevoked` is a single mutex-locked map lookup — no I/O, no network:

```cpp
bool State::IsRevoked(const std::string &user_id, const std::string &jti, int64_t now_us) {
  std::lock_guard<std::mutex> lk(mtx_);
  return ActiveRevocation(deny_user_, user_id, now_us) ||
         (!jti.empty() && ActiveRevocation(deny_jti_, jti, now_us));
}
```

**Latency:** Steps 1–3 complete in <1 s. Revocation is effective on the agent's **very next query**; no session disconnect required.

---

## Revocation path B — full snapshot push

Used when an **ACL rule is created, modified, or deleted**. Recompiles the entire endpoint policy and atomically swaps birdshot's in-memory grant table.

### 1. Control-plane trigger

`apps/control-api/src/routes/acl.ts`:

```
POST   /api/cp/acl       → create rule  → recompileAndPush(datalakeId)
PATCH  /api/cp/acl/:id   → update rule  → recompileAndPush(datalakeId)
DELETE /api/cp/acl/:id   → delete rule  → recompileAndPush(datalakeId)
```

Also surfaced via `POST /:id/refresh-policy` on datalakes (admin recovery lever, `datalakes.ts:399–444`).

### 2. Policy compilation

`apps/control-api/src/lib/gateway-push.ts:77–130` calls `compileEndpointPolicy`:

**`apps/control-api/src/lib/effective-policy.ts:432–586`**

1. Load **all** `acl_rule` rows for the datalake (direct agent grants + user-subject grants).
2. Load all `acl_policy` rows (non-catalog allowlists).
3. Enumerate every active agent that has a delegation row or whose owner has user-subject grants.
4. For each agent: derive effective rules by intersecting the owner's user grants with the agent's delegation scope (`waddling.delegation` rows). Derived grants are **never persisted** — computed fresh each compile.
5. Call `compilePolicy()`.

**`apps/control-api/src/lib/policy-compiler.ts:286–506`** (pure, unit-testable):

- Filters by temporal validity (`not_before ≤ now < expires_at` + optional UTC time window).
- **Wildcard expansion** (lines 242–270): expands rules with `schema='*'` or `table='*'` against the real lake catalog into concrete `schema.table` refs. Only `read`/`write` expand; DDL verbs (`create`/`drop`/`alter`/`detach`) stay as `*` (match-everything in birdshot's RefMatch).
- Precedence: `deny` beats `allow`; lower `priority` number wins within the same (agent, table, verb) selector.
- **Fail-closed guard** (lines 448–494): if a role mixes column allow-lists with parse-authorized DDL, the entire role's grants are dropped.
- Outputs `BirdshotSnapshot` (roleGrants, userRoles, roleConstraints, policies) plus `activeAgentIds`.

A deleted rule is simply absent from the recompiled output — no grant row is emitted for it.

### 3. Snapshot dispatch

`apps/control-api/src/lib/gateway-push.ts:99–118`:

```typescript
await bumpPolicyVersion(datalakeId, snapshot, jwksArr);  // version hash for polling cache

const snapshotReq: SnapshotRequest = {
  datalakeId,
  auth: { issuer, audience, mode: 'rs256', jwks: jwksArr },
  snapshot,
  lakeCatalog,
  gatewayBoot,
};
await gw.pushSnapshot(snapshotReq);
```

`apps/control-api/src/lib/gateway-client.ts:201–210`:

```typescript
pushSnapshot(req: SnapshotRequest): Promise<GatewayAck> {
  // Remaps datalakeId → endpointId on the wire
  return this.send<GatewayAck>('POST', '/gw/snapshot', { endpointId: req.datalakeId, ...rest }, 45_000);
}
```

Transport: workerd **service binding** to `waddling-dataplane` — no public route, no bearer token (the binding is the trust boundary). 45 s timeout accommodates cold gateway boot.

**Best-effort semantics:** if the gateway is unreachable, the ACL mutation is still committed to Postgres. `recompileAndPush` returns `{ pushed: false, pushError }`. The snapshot re-pushes on the next agent reconnect or manual `refresh-policy` call.

### 4. Gateway snapshot application

`apps/dataplane/gateway/gateway/gateway-src/ctrl-server.ts:87–92`:

```typescript
if (method === "POST" && url === "/gw/snapshot") {
  const body = await readJson<SnapshotBody>(req);
  await applySnapshot(runtime, body.snapshot, body.auth);
  return send(res, 200, { ok: true, grants: body.snapshot.roleGrants.length });
}
```

`apps/dataplane/gateway/gateway/gateway-src/duck.ts:417–456` (`applySnapshot`):

```
1. birdshot_reset_config()                              — clear ALL staged config
2. birdshot_set_lake_catalog(lakeAlias)                 — e.g. 'lake'
3. birdshot_set_auth(issuer, audience, 'rs256')
4. birdshot_add_jwk(kid, n, e)                          — one per JWK
5. birdshot_add_user_role(userId, role)                 — one per agent
6. birdshot_add_role_grant(role, tableRef, action)      — one per (agent, table, verb)
7. birdshot_add_grant_constraint(role, tableRef, cols, ws, we)  — column/window constraints
8. birdshot_commit_config()                             — atomic live_ ← staging_
```

### 5. Birdshot C++ atomic swap

`birdshot/src/birdshot_state.hpp:201–283`:

```cpp
class State {
  std::mutex mtx_;
  PolicySnapshot live_;     // currently active grants
  PolicySnapshot staging_;  // built by add_* calls
  std::unordered_map<string, int64_t> deny_user_;  // path-A denylist
  std::unordered_map<string, int64_t> deny_jti_;
};
```

Each `birdshot_add_*` / `birdshot_reset_config()` call acquires `mtx_` and mutates `staging_`. `birdshot_commit_config()` does `live_ = staging_` under the same lock — atomic swap, no quiesce.

After commit, every subsequent `birdshot_authorize` call reads `live_` — the deleted rule is gone.

---

## Quack hook wiring

`duck.ts` (startup, after DuckDB opens):

```typescript
await c.run("SET GLOBAL quack_authentication_function = 'birdshot_authenticate'");
await c.run("SET GLOBAL quack_authorization_function  = 'birdshot_authorize'");
```

- `birdshot_authenticate(sid, token, server_token)` — verifies RS256 JWT against in-memory JWKS; caches `Identity{user_id, jti, exp_us}` in `sessions_[sid]`. Called once per quack connection.
- `birdshot_authorize(sid, query)` — called on **every** query; checks denylist first, then evaluates `live_` grant table. Session caching of the Identity does not bypass per-query authz.

---

## Path comparison

| | Path A (instant denylist) | Path B (snapshot push) |
|---|---|---|
| **Trigger** | Agent deleted / revoked | ACL rule created / updated / deleted |
| **Mechanism** | `deny_user_` map entry | Full `live_` grant table swap |
| **Scope** | Single principal, all endpoints | All principals, single endpoint |
| **Latency** | <1 s end-to-end | <1 s + compile time (~50–200 ms) |
| **Effect** | Next query from that agent denied | Next query from any agent sees new grants |
| **Persists across restart?** | No (in-memory only; snapshot push follows) | Yes — Postgres is the source of truth; re-pushed on reconnect |

---

## Key invariants

1. **Full endpoint snapshots only.** `applySnapshot` always resets and replaces the entire policy for the endpoint. Partial pushes would leave other agents' grants undefined after the reset.

2. **Deny-wins, compile-time resolution.** Precedence is resolved by the compiler, not by birdshot at query time. Birdshot only sees the already-resolved `roleGrants`.

3. **No caching between commit and enforce.** `birdshot_commit_config()` and `birdshot_authorize()` share the same in-process mutex-guarded `live_` struct. No cache invalidation event, no poll interval.

4. **Denylist survives snapshot push.** Path A denylist entries (`deny_user_`, `deny_jti_`) are NOT cleared by `birdshot_reset_config()` — they live in a separate map. A revoked agent remains denied even if a snapshot push races with or follows the revocation.

5. **Delegation never persisted.** Per-user grants intersected with delegation scope are derived fresh on every `compileEndpointPolicy` call. Revoking a delegation takes effect on the next snapshot push with no additional revocation step.

---

## Interaction with the waddling API

The waddling MCP tools and REST routes sit above the enforcement layer. The control plane never calls birdshot directly — it compiles policies and pushes snapshots; birdshot runs inside the gateway and enforces on every quack query.

### `waddling_connect` — the JWT triangle

`apps/control-api/src/routes/sessions.ts:271–684`

Every connect follows three steps that must happen in order:

**Step 1 — compile and push snapshot**

`compileEndpointPolicy(datalakeId, now)` runs at line 402, compiling ALL agents' effective grants for the endpoint. The resulting `BirdshotSnapshot` is pushed to the gateway via `DATAPLANE` service binding (`POST /gw/snapshot`). This must complete before the JWT is minted — it installs the JWKS and grant table that birdshot will validate against.

**Step 2 — mint session JWT**

A short-lived RS256 JWT (15 min TTL) is signed with a key loaded from the `jwks` table. Claims include:
- `id` / `sub`: `agent:<agentId>` — birdshot's principal
- `aud`: `gw:<datalakeId>` — scope-locked to one endpoint
- `jti`: a UUID (revocable individually via path A denylist)
- `exp`: now + 15 min

The `kid` in the JWT header must match a key the gateway already knows. If the snapshot push in step 1 failed, the ATTACH in step 3 fails — the JWT triangle enforces ordering.

**Step 3 — ATTACH quack in the workspace**

`dpFetch('/configure', { lakeToken: sessionJwt })` tells the WorkspaceSandbox to run:
```sql
ATTACH 'quack:443' WITH (TOKEN '...jwt...');
```
The gateway receives this ATTACH and calls `birdshot_authenticate(token, server_token)`, which validates the JWT signature against the JWKS installed in step 1. If the JWKS was not yet pushed, authentication fails and the ATTACH is rejected.

**Pre-flight gates on connect** (before the triangle runs):
- Org has prepaid credits (line 294)
- Endpoint status is `'running'` (line 286)
- Caller and endpoint share the same org (lines 310, 319, 335)
- `compileEndpointPolicy` must yield ≥1 table grant — zero grants is a 403 with a message identifying whether the cause is no delegation, no user grants, or no endpoint grants (lines 404–443)

### `waddling_query` — quack path, no re-verification on control plane

`apps/control-api/src/routes/sessions.ts:881–1050`

The control plane forwards the agent's SQL to the WorkspaceSandbox (`dpFetch('/query', { sql })`). The workspace executes it over the already-established quack ATTACH, which causes `birdshot_authorize` to fire on the gateway for every table reference. The control plane never sees the raw data — it only:
- Records usage events
- Drains birdshot's audit log after the query (`gatewayClient.drainAudit()`) and persists decisions as `audit_event` rows

### `waddling_etl` — parse-layer pre-authorization

`apps/control-api/src/routes/sessions.ts:1053–1160`

ETL (CTAS / INSERT from external source) goes through an extra parse-layer dry-run on the control plane (line 1126) before the statement reaches the gateway. The dry run checks `read_source`, `copy_from`, `copy_to`, `create`, and `etl` capabilities against the `acl_policy` patterns. This is a constant-literal match — the source URL in `read_json('https://...')` must match a stored pattern. Only after that check passes does the control plane forward to the data plane, where birdshot enforces again at execution time.

### `waddling_qb_*` — quackboard with org-scoped snapshot

`apps/control-api/src/routes/quackboard.ts`

The quackboard is a per-org shared DuckDB (no external lake). `waddling_qb_join` builds an org snapshot via `buildOrgQuackboardSnapshot()` that grants every active agent RW access to the shared coordination tables (`observations`, `notifications`, `subscriptions`, `messages`, `boundaries`, `objectives`, `claims`). `agent_memory` is deliberately excluded from the snapshot — private memory is accessible only via the trusted `qb_remember` / `qb_mine` ops, not via raw `qb_query`.

### ACL rule CRUD and snapshot timing

`apps/control-api/src/routes/acl.ts`

Every ACL mutation triggers `recompileAndPush` synchronously before the HTTP response returns. The response carries the new snapshot version. This means:
- An ACL rule deletion takes effect for the **next** query after the HTTP 200 returns
- If the gateway is unreachable, the rule is committed to Postgres and the response carries `{ pushed: false, pushError }` — the push is retried on the next connect or via `POST /:id/refresh-policy`

### Permission layers (no bypass path exists)

| Layer | Where | What enforced |
|---|---|---|
| API-key / OAuth auth | `/mcp` → `resolveCaller()` | Caller identity |
| Org isolation | All `/api/cp/*` routes | Caller and resource share org |
| Credit gate | `/sessions` POST | Org balance > 0 |
| Endpoint running | `/sessions` POST | Datalake status = 'running' |
| Grant check | `compileEndpointPolicy` in session connect | Agent has ≥1 table grant |
| JWT triangle ordering | Step 1 before step 3 | Snapshot pushed before ATTACH |
| `birdshot_authenticate` | Gateway, quack ATTACH | JWT signature + JWKS match |
| `birdshot_authorize` | Gateway, every query | Table + column + window grants |
| Parse-layer auth | ETL dry-run on control plane | Source/dest URI pattern match |
| Denylist | Gateway, every query | Revoked agent/JTI blocked |

The control plane holds secrets (catalog DSN, signing keys). The workspace holds no secrets. The gateway decrypts what it needs on boot. Agent SQL never touches the control plane database.

---

## Update — durable dispatch shipped (2026-06-26)

The best-effort delivery and write-amplification gaps below are **largely closed** in production. Implementation:

- **`waddling.gateway_dispatch` outbox** (migration 020): coalescing snapshot dirty-markers (one row/datalake) + discrete idempotent revoke rows. Snapshots are recompiled from current DB state at drain — never stored — so a burst of edits collapses to one push.
- **`apps/control-api/src/lib/gateway-dispatch.ts`**: `enqueueSnapshotDispatch` / `enqueueRevokeDispatch`, `recompileAndEnqueue` (drop-in for `recompileAndPush` on edit paths — compiles synchronously for the response, delivers async), `kickDispatch` (immediate `waitUntil` attempt, ctx-guarded), `drainGatewayDispatch` (exponential backoff, give-up after 12 attempts).
- **Edit paths now async**: `acl.ts`, `policies.ts`, `delegations.ts`, and `agents.ts` `DELETE /:id` enqueue + kick instead of blocking on the push. Agent-delete flips `status='revoked'` first (the durable, restart-safe gate via `resolveCaller`), then enqueues the revoke **and** a recompile so the director's cached snapshot drops the agent's grants.
- **Cron drain**: control-api `scheduled()` (`*/5`) runs `drainGatewayDispatch` as the retry/reconcile backstop. Requires `initCrypto` + `initDataplane` in the scheduled context (the request middleware's per-isolate inits don't run for cron).
- **Write-amp apply fix**: `applySnapshot` (gateway-src/duck.ts) now applies the whole birdshot config in ONE multi-statement `connection.run()` instead of ~14+ serial round-trips.

Live-verified in prod: an enqueued snapshot drains via the cron, recompiles, and pushes to the gateway (~2.4 min, within the `*/5` window); the retry/backoff path was confirmed by an injected failure (a missing scheduled-context `initCrypto`, since fixed).

**Still open (documented, not yet built):** the version-drift reconcile (#2's deeper fix) — once a snapshot row is marked delivered, the cron won't re-push, so a direct-DB edit or a rare push-ordering inversion still self-heals only on next connect / ≤15-min JWT. A monotonic applied-version the director can reject-older on is the clean follow-up.

## Known issues & limitations (pre-fix analysis — see Update above for what shipped)

The common path — warm gateway, successful push — is genuinely sub-second. Every issue below lives in the failure and scale edges. Verified against source; the two scariest candidates were refuted.

### Refuted (durable Postgres gate holds)

- **Revoked agent cannot reconnect.** `resolveCaller` (`apps/control-api/src/lib/cp-shared.ts:120–129`) loads agent status from Postgres on every API-key auth and 403s if `status != 'active'`. Not reliant on in-memory denylist.
- **Unrelated recompile cannot resurrect a revoked agent's grants.** The agent-enumeration query in `compileEndpointPolicy` (`effective-policy.ts:492`) filters `AND a.status = 'active'`, so a revoked agent is never re-added to a snapshot even though `DELETE /agents/:id` skips `recompileAndPush`.

### Real issues

1. **Warm-session revocation gap (≤15 min) — undercuts "instant revert."** Both `/gw/revoke` and `/gw/snapshot` calls are best-effort `catch {}` with **no retry and no reconciliation loop**. If an agent holds a warm quack session and the revoke RPC fails (gateway briefly unreachable, network blip), the agent keeps querying until the JWT naturally expires — up to `SESSION_TTL_SECONDS = 15 min` (`session-jwt.ts:22`). `birdshot_authorize` re-checks only the in-memory denylist + grants + JWT exp per query; it never consults Postgres, so the durable `status='revoked'` flip does not help a session that already authenticated.

2. **No outbox / reconciler; failed pushes silently go stale.** A failed snapshot push persists the rule in Postgres and returns `{ pushed: false, pushError }`, then waits for a *coincidental* next connect or unrelated recompile to re-push (`gateway-push.ts:119–129`). The keep-warm cron (`dataplane/worker/src/index.ts:1685`) only warms actors — it does **not** re-push policy. Most dangerous for an ACL **narrowing** (`DELETE /acl/:id`) whose push fails: the broader grant stays live in the gateway's `live_` while the agent's status is still `active`, so neither the connect gate nor the denylist closes it.

3. **Concurrency race on the shared staging buffer.** `applySnapshot` runs `reset_config → add_* → commit_config` as separate awaited `c.run()` calls on the single `rt.connection`, with no mutex/queue (`duck.ts`, `ctrl-server.ts:87–92`). Two concurrent `POST /gw/snapshot` (e.g. an ACL edit racing a connect on the same endpoint) can interleave their reset/add/commit on the shared `staging_`, producing a merged or double-committed snapshot until the next clean push. DO/actor single-threading serializes individual statements but not the logical sequence across `await` points.

4. **Write amplification — O(agents × tables) per change.** Every ACL edit recompiles the *entire* endpoint (all agents) and re-pushes the full snapshot, applied as one serial `c.run()` per JWK, role, grant, and constraint inside `applySnapshot`. With wildcard expansion against a large catalog × many agents, a one-line ACL edit can mean thousands of serial SQL round-trips; the 45 s push timeout reflects this. No incremental/delta push.

5. **Silent no-op security rules.**
   - `subject_kind='org'` rules are skipped by the compiler ("org-scope enumeration unsupported") — an admin-written org-wide rule silently does nothing.
   - The fail-closed guard (`policy-compiler.ts:448–494`) drops a role's *entire* grant set when column constraints mix with parse-authorized DDL — configured access silently evaporates, reason buried in compile logic.

6. **Wildcard staleness vs catalog cache.** Wildcards (`read main.*`) expand against a *cached* catalog at compile time. A table created after that compile isn't covered until the catalog cache refreshes and a recompile fires. Safe direction (under-grant / fail-closed) but surprising — new tables are silently ungranted. See also the known limitation that column ACLs fail closed on lake reads.

7. **Lossy audit trail.** Birdshot decisions are drained post-hoc, best-effort via `waitUntil` (`drainAudit`). Enforcement is sound, but audit rows can be dropped on drain failure or worker eviction — notable for a governance product whose value proposition includes the audit log.

8. **Non-atomic per-endpoint revoke fan-out.** Agent delete loops endpoints with `catch {}` per endpoint; partial failure leaves the agent revoked on some endpoints' warm sessions but not others, with no record of which succeeded (bounded by the same ≤15 min window + durable reconnect gate).

### Net

Strong steady-state design (in-memory enforcement, atomic `live_` swap, durable status gate as the real backstop). The gaps are operational robustness: best-effort delivery with no retry/reconciliation, a full-snapshot-per-change cost model that won't scale to large endpoints, an unserialized staging buffer, and several silent-no-op footguns. The headline "near-instant revert" holds only when the gateway is reachable at revoke time; the ≤15 min warm-session window is the honest worst case.

---

## File index

| Layer | File | Key lines |
|---|---|---|
| Type definition | `packages/control-schema/src/types.ts` | 78–123 |
| Policy compiler | `apps/control-api/src/lib/policy-compiler.ts` | 196–506 |
| Endpoint policy | `apps/control-api/src/lib/effective-policy.ts` | 432–586 |
| Recompile + push | `apps/control-api/src/lib/gateway-push.ts` | 77–130 |
| Gateway client | `apps/control-api/src/lib/gateway-client.ts` | 201–210 |
| ACL routes | `apps/control-api/src/routes/acl.ts` | 354–376 (DELETE) |
| Agent revoke route | `apps/control-api/src/routes/agents.ts` | DELETE /:id |
| Admin recovery | `apps/control-api/src/routes/datalakes.ts` | 399–444 |
| Ctrl server (shipped) | `apps/dataplane/gateway/gateway/gateway-src/ctrl-server.ts` | 87–99 |
| applySnapshot (shipped) | `apps/dataplane/gateway/gateway/gateway-src/duck.ts` | 417–456 |
| Birdshot state | `birdshot/src/birdshot_state.hpp` | 201–283 |
| Config staging/commit | `birdshot/src/birdshot_extension.cpp` | 56–146 |
| Revoke fn | `birdshot/src/birdshot_extension.cpp` | 171–177 |
| IsRevoked | `birdshot/src/birdshot_extension.cpp` | 191–194 |
| Authorize hook | `birdshot/src/birdshot_extension.cpp` | 629–809 |
