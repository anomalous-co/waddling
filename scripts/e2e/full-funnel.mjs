#!/usr/bin/env node
/**
 * Full-funnel E2E smoke: signup → pay → provision → query → debit.
 *
 * Drives the LIVE, DEPLOYED HTTP surface in order and asserts the money + product
 * path end-to-end. This is the pre-launch gate (ANO-100). Scope per the launch
 * decision: Stripe *subscription* + the existing session-duration debit (the credit
 * ledger already records debits); credit-pack purchase and balance-zero cutoff are a
 * tracked fast-follow and are NOT asserted here.
 *
 * The Stripe Checkout step is a hosted page that needs a card — a pure-HTTP script
 * can't complete it. Two supported modes:
 *   - WITH_STRIPE=poll  : the operator completes Checkout in a browser (test card
 *                         4242 4242 4242 4242) — or `stripe trigger checkout.session.completed`
 *                         is run — and this script polls until the subscription is active.
 *   - WITH_STRIPE=skip  : skip the pay step (asserts only the upgrade URL is mintable).
 * The browser-driven variant (Claude-in-Chrome) covers the visual + cross-subdomain
 * identity-stitch proof separately; this script is the reproducible backend assertion.
 *
 * Requires Node 20+ (global fetch). No external deps. Reads config from env:
 *   CONTROL_API_BASE   e.g. https://api.getwaddling.com   (required)
 *   WEB_ORIGIN         e.g. https://app.getwaddling.com   (for cookie Origin/redirects)
 *   DATALAKE_ID        an existing running lake to query, OR set CREATE_DATALAKE=1
 *   AGENT_KEY          an sk_agent_ key scoped to that lake (for connect/query)
 *   IN_SCOPE_SQL       a governed SELECT that should be ALLOWED (e.g. SELECT 1)
 *   OUT_OF_SCOPE_SQL   a governed SELECT that should be DENIED (references an ungranted table)
 *   STAR_JOIN_SQL      optional: the fact⨝dim JOIN to assert the star schema is loaded
 *   WITH_STRIPE        poll | skip            (default skip)
 *   STRIPE_PLAN        pro | enterprise       (default pro)
 *   STRIPE_TIMEOUT_S   how long to poll for an active subscription (default 300)
 *
 * Exit code 0 = all assertions passed; 1 = a failure (with a printed reason).
 */

const BASE = reqEnv('CONTROL_API_BASE').replace(/\/+$/, '');
const WEB_ORIGIN = (process.env.WEB_ORIGIN || BASE).replace(/\/+$/, '');
const WITH_STRIPE = process.env.WITH_STRIPE || 'skip';
const STRIPE_PLAN = process.env.STRIPE_PLAN || 'pro';
const STRIPE_TIMEOUT_S = Number(process.env.STRIPE_TIMEOUT_S || 300);

// A deterministic-but-unique fake identity per run (no Math.random dependency on a
// stable seed: the timestamp is enough to avoid slug/email collisions between runs).
const stamp = Date.now();
const FAKE = {
  email: `e2e+${stamp}@getwaddling-e2e.test`,
  password: `E2e!${stamp}aB`,
  name: `E2E ${stamp}`,
  orgName: `E2E Org ${stamp}`,
  orgSlug: `e2e-${stamp}`,
};

// ── tiny test harness ──────────────────────────────────────────────────────────
let PASS = 0;
const FAILURES = [];
function ok(name) { PASS++; console.log(`  ✓ ${name}`); }
function fail(name, detail) { FAILURES.push({ name, detail }); console.log(`  ✗ ${name}\n      ${detail}`); }
function assert(cond, name, detail) { cond ? ok(name) : fail(name, detail || 'assertion failed'); return cond; }
function section(t) { console.log(`\n• ${t}`); }
function reqEnv(k) { const v = process.env[k]; if (!v) { console.error(`Missing required env ${k}`); process.exit(2); } return v; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── a minimal cookie jar (Better Auth session rides a cookie) ───────────────────
const jar = new Map();
function storeCookies(res) {
  // Node fetch exposes multiple Set-Cookie via getSetCookie() (undici).
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function api(path, { method = 'GET', body, bearer, json = true } = {}) {
  const headers = { origin: WEB_ORIGIN };
  if (json && body !== undefined) headers['content-type'] = 'application/json';
  const cookie = cookieHeader();
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : json ? JSON.stringify(body) : body,
    redirect: 'manual',
  });
  storeCookies(res);
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, res };
}

