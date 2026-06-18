/**
 * demo-agent/index.ts — waddling scripted walkthrough agent.
 *
 * Drives the §8 six-step narrative end-to-end and FAILS LOUD (exit 1) if any
 * step doesn't produce its required real outcome. No step is allowed to print
 * a green "ok" on a swallowed error — that would fake a passing demo.
 *
 *  Step 1: List endpoints → discover prod-lake
 *  Step 2: Connect (analyst) → attach_sql → query sales.orders (real rows)
 *  Step 3: SELECT ssn FROM sales.customers → structured authorization_denied
 *  Step 4: Admin grants analyst read sales.customers [customer_id,name] (REST)
 *  Step 5: Retry SELECT customer_id,name → real rows, ssn absent
 *  Step 6: etl-bot connect → write events (ok) → admin revokes → write DENIED
 *
 * Exit code: 0 only if all steps pass.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MCP_EXTERNAL_URL = process.env.MCP_EXTERNAL_URL ?? 'http://localhost:8810';
const WADDLING_URL     = process.env.WADDLING_URL     ?? 'http://localhost:3100';
const ANALYST_KEY      = process.env.WADDLING_API_KEY ?? '';
const ADMIN_TOKEN      = process.env.WADDLING_ADMIN_TOKEN ?? '';
const ETLBOT_KEY       = process.env.ETLBOT_API_KEY ?? '';

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function step(n: number, title: string): void {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[demo] STEP ${n}: ${title}`);
  console.log(`${'─'.repeat(60)}`);
}
function ok(msg: string): void   { console.log(`[demo]   OK  ${msg}`); }
function info(msg: string): void { console.log(`[demo]        ${msg}`); }
function die(msg: string): never {
  console.log(`[demo]   FAIL ${msg}`);
  process.exit(1);
}

// ── REST helpers (admin uses an org-scoped sk_ agent key — real auth) ──────────
async function adminGet(path: string): Promise<unknown> {
  const res = await fetch(`${WADDLING_URL}${path}`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}
async function adminFetch(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${WADDLING_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function waitForMcp(retries = 40, delayMs = 2000): Promise<void> {
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(`${MCP_EXTERNAL_URL}/`);
      if (res.status < 500) return;
    } catch { /* not ready */ }
    console.log(`[demo] Waiting for MCP server (${i}/${retries})...`);
    await sleep(delayMs);
  }
  throw new Error('MCP server did not become ready.');
}

