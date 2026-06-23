// Break the cold-start deadlock: a connect kicks the container boot (startProcess
// fires ~2s in and the container keeps booting even after the parent request is
// canceled at ~25s). Wait generously for the background boot, then retry connect
// and climb the ladder. Env: CONTROL_API_BASE, AGENT_KEY, DATALAKE_ID.
const BASE = (process.env.CONTROL_API_BASE || 'https://api.getwaddling.com').replace(/\/+$/, '');
const KEY = process.env.AGENT_KEY, LAKE = process.env.DATALAKE_ID;
const H = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
const t0 = Date.now();
const ts = () => `+${Math.round((Date.now() - t0) / 1000)}s`;

async function connect() {
  const t = Date.now();
  try {
    const r = await fetch(`${BASE}/api/cp/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ datalakeId: LAKE }) });
    const j = await r.json();
    return { ms: Date.now() - t, j };
  } catch (e) { return { ms: Date.now() - t, j: { error: 'fetch_threw', detail: e.message } }; }
}
async function query(sid, sql) {
  const t = Date.now();
  const r = await fetch(`${BASE}/api/cp/sessions/${sid}/query`, { method: 'POST', headers: H, body: JSON.stringify({ sql }) });
  return { ms: Date.now() - t, j: await r.json() };
}

const rungs = [
  ['1. SELECT 1', 'SELECT 1 AS one'],
  ['2. zzz_probe', 'SELECT count(*) FROM lake.main.zzz_probe'],
  ['3. fnl_fct (single new table)', 'SELECT count(*) FROM lake.main.fnl_fct_funnel_event'],
  ['4. fnl_dim_event_type', 'SELECT count(*) FROM lake.main.fnl_dim_event_type'],
  ['5. the JOIN', `SELECT et.stage_category, count(*) n FROM lake.main.fnl_fct_funnel_event f JOIN lake.main.fnl_dim_event_type et ON f.event_type_key=et.event_type_key GROUP BY 1 ORDER BY 1`],
];

let sid = '';
for (let i = 1; i <= 8; i++) {
  const { ms, j } = await connect();
  console.log(`${ts()} connect#${i} [${ms}ms]: ${JSON.stringify(j).slice(0, 160)}`);
  if (j.sessionId) { sid = j.sessionId; break; }
  console.log(`${ts()} waiting 60s for background boot…`);
  await new Promise((r) => setTimeout(r, 60_000));
}
if (!sid) { console.log(`${ts()} NEVER WARMED — cold-start deadlock confirmed`); process.exit(1); }

console.log(`${ts()} CONNECTED ${sid}\n`);
for (const [label, sql] of rungs) {
  try {
    const { ms, j } = await query(sid, sql);
    if (j.error) console.log(`  ✗ ${label} [${ms}ms] error=${j.error} reason=${JSON.stringify(j.reason)}`);
    else console.log(`  ✓ ${label} [${ms}ms] rows=${JSON.stringify(j.rows)}`);
  } catch (e) { console.log(`  ✗ ${label} threw ${e.message}`); }
}
console.log(`${ts()} done`);
