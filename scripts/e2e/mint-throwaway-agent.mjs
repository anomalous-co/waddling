#!/usr/bin/env node
/**
 * Mint a throwaway funnel agent for the governed ETL proof.
 *
 * Self-service via the public control-api (no admin creds): signup a fresh user →
 * create an org → provision a managed DuckLake → mint ONE agent whose grants are
 * exactly the verbs the star build emits on the target schema:
 *   create + write + drop + read on `main.*`
 * (read_source is NOT needed — star-schema-governed.ts inlines its source as a
 * VALUES subquery, so no read_parquet egress.)
 *
 * Prints `AGENT_KEY=… DATALAKE_ID=…` and writes them to OUT_ENV (default
 * /tmp/funnel-agent.env) so the caller can: `set -a; . /tmp/funnel-agent.env; set +a`.
 *
 * Env:
 *   CONTROL_API_BASE  (default https://api.getwaddling.com)
 *   WEB_ORIGIN        (default https://app.getwaddling.com) — cookie Origin
 *   TARGET_SCHEMA     (default main) — schema the grants cover
 *   OUT_ENV           (default /tmp/funnel-agent.env)
 *   PROVISION_TIMEOUT_S (default 240) — how long to wait for the lake to run
 *
 * Run: node scripts/e2e/mint-throwaway-agent.mjs
 */

const BASE = (process.env.CONTROL_API_BASE || 'https://api.getwaddling.com').replace(/\/+$/, '');
const WEB_ORIGIN = (process.env.WEB_ORIGIN || 'https://app.getwaddling.com').replace(/\/+$/, '');
const TARGET_SCHEMA = process.env.TARGET_SCHEMA || 'main';
const OUT_ENV = process.env.OUT_ENV || '/tmp/funnel-agent.env';
const PROVISION_TIMEOUT_S = Number(process.env.PROVISION_TIMEOUT_S || 240);

const stamp = Date.now();
const FAKE = {
  email: `etl+${stamp}@getwaddling-e2e.test`,
  password: `E2e!${stamp}aB`,
  name: `ETL ${stamp}`,
  orgName: `ETL Org ${stamp}`,
  orgSlug: `etl-${stamp}`,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// minimal cookie jar (Better Auth session rides a cookie)
const jar = new Map();
function storeCookies(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

async function api(path, { method = 'GET', body, bearer } = {}) {
  const headers = { origin: WEB_ORIGIN };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const cookie = cookieHeader();
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  storeCookies(res);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

function die(msg, detail) {
  console.error(`\n✗ ${msg}\n  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  process.exit(1);
}

async function main() {
  console.log(`Mint throwaway funnel agent → ${BASE}`);
  console.log(`  fake user: ${FAKE.email}`);

  // 1. signup
  let r = await api('/api/auth/sign-up/email', {
    method: 'POST',
    body: { email: FAKE.email, password: FAKE.password, name: FAKE.name },
  });
  if (!(r.status >= 200 && r.status < 300)) die('sign-up failed', r);
  if (jar.size === 0) die('no session cookie issued after signup', r);
  console.log('  ✓ signed up (session cookie issued)');

  // 2. create org
  r = await api('/api/auth/organization/create', {
    method: 'POST',
    body: { name: FAKE.orgName, slug: FAKE.orgSlug },
  });
  const orgId = r.data?.id || r.data?.organization?.id;
  if (!orgId) die('org create failed', r);
  console.log(`  ✓ org created: ${orgId}`);

  // 3. provision a managed DuckLake
  r = await api('/api/cp/datalakes', {
    method: 'POST',
    body: { name: `ETL Lake ${stamp}`, slug: `etl-lake-${stamp}`, managed: true, region: 'auto', encrypted: false, kind: 'lake' },
  });
  const datalakeId = r.data?.datalakeId || r.data?.datalake?.id || r.data?.id;
  if (!datalakeId) die('datalake create failed', r);
  console.log(`  ✓ datalake created: ${datalakeId} — waiting for status=running …`);

  const until = Date.now() + PROVISION_TIMEOUT_S * 1000;
  let running = false;
  while (Date.now() < until) {
    const d = await api(`/api/cp/datalakes/${encodeURIComponent(datalakeId)}`);
    const st = d.data?.datalake?.status || d.data?.status;
    if (st === 'running') { running = true; break; }
    process.stdout.write(`    … status=${st ?? '?'}\r`);
    await sleep(5000);
  }
  if (!running) die('datalake did not reach status=running in time', `${PROVISION_TIMEOUT_S}s`);
  console.log(`\n  ✓ datalake running`);

  // 4. mint the agent + the four verbs the star build emits on TARGET_SCHEMA.*
  const grant = (capability) => ({ datalakeId, capability, schema: TARGET_SCHEMA, table: '*', effect: 'allow' });
  r = await api('/api/cp/agents', {
    method: 'POST',
    body: {
      name: `funnel-etl-${stamp}`,
      description: 'throwaway agent for the governed star-schema ETL proof',
      grants: ['create', 'write', 'drop', 'read'].map(grant),
    },
  });
  const agentKey = r.data?.apiKey || r.data?.key;
  const agentId = r.data?.agentId;
  if (!agentKey) die('agent mint failed', r);
  console.log(`  ✓ agent minted: ${agentId}`);
  console.log(`    grants: ${(r.data?.grants ?? []).map((g) => `${g.capability} ${g.schema}.${g.table}`).join(', ')}`);

  const env = `AGENT_KEY=${agentKey}\nDATALAKE_ID=${datalakeId}\nAGENT_ID=${agentId}\nORG_ID=${orgId}\nCONTROL_API_BASE=${BASE}\n`;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUT_ENV, env);
  console.log(`\nWrote ${OUT_ENV}:\n${env}`);
  console.log(`Next: set -a; . ${OUT_ENV}; set +a; node_modules/.bin/tsx scripts/e2e/star-schema-governed.ts`);
}

main().catch((e) => { console.error('MINT ERROR:', e); process.exit(1); });
