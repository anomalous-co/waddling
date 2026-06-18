# Stage D gateway probe — the waddling gateway as a private CF Container Durable Object

## What this proves

Lynchpin #1 (`apps/cf-stagec-hop-probe`) proved a Sandbox's outbound handler can
route an allowlisted egress to an internal DO via its binding — i.e. the gateway
will be *reached* internally. This probe proves the OTHER unproven integration:

> The waddling gateway (DuckDB + `quack_serve` + birdshot) actually **runs inside a
> CF Container Durable Object**, is reachable via **`containerFetch`** (NOT a public
> host), serves **birdshot-gated quack**, and `birdshot_authorize` gates queries in
> **production RS256 mode** (not the dev mode that skips signature/iss/aud).

`GW-PASS` iff: the allowed query returns rows AND the denied query is an
authorization denial (the query threw AND birdshot's audit decision is `deny`) AND
birdshot ran in `mode=rs256` (a green result in dev mode is a FALSE PASS).

## Proof path (honest scope)

```
Worker /probe
  → GatewayDO.startProcess("node --import tsx /opt/gateway/entrypoint.mjs")   [in container]
  → containerFetch(:8080 /ctrl/snapshot)   push ACL + RS256 JWKS into birdshot (production mode)
  → mint RS256 session JWT (jose) in the Worker  (kid matches the pushed JWK)
  → containerFetch(:8080 /query {token, sql})
       → in-container DuckDB quack CLIENT  ATTACH 'quack:localhost:9500' (TOKEN=jwt)
       → birdshot_authenticate (RS256) + birdshot_authorize gate the SQL on loopback quack:9500
```

The `containerFetch` hop carries the **control request + JSON rows**, NOT raw quack
wire. This proves *"the gateway DO serves gated quack"*; it does NOT claim quack wire
survives the DO hop (that is a later step — the workspace→gateway wiring). workerd
has no DuckDB, so the agent's quack client physically cannot live in the Worker; it
lives in the container, exactly where a real workspace's DuckDB will.

## Container-reach mechanism: forwarder (NOT containerFetch straight to :9500)

The container runs a thin HTTP **forwarder** on `:8080` (`container/gateway/entrypoint.mjs`).
The DO reaches it via `containerFetch(url, init, 8080)`. Two surfaces:
- `POST /ctrl/snapshot`, `GET /ctrl/status` — in-process birdshot control on the
  gateway's trusted DuckDB connection (the same one `quack_serve` was started from);
- `POST /query {token, sql}` — runs the gated query via the in-container quack client;
- everything else — proxied byte-for-byte to loopback `quack:9500`.

**Why a forwarder rather than `containerFetch` straight to `:9500`:** the birdshot
control functions (`applySnapshot`, `birdshot_status`, `birdshot_log_drain`) MUST run
on the same in-process connection that started `quack_serve` — only a process next to
that connection can call them. `containerFetch` directly to `:9500` reaches quack but
NOT those in-process control functions, so a forwarder is required for the snapshot
push and the audit-drain regardless. It co-locates the control channel with the quack
proxy so the DO drives both over one port.

## Validated locally (this sandbox)

- `npx tsc --noEmit` — clean.
- `npx wrangler types` — clean.
- `npx wrangler deploy --dry-run` — Worker bundles (603 KiB; gzip 131.67 KiB). The
  container image build proceeds through every step EXCEPT the birdshot binary fetch
  (see Blocker). A side build with the fetch stubbed confirmed the rest of the image
  (`npm install @duckdb/node-api@1.5.3-r.3 + tsx`, gateway-src copy, entrypoint copy)
  builds cleanly on `linux/amd64`.
- **End-to-end gateway flow smoke test on the host (macOS arm64, real osx_arm64
  birdshot binary):** booted `entrypoint.mjs`, pushed the RS256 snapshot, minted the
  RS256 JWT, ran both queries. Result:
  ```
  mode=rs256
  ALLOW  SELECT * FROM lake.orders  → 3 rows, authorizeDecision="allow"
  DENY   SELECT ssn FROM lake.secrets → "Authorization failed", authorizeDecision="deny"
  VERDICT: GW-PASS
  ```
  The container is the identical code on linux/amd64. This host smoke is the strongest
  validation here — it caught two real bugs (query must be `lake.<table>`, and the
  bind-walk lake catalog must be `memory`) that tsc/dry-run never would.

## Prediction: GW-PASS

The full gateway flow (boot → snapshot → mint → gated allow/deny) is proven on the
host with the real birdshot binary. The deployed-run unknowns — none exercised by the
host smoke, all deploy-only-validatable — are:

- **`containerFetch` to a started-process port is NEW here** — the hop probe used the
  outbound-handler + `exec` path and never called `containerFetch`. This probe is the
  first to drive `containerFetch(url, init, 8080)` to a node process the DO started.
  Medium risk: standard SDK usage, but unproven in this stack.
- **`startProcess` cwd / tsx resolution** — mitigated by loading tsx via absolute path
  (`/opt/gateway/node_modules/tsx`) AND pinning `cwd: /opt/gateway`. Low risk.
- **linux/amd64 birdshot binary loading** — CI builds it; the host proved the osx_arm64
  build loads + gates identically. Low risk.
- **the birdshot R2 fetch resolving on CF build infra** — see Blocker. The single hard
  dependency for a successful deploy.

The probe drives the DO entirely through SDK methods (`exec`/`startProcess`/
`containerFetch`), NOT custom subclass methods on the `getSandbox` stub, so there is no
dependency on subclass-RPC dispatch.

## The exact birdshot ACL-snapshot + JWK-push API (for the real control-plane wiring)

The snapshot push goes through the REAL gateway code (`packages/gateway/src/duck.ts`
`applySnapshot`), unchanged. With `auth` present it issues, in order:

```sql
SELECT birdshot_reset_config();
SELECT birdshot_set_lake_catalog('memory');            -- the bind-walk catalog
SELECT birdshot_set_auth('<issuer>', 'gw:<endpointId>', 'rs256');   -- PRODUCTION MODE
SELECT birdshot_add_jwk('<kid>', '<n_b64url>', '<e_b64url>');       -- one per JWK
SELECT birdshot_add_user_role('agent:<id>', 'agent_<id>');
SELECT birdshot_add_role_grant('agent_<id>', 'main.orders', 'read');
SELECT birdshot_commit_config();
```

`birdshot_set_auth(..., 'rs256')` is what puts birdshot in production mode — pushing
`auth` guarantees it by construction; the probe ALSO asserts `birdshot_status().mode
=== 'rs256'` so a dev-mode false-pass can never slip through. Note `birdshot_status()`
returns a SPACE-delimited `key=value` string (NOT JSON); the forwarder parses `mode=`
out of it.

**PROBE-SPECIFIC, do NOT copy verbatim into the real WorkspaceSandbox wiring:**
`birdshot_set_lake_catalog('memory')` and seeding into `memory.main` are probe
artifacts. The real control plane (`apps/control-api/src/routes/sessions.ts` →
`applySnapshot`) uses the **ducklake alias** as the lake catalog and the data lives in
the ATTACHed ducklake, not `memory`. The probe seeds in `memory.main` because that is
where quack's serving connection resolves the bare federated ref (see the data triple
below); the `'memory'` catalog is a consequence of that placement, not the production
value. What IS faithful and reusable: the `birdshot_set_auth`/`birdshot_add_jwk`/
`birdshot_add_role_grant` call sequence and the RS256 JWT mint.

