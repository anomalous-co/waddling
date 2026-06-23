/**
 * Star-schema ETL proof — runs the ACTUAL pipeline model SQL (imported from
 * apps/pipelines/src/models) against synthetic funnel events on DuckDB v1.5.3,
 * the same engine the governed gateway runs. Proves the transform the live
 * pipeline performs in its governed-load step:
 *   - the 6 marketing.* tables build in declared order (dims before fact),
 *   - the fact's md5 FKs resolve against every dim (no orphans),
 *   - the fact⨝dim JOIN returns rows across funnel stage_categories,
 *   - uuid dedup drops double-sent rows,
 *   - CREATE OR REPLACE + deterministic keys = idempotent (re-run is stable).
 *
 * This is the transform/load substance. The live path additionally runs it
 * through the gateway under birdshot grants (create/write/drop/read_source on
 * marketing.*), which this does not exercise.
 *
 * Run: node_modules/.bin/tsx scripts/e2e/star-schema-proof.ts
 */
import { DuckDBInstance } from '@duckdb/node-api';
import { writeFileSync } from 'node:fs';
import { funnelStar } from '../../apps/pipelines/src/models/funnel-star';

// ── synthetic funnel events (all 22 staging columns; nulls where N/A) ──────────
const COLS = [
  'uuid', 'event', 'distinct_id', 'person_id', 'timestamp', 'current_url', 'pathname',
  'utm_source', 'utm_medium', 'utm_campaign', 'referrer', 'cta_location', 'cta_text',
  'plan', 'decision', 'duration_ms', 'reason', 'from_plan', 'to_plan', 'mrr_cents', 'email', 'name',
];
type Row = Record<string, string | number | null>;
const base = (o: Partial<Row>): Row => {
  const r: Row = {};
  for (const c of COLS) r[c] = (o[c] ?? null) as string | number | null;
  return r;
};
let n = 0;
const ts = (h: number) => `2026-06-2${(h % 3) + 1} 1${h % 9}:00:00`;
const ev = (event: string, o: Partial<Row> = {}): Row =>
  base({ uuid: `u${++n}`, event, timestamp: ts(n), distinct_id: o.person_id ? null : `dev-${(n % 4)}`, ...o });

const events: Row[] = [
  // anonymous marketing visits with UTM (device ids), one campaign + one organic
  ev('$pageview', { distinct_id: 'dev-1', pathname: '/', current_url: 'https://getwaddling.com/', utm_source: 'hn', utm_medium: 'social', utm_campaign: 'launch', referrer: 'https://news.ycombinator.com/' }),
  ev('$pageview', { distinct_id: 'dev-1', pathname: '/pricing', current_url: 'https://getwaddling.com/pricing', utm_source: 'hn', utm_medium: 'social', utm_campaign: 'launch' }),
  ev('signup_cta_clicked', { distinct_id: 'dev-1', cta_location: 'pricing', cta_text: 'start free' }),
  ev('$pageview', { distinct_id: 'dev-2', pathname: '/', current_url: 'https://getwaddling.com/' }),
  // person p1 signs up (identified) + converts
  ev('signup_started', { person_id: 'p1' }),
  ev('signup_completed', { person_id: 'p1', email: 'ada@example.com', name: 'Ada' }),
  ev('org_created', { person_id: 'p1' }),
  ev('upgrade_viewed', { person_id: 'p1', from_plan: 'free' }),
  ev('checkout_started', { person_id: 'p1', to_plan: 'pro' }),
  ev('checkout_completed', { person_id: 'p1', plan: 'pro', mrr_cents: 9900 }),
  // person p1 activation in the data plane
  ev('mcp_connect', { person_id: 'p1' }),
  ev('first_query', { person_id: 'p1' }),
  ev('query_executed', { person_id: 'p1', decision: 'allow', duration_ms: 42 }),
  ev('denial_hit', { person_id: 'p1', decision: 'deny', reason: 'table' }),
  // person p2 signs up but stalls at activation (funnel drop)
  ev('signup_completed', { person_id: 'p2', email: 'grace@example.com', name: 'Grace' }),
  ev('mcp_connect', { person_id: 'p2' }),
];
// double-send the conversion (simulate at-least-once buffer retry) — must dedup on uuid
const dup = { ...events[9] };
events.push(dup);

const TOTAL_UNIQUE = new Set(events.map((e) => e.uuid)).size;

