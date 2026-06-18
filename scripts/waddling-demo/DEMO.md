# waddling Demo

Self-contained end-to-end demo: control-plane Postgres + DuckDB gateway + Next.js
control plane + External MCP server + scripted demo agent. One command up.

There are two ways to run it: **host-native (no Docker, recommended)** and the
original **Docker Compose** stack (further down).

---

## Run without Docker (recommended)

One script brings up the whole stack as plain Node processes — no Docker,
no Postgres install, no MinIO:

```bash
bash scripts/waddling-demo/run-local.sh          # bring up, stay running
bash scripts/waddling-demo/run-local.sh --demo   # bring up + run the 6-step walkthrough, then tear down
```

How it differs from the Docker stack (same product code, lighter deps):

| Concern            | Docker stack            | Host-native (`run-local.sh`)                              |
| ------------------ | ----------------------- | --------------------------------------------------------- |
| Control-plane DB   | `postgres:16` container | **PGlite** socket server on `127.0.0.1:5470` (pure JS)    |
| DuckLake catalog   | Postgres catalog        | **local DuckDB file** `.local/lake/lake.ducklake`         |
| Lake data store    | MinIO (S3)              | **local directory** `.local/lake/data/`                   |
| birdshot extension | Linux/arm64 ELF build   | the **macOS** build `birdshot/build/release/.../*.duckdb_extension` |

**Prerequisites**

1. Node (with `npx`) + `pnpm install` already run at the repo root.
2. The **macOS** birdshot extension built once: `make -C birdshot`
   (produces `birdshot/build/release/extension/birdshot/birdshot.duckdb_extension`).
   The Linux cross-compile is only for the Docker gateway and is NOT needed here.
3. Free ports: **3100** (app), **5470** (PGlite), **9500/9510** (gateway),
   **8810** (mcp-external). If a stale Docker demo holds 5470/9000/9001, stop it
   with `docker compose -f scripts/waddling-demo/docker-compose.yml down`.

**What it does** — boots in dependency order (PGlite → seed → gateway → app →
mcp-external), where the seed runs to completion and EXITS before the gateway
opens the single-writer local DuckLake file. Then prints:

```
Dashboard : http://localhost:3100
Login     : admin@acme.test  /  waddling-demo
Agent keys: analyst sk_agent_analyst_demo · etl-bot sk_agent_etlbot_demo · admin sk_agent_admin_demo
```

State lives under `scripts/waddling-demo/.local/` (pgdata, lake, logs); delete it
to reset. Per-service logs are in `.local/logs/`. Ctrl-C tears everything down.

---

## Run with Docker Compose

## Prerequisites

1. **Docker** (Engine 24+ with Compose v2, ≥6 GB RAM, ≥15 GB free disk) —
   `docker compose version`
2. **Build the LINUX/arm64 birdshot extension first.** The gateway container is
   Linux and cannot LOAD the host's macOS (Mach-O) build, so build the Linux
   binary in a one-shot Docker builder:

   ```bash
   bash scripts/waddling-demo/build-birdshot-linux.sh
   ```

   Output (the gateway Dockerfile COPYs this exact path):

   ```
   birdshot/build-linux/birdshot.duckdb_extension   (ELF aarch64)
   ```

   If it is missing, `docker compose build` fails with a clear COPY error.
   (The legacy `make -C birdshot` produces the macOS build under
   `birdshot/build/release/...` — that is for local host use only, NOT the
   container.)

3. No other ports in use: **3100** (app), **5470** (postgres), **9000/9001**
   (minio), **9500/9510** (gateway), **8810** (mcp-external).

---

## Bring up the stack

Build all images, then start the infra + services detached:

```bash
docker compose -f scripts/waddling-demo/docker-compose.yml build
docker compose -f scripts/waddling-demo/docker-compose.yml up -d \
  postgres minio gateway app mcp-external
```

First build takes ~5-8 minutes (node packages + Next.js build). The `gateway`
boots an empty DuckLake (CREATE_IF_NOT_EXISTS) and becomes healthy before the
seed runs; the seed then populates the `sales` tables into the same catalog.

---

## Seed the database

Run the seed (one-shot `seed` profile) AFTER the infra is up:

```bash
docker compose -f scripts/waddling-demo/docker-compose.yml \
  --profile seed run --rm seed
```