## How the RS256 session JWT is minted (mirrors control-api/sessions.ts)

`jose`: generate an RSA-2048 keypair (`RSASSA-PKCS1-v1_5`/SHA-256) per `/probe` run;
push the public half as the JWKS (`{kid, n, e}`); mint with the private half:

```
new SignJWT({ id: "agent:<id>" })
  .setProtectedHeader({ alg: "RS256", kid })   // kid matches the pushed JWK
  .setSubject("agent:<id>")
  .setIssuer(ISSUER)
  .setAudience("gw:<endpointId>")
  .setIssuedAt().setJti(uuid).setExpirationTime("15m")
  .sign(privateKey)
```

## The proven data triple (placement / grant / query)

These three MUST agree (mirrors `birdshot/test/e2e/birdshot.e2e.ts:147-188`):
1. **placement** — tables seeded in `memory.main` (`memory.main.orders`,
   `memory.main.secrets`). quack serves a federated scan on a connection defaulting to
   `memory.main`, so the bare ref it pushes down must resolve there. (Seeding into the
   ducklake fails: birdshot allows the scan but quack's serving connection can't
   resolve bare `orders` against the lake catalog.)
2. **grant tableRef** — `main.orders` (read). `secrets` has NO grant → deny by omission.
3. **client query** — `SELECT * FROM lake.orders` / `SELECT ssn FROM lake.secrets`
   (`lake` = the ATTACH alias). The bind-walk lake catalog is `memory` (the
   `lakeCatalog` field on the snapshot push), so `lake.orders` resolves to
   `memory.main.orders` and the `main.orders` grant matches.

