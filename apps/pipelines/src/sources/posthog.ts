/**
 * PostHog HogQL incremental pull, as a SourceAdapter.
 *
 * Ported from apps/funnel-ingest. Each extract() asks PostHog's query API for
 * events newer than the watermark and older than a safety lag, paged, deduped by
 * uuid within the run. PostHog holds the complete identity-stitched dataset
 * (anonymous pageviews + UTMs + person merges) — the authoritative source for
 * "who converted", which dual-writing our own events could not reproduce.
 *
 * Watermark = the max event timestamp pulled, persisted only after the governed
 * load succeeds. The query uses strict `>` plus a lag (events are pulled only
 * once at least LAG_SECONDS old) so PostHog's own ingestion lag can't make us
 * skip late-arriving rows. `uuid` is carried so the fact CTAS can dedup, since
 * pull-level exactly-once is not guaranteed across workflow retries.
 */

import type { SourceAdapter, StagingRecord } from '../types';
import type { Env } from '../env';
import { ISO_RE } from '../lib/validate';

// Only pull events at least this old, so PostHog ingestion lag can't make us
// skip rows whose timestamp is < now but which weren't queryable on the prior run.
const LAG_SECONDS = 300;
// Per-query page size, and the max pages drained in ONE extract(). The product
// (PAGE_SIZE * MAX_PAGES) bounds how many records a single workflow run hands
// across the step boundary — kept modest so the extract→buffer step result stays
// well under the persisted step-result size cap. The next run resumes from the
// advanced watermark, so a backlog drains over several runs rather than one.
const PAGE_SIZE = 10_000;
const MAX_PAGES = 5;

// Columns projected out of PostHog, in order. The stream schema (schema.json)
// and the staging Parquet column names MUST match these keys.
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
  'decision',
  'duration_ms',
  'reason',
  'from_plan',
  'to_plan',
  'mrr_cents',
  'email',
  'name',
] as const;

// HogQL SELECT list (aliased to COLUMNS). properties.* are nullable.
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
  properties.plan AS plan,
  properties.decision AS decision,
  properties.duration_ms AS duration_ms,
  properties.reason AS reason,
  properties.from_plan AS from_plan,
  properties.to_plan AS to_plan,
  properties.mrr_cents AS mrr_cents,
  person.properties.email AS email,
  person.properties.name AS name
`;

/** Default event allow-list when a spec declares no `events`. */
export const DEFAULT_EVENTS = [
  '$pageview',
  'signup_cta_clicked',
  'signup_started',
  'signup_completed',
  'org_created',
];

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
export function phTsToIso(raw: string): string {
  let s = raw.trim().replace(' ', 'T');
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
  return new Date(s).toISOString();
}

/** Run one HogQL page: rows newer than `sinceIso`, older than the lag cutoff. */
async function queryPage(
  env: Env,
  sinceIso: string,
  events: string[],
): Promise<QueryResponse> {
  // sinceIso is our own cursor value; validate before interpolation regardless.
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
        query: { kind: 'HogQLQuery', query: hogql, name: 'etl-posthog' },
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`PostHog query failed ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  return (await res.json()) as QueryResponse;
}

/** Coerce a PostHog cell to a stream-schema scalar (the schema is all-scalar). */
function toScalar(v: unknown): string | number | boolean | null {
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  // Objects/arrays (rare for the projected props) → JSON so the cell stays scalar.
  return JSON.stringify(v);
}

// Columns the stream schema types as int64 — coerce to a number (or null) so a
// numeric property captured as a string doesn't fail structured-stream validation.
const NUMERIC_COLUMNS = new Set<string>(['duration_ms', 'mrr_cents']);

/** Map a positional result row to a stream record keyed by COLUMNS. */
function toRecord(row: unknown[]): StagingRecord {
  const rec: StagingRecord = {};
  COLUMNS.forEach((col, i) => {
    const v = row[i];
    if (col === 'timestamp') {
      // Normalize to UTC ISO so the staging sink gets a clean, zoned timestamp.
      rec[col] = v == null ? null : phTsToIso(String(v));
    } else if (NUMERIC_COLUMNS.has(col)) {
      const n = v == null ? null : Number(v);
      rec[col] = n != null && Number.isFinite(n) ? n : null;
    } else {
      rec[col] = toScalar(v);
    }
  });
  return rec;
}

/**
 * Build a pull adapter bound to a specific event allow-list (a spec's `events`,
 * falling back to DEFAULT_EVENTS). The registry uses this so each pipeline
 * filters to exactly its taxonomy.
 */
export function posthogSourceWithEvents(events: string[] = DEFAULT_EVENTS): SourceAdapter {
  return {
    kind: 'pull',
    async extract(env, cursor) {
      let watermark = cursor ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const seen = new Set<string>();
      const records: StagingRecord[] = [];
      const tsIdx = COLUMNS.indexOf('timestamp' as (typeof COLUMNS)[number]);
      const uuidIdx = COLUMNS.indexOf('uuid' as (typeof COLUMNS)[number]);

      for (let page = 0; page < MAX_PAGES; page++) {
        const { results } = await queryPage(env, watermark, events);
        if (results.length === 0) break;

        for (const row of results) {
          const uuid = row[uuidIdx];
          const key = uuid == null ? null : String(uuid);
          if (key && seen.has(key)) continue;
          if (key) seen.add(key);
          records.push(toRecord(row));
        }

        const iso = phTsToIso(String(results[results.length - 1]![tsIdx]));
        if (iso === watermark) break;
        watermark = iso;
        if (results.length < PAGE_SIZE) break;
      }

      return { records, nextCursor: records.length ? watermark : cursor };
    },
  };
}
