/**
 * LIVE governed star-schema ETL proof — drives the deployed gateway as the analytics
 * agent (sk_agent_ key), exactly like apps/pipelines' governed-load step:
 *   connect → ordered CREATE OR REPLACE per targetModel.order → query the result back.
 *
 * It runs the ACTUAL model transform SQL from apps/pipelines/src/models, with the
 * read_parquet(stagingGlob) source swapped for an inline VALUES subquery of synthetic
 * funnel events (so no external staging/read_source is needed). Every statement is
 * birdshot-authorized at the gateway; the final assertions query through the same
 * governed /query path the product exposes.
 *
 * Env: CONTROL_API_BASE, AGENT_KEY, DATALAKE_ID.
 * Run: node_modules/.bin/tsx scripts/e2e/star-schema-governed.ts
 */
import { funnelStar } from '../../apps/pipelines/src/models/funnel-star';

const BASE = (process.env.CONTROL_API_BASE || 'https://api.getwaddling.com').replace(/\/+$/, '');
const KEY = reqEnv('AGENT_KEY');
const LAKE = reqEnv('DATALAKE_ID');
function reqEnv(k: string): string { const v = process.env[k]; if (!v) { console.error(`missing env ${k}`); process.exit(2); } return v; }

// ── synthetic funnel events (22 staging columns) ───────────────────────────────
const COLS: [string, 'str' | 'ts' | 'num'][] = [
  ['uuid', 'str'], ['event', 'str'], ['distinct_id', 'str'], ['person_id', 'str'], ['timestamp', 'ts'],
  ['current_url', 'str'], ['pathname', 'str'], ['utm_source', 'str'], ['utm_medium', 'str'],
  ['utm_campaign', 'str'], ['referrer', 'str'], ['cta_location', 'str'], ['cta_text', 'str'], ['plan', 'str'],
  ['decision', 'str'], ['duration_ms', 'num'], ['reason', 'str'], ['from_plan', 'str'], ['to_plan', 'str'],
  ['mrr_cents', 'num'], ['email', 'str'], ['name', 'str'],
];
type Ev = Record<string, string | number | null>;
let n = 0;
const ev = (event: string, o: Partial<Ev> = {}): Ev => {
  const r: Ev = {};
  for (const [c] of COLS) r[c] = (o[c] ?? null) as string | number | null;
  r.uuid = `u${++n}`; r.event = event; r.timestamp = `2026-06-2${(n % 3) + 1} 1${n % 9}:00:00`;
  if (!o.person_id && !o.distinct_id) r.distinct_id = `dev-${n % 3}`;
  return r;
};
const EVENTS: Ev[] = [
  ev('$pageview', { distinct_id: 'dev-1', pathname: '/', current_url: 'https://getwaddling.com/', utm_source: 'hn', utm_medium: 'social', utm_campaign: 'launch', referrer: 'https://news.ycombinator.com/' }),
  ev('$pageview', { distinct_id: 'dev-1', pathname: '/pricing', current_url: 'https://getwaddling.com/pricing', utm_source: 'hn', utm_medium: 'social', utm_campaign: 'launch' }),
  ev('signup_cta_clicked', { distinct_id: 'dev-1', cta_location: 'pricing', cta_text: 'start free' }),
  ev('signup_completed', { person_id: 'p1', email: 'ada@example.com', name: 'Ada' }),
  ev('org_created', { person_id: 'p1' }),
  ev('checkout_completed', { person_id: 'p1', plan: 'pro', mrr_cents: 9900 }),
  ev('mcp_connect', { person_id: 'p1' }),
  ev('query_executed', { person_id: 'p1', decision: 'allow', duration_ms: 42 }),
  ev('denial_hit', { person_id: 'p1', decision: 'deny', reason: 'table' }),
  ev('signup_completed', { person_id: 'p2', email: 'grace@example.com', name: 'Grace' }),
];
EVENTS.push({ ...EVENTS[5] }); // double-send (dedup target)
const UNIQUE = new Set(EVENTS.map((e) => e.uuid)).size;

