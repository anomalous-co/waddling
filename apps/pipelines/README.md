# @waddling/pipelines

A Cloudflare Workflows ETL fleet. One Worker, one registry, N pipelines. Each
pipeline pulls events from a source (PostHog HogQL today), buffers them to a
Cloudflare Pipelines Stream that rolls Parquet into an R2 prefix inside the lake
bucket, then loads a governed **star schema** into a DuckLake lake by acting as a
normal Waddling agent (`POST /sessions` → ordered `POST /:id/etl`).

```
cron tick ─▶ dispatcher ─▶ EtlWorkflow per due pipeline
                              extract  (PostHog HogQL page → records + watermark)
                              buffer   (records → Stream, ≤1 MB chunks)
                              settle   (sleep ≥ sink roll-interval)
                              load     (ONE session → CREATE SCHEMA + ordered star CTAS)
                              advance  (monotonic D1 watermark + clear running)
```

## Why this shape

- **Workflows, not a bare cron**: durable, checkpointed steps survive eviction and
  retry independently. At-least-once is made safe by design — see *Idempotency*.
- **D1 cursor store, not KV**: the watermark advance is a monotonic guarded
  `UPDATE … WHERE watermark < ?`, which needs strong consistency. D1 is also the
  dispatcher's overlap backstop (the `running` flag).
- **Star schema in the governed lake, not a flat table**: the dimensional model
  *is* the product — grant-gated, audited, birdshot-authorized. Cloudflare-Pipelines
  SQL stays minimal (per-row normalize only); all dedup, dimension build, and
  surrogate-key hashing live in the governed DuckLake CTAS.

## Layout

```
src/
  dispatcher.ts        default export { scheduled, fetch }; overlap-guarded WF.create; Access/RUN_TOKEN-gated GET /run
  workflow.ts          EtlWorkflow: extract? → buffer → settle → governed-load → advance-cursor
  registry.ts          REGISTRY: PipelineSpec[]; budgetTotals() + the ≤20/20/20 cap assertion
  cursor.ts            D1 cursor store (read / markRunning / clearRunning / monotonic advance)
  types.ts             SourceAdapter, StarTable, TargetModel, PipelineSpec, StagingRecord
  env.ts               Env bindings + EtlParams
  lib/validate.ts      IDENT_RE, ISO_RE, glob quote-guard
  lib/governed-load.ts runStarBuild: ONE session, schema prelude + ordered CTAS, typed denials
  sources/posthog.ts   PostHog HogQL incremental pull → SourceAdapter
  models/conformed.ts  shareable conformed dims: dim_date, dim_person
  models/funnel-star.ts the PostHog funnel TargetModel (dim_event_type, dim_campaign, dim_page, fct_funnel_event)
migrations/0001_cursors.sql
schema.json            the Pipelines Stream schema (staging columns)
```

## Star schema (`marketing` lake schema)

| table | kind | key | notes |
|---|---|---|---|
| `dim_date` | conformed dim | `date_key` (yyyymmdd int) | calendar attrs from distinct event dates |
| `dim_person` | conformed dim | `person_key = md5(coalesce(person_id, distinct_id))` | first/last seen, is_identified, email/name (PostHog-merged) |
| `dim_event_type` | dim | `event_type_key = md5(event)` | `stage_category` rolls events up to marketing/signup/activation/paid |
| `dim_campaign` | dim | `md5(utm_source|medium|campaign|referrer)` | acquisition attribution |
| `dim_page` | dim | `md5(coalesce(pathname, current_url))` | page of a marketing event |
| `fct_funnel_event` | **fact** | degenerate `event_uuid` | FKs computed with the SAME md5 expr as each dim; measures `is_conversion`, `cta_location`, `cta_text` |

Surrogate keys are deterministic `md5(natural_key)`, computed identically in the
dim and the fact, so FK resolution is a pure function (no join, rebuild-safe).
Build order is dims-before-fact so a verification JOIN returns rows immediately.