## Security assertions

- **Production RS256 mode** — verdict requires `birdshotMode === "rs256"` from
  `birdshot_status()`. A dev-mode green is reported as a FALSE-PASS guard, not a pass.
- **Boot order** — `bootDuckRuntime` installs the birdshot auth/authz hooks BEFORE
  `quack_serve` (`duck.ts:126-133`); the forwarder (hence `/healthz`, hence the whole
  exchange) starts only AFTER `bootDuckRuntime` returns, so there is no observable
  allow-all window. NOTE: `bootOrderOk` in the verdict is this STRUCTURAL guarantee,
  reported as a constant — it is not a runtime-measured check (there is no way to
  observe the pre-serve window from outside the boot).
- **Denied query is an authz denial** — not an empty result, not a parse error. A deny
  has no string on the wire; the verdict requires the query to THROW AND birdshot's
  last authorize audit decision (`birdshot_log_drain`) to be `deny`. Confirmed on the
  host: deny error = `Invalid Input Error: Authorization failed`, decision = `deny`.

## Blocker (deploy-time, isolated to one Dockerfile line)

The birdshot extension is arch-specific. The Dockerfile fetches the `linux_amd64`
build from the R2 CDN (`https://ext.getwaddling.com/v1.5.3/linux_amd64/birdshot.duckdb_extension.gz`,
the canonical layout — `infra/r2/setup-r2.sh`). That host returns **NXDOMAIN from this
dev sandbox** (and via 1.1.1.1) — consistent with the R2 custom domain not being live
in this network yet — so a LOCAL `wrangler deploy --dry-run` image build stops at that
one `RUN`. The host-local `birdshot/build-linux/birdshot.duckdb_extension` is **arm64**,
not amd64, so it can't substitute (it would not LOAD on the amd64 container).

This is a **deploy-time fetch**, not a code blocker: the conductor's Cloudflare-side
build resolves `ext.getwaddling.com`. If it does NOT resolve there either, the fix is
one of: (a) point `BIRDSHOT_BASE_URL` build-arg at the R2 `.r2.dev` / account URL, or
(b) bake a `linux_amd64` binary into the build context and `COPY` it (mirroring
`scripts/waddling-demo/Dockerfile.gateway:60`). Verify the amd64 artifact exists in R2
first: `curl -I https://ext.getwaddling.com/v1.5.3/linux_amd64/birdshot.duckdb_extension.gz`.

## Deploy / run / teardown (conductor)

```bash
cd apps/cf-stagec-gw-probe/worker
npm install                      # standalone (outside the apps/* workspace glob)
npx wrangler deploy              # builds the linux/amd64 image (needs ext.getwaddling.com to resolve)

# Run the probe (first call cold-boots the gateway; allow ~60-90s):
curl https://cf-stagec-gw-probe.<your-subdomain>.workers.dev/probe | jq

# Expect: { "verdict": "GW-PASS", "birdshotMode": "rs256", "allowedRowCount": 3,
#           "deniedByAuthz": true, "deniedAuthorizeDecision": "deny", ... }

# Teardown:
npx wrangler delete
```

## Files

- `worker/src/index.ts` — `GatewayDO` (Sandbox subclass) + `/probe` orchestration + RS256 mint.
- `worker/wrangler.jsonc` — container (standard-2), DO binding, `WADDLING_ENV=production`.
- `container/Dockerfile` — gateway image (sandbox base + DuckDB + birdshot amd64 + tsx).
- `container/gateway/entrypoint.mjs` — boot (reuses `packages/gateway` `bootDuckRuntime`)
  + seed + forwarder + in-container quack client + audit-drain.
- `container/gateway/gateway-src/` — copy of `packages/gateway/src` (imported, not forked).
```