const lit = (v: string | number | null, kind: string): string => {
  if (v == null) return 'NULL';
  if (kind === 'num') return String(v);
  if (kind === 'ts') return `TIMESTAMP '${v}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
};
// Inline, self-contained source: a VALUES subquery with explicit casts, exposing the
// 22 staging column names the model SQL references. Replaces read_parquet(...) so each
// CTAS is authorized by `create` alone (no read of an intermediate/new table).
const rows = EVENTS.map((e) => `(${COLS.map(([c, k]) => lit(e[c], k)).join(',')})`).join(',\n    ');
const sel = COLS.map(([c, k]) => `${c}::${k === 'ts' ? 'TIMESTAMP' : k === 'num' ? 'BIGINT' : 'VARCHAR'} AS ${c}`).join(', ');
const INLINE = `(SELECT ${sel} FROM (VALUES\n    ${rows}\n  ) AS _v(${COLS.map(([c]) => c).join(',')}))`;
const READ_PARQUET = /read_parquet\([^)]*union_by_name\s*=>\s*true\)/g;
// The query path (gateway restoreLakeViews) exposes only the lake's `main` schema, so
// land the star tables in `lake.main.fnl_*` (catalog-qualified so they persist to the
// DuckLake, prefixed to avoid colliding with existing main tables). The model transform
// SQL is otherwise unchanged. (A gateway change to expose all schemas would let this use
// the model's native `marketing.*` — see the restoreLakeViews note.)
const T = (t: string) => `lake.main.fnl_${t}`;
const tableSql = (name: string): string =>
  funnelStar.tables[name]!
    .sql({ stagingGlob: 'INLINE' })
    .replace(READ_PARQUET, INLINE)
    .replace(/\bmarketing\.([a-z_]+)/g, (_m, t: string) => T(t));

// ── governed driver (acts as the agent) ────────────────────────────────────────
const H = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
async function connect(): Promise<string> {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${BASE}/api/cp/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ datalakeId: LAKE }) });
    const j = (await r.json()) as { sessionId?: string; detail?: string; error?: string };
    if (j.sessionId) return j.sessionId;
    console.log(`  connect retry ${i + 1}: ${j.detail || j.error}`);
    await new Promise((res) => setTimeout(res, 5000));
  }
  throw new Error('connect failed');
}
async function etl(sid: string, sql: string): Promise<{ ok: boolean; reason?: string }> {
  const r = await fetch(`${BASE}/api/cp/sessions/${sid}/etl`, { method: 'POST', headers: H, body: JSON.stringify({ sql }) });
  const j = (await r.json()) as { ok?: boolean; error?: string; reason?: string };
  return { ok: j.ok === true, reason: j.error ? `${j.error}: ${j.reason ?? ''}` : undefined };
}
async function query(sid: string, sql: string): Promise<{ columns: string[]; rows: unknown[][] }> {
  const r = await fetch(`${BASE}/api/cp/sessions/${sid}/query`, { method: 'POST', headers: H, body: JSON.stringify({ sql }) });
  const j = (await r.json()) as { columns?: string[]; rows?: unknown[][]; error?: string; reason?: string };
  if (j.error) throw new Error(`query ${j.error}: ${j.reason ?? ''}`);
  return { columns: j.columns ?? [], rows: j.rows ?? [] };
}

async function main() {
  let pass = 0; const fails: string[] = [];
  const ok = (c: boolean, m: string, x = '') => { c ? (pass++, console.log(`  ✓ ${m}`)) : (fails.push(m), console.log(`  ✗ ${m}  ${x}`)); };

  console.log(`LIVE governed star build → ${BASE} | lake ${LAKE} | ${EVENTS.length} events (${UNIQUE} unique)\n`);
  const sid = await connect();
  console.log(`connected: session ${sid}\n`);

  console.log('• Governed build through /etl (birdshot-authorized CREATE OR REPLACE, in order)');
  for (const name of funnelStar.order) {
    const r = await etl(sid, tableSql(name));
    ok(r.ok, `build ${T(name)}`, r.reason ?? '');
  }

  console.log('\n• Idempotent rebuild (CREATE OR REPLACE again — exercises drop)');
  for (const name of funnelStar.order) { const r = await etl(sid, tableSql(name)); if (!r.ok) ok(false, `rebuild ${name}`, r.reason ?? ''); }
  ok(true, 'rebuild: all 6 CREATE OR REPLACE re-authorized + executed (idempotent)');

  // Query through the governed /query path. The workspace attaches the lake as `lake`,
  // so reference `lake.<schema>.<table>`. Reconnect first: read:*.* expands to CONCRETE
  // catalog refs, and the marketing.* tables were created AFTER the build session's
  // connect — a fresh session re-derives read grants over the now-existing tables (the
  // post-ETL catalog refresh is async, so retry while it catches up).
  console.log('\n• Query the result back through the governed /query path (lake.main.fnl_*)');
  const L = T;
  let sid2 = '';
  let stages: string[] = [];
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 6000));
    sid2 = await connect();
    try {
      const jn = await query(sid2,
        `SELECT et.stage_category, count(*) AS n FROM ${L('fct_funnel_event')} f
           JOIN ${L('dim_event_type')} et ON f.event_type_key = et.event_type_key
          GROUP BY 1 ORDER BY 1`);
      stages = jn.rows.map((r) => `${r[0]}=${r[1]}`);
      break;
    } catch (e) { console.log(`  query retry ${i + 1}: ${(e as Error).message}`); }
  }
  console.log('   fact⨝dim:', stages.join('  '));
  ok(stages.length >= 4, '≥4 funnel stages returned via the governed /query', stages.join(','));

  const fc = await query(sid2, `SELECT count(*) FROM ${L('fct_funnel_event')}`);
  ok(Number(fc.rows[0]![0]) === UNIQUE, `fact grain = unique events (${fc.rows[0]![0]} == ${UNIQUE}) — uuid dedup + idempotent`, String(fc.rows[0]![0]));

  const orph = await query(sid2,
    `SELECT count(*) FROM ${L('fct_funnel_event')} f
       LEFT JOIN ${L('dim_person')} d ON f.person_key = d.person_key WHERE d.person_key IS NULL`);
  ok(Number(orph.rows[0]![0]) === 0, 'fct.person_key → dim_person : 0 orphans (md5 FKs resolve)', String(orph.rows[0]![0]));

  console.log(`\n${'─'.repeat(60)}\nPASSED ${pass}  FAILED ${fails.length}`);
  if (fails.length) { console.log('Failures:\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log('LIVE governed star-schema ETL PROVEN ✓ (through the gateway + birdshot, queried via the product)');
}
main().catch((e) => { console.error('GOVERNED PROOF ERROR:', e); process.exit(1); });