Query surface (through the gateway): `lake.marketing.<table>`. Load surface (the
CTAS the fleet issues): bare `marketing.<table>`.

## Idempotency / at-least-once invariants

- `buffer` may double-send on a retry → the fact CTAS dedups on `uuid`
  (`row_number() OVER (PARTITION BY uuid ORDER BY timestamp DESC) = 1`).
- `governed-load` is idempotent: every statement is `CREATE OR REPLACE TABLE` and
  surrogate keys are deterministic, so a re-run rebuilds to the identical state.
- `advance-cursor` is a monotonic guarded UPDATE → a stale retry is a no-op.
- `running` is cleared in the advance step **and** in a `catch` on the workflow
  body, so an errored run doesn't wedge the dispatcher's overlap guard. As a
  second backstop, the dispatcher re-dispatches a pipeline whose `running=1` but
  whose `last_run_at` is older than the stale threshold (6h).

## Provisioning runbook

All of this is per-source. For the bundled `posthog-funnel` pipeline:

### 1. D1 cursor store

```bash
wrangler d1 create pipelines-cursors          # copy the database_id into wrangler.jsonc (<D1_ID>)
wrangler d1 execute pipelines-cursors --remote --file migrations/0001_cursors.sql
```

### 2. Pipelines stream (schema-validated)

```bash
wrangler pipelines streams create funnel-events --schema-file schema.json
wrangler pipelines streams list                # copy the stream id into wrangler.jsonc (<STREAM_ID>)
```

### 3. R2 sink (Parquet, inside the lake bucket)

The sink writes under a prefix INSIDE the lake bucket so the gateway's lake S3
secret already covers the `read_parquet` egress. **R2 sinks require explicit
credentials** (Object Read & Write on the lake bucket — from `wrangler r2 bucket
create` output or an R2 API token).

```bash
wrangler pipelines sinks create funnel-sink \
  --type r2 --format parquet \
  --bucket <lake-bucket> \
  --path "org-<ID>/_ingest/funnel" \
  --compression zstd \
  --roll-interval 300 \
  --access-key-id "$LAKE_R2_ACCESS_KEY_ID" \
  --secret-access-key "$LAKE_R2_SECRET"
```

> The `--roll-interval 300` MUST match `SINK_ROLL_INTERVAL_SECONDS` in
> `src/workflow.ts`. The `settle` step sleeps `roll-interval + margin` so
> `governed-load` never reads staging before any Parquet has rolled (which would
> yield an empty fact). If you change one, change the other.

Point the registry's `stagingGlob` at this sink's output:
`s3://<lake-bucket>/org-<ID>/_ingest/funnel/**/*.parquet`.

### 4. Pipeline (stream → sink; light per-row normalize only)

```bash
wrangler pipelines create funnel-pipeline \
  --sql "INSERT INTO funnel-sink SELECT * FROM funnel-events"
```

Keep this SQL stateless — timestamp zoning / null-coalesce / lowercase utm at
most. All dedup, dimension build, and surrogate-key hashing live in the governed
DuckLake CTAS (`src/models/*`), not here. Pipelines are immutable — delete and
recreate to change the SQL.

### 5. Secrets

```bash
wrangler secret put POSTHOG_PERSONAL_API_KEY   # PostHog personal API key, query:read scope
wrangler secret put FUNNEL_AGENT_KEY           # the funnel source's sk_agent_… key
wrangler secret put RUN_TOKEN                   # optional: bearer gate for GET /run (skip if behind Access)
```

### 6. Vars (wrangler.jsonc)

Fill `POSTHOG_PROJECT_ID`, `CONTROL_API_BASE`, `DATALAKE_ID`, and the registry
spec's `stagingGlob` + `datalakeId` placeholders.

### 7. Deploy

```bash
pnpm run deploy        # NOT bare `pnpm deploy`
```

## Birdshot grants — the per-source agent