The seed script will:
- Create MinIO bucket `waddling-lake`
- Apply `packages/control-schema/schema.sql` (waddling tables)
- Apply Better Auth schema tables + seed one RS256 **JWKS** signing key
- Create org **acme**, admin user **admin@acme.test** / **waddling-demo**
- Create endpoint **prod-lake** (gateway pointing at MinIO)
- Create agents with **deterministic, hashed** API keys (stored as the
  better-auth SHA-256/base64url hash so `verifyApiKey` succeeds):
  - `analyst`   → `sk_agent_analyst_demo`
  - `etl-bot`   → `sk_agent_etlbot_demo`
  - `admin-bot` → `sk_agent_admin_demo`  (authorizes the demo's admin REST calls)
- Load DuckLake `sales` schema: `orders` (20k rows), `customers` (10k, with
  PII `ssn` column), `events` (20k rows) as Parquet on MinIO
- Install ACL rules:
  - `analyst` → read `sales.orders` (all columns)
  - `analyst` → read `sales.customers` (columns: `customer_id, name, email,
    country, tier, created_at` — **no ssn**)
  - `etl-bot` → write `sales.events`

These keys are wired into `docker-compose.yml` (`WADDLING_API_KEY`,
`WADDLING_ADMIN_TOKEN`, `ETLBOT_API_KEY`) so the demo agent runs unattended.

---

## Run the demo agent

After seeding, run the scripted walkthrough (fails loud on any broken step):

```bash
docker compose -f scripts/waddling-demo/docker-compose.yml \
  run --rm demo-agent
```

---

## What you'll see

### Dashboard

Open **http://localhost:3100** and sign in:

```
Email:    admin@acme.test
Password: waddling-demo
```

You'll see:
- Org **Acme Corp** with 1 running endpoint (`prod-lake`) and 2 agents
- Real-time audit log and usage metrics as the demo agent runs
- ACL rule builder at `/dashboard/acl`

### Demo agent (scripted narrative)

The `demo-agent` container executes automatically after all services start.
Watch its output with:

```bash
docker compose -f scripts/waddling-demo/docker-compose.yml logs -f demo-agent
```

#### The 6-step narrative

**Step 1 — Discover endpoints**
The agent calls `waddling_list_endpoints` and finds `prod-lake` (status:
`running`).

**Step 2 — Connect and query orders**
The agent calls `waddling_connect` → receives an `ATTACH` SQL string + session
JWT. Then calls `waddling_query "SELECT * FROM sales.orders LIMIT 5"` →
returns 5 rows. Dashboard audit log lights up with an `allow` entry.

**Step 3 — Structured denial on SSN column**
Agent calls `waddling_query "SELECT ssn FROM sales.customers LIMIT 5"`.
The gateway proxy sees `ssn` is not in the analyst's column allow-list and
returns a structured error:

```json
{
  "error": "authorization_denied",
  "table": "sales.customers",
  "reason": "column 'ssn' not in allow-list for agent:analyst"
}
```

The audit log records a `deny` event. The agent can self-correct.

**Step 4 — Admin grants additional column access**
The admin (via the dashboard or Internal MCP) runs:

```
POST /api/cp/acl
{ endpoint_id, agent_id: analyst, schema: sales, table: customers,
  columns: [customer_id, name], verb: read }
```

The **policy compiler** recompiles and pushes a fresh birdshot snapshot to the
gateway. The new rule is visible on the `/dashboard/acl` page.

**Step 5 — Retry succeeds, SSN still absent**
Agent retries `SELECT customer_id, name FROM sales.customers LIMIT 5` →
returns rows. `ssn` is not in the response even though the underlying table
has it — the **gateway query proxy** enforces the column allow-list before
the SQL reaches DuckDB.

**Step 6 — Instant revocation**
Admin revokes `etl-bot` via `POST /api/cp/agents/:id/revoke`. This calls
`birdshot_revoke('user', 'agent:etl-bot', 'demo-revoke', 0)` on the gateway —
adding the principal to birdshot's **in-memory denylist**. Any subsequent
`etl-bot` write is denied within the same millisecond, before the JWT expires.
Usage page shows query counts; billing page shows the active Pro plan.

---

## Teardown

```bash
docker compose -f scripts/waddling-demo/docker-compose.yml down -v
```

The `-v` flag removes named volumes (postgres data, minio data). Omit it to
preserve data between runs.

---

## Troubleshooting

**`COPY birdshot.duckdb_extension` fails at build time:**
Run `make -C birdshot` first. See `birdshot/README.md` for build requirements
(CMake, a C++17 compiler, ~4 GB disk space).

**Gateway exits with "extension not loadable":**
The birdshot binary must match the DuckDB engine version (v1.5.3). Rebuild
with the pinned DuckDB submodule in `birdshot/`.

**MinIO health check fails:**
MinIO's `mc ready local` check requires the `mc` binary. If the minio image
does not include it, the check falls back to the HTTP health endpoint. Wait
30 seconds and re-run `docker compose up`.

**Seed script: "Better Auth migration failed":**
The seed applies a minimal subset of Better Auth tables. If the full app
(W1) also runs migrations, re-running seed is safe (all CREATE TABLE calls
use `IF NOT EXISTS`).

**App port 3100 already in use:**
Edit the host port mapping in `docker-compose.yml` (W0 owns that file). Or
stop the conflicting service.

---

## Architecture in this demo

```
Browser  ──HTTPS──▶  app:3100   (Next.js — control plane + dashboard)
                          │
                    Postgres:5432 (inside docker: waddling schema + auth tables
                                   + DuckLake catalog)
                          │
demo-agent ──MCP──▶  mcp-external:8810
                          │ HTTP REST
                    app:3100/api/cp/*
                          │
                     gateway:9510 (ctrl) / 9500 (quack)
                          │
                    DuckDB + birdshot (table-level ACL + instant revocation)
                          │
                    MinIO:9000 (s3://waddling-lake/ — Parquet via DuckLake)
```