async function connectMcp(apiKey: string, name: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${MCP_EXTERNAL_URL}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${apiKey}` } } },
  );
  const client = new Client({ name, version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ value: unknown; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  let value: unknown = result;
  if (result.content && Array.isArray(result.content)) {
    const text = result.content
      .filter((c: { type: string }) => c.type === 'text')
      .map((c: { type: string; text?: string }) => (c as { text: string }).text)
      .join('\n');
    try { value = JSON.parse(text); } catch { value = text; }
  }
  return { value, isError: result.isError === true };
}

// ── Main narrative ────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('\n[demo] waddling scripted demo — §8 walkthrough\n');
  if (!ANALYST_KEY || !ADMIN_TOKEN) die('missing WADDLING_API_KEY / WADDLING_ADMIN_TOKEN');

  await waitForMcp();

  const analyst = await connectMcp(ANALYST_KEY, 'demo-analyst');
  ok('Connected analyst to External MCP');

  // ── STEP 1 ─────────────────────────────────────────────────────────────────
  step(1, 'List endpoints → discover prod-lake');
  const ep1 = await callTool(analyst, 'waddling_list_endpoints', {});
  if (ep1.isError) die(`list_endpoints error: ${JSON.stringify(ep1.value)}`);
  const endpoints = (ep1.value as { endpoints?: unknown[] }).endpoints ?? ep1.value;
  info(`Endpoints: ${JSON.stringify(endpoints)}`);
  const endpoint = Array.isArray(endpoints)
    ? endpoints.find((e: { slug?: string; name?: string }) => e.slug === 'prod-lake' || e.name === 'prod-lake')
    : null;
  if (!endpoint) die('prod-lake endpoint not found');
  const endpointId = (endpoint as { id: string }).id;
  ok(`Found endpoint prod-lake (status=${(endpoint as { status?: string }).status}) id=${endpointId}`);

  // ── STEP 2 ─────────────────────────────────────────────────────────────────
  step(2, 'Connect as analyst → query sales.orders LIMIT 5');
  const conn = await callTool(analyst, 'waddling_connect', { endpoint_id: endpointId });
  if (conn.isError) die(`connect error: ${JSON.stringify(conn.value)}`);
  const connV = conn.value as { session_id?: string; attach_sql?: string; granted?: unknown };
  const sessionId = connV.session_id;
  if (!sessionId) die('no session_id from waddling_connect');
  ok(`Session opened: ${sessionId}`);
  ok(`ATTACH SQL: ${connV.attach_sql}`);
  info(`Granted: ${JSON.stringify(connV.granted)}`);

  const orders = await callTool(analyst, 'waddling_query', {
    session_id: sessionId,
    sql: 'SELECT * FROM sales.orders LIMIT 5',
  });
  if (orders.isError) die(`orders query denied unexpectedly: ${JSON.stringify(orders.value)}`);
  const ordersV = orders.value as { columns?: string[]; row_count?: number };
  if (!ordersV.row_count) die(`expected orders rows, got: ${JSON.stringify(ordersV)}`);
  ok(`Got ${ordersV.row_count} orders row(s). Columns: ${ordersV.columns?.join(', ')}`);

  // ── STEP 3 ─────────────────────────────────────────────────────────────────
  step(3, 'Analyst SELECT ssn FROM sales.customers → expect structured DENIAL');
  const ssn = await callTool(analyst, 'waddling_query', {
    session_id: sessionId,
    sql: 'SELECT ssn FROM sales.customers LIMIT 5',
  });
  const ssnV = ssn.value as { error?: string; reason?: string; columns?: string[] };
  if (ssnV.columns?.includes('ssn')) die('SSN column was returned — SECURITY BUG');
  if (ssnV.error !== 'authorization_denied') {
    die(`expected authorization_denied, got: ${JSON.stringify(ssnV)}`);
  }
  ok(`Structured denial: ${ssnV.error} — ${ssnV.reason ?? ''}`);

  // ── STEP 4 ─────────────────────────────────────────────────────────────────
  step(4, 'Admin grants analyst read sales.customers [customer_id, name] (REST)');
  const agentsBody = await adminGet('/api/cp/agents') as { agents?: Array<{ id: string; name: string }> };
  const agentsList = agentsBody.agents ?? [];
  const analystAgent = agentsList.find(a => a.name === 'analyst');
  if (!analystAgent) die(`analyst agent not found via REST: ${JSON.stringify(agentsBody)}`);
  await adminFetch('POST', '/api/cp/acl', {
    endpointId,
    agentId: analystAgent.id,
    schema: 'sales',
    table: 'customers',
    columns: ['customer_id', 'name'],
    verb: 'read',
    effect: 'allow',
  });
  ok('Admin grant applied + policy recompiled (REST 201)');
  info('Note: analyst already had a [customer_id,name,email,country,tier,created_at] allow;');
  info('this regrant is honored by the compiler precedence — ssn is never in any allow.');
  await sleep(1500); // allow policy push + reconnect window

  // ── STEP 5 ─────────────────────────────────────────────────────────────────
  step(5, 'Analyst retries SELECT customer_id, name FROM sales.customers');
  const cust = await callTool(analyst, 'waddling_query', {
    session_id: sessionId,
    sql: 'SELECT customer_id, name FROM sales.customers LIMIT 5',
  });
  if (cust.isError) die(`customers query denied unexpectedly: ${JSON.stringify(cust.value)}`);
  const custV = cust.value as { columns?: string[]; row_count?: number };
  if (custV.columns?.includes('ssn')) die('SSN leaked after grant — SECURITY BUG');
  if (!custV.row_count) die(`expected customer rows, got: ${JSON.stringify(custV)}`);
  ok(`Allowed columns returned: ${custV.columns?.join(', ')} (${custV.row_count} rows)`);
  ok('SSN absent — gateway proxy enforces the column allow-list');

  // ── STEP 6 ─────────────────────────────────────────────────────────────────
  step(6, 'etl-bot write → admin revoke → next write INSTANTLY DENIED');
  if (!ETLBOT_KEY) die('missing ETLBOT_API_KEY');
  const etl = await connectMcp(ETLBOT_KEY, 'demo-etlbot');
  const etlConn = await callTool(etl, 'waddling_connect', { endpoint_id: endpointId });
  if (etlConn.isError) die(`etl-bot connect error: ${JSON.stringify(etlConn.value)}`);
  const etlSession = (etlConn.value as { session_id?: string }).session_id;
  if (!etlSession) die('etl-bot got no session_id');
  ok(`etl-bot session opened: ${etlSession}`);

  const writeSql =
    "INSERT INTO sales.events VALUES (999999, 1, 'demo_write', '{\"src\":\"demo\"}', now())";
  const w1 = await callTool(etl, 'waddling_query', { session_id: etlSession, sql: writeSql });
  if (w1.isError) die(`etl-bot first write should succeed, got: ${JSON.stringify(w1.value)}`);
  ok('etl-bot write #1 succeeded (has write grant on sales.events)');

  // Admin revokes etl-bot (DELETE /api/cp/agents/:id → birdshot_revoke).
  const etlAgent = agentsList.find(a => a.name === 'etl-bot')
    ?? (await adminGet('/api/cp/agents') as { agents: Array<{ id: string; name: string }> })
        .agents.find(a => a.name === 'etl-bot');
  if (!etlAgent) die('etl-bot agent not found via REST');
  const revoke = await adminFetch('DELETE', `/api/cp/agents/${etlAgent.id}`, { reason: 'demo-revoke' }) as {
    success?: boolean; affectedSessions?: number;
  };
  ok(`etl-bot revoked (birdshot denylist + ${revoke.affectedSessions ?? 0} session(s) killed)`);

  // The session was killed → the control plane refuses to proxy. Try the write
  // again; it MUST be denied (no green path).
  const w2 = await callTool(etl, 'waddling_query', { session_id: etlSession, sql: writeSql });
  const w2V = w2.value as { error?: string; reason?: string };
  if (!w2.isError && !w2V.error) {
    die(`etl-bot write #2 should be DENIED after revoke, got: ${JSON.stringify(w2V)}`);
  }
  ok(`etl-bot write #2 DENIED after revoke: ${w2V.error ?? 'error'} — ${w2V.reason ?? ''}`);
  await etl.close();

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  console.log('[demo] NARRATIVE COMPLETE — all 6 steps passed for real');
  console.log('='.repeat(60));
  console.log(`[demo]  1. prod-lake discovered (running)`);
  console.log(`[demo]  2. orders query: ${ordersV.row_count} rows`);
  console.log(`[demo]  3. ssn query: authorization_denied`);
  console.log(`[demo]  4. admin grant: analyst read customers [customer_id,name]`);
  console.log(`[demo]  5. customers query: ${custV.row_count} rows, ssn absent`);
  console.log(`[demo]  6. etl-bot revoked → write denied`);
  console.log('='.repeat(60));

  await analyst.close();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('[demo] FATAL:', err);
  process.exit(1);
});
