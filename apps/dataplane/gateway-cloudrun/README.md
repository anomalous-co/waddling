# waddling gateway — GCP Cloud Run (writer + reader)

The DuckDB gateway re-homed on plain Cloud Run, replacing the Cloudflare
Durable-Object/Sandbox container pool. One image, two roles selected by `GW_ROLE`.

## Why this exists

The CF data plane load-balanced reads across a multi-replica pool where a read could land on
a different replica than the write, holding a stale `memory.main` read-through view → post-write
reads returned 0 rows / "table does not exist" / hangs. This gateway removes that class:

- **No quack, no `memory.main` views.** birdshot's `birdshot_authorize` *is* the production authz
  function (quack only wired it as a callback). So each request authenticates the session JWT,
  authorizes the exact statement, and — only on allow — executes the byte-identical SQL directly
  on the DuckLake-attached connection (the proven `/governed-load` pattern, now also for reads).
- **Reader coherence by construction.** Each `/query` runs on a fresh connection off the shared
  instance, so it reads the current DuckLake snapshot (immutable Parquet + Postgres catalog) —
  it sees the writer's latest commit immediately, across instances. A unique birdshot session id
  per request isolates concurrent agents' principals.
- **Writer** serializes governed writes on the lake-owning connection (per-endpoint affinity
  avoids DuckLake commit races); **reader** autoscales for 10s–100s agents/s.

## Storage = GCS (no R2)

Lake Parquet lives in `gs://waddling-lake-prod`. DuckDB reaches it via its S3-compatible interop
endpoint: `S3_ENDPOINT=storage.googleapis.com` + a GCS HMAC key, `DUCKLAKE_DATA_PATH=s3://waddling-lake-prod/<endpoint>/`.

## Build layout

`server.mjs` (top level) imports the vendored TypeScript gateway core in `gateway-src/` (the
shipped, diverged copy — `bootDuckRuntime` gains `{serveQuack:false, lakeViews:false}`). The
Dockerfile esbuild-bundles `server.mjs` → `server.js` and runs `node server.js`. Only runtime
dep is `@duckdb/node-api`; the linux_amd64 birdshot binary is staged in `birdshot/`.

## HTTP surface

- `GET  /healthz` — role, snapshot version, lake attached, policy loaded
- `POST /ctrl/snapshot` `{snapshot, auth, lakeCatalog, version}` — push a birdshot ACL snapshot
- `POST /ctrl/reapply` — re-apply the cached snapshot (recover a hot replica)
- `POST /ctrl/revoke` `{kind,id,reason,expiresUs}` — instant revocation
- `GET  /ctrl/status` — birdshot status
- `POST /query` `{token, sql}` — governed read (both roles)
- `POST /governed-load` `{token, sql}` — governed write (writer only; 403 on a reader)

## Local smoke test (the milestone gate)

Real birdshot is linux_amd64 only, so the test runs in a container:

```bash
pnpm run smoke   # or: npm run smoke
```

`test/smoke.mjs` boots two DuckDB instances over one local-file DuckLake (writer + reader) and
asserts: a reader instance sees the writer's CREATE + rows (cross-instance, warm-reader-reads-own-write),
a data-only INSERT is visible to a fresh reader read, an ungranted table is DENIED, and a table
created *after* the reader booted is visible. (The HTTP server + GCS/Cloud SQL paths are verified
live on Cloud Run — see below.)

## Deploy

```bash
./provision.sh   # one-time: SA + IAM, fresh Cloud SQL client cert, server CA, GCS HMAC, secrets
./deploy.sh      # build image + deploy gw-writer and gw-reader to Cloud Run
```

Target: project `project-bd87157a-f6fd-4d44-830`, region `us-west1`, Cloud SQL `waddling-main`,
Artifact Registry `us-west1-docker.pkg.dev/project-bd87157a-f6fd-4d44-830/waddling`.

`deploy.sh` deploys both services `--no-allow-unauthenticated` (the router/control plane calls
them with an identity token). `DUCKLAKE_*` per-endpoint values are deployment defaults here; the
endpoint router (WS2) supplies them per request/runtime.
