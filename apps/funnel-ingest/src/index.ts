/**
 * Funnel ingestion Worker — PostHog → Cloudflare Pipelines → R2 Data Catalog → lake.
 *
 * A Cron-triggered puller. Each tick it asks PostHog (HogQL query API) for funnel
 * events newer than the last watermark, maps each row to the stream schema, and
 * `send()`s them to a Pipelines Stream. The Pipeline's SQL writes them to an R2
 * Data Catalog (Apache Iceberg) table, which the waddling lake reads natively
 * (DuckDB speaks R2 Data Catalog) — so the funnel lands as a governed lake table.
 *
 * Chosen over dual-writing our own events because PostHog holds the COMPLETE,
 * identity-stitched dataset (anonymous pageviews + UTMs + person merges), which is
 * what actually answers "who converted". This is the batch ("regularly ingested")
 * half; real-time conversion events could be added later by also sending from
 * control-api's auth hooks to the same stream.
 *
 * Watermark: the max event timestamp ingested, persisted in KV. The query uses a
 * strict `>` plus a safety lag (events are only pulled once they're at least
 * LAG_SECONDS old) so PostHog's own ingestion lag doesn't cause us to skip
 * late-arriving rows. `uuid` is carried through as the row key for dedup at query
 * time in the lake, since pull-level exactly-once is not guaranteed across retries.
 */

interface Pipeline {
  send(data: object[]): Promise<void>;
}

export interface Env {
  /** Pipelines Stream binding (→ SQL pipeline → R2 Data Catalog sink). */
  FUNNEL_STREAM: Pipeline;
  /** KV namespace holding the single ingestion watermark. */
  WATERMARK: KVNamespace;
  /** PostHog personal API key with "query read" scope (Worker secret). */
  POSTHOG_PERSONAL_API_KEY: string;
  /** PostHog app host, e.g. https://us.posthog.com (NOT the ingestion host). */
  POSTHOG_APP_HOST: string;
  /** PostHog project id the events live in. */
  POSTHOG_PROJECT_ID: string;
  /** Comma-separated event allow-list. Unset ⇒ DEFAULT_EVENTS. */
  FUNNEL_EVENTS?: string;

  // ── DuckLake load (dogfood): act as a normal agent and ingest the Pipeline's
  // Parquet into an existing org's lake via the governed waddling_etl path.
  // All four must be set for the load step to run; otherwise it's skipped.
  /** control-api origin, e.g. https://api.getwaddling.com. */
  CONTROL_API_BASE?: string;
  /** sk_agent_… key for the analytics agent in the target org (Worker secret). */
  WADDLING_AGENT_KEY?: string;
  /** The org endpoint/datalake id the funnel table lives in. */
  DATALAKE_ID?: string;
  /** s3:// glob the gateway reads — the Pipeline's Parquet output prefix, inside
   *  the lake bucket so the gateway's lake S3 secret already covers it. */
  LAKE_FUNNEL_GLOB?: string;
  /** Destination DuckLake table (main schema). Unset ⇒ "funnel_events". */
  LAKE_FUNNEL_TABLE?: string;
}

const DEFAULT_EVENTS = [
  '$pageview',
  'signup_cta_clicked',
  'signup_started',
  'signup_completed',
  'org_created',
];

const WATERMARK_KEY = 'funnel:last_ts';
// Only pull events at least this old, so PostHog ingestion lag can't make us skip
// rows whose timestamp is < now but which weren't queryable on the prior tick.
const LAG_SECONDS = 300;
// Per-query page size and the max pages we'll drain in one cron invocation (keeps
// us well inside Worker CPU/subrequest limits; the next tick resumes from the
// advanced watermark).
const PAGE_SIZE = 10_000;
const MAX_PAGES = 20;

// The columns we project out of PostHog, in order. The stream schema field names
// (schema.json) MUST match these keys.
const COLUMNS = [
  'uuid',
  'event',
  'distinct_id',
  'person_id',
  'timestamp',
  'current_url',
  'pathname',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'referrer',
  'cta_location',
  'cta_text',
  'plan',
] as const;