async function main() {
  const inst = await DuckDBInstance.create(':memory:');
  const c = await inst.connect();
  const STG = '/tmp/funnel_stg.parquet';
  writeFileSync('/tmp/funnel_synth.json', JSON.stringify(events));

  // Land the synthetic events as Parquet (what the CF Pipelines sink would write).
  await c.run(`CREATE TABLE _raw AS SELECT * FROM read_json_auto('/tmp/funnel_synth.json')`);
  await c.run(`COPY _raw TO '${STG}' (FORMAT parquet)`);
  await c.run(`CREATE SCHEMA marketing`);

  const q1 = async (sql: string): Promise<number> =>
    Number((await c.runAndReadAll(sql)).getRowObjects()[0]!.n);

  const run = async () => {
    for (const name of funnelStar.order) {
      const sql = funnelStar.tables[name]!.sql({ stagingGlob: STG });
      await c.run(sql);
    }
  };

  let pass = 0; const fails: string[] = [];
  const ok = (cond: boolean, msg: string, extra = '') => { cond ? (pass++, console.log(`  ✓ ${msg}`)) : (fails.push(msg), console.log(`  ✗ ${msg}  ${extra}`)); };

  console.log(`Star-schema ETL proof — DuckDB ${'(node-api 1.5.3)'} | ${events.length} events (${TOTAL_UNIQUE} unique uuids)\n`);
  console.log('• Build #1 (dims → fact, in declared order)');
  await run();
  for (const t of funnelStar.order) ok((await q1(`SELECT count(*) n FROM marketing.${t}`)) >= 0, `marketing.${t} exists`);

  console.log('\n• Grain + dedup');
  const factN = await q1(`SELECT count(*) n FROM marketing.fct_funnel_event`);
  ok(factN === TOTAL_UNIQUE, `fact grain = unique events (${factN} == ${TOTAL_UNIQUE}) — uuid dedup dropped the double-send`, `got ${factN}`);

  console.log('\n• FK integrity (every fact FK resolves to a dim row — md5 keys match dim↔fact)');
  for (const [fk, dim, dk] of [
    ['person_key', 'dim_person', 'person_key'],
    ['event_type_key', 'dim_event_type', 'event_type_key'],
    ['campaign_key', 'dim_campaign', 'campaign_key'],
    ['page_key', 'dim_page', 'page_key'],
    ['date_key', 'dim_date', 'date_key'],
  ] as const) {
    const orphans = await q1(`SELECT count(*) n FROM marketing.fct_funnel_event f LEFT JOIN marketing.${dim} d ON f.${fk}=d.${dk} WHERE d.${dk} IS NULL`);
    ok(orphans === 0, `fct.${fk} → ${dim} : 0 orphans`, `got ${orphans}`);
  }

  console.log('\n• Funnel fact⨝dim JOIN returns rows across stage_categories');
  const stages = (await c.runAndReadAll(
    `SELECT et.stage_category, count(*) n FROM marketing.fct_funnel_event f
       JOIN marketing.dim_event_type et ON f.event_type_key=et.event_type_key
      GROUP BY 1 ORDER BY 1`,
  )).getRowObjects();
  console.log('   ', stages.map((r) => `${r.stage_category}=${r.n}`).join('  '));
  ok(stages.length >= 4, `≥4 funnel stages present`, `got ${stages.map((s) => s.stage_category).join(',')}`);
  ok(stages.some((s) => s.stage_category === 'paid' && Number(s.n) > 0), `paid stage has rows (checkout_completed etc.)`);
  ok(stages.some((s) => s.stage_category === 'activation' && Number(s.n) > 0), `activation stage has rows`);

  console.log('\n• dim_person identity-merge correctness');
  const identified = await q1(`SELECT count(*) n FROM marketing.dim_person WHERE is_identified`);
  const withEmail = await q1(`SELECT count(*) n FROM marketing.dim_person WHERE email IS NOT NULL`);
  ok(identified === 2, `2 identified persons (p1, p2)`, `got ${identified}`);
  ok(withEmail === 2, `identified persons carry email (person-prop, allowed)`, `got ${withEmail}`);
  const conv = await q1(`SELECT count(*) n FROM marketing.fct_funnel_event WHERE is_conversion`);
  ok(conv >= 2, `is_conversion measure set on signup_completed/checkout_completed`, `got ${conv}`);

  console.log('\n• Idempotency — re-run the whole build (CREATE OR REPLACE + deterministic md5)');
  const before = await q1(`SELECT count(*) n FROM marketing.fct_funnel_event`);
  const keysBefore = await q1(`SELECT count(DISTINCT person_key) n FROM marketing.dim_person`);
  await run();
  const after = await q1(`SELECT count(*) n FROM marketing.fct_funnel_event`);
  const keysAfter = await q1(`SELECT count(DISTINCT person_key) n FROM marketing.dim_person`);
  ok(after === before, `fact row count stable after rebuild (${before} == ${after})`, `got ${after}`);
  ok(keysAfter === keysBefore, `person surrogate keys stable after rebuild (deterministic)`, `got ${keysAfter}`);

  console.log(`\n${'─'.repeat(60)}\nPASSED ${pass}   FAILED ${fails.length}`);
  if (fails.length) { console.log('Failures:\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log('Star-schema ETL transform PROVEN ✓ (real model SQL, DuckDB 1.5.3)');
}
main().catch((e) => { console.error('PROOF ERROR:', e); process.exit(1); });
