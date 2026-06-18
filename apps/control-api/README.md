# @waddling/control-api — Stage A scaffold

A minimal Hono Worker that validates the three load-bearing Cloudflare bindings
the real control plane (Stage B) will be built on. The `/probe/*` routes are
**temporary**; Stage B ports the actual control plane on top of this app and
deletes the probes.

## What the probes prove

| Route | Binding | What it proves |
|---|---|---|
| `GET /probe/db` | Hyperdrive (`HYPERDRIVE`) | A `pg` Pool can reach PlanetScale Postgres through Hyperdrive and run `SELECT 1` / `SELECT version()`. |
| `GET /probe/secret` | Secrets Store (`MASTER_KEY`) | The Worker can read a secret via `.get()`. Reports presence/length/placeholder only — **never the value**. |
| `GET /probe/r2` | R2 over SigV4 (`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`) | A presigned-URL PUT→GET round-trip against the R2 S3 endpoint (Model B — no native R2 binding). |
| `GET /probe` | all three | Combined result plus a top-level `summary`. |

## Deploy and run

```bash
cd apps/control-api
npx wrangler deploy
# then hit the deployed Worker:
curl https://waddling-control-api.mirri.workers.dev/probe
```

> Deploys are handled by the conductor (production deploys are soft-blocked).
> `npx wrangler deploy --dry-run` validates config + bundles without deploying.

### Reading results

- `summary.db: "ok"` — Hyperdrive → Postgres works. A `fail` whose error mentions
  TLS/cert means PlanetScale's CA must be uploaded with `wrangler cert` (Hyperdrive
  uses WebPKI and ignores libpq's `sslrootcert`).
- `summary.secret: "ok"` — the master key was readable. The Stage-A value is a
  **PLACEHOLDER** (`isPlaceholder: true` is expected); Stage B replaces it with the
  real `BETTER_AUTH_SECRET`.
- `summary.r2: "pending-r2-token"` — **expected** until a real R2 token lands.
  Placeholder creds make R2 answer 403; the probe reports this fail-closed and it
  does **not** count as a Stage-A failure. Once a real token is in place this
  becomes `"ok"` with `roundTripMatch: true`.

## Pending: real R2 API token

The R2 probe is PENDING a real R2 S3 API token. To unblock it:

1. Cloudflare dashboard → R2 → **Manage R2 API Tokens** → create an S3 token with
   read/write on `waddling-ws-probe`. Copy the Access Key ID + Secret Access Key.
2. The conductor pushes them into Secrets Store:
   ```bash
   npx wrangler secrets-store secret update r2-access-key-id     --store-id 121d675c4103466f90c6e1a97e1fd494
   npx wrangler secrets-store secret update r2-secret-access-key --store-id 121d675c4103466f90c6e1a97e1fd494
   ```
3. Re-run `curl …/probe/r2` — expect `ok: true`, `roundTripMatch: true`.

## Local dev

`wrangler dev` does **not** route through the real Hyperdrive proxy, so the
authoritative `/probe/db` result is from the deployed Worker. See `.dev.vars.example`
for the local Hyperdrive connection-string override.