// HogQL SELECT list (aliased to COLUMNS). properties.* are nullable strings.
const SELECT_LIST = `
  uuid,
  event,
  distinct_id,
  person_id,
  timestamp,
  properties.$current_url AS current_url,
  properties.$pathname AS pathname,
  properties.utm_source AS utm_source,
  properties.utm_medium AS utm_medium,
  properties.utm_campaign AS utm_campaign,
  properties.$referrer AS referrer,
  properties.cta_location AS cta_location,
  properties.cta_text AS cta_text,
  properties.plan AS plan
`;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/;

/** PostHog query API response shape (results are positional arrays). */
interface QueryResponse {
  results: unknown[][];
  columns: string[];
}

/**
 * Parse a PostHog DateTime cell to a UTC ISO string. The query API may return
 * "2026-06-20T10:00:00Z", "2026-06-20T10:00:00", or "2026-06-20 10:00:00"; the
 * latter two lack a zone and `new Date()` would read them as LOCAL time, drifting
 * the watermark. PostHog stores UTC, so force the Z.
 */
function phTsToIso(raw: string): string {
  let s = raw.trim().replace(' ', 'T');
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
  return new Date(s).toISOString();
}

function eventList(env: Env): string[] {
  const raw = env.FUNNEL_EVENTS?.trim();
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_EVENTS;
}

/** Run one HogQL page, return rows newer than `sinceIso` and older than the lag cutoff. */
async function queryPage(env: Env, sinceIso: string, events: string[]): Promise<QueryResponse> {
  // sinceIso is our own KV value; validate before interpolation regardless.
  if (!ISO_RE.test(sinceIso)) throw new Error(`invalid watermark: ${sinceIso}`);
  const eventsSql = events.map((e) => `'${e.replace(/'/g, "''")}'`).join(', ');
  // ClickHouse toDateTime() wants "YYYY-MM-DD HH:MM:SS" (space, no zone) and reads
  // it as UTC on PostHog Cloud. Drop the millis/zone off our UTC ISO watermark.
  const sinceClickhouse = sinceIso.slice(0, 19).replace('T', ' ');
  const hogql = `
    SELECT ${SELECT_LIST}
    FROM events
    WHERE timestamp > toDateTime('${sinceClickhouse}')
      AND timestamp < now() - toIntervalSecond(${LAG_SECONDS})
      AND event IN (${eventsSql})
    ORDER BY timestamp ASC
    LIMIT ${PAGE_SIZE}
  `;

  const res = await fetch(
    `${env.POSTHOG_APP_HOST.replace(/\/+$/, '')}/api/projects/${env.POSTHOG_PROJECT_ID}/query/`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.POSTHOG_PERSONAL_API_KEY}`,
      },
      body: JSON.stringify({
        query: { kind: 'HogQLQuery', query: hogql, name: 'funnel-ingest' },
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`PostHog query failed ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  return (await res.json()) as QueryResponse;
}

/** Map a positional result row to a stream record keyed by COLUMNS. */
function toRecord(row: unknown[]): Record<string, unknown> {
  const rec: Record<string, unknown> = {};
  COLUMNS.forEach((col, i) => {
    const v = row[i];
    if (col === 'timestamp') {
      // Normalize to UTC ISO so the Iceberg sink gets a clean, zoned timestamp.
      rec[col] = v == null ? null : phTsToIso(String(v));
    } else {
      rec[col] = v === undefined ? null : v;
    }
  });
  return rec;
}

async function ingest(env: Env): Promise<{ sent: number; pages: number; watermark: string }> {
  const events = eventList(env);
  // First run ⇒ start 24h back so the first tick has something to do without a
  // full-history backfire (backfill is a separate one-off; see README).
  let watermark =
    (await env.WATERMARK.get(WATERMARK_KEY)) ??
    new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  let sent = 0;
  let pages = 0;
  for (; pages < MAX_PAGES; pages++) {
    const { results } = await queryPage(env, watermark, events);
    if (results.length === 0) break;

    const tsIdx = COLUMNS.indexOf('timestamp');
    const records = results.map(toRecord);

    // Pipelines: max 1 MB / send — chunk conservatively.
    for (let i = 0; i < records.length; i += 1000) {
      await env.FUNNEL_STREAM.send(records.slice(i, i + 1000));
    }
    sent += records.length;

    // Advance watermark to the newest timestamp in this page.
    const iso = phTsToIso(String(results[results.length - 1]![tsIdx]));
    if (iso === watermark) break; // no forward progress — avoid an infinite loop
    watermark = iso;
    await env.WATERMARK.put(WATERMARK_KEY, watermark);

    if (results.length < PAGE_SIZE) break; // drained
  }

  return { sent, pages, watermark };
}

