# funnel-ingest

Pulls the marketing/signup funnel events from **PostHog** and lands them in **an
existing org's DuckLake lake — through Waddling's own governed ETL path**, on a
schedule. Cloudflare Pipelines is the durable buffer + Parquet writer; the lake
load goes through the gateway (birdshot-authorized) exactly like a customer agent.
No standalone Iceberg catalog — the funnel becomes a native DuckLake table.

```
PostHog (HogQL query API)
      │  cron hourly, incremental by watermark
      ▼
Worker (this app)
  ├─ send() ─▶ Pipelines Stream ──SQL──▶ Sink: R2 raw Parquet (into the lake bucket prefix)
  │
  └─ acts as a normal agent (sk_agent_ key):
        waddling_connect ─▶ waddling_etl  (CREATE OR REPLACE TABLE … FROM read_parquet)
                                 │  birdshot authorizes the statement, then the gateway
                                 ▼  runs it on the trusted connection (egress + lake write)
        lake.main.funnel_events — native DuckLake, birdshot-governed, queried through
        Waddling (waddling_query) like any customer table  ← our own duck legs
```

The two halves are decoupled: the Pipeline rolls Parquet on its own interval; the
load step rebuilds the DuckLake table from whatever Parquet has settled.

**Why pull from PostHog** (not dual-write our own events): PostHog holds the
complete, identity-stitched dataset (anonymous pageviews + UTMs + person merges) —
what the funnel analysis actually needs.

**Why through `waddling_etl`** (not a direct DuckDB/Iceberg attach): the lake is the
product. The funnel data must be ingested and served the same governed way a customer
would — into a real org's lake, gated by birdshot. (DuckLake *can* absorb Iceberg via
`iceberg_to_ducklake()` / `ducklake_add_data_files()`, but we avoid Iceberg entirely
here: Pipelines writes plain Parquet, the gateway CTAS-loads it into DuckLake.)

## Inputs you must supply

| Value | Where to get it |
|-------|-----------------|
| `POSTHOG_PROJECT_ID` / `POSTHOG_PERSONAL_API_KEY` | PostHog → Settings → Project ID; Personal API key, scope **query:read** |
| `POSTHOG_APP_HOST` | `https://us.posthog.com` or `https://eu.posthog.com` (app host, not ingestion) |
| `DATALAKE_ID` | the **existing org endpoint** the funnel table lives in (`waddling_list_datalakes`) |
| `WADDLING_AGENT_KEY` | an `sk_agent_…` key for an analytics agent in that org |
| Lake bucket name + prefix | the endpoint's lake bucket (`DATA_PATH s3://waddling-lake/org-<id>/…`); write the Pipeline Parquet under an `_ingest/funnel/` prefix there so the gateway's lake S3 secret already covers reads |

**Birdshot grant (required):** the analytics agent must be granted permission to run
the CTAS into `funnel_events` (a write on `main.funnel_events`). Without it the ETL
returns `authorization_denied` — by design. Grant it the same way as any agent
(dashboard ACL / admin MCP).

## One-time provisioning (run from this directory)

```bash
pnpm install

# 1. Stream (schema-validated). Names referenced in pipeline SQL must be
#    underscore_case (a hyphen parses as SQL subtraction).
wrangler pipelines streams create funnel_events --schema-file schema.json
wrangler pipelines streams list                 # copy id → wrangler.jsonc "pipeline"

# 2. Sink → RAW PARQUET, written INTO the endpoint's lake bucket under _ingest/funnel/
#    (NOT r2-data-catalog — no Iceberg). Pass the LAKE bucket's own R2 keys explicitly
#    so the gateway's lake S3 secret can read exactly what the sink writes (R2 sinks
#    require credentials; a different auto-created cred could be scoped elsewhere).
#    --partitioning is a strftime pattern (default year/month/day); roll-interval min 10s.
wrangler pipelines sinks create funnel_sink \
  --type r2 --format parquet \
  --bucket waddling-lake --path "org-<ID>/_ingest/funnel" \
  --partitioning "year=%Y/month=%m/day=%d" \
  --compression zstd --roll-interval 300 \
  --access-key-id "$LAKE_R2_ACCESS_KEY_ID" --secret-access-key "$LAKE_R2_SECRET"

# 3. Pipeline: stream → sink. Passthrough + lower(event); immutable once created.
wrangler pipelines create funnel_pipeline \
  --sql "INSERT INTO funnel_sink SELECT uuid, lower(event) AS event, distinct_id, person_id, timestamp, current_url, pathname, utm_source, utm_medium, utm_campaign, referrer, cta_location, cta_text, plan FROM funnel_events"

# 4. Watermark KV. Note id → wrangler.jsonc "kv_namespaces".
wrangler kv namespace create funnel-ingest-watermark

# 5. Secrets (NOT in wrangler.jsonc)
wrangler secret put POSTHOG_PERSONAL_API_KEY
wrangler secret put WADDLING_AGENT_KEY

# 6. Fill wrangler.jsonc placeholders: <STREAM_ID>, <KV_ID>, <PROJECT_ID>,
#    DATALAKE_ID, LAKE_FUNNEL_GLOB (match the sink --bucket/--path above).

# 7. Deploy (registers the hourly cron)
pnpm run deploy
```

## Verify

```bash
wrangler dev          # then GET /run → runs the pull AND the lake load once
wrangler tail         # watch "[funnel-ingest] pull sent=…" and "lake load ok → funnel_events"
```

Then read it **through Waddling** (the whole point — governed, in the product):

```
waddling_connect(datalake_id=…)
waddling_query("SELECT event, count(*) FROM lake.main.funnel_events GROUP BY 1 ORDER BY 2 DESC")
```

If the agent lacks the grant, `waddling_etl` / `waddling_query` returns a structured
`authorization_denied` — that's birdshot doing its job.

## Notes / tradeoffs

- **Lake load is idempotent.** `CREATE OR REPLACE TABLE … row_number() OVER
  (PARTITION BY uuid …) = 1` — a full rebuild, de-duplicated on PostHog's `uuid`,
  each run. Cheap at funnel volume. Swap to incremental `ducklake_add_data_files`
  (zero-copy register of new Parquet files) if it grows.
- **Session reuse.** One-key-per-agent: each hourly `waddling_connect` supersedes the
  prior session, so reconnecting doesn't accumulate sessions.
- **Watermark + lag.** Pull uses `timestamp > watermark` and `< now() - 300s`
  (`LAG_SECONDS`) so PostHog ingestion lag can't skip late rows; first run starts 24h
  back. Floored to whole seconds with strict `>` — if >`PAGE_SIZE` (10k) events ever
  share one boundary second, the overflow is skipped (not a risk at current volume).
- **Backfill.** `wrangler kv key put --binding WATERMARK funnel:last_ts
  '2026-01-01T00:00:00Z'` then hit `/run` repeatedly (drains `MAX_PAGES × PAGE_SIZE`/call).
- **Pipeline SQL is immutable;** adding a column means recreating the sink/pipeline.
- **`timestamp`** is sent as RFC 3339 (CF streams also accept Unix s/ms/µs).
- **Account caps (open beta): 20 streams / 20 sinks / 20 pipelines.** One-per-source
  ⇒ ~20 source pipelines before a limit-increase request. Stream ingest ≤ 5 MB/s,
  payload ≤ 5 MB/send (the worker already chunks sends to 1000 rows).