The funnel source's agent (`FUNNEL_AGENT_KEY`) must be granted **every verb the
build emits** on `marketing.*`, plus the source-policy host. birdshot capabilities
are distinct verbs (`create`, `write`, `drop`, `read_source`, … — see
`CAPABILITY_VALUES` in control-api `routes/agents.ts`), and the star build uses
**four** of them:

1. **`create` on `marketing.*`** — the `CREATE [OR REPLACE] TABLE marketing.<t>`
   (and the `CREATE SCHEMA` prelude).
2. **`write` on `marketing.*`** — the CTAS populates the tables.
3. **`drop` on `marketing.*`** — `CREATE OR REPLACE` is an implicit
   **drop-then-create**. On run #1 the tables don't exist (no drop), but on EVERY
   subsequent run REPLACE drops first. Without `drop`, run #2+ is denied — and
   because the build is a full rebuild, the *previous* run's tables persist
   unchanged, which can masquerade as "idempotent" (see the proof note below).
4. **`read_source` on `marketing.*` (or the source host)** — `read_parquet` over
   `s3://…` egresses; birdshot authorizes the read_source verb + host first.

Plus the **source-policy allowing the staging-glob host** so the `read_parquet`
over `s3://<lake-bucket>/org-<ID>/_ingest/funnel/**` is permitted at fetch time.

> Grant all four verbs (least-privilege is still satisfied — these are exactly the
> verbs the ETL runs, nothing more). A missing verb surfaces as a typed
> `AuthorizationDeniedError` on the offending statement. **Verify run #2
> explicitly** (it exercises `drop`) — a green run #1 does NOT prove run #2 works.

**The `marketing` schema itself.** `runStarBuild` issues a leading
`CREATE SCHEMA IF NOT EXISTS marketing` so a fresh lake has somewhere to land the
tables. This statement is **tolerant**: if the agent's grants don't authorize a
bare `CREATE SCHEMA`, the denial is logged and the build continues — the table
CTASes land in the schema instead. So provision the schema ONE of two ways:

- grant the agent enough that `CREATE SCHEMA` authorizes (covered by a broad
  `marketing.*` create grant in most ACL setups), **or**
- pre-create `marketing` as part of grant provisioning (the schema exists before
  the first run), and let the tolerant prelude no-op.

Either way the load proceeds; only a denial on an actual `marketing.<table>`
hard-fails.

## Account caps (open beta: 20 / 20 / 20)

Each spec declares its `budget` (streams / sinks / pipelines consumed).
`registry.ts` asserts the fleet total stays ≤20 of each at module load, so a
registry edit that blows the budget fails fast. ~20 sources is the ceiling before
requesting a limit increase.

## Cutover from `apps/funnel-ingest`

`apps/funnel-ingest` is the cron predecessor (flat `funnel_events` table). It and
this fleet pull the same PostHog window — running both races the watermark.
Cut over by EITHER:

- **Stop the old cron first**: set `apps/funnel-ingest/wrangler.jsonc`
  `triggers.crons: []` and redeploy it, THEN deploy + enable `apps/pipelines`; or
- **Bake against a distinct cursor + staging**: point this fleet at a different
  staging prefix and a fresh D1 cursor row, verify the star tables, then swap.

The two write different lake tables (`main.funnel_events` vs `marketing.*`), so
they don't clobber each other's output — the only shared resource is the PostHog
read window, which the watermark guards.

## Adding a second source

A new source is: **a registry entry** + **a `SourceAdapter`** (its `extract`) +
**a `TargetModel`** (reusing the conformed dims `dim_date` / `dim_person`) +
**infra** (a stream/sink/pipeline + a `wrangler secret put` for its agent key) +
**birdshot grants** for that agent. No new Worker.

## Manual trigger

```bash
# behind Access, or:
curl -H "authorization: Bearer $RUN_TOKEN" \
  "https://<worker>/run?pipeline=posthog-funnel"
```