const IDENT_RE = /^[a-z_][a-z0-9_]*$/i;

/**
 * Load the Pipeline's Parquet into an existing org's DuckLake — the dogfood path:
 * authenticate as a normal agent (sk_agent_ key), open a governed session, and run
 * `waddling_etl`. birdshot authorizes the CTAS before any read_source fetch, and the
 * table lands native in DuckLake (`lake.main.<table>`), served + governed through the
 * gateway like any customer table. Skipped (logged) until all inputs are configured.
 *
 * Idempotent: a full rebuild each run, de-duplicated on PostHog's `uuid`. Cheap at
 * funnel volume; swap to incremental `ducklake_add_data_files` if it grows.
 */
async function loadIntoLake(env: Env): Promise<{ skipped: true } | { table: string; phase: string }> {
  const base = env.CONTROL_API_BASE?.replace(/\/+$/, '');
  const key = env.WADDLING_AGENT_KEY?.trim();
  const datalakeId = env.DATALAKE_ID?.trim();
  const glob = env.LAKE_FUNNEL_GLOB?.trim();
  if (!base || !key || !datalakeId || !glob) return { skipped: true };

  const table = env.LAKE_FUNNEL_TABLE?.trim() || 'funnel_events';
  if (!IDENT_RE.test(table)) throw new Error(`invalid LAKE_FUNNEL_TABLE: ${table}`);
  if (glob.includes("'")) throw new Error('LAKE_FUNNEL_GLOB must not contain quotes');

  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

  // 1. Governed session against the org's lake (one-key-per-agent: this supersedes
  //    any prior session, so hourly reconnects don't accumulate).
  const cRes = await fetch(`${base}/api/cp/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ datalakeId }),
  });
  if (!cRes.ok) throw new Error(`connect ${cRes.status}: ${(await cRes.text()).slice(0, 300)}`);
  const { sessionId } = (await cRes.json()) as { sessionId: string };

  // 2. Governed ETL: rebuild + uuid-dedup over the Pipeline's Parquet. read_parquet
  //    egress + the lake write run on the gateway's trusted connection, AFTER birdshot
  //    authorizes this exact statement against the agent's grants.
  const sql =
    `CREATE OR REPLACE TABLE ${table} AS ` +
    `SELECT * EXCLUDE (_rn) FROM (` +
    `SELECT *, row_number() OVER (PARTITION BY uuid ORDER BY timestamp DESC) AS _rn ` +
    `FROM read_parquet('${glob}', union_by_name => true)` +
    `) WHERE _rn = 1`;

  const eRes = await fetch(`${base}/api/cp/sessions/${encodeURIComponent(sessionId)}/etl`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sql }),
  });
  const j = (await eRes.json().catch(() => ({}))) as { ok?: boolean; phase?: string; error?: string; reason?: string };
  if (!eRes.ok || j.ok !== true) {
    throw new Error(`etl ${eRes.status}: ${j.error ?? j.reason ?? JSON.stringify(j).slice(0, 300)}`);
  }
  return { table, phase: j.phase ?? 'done' };
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      Promise.allSettled([
        ingest(env).then(
          (r) => console.log(`[funnel-ingest] pull sent=${r.sent} pages=${r.pages} watermark=${r.watermark}`),
          (e) => console.error('[funnel-ingest] pull failed:', e),
        ),
        loadIntoLake(env).then(
          (r) => console.log(`[funnel-ingest] lake ${'skipped' in r ? 'load skipped (unconfigured)' : `load ok → ${r.table} (${r.phase})`}`),
          (e) => console.error('[funnel-ingest] lake load failed:', e),
        ),
      ]),
    );
  },

  // Manual trigger for testing / backfill nudges: GET /run (no auth — deploy the
  // Worker private, workers_dev disabled, or gate behind Access).
  async fetch(req: Request, env: Env): Promise<Response> {
    if (new URL(req.url).pathname !== '/run') return new Response('funnel-ingest', { status: 200 });
    try {
      const pull = await ingest(env);
      const lake = await loadIntoLake(env);
      return Response.json({ pull, lake });
    } catch (e) {
      return new Response(`error: ${e instanceof Error ? e.message : String(e)}`, { status: 500 });
    }
  },
};
