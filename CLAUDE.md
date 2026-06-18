# waddling

Dynamic agent access-control for DuckDB. Agents connect their DuckDB instances to org-managed endpoints; birdshot enforces per-agent table-level ACLs at the gateway via Quack wire protocol.

## Conventions

- **Git commits**: do NOT add a `Co-Authored-By` trailer (or any co-author/attribution line) to commit messages. Write the message body and stop.

## Architecture

Three-plane architecture:
- **Control plane**: Next.js app (`apps/waddling`) + Postgres 16 (Cloud SQL on GCP)
- **Data plane**: DuckDB gateway + birdshot extension (Rivet actor on Cloud Run)
- **Agent plane**: customer's DuckDB instance, connects via `ATTACH 'quack:...'`

See `waddling-context/ARCHITECTURE.md` for the full system spec.

## RivetKit

RivetKit runs the DuckDB gateway as long-lived **Runner-mode** actors. One actor per endpoint (key `[orgId, endpointId]`). `DuckRuntime` lives in `c.vars` (ephemeral, rebuilt on wake).

Reference docs: https://rivet.dev/llms.txt  
GCP Cloud Run deploy guide: https://rivet.dev/docs/connect/gcp-cloud-run/

The PoC is at `gateway-rivet-poc/`. Proven: fork A (birdshot loads+enforces inside actor). Fork B (external quack ATTACH via Rivet HTTP proxy) is wired in `onRequest` but not yet verified end-to-end.

Rivet project: `anomalous-bnnl-production-3zpe` — credentials in Secret Manager (`rivet-endpoint`, `rivet-public-endpoint`).

## Birdshot

C++ DuckDB extension enforcing per-agent table-level ACLs via Quack auth/authz hooks. DuckDB version pinned at `v1.5.3` (`@duckdb/node-api 1.5.3-r.3`).

**Build**: GitHub Actions in the `birdshot/` repo (`.github/workflows/build-birdshot.yml`). Delegates to DuckDB's official reusable workflow (`duckdb/extension-ci-tools/.github/workflows/_extension_distribution.yml`, pinned to the same commit as the vendored submodule) so vcpkg handles OpenSSL + cross-compilation + emscripten + MSVC on every platform. With no `exclude_archs` it builds all 9 default (`opt_in:false`) targets: `linux_amd64`, `linux_arm64`, `osx_amd64`, `osx_arm64`, `windows_amd64`, `windows_amd64_mingw`, `wasm_mvp`, `wasm_eh`, `wasm_threads`. A `publish` job then pushes every artifact to R2. (GCP Cloud Build was ruled out: no macOS/Windows runners.)

**Distribution**: Cloudflare R2 bucket `waddling-ext`, served via CDN at `https://ext.getwaddling.com`. Two layouts:
- Native: `v1.5.3/{platform}/birdshot.duckdb_extension.gz` (gzip)
- WASM: `duckdb-wasm/v1.5.3/{platform}/birdshot.duckdb_extension.wasm` (raw `.wasm`; the `duckdb-wasm/` prefix + `.wasm` suffix is what the DuckDB-Wasm loader expects). R2 needs a CORS policy (GET/HEAD from `*`) because wasm extensions are fetched from the browser.

```sql
-- native
SET allow_unsigned_extensions = true;
INSTALL birdshot FROM 'https://ext.getwaddling.com';
LOAD birdshot;

-- duckdb-wasm
SET custom_extension_repository = 'https://ext.getwaddling.com';
LOAD birdshot;
```

**Usages** (6 call sites):
1. `packages/gateway/src/duck.ts` — loads at runtime, wires auth/authz hooks
2. `gateway-rivet-poc/src/registry.ts` — loaded in Rivet Runner-mode actor
3. Policy compiler → `birdshot_*` SQL functions push ACL snapshots to gateway
4. `waddling_install_extension` MCP tool → returns the INSTALL SQL to agents
5. `waddling_admin_endpoint_status` MCP tool → calls `birdshot_status()`
6. `scripts/waddling-demo/Dockerfile.gateway` — pre-baked for local demo

**Security note**: birdshot gates tables; column/row/window filtering is handled by the MCP gateway proxy layer. See `waddling-context/` for ACL model.

## Infrastructure scripts

- `infra/gcp/setup.sh` — create GCP project, enable APIs, Cloud SQL, Artifact Registry, Secret Manager
- `infra/gcp/deploy-actor.sh` — build + push + deploy the Rivet gateway actor to Cloud Run
- `birdshot/.github/workflows/build-birdshot.yml` — cross-platform CI + R2 upload
- `infra/r2/setup-r2.sh` — R2 bucket creation + CORS

## Local dev

```bash
# Demo stack (Postgres + MinIO + gateway + Next.js)
docker compose -f scripts/waddling-demo/docker-compose.yml up

# Rivet actor (needs rivet-engine on :6420 first)
cd gateway-rivet-poc && npm run dev
npm run verify        # runs fork A enforcement proof
npm run verify:b      # tests fork B (quack via HTTP proxy)
```