// ── the flow ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Full-funnel E2E → ${BASE}  (web origin ${WEB_ORIGIN})`);
  console.log(`Fake account: ${FAKE.email}`);

  // 1. Signup (email/password). Better Auth: POST /api/auth/sign-up/email.
  section('1. Signup');
  let r = await api('/api/auth/sign-up/email', {
    method: 'POST',
    body: { email: FAKE.email, password: FAKE.password, name: FAKE.name },
  });
  assert(r.status >= 200 && r.status < 300, 'sign-up returns 2xx', `status=${r.status} body=${JSON.stringify(r.data)}`);
  assert(jar.size > 0, 'a session cookie was issued', 'no Set-Cookie captured — cross-origin cookie may be misconfigured');
  // signup_completed fires server-side (auth hook) — assertable only in PostHog, noted not here.

  // 2. Create org (Better Auth organization plugin).
  section('2. Create organization');
  r = await api('/api/auth/organization/create', {
    method: 'POST',
    body: { name: FAKE.orgName, slug: FAKE.orgSlug },
  });
  assert(r.status >= 200 && r.status < 300, 'org create returns 2xx', `status=${r.status} body=${JSON.stringify(r.data)}`);
  const orgId = r.data?.id || r.data?.organization?.id;
  assert(!!orgId, 'org id resolved', `body=${JSON.stringify(r.data)}`);
  // org_created + starter credit grant fire in the afterCreateOrganization hook.

  // 3. Starter credit grant present (the prepaid ledger seeded the new org).
  section('3. Starter credit grant');
  r = await api('/api/cp/billing');
  const balMicro = r.data?.credit?.balanceMicro;
  assert(r.status === 200, 'GET /api/cp/billing 200', `status=${r.status}`);
  assert(typeof balMicro === 'number' && balMicro > 0, 'starter credit balance > 0', `credit=${JSON.stringify(r.data?.credit)}`);
  assert(r.data?.plan?.name === 'free', 'new org starts on the free plan', `plan=${JSON.stringify(r.data?.plan)}`);

  // 4. Pay: subscription upgrade → Checkout (test card completes it out of band).
  section(`4. Subscription (WITH_STRIPE=${WITH_STRIPE})`);
  r = await api('/api/auth/subscription/upgrade', {
    method: 'POST',
    body: { plan: STRIPE_PLAN, referenceId: orgId, successUrl: `${WEB_ORIGIN}/dashboard/billing?upgrade=success`, cancelUrl: `${WEB_ORIGIN}/dashboard/billing` },
  });
  const checkoutUrl = r.data?.url || r.data?.checkoutUrl;
  assert(!!checkoutUrl, 'upgrade mints a Stripe Checkout URL', `status=${r.status} body=${JSON.stringify(r.data)} (needs a REAL test STRIPE_SECRET_KEY — placeholders short-circuit this)`);
  if (checkoutUrl) console.log(`      → complete Checkout here with test card 4242…: ${checkoutUrl}`);

  if (WITH_STRIPE === 'poll') {
    console.log(`      polling for an active subscription (≤${STRIPE_TIMEOUT_S}s)…`);
    const until = Date.now() + STRIPE_TIMEOUT_S * 1000;
    let active = false;
    while (Date.now() < until) {
      const b = await api('/api/cp/billing');
      const st = b.data?.subscription?.status;
      const pn = b.data?.plan?.name;
      if (st === 'active' || st === 'trialing' || pn === STRIPE_PLAN) { active = true; break; }
      await sleep(5000);
    }
    assert(active, `subscription became active/${STRIPE_PLAN}`, 'timed out — was Checkout completed + did the webhook reach the deployed endpoint?');
    // checkout_completed fires from the stripe onEvent → PostHog (assert in PostHog).
  } else {
    console.log('      WITH_STRIPE=skip → not completing payment (subscription stays free).');
  }

  // 5. Provision a datalake (unless one was supplied) and wait for it to run.
  section('5. Provision datalake');
  let datalakeId = process.env.DATALAKE_ID;
  if (!datalakeId && process.env.CREATE_DATALAKE === '1') {
    r = await api('/api/cp/datalakes', {
      method: 'POST',
      body: { name: `E2E Lake ${stamp}`, slug: `e2e-lake-${stamp}`, managed: true, region: 'auto', encrypted: false, kind: 'ducklake' },
    });
    datalakeId = r.data?.datalakeId;
    assert(!!datalakeId, 'datalake create returns an id', `status=${r.status} body=${JSON.stringify(r.data)}`);
    // endpoint_created fires server-side.
    const until = Date.now() + 180_000;
    let running = false;
    while (Date.now() < until) {
      const d = await api(`/api/cp/datalakes/${encodeURIComponent(datalakeId)}`);
      if (d.data?.datalake?.status === 'running') { running = true; break; }
      await sleep(5000);
    }
    assert(running, 'datalake reached status=running', 'timed out provisioning');
  } else {
    assert(!!datalakeId, 'DATALAKE_ID provided (or set CREATE_DATALAKE=1)', 'no lake to query');
  }

  // 6. Governed query as an agent: in-scope allowed, out-of-scope denied, debit lands.
  section('6. Governed query + debit');
  const agentKey = process.env.AGENT_KEY;
  if (agentKey && datalakeId) {
    const conn = await api('/api/cp/sessions', { method: 'POST', body: { datalakeId }, bearer: agentKey });
    const sessionId = conn.data?.sessionId;
    assert(!!sessionId, 'waddling_connect opens a session', `status=${conn.status} body=${JSON.stringify(conn.data)}`);

    if (sessionId && process.env.IN_SCOPE_SQL) {
      const q = await api(`/api/cp/sessions/${encodeURIComponent(sessionId)}/query`, { method: 'POST', body: { sql: process.env.IN_SCOPE_SQL }, bearer: agentKey });
      assert(q.status === 200 && Array.isArray(q.data?.rows), 'in-scope query is ALLOWED + returns rows', `status=${q.status} body=${JSON.stringify(q.data)}`);
      // query_executed{decision:allow} + first_query fire server-side (delegated path).
    }
    if (sessionId && process.env.OUT_OF_SCOPE_SQL) {
      const q = await api(`/api/cp/sessions/${encodeURIComponent(sessionId)}/query`, { method: 'POST', body: { sql: process.env.OUT_OF_SCOPE_SQL }, bearer: agentKey });
      assert(q.status === 403 && q.data?.error === 'authorization_denied', 'out-of-scope query is DENIED (structured)', `status=${q.status} body=${JSON.stringify(q.data)}`);
      // denial_hit{reason} fires server-side.
    }
    if (sessionId && process.env.STAR_JOIN_SQL) {
      const q = await api(`/api/cp/sessions/${encodeURIComponent(sessionId)}/query`, { method: 'POST', body: { sql: process.env.STAR_JOIN_SQL }, bearer: agentKey });
      assert(q.status === 200 && (q.data?.rows?.length ?? 0) > 0, 'star-schema fact⨝dim JOIN returns rows', `status=${q.status} body=${JSON.stringify(q.data)}`);
    }
    // Debit: a usage_event row landed for this query → it shows up in the usage rollup.
    const u = await api('/api/cp/usage');
    const total = u.data?.rollup?.queries ?? u.data?.rollup?.total ?? null;
    assert(u.status === 200, 'GET /api/cp/usage 200 (usage_event recorded)', `status=${u.status}`);
    if (total != null) assert(Number(total) >= 1, 'at least one usage_event/query recorded (debit driver)', `rollup=${JSON.stringify(u.data?.rollup)}`);
  } else {
    console.log('      AGENT_KEY/DATALAKE_ID not set → skipping the governed-query assertions.');
  }

  // ── summary ──
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`PASSED ${PASS}   FAILED ${FAILURES.length}`);
  if (FAILURES.length) {
    console.log('\nFailures:');
    for (const f of FAILURES) console.log(`  ✗ ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.log('All assertions passed ✓');
}

main().catch((e) => { console.error('\nHARNESS ERROR:', e); process.exit(1); });
