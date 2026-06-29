# GCP Cloud SQL — the managed Postgres move

Waddling's managed Postgres lives in **one shared GCP Cloud SQL instance**. This doc is
the canonical record of that move (off Neon/PlanetScale) and the operational runbook for
it. For credential operations (cert/password rotation), **don't hand-run gcloud/wrangler —
use [`infra/gcp/credops.sh`](../infra/gcp/credops.sh)** (see [Credential operations](#credential-operations--how-we-do-it)).

## Why

Both the control plane **and** every per-org DuckLake catalog now live as databases inside
a single shared Cloud SQL instance, using a **database-per-org** tenancy model. One
instance to run, patch, and pay for; tenant isolation is enforced by separate databases +
roles rather than separate instances. This replaced the earlier Neon (managed catalog) /
PlanetScale (control plane) split.

## The instance

| | |
|---|---|
| Instance | `waddling-main` |
| Project | `project-bd87157a-f6fd-4d44-830` |
| Region | `us-west1` |
| Engine | Postgres 18 |
| Public IP | `34.168.85.164` |
| Connection name | `project-bd87157a-f6fd-4d44-830:us-west1:waddling-main` |

> The active `gcloud config` project is a different, unrelated project — **always pass
> `--project=project-bd87157a-f6fd-4d44-830` explicitly** for any Cloud SQL op.

### Access posture (mTLS over public IP)

- **Authorized networks `0.0.0.0/0` + `ssl-mode=TRUSTED_CLIENT_CERTIFICATE_REQUIRED`** —
  the instance is reachable from anywhere, but a connection is refused without a valid
  **client certificate**. mTLS *is* the perimeter; the open network range is intentional.
- Clients connect with **`sslmode=verify-ca`** (not `verify-full`): the server cert's CN
  (`Cloud SQL Server CA`) ≠ the public IP, so full hostname verification would fail. The
  server CA is `GOOGLE_MANAGED_INTERNAL_CA` (not in the system trust store), so every
  client must be given the server CA explicitly (`sslrootcert`).

## Tenancy model: database-per-org

- **Control plane:** database `waddling_control` (control-plane schema migrations + Better
  Auth tables). `waddling_app` is the admin/login role.
- **Per org:** a database `waddling_org_<sanitized-orgId>` with a dedicated login role
  `orguser_<sanitized-orgId>`. On provision: `REVOKE CONNECT … FROM PUBLIC` then
  `GRANT CONNECT, TEMP, CREATE` to that org's role only — so an org role cannot even
  connect to another org's database (cross-tenant isolation, verified live). Inside the
  org DB, each endpoint gets its own DuckLake `METADATA_SCHEMA` (`ep_<id>` / a named
  schema like `dl_demo_lake`), so multiple endpoints share one catalog DB without seeing
  each other's tables.
- **Provisioning is plain SQL over Hyperdrive — no Cloud SQL Admin API.** `CREATE
  DATABASE` / `CREATE ROLE` / `GRANT` run as individual autocommit statements (not inside
  a transaction — `CREATE DATABASE` can't run in a txn block). Code:
  [`apps/control-api/src/lib/cloudsql.ts`](../apps/control-api/src/lib/cloudsql.ts),
  invoked from the catalog-provision path. DB ownership is **not** transferred (PG's "must
  be able to SET ROLE" blocks it; `GRANT CREATE` is enough for DuckLake to `CREATE SCHEMA`).

## How each plane reaches the instance

Three consumers, two transport mechanisms — both mTLS, but the client-cert is presented
very differently:

### 1. control-api → Hyperdrive (mTLS, server-side)

`workerd` cannot present a client certificate on its own outbound TLS, so a Worker cannot
talk to a `TRUSTED_CLIENT_CERTIFICATE_REQUIRED` instance directly. The path is
**Cloudflare Hyperdrive with mTLS**: the client cert + server CA are uploaded to Cloudflare
as cert objects and referenced by the Hyperdrive config (`sslmode=verify-ca`); Hyperdrive
presents them server-side. control-api just reads `env.HYPERDRIVE.connectionString` and
opens a normal `pg` pool per request (never cached across requests — Hyperdrive pools
server-side, and caching a pool on workerd causes 1101s). All provisioning SQL rides this
same Hyperdrive pool.

### 2. gateway containers → direct libpq (mTLS, in-container)

The DuckDB gateway (Cloud Run / CF container) ATTACHes the org's DuckLake postgres catalog
over **direct libpq** with `sslmode=verify-ca` + `sslcert`/`sslkey`/`sslrootcert` **file
paths**. The PEMs ride as dataplane Worker **secrets** (`GW_PG_SSLCERT_PEM`,
`GW_PG_SSLKEY_PEM`, `GW_PG_SSLROOTCERT_PEM`) and are materialized to files in the container
at boot by [`entrypoint.mjs`](../apps/dataplane/gateway/gateway/entrypoint.mjs). The
gateway connects as the per-org `orguser_<id>` role, **not** `waddling_app`.

> **The base64 PEM gotcha (load-bearing).** The Cloudflare Sandbox `startProcess` env
> channel **indents the continuation lines of a multi-line env value** (~6 leading spaces
> per line). A raw PEM passed that way lands corrupted (`1372B` vs `1253B`), and OpenSSL
> rejects the indented base64/END lines (`PEM lib` / `bad end line`). That made the
> postgres-catalog ATTACH fail on every cold boot → `bootDuckRuntime` threw before the
> forwarder listened → the gateway never warmed → control-api's `/gw/snapshot` aborted at
> its 45s timeout. **Fix:** carry the PEMs **base64-encoded** through the env (single line,
> no newlines to indent) and decode in the entrypoint. `bootEnvFromConfig` emits
> `GW_PG_SSL{CERT,KEY,ROOTCERT}_PEM_B64 = btoa(pem)`; the entrypoint's `pemFromEnv()`
> does `Buffer.from(b64,'base64')`. The **stored secret stays raw PEM**; the base64 wrap
> happens in transit only. (Re-uploading the secret does nothing — the corruption was
> never at rest.)

### 3. agent plane → never

Agents never reach Cloud SQL. The control plane *manages*; agent runtime/coordination/memory
data lives in the data plane. Cloud SQL holds control-plane + catalog metadata only.

## mTLS material

| Material | Stored as | Used by |
|---|---|---|
| **Client cert + key** (one shared per deployment, e.g. `waddling-client-<date>`) | a Cloudflare **mTLS-cert object** (referenced by Hyperdrive) **and** dataplane secrets `GW_PG_SSLCERT_PEM` / `GW_PG_SSLKEY_PEM` | control-api (Hyperdrive) + gateways (libpq) |
| **Server CA** (`server-ca.pem`, Google-managed) | a Cloudflare **CA-cert object** **and** dataplane secret `GW_PG_SSLROOTCERT_PEM` | both, for `verify-ca` |
| **`waddling_app` DB password** | the Hyperdrive config's `origin-password` | control-api only |

Both consumers of a given piece of material **must move together** or one side breaks —
exactly the failure modes the tooling below exists to prevent.

## Credential operations — how we do it

**Use [`infra/gcp/credops.sh`](../infra/gcp/credops.sh).** It is the supported way to do
every credential operation against `waddling-main`. Do not hand-run the underlying
gcloud/wrangler commands — the tool encodes the ordering, the verifications, and the
non-obvious gotchas below.

```
infra/gcp/credops.sh          # interactive menu
infra/gcp/credops.sh <1-5>    # jump straight to one op
```

| # | Operation | What it does |
|---|---|---|
| 1 | **Rotate client cert** | mint → upload to CF → repoint Hyperdrive → rotate gateway secrets → verify both paths → offer to retire the old. (Delegates to the non-interactive primitive [`rotate-mtls.sh`](../infra/gcp/rotate-mtls.sh).) |
| 2 | **Retire an old client cert** | lists certs, warns about the warm-replica window, deletes on explicit confirm |
| 3 | **Rotate DB password** | `gcloud … set-password --retain-password` (Postgres **dual-password**) → Hyperdrive update → verify `/probe/db` → `--discard-dual-password`. Zero-downtime: the old password stays valid until the new one is proven. |
| 4 | **Re-push gateway PEM secrets** | re-seed `GW_PG_SSL{CERT,KEY,ROOTCERT}_PEM` from known-good material (auto-fetches the active cert/CA from gcloud; key from a file). For stale/corrupt secrets. |
| 5 | **Rotate server CA** | create upcoming CA → distribute an old+new bundle to all clients → `server-ca-certs rotate` (cutover) → rollback on a failed verify |

Every mutation is confirmed; destructive steps are gated behind an explicit `y`. Secrets
stay off stdout/argv where possible (gcloud `--prompt-for-password` / `read -s`; PEMs in a
`700` tmpdir shredded on exit; Worker secrets piped over stdin).

### Gotchas the tooling encodes (and you must respect if you ever go manual)

- **`wrangler hyperdrive update` must re-pass `--ca-certificate-id` + `--mtls-certificate-id`
  + `--sslmode verify-ca` on *every* call** — even when you're only changing the password.
  A bare update drops the client cert from its validation connection and fails with
  `SQLSTATE 28000` ("requires a valid client certificate").
- **Rotating `waddling_app`'s password without updating Hyperdrive takes control-api down**
  (`password authentication failed for user "waddling_app"`). This happened once; op 3
  does both atomically. `waddling_app` is a gcloud-managed `BUILT_IN` user, so
  `set-password` works without knowing the old password.
- **Don't `.destroy()` a warm gateway container to pick up new certs** (it hangs). Warm
  replicas cache cert files at boot and roll onto new material only on the next cold boot —
  let them idle out (~10m) before retiring an old cert.
- **`verify-ca`, never `verify-full`** (server cert CN ≠ public IP).
- Server-CA rotation: `verify-ca` clients must **trust the new CA before** the server cuts
  over — op 5 distributes an old+new bundle first, so verification passes on both sides of
  the cutover, with `server-ca-certs rollback` as the escape hatch.
- **Poisoned Hyperdrive data-plane after a cert rotation.** Rotating the client cert and
  then deleting the old one can leave Hyperdrive's data-plane connection pool stuck:
  `/probe/db` returns an opaque **`"Internal error."`** on every query even though
  `wrangler hyperdrive update` validation passes and direct libpq with the same
  cert/password/origin works. A config update does NOT flush it. **Remedy: recreate the
  Hyperdrive config fresh** (`wrangler hyperdrive create … --ca-certificate-id …
  --mtls-certificate-id … --sslmode verify-ca --caching-disabled`), set the new id in
  `apps/control-api/wrangler.jsonc`, and `wrangler deploy`. (This is why the live config id
  changed from `7e4d9fdb…` to `8a86652d…`.) `rotate-mtls.sh` re-checks `/probe/db` after the
  old-cert deletion and prints the recreate command if it goes stale.

## Inventory (resource references — not secrets)

| | |
|---|---|
| Hyperdrive config id | `8a86652d8cbb439c911033f8d29dd573` (→ `waddling_control`, mTLS, verify-ca, caching disabled) |
| CF CA-cert id (server CA) | `24dd5caf-275a-4f84-bb05-79f6830f1a6d` |
| CF mTLS-cert id (current client cert) | `1c4a49cd-3131-40e8-a5a3-0eabcfbeb99b` |
| Control/admin role | `waddling_app` |
| Per-org role pattern | `orguser_<sanitized-orgId>` |
| Dataplane gateway secrets | `GW_PG_SSLCERT_PEM`, `GW_PG_SSLKEY_PEM`, `GW_PG_SSLROOTCERT_PEM` |

Cert/password **values** live only in Cloud SQL, Cloudflare cert objects, and Worker
secrets — never in the repo. The CF mTLS-cert id changes on every client-cert rotation;
read the live value with `wrangler hyperdrive get 7e4d9fdb…` (credops shows it in its state
banner).

## Code map

- Provisioning: [`apps/control-api/src/lib/cloudsql.ts`](../apps/control-api/src/lib/cloudsql.ts), catalog-provision path
- Hyperdrive binding + PG vars: [`apps/control-api/wrangler.jsonc`](../apps/control-api/wrangler.jsonc)
- Gateway boot env (base64 PEMs): `bootEnvFromConfig` in [`apps/dataplane/worker/src/index.ts`](../apps/dataplane/worker/src/index.ts)
- Gateway PEM materialization: [`apps/dataplane/gateway/gateway/entrypoint.mjs`](../apps/dataplane/gateway/gateway/entrypoint.mjs)
- Credential ops: [`infra/gcp/credops.sh`](../infra/gcp/credops.sh) · [`infra/gcp/rotate-mtls.sh`](../infra/gcp/rotate-mtls.sh)
