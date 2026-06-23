// Diagnostic ladder: one session, simplest→hardest, to isolate where the
// governed query-back breaks. Env: CONTROL_API_BASE, AGENT_KEY, DATALAKE_ID.
const BASE = (process.env.CONTROL_API_BASE || 'https://api.getwaddling.com').replace(/\/+$/, '');
const KEY = process.env.AGENT_KEY;
const LAKE = process.env.DATALAKE_ID;
const H = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };

async function connect() {
  const r = await fetch(`${BASE}/api/cp/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ datalakeId: LAKE }) });
  const j = await r.json();
  return j;
}
async function query(sid, sql) {
  const t = Date.now();
  const r = await fetch(`${BASE}/api/cp/sessions/${sid}/query`, { method: 'POST', headers: H, body: JSON.stringify({ sql }) });
  const j = await r.json();
  return { ms: Date.now() - t, j };
}

const rungs = [
  ['1. SELECT 1', 'SELECT 1 AS one'],
  ['2. known-good zzz_probe', 'SELECT count(*) FROM lake.main.zzz_probe'],
  ['3. single new table', 'SELECT count(*) FROM lake.main.fnl_fct_funnel_event'],
  ['4. dim count', 'SELECT count(*) FROM lake.main.fnl_dim_event_type'],
  ['5. the JOIN', `SELECT et.stage_category, count(*) n FROM lake.main.fnl_fct_funnel_event f JOIN lake.main.fnl_dim_event_type et ON f.event_type_key=et.event_type_key GROUP BY 1 ORDER BY 1`],
];

const c = await connect();
console.log('connect:', JSON.stringify(c).slice(0, 300));
if (!c.sessionId) process.exit(1);
for (const [label, sql] of rungs) {
  try {
    const { ms, j } = await query(c.sessionId, sql);
    if (j.error) console.log(`  ✗ ${label}  [${ms}ms]  error=${j.error} reason=${JSON.stringify(j.reason)}`);
    else console.log(`  ✓ ${label}  [${ms}ms]  rows=${JSON.stringify(j.rows)}`);
  } catch (e) {
    console.log(`  ✗ ${label}  threw: ${e.message}`);
  }
}
