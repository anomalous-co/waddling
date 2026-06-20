/**
 * /api/cp/quackboard — the per-org governed agent coordination board (the "quackboard").
 *
 * A quackboard is the gateway minus the DuckLake auto-mount, plus a durable R2-backed
 * .duckdb file: one per org (`kind='quackboard'` datalake row). Many agents read/write a
 * shared set of coordination tables (observations, notifications, subscriptions, …) with
 * birdshot enforcing per-agent table-level ACLs, exactly like the lake gateway.
 *
 * The tool family (loopbacks from the MCP qb_* tools):
 *   POST /join      → ensure the org's quackboard is booted + carries the current birdshot
 *                     snapshot; return the caller's identity + the shared-table protocol.
 *   POST /observe   → append an observation (shared corpus) + fan a pub/sub notification to
 *                     every matching subscriber. agent_role is BOUND from the caller's
 *                     identity, never a tool argument.
 *   POST /recall    → substring search the shared observations (gated read).
 *   POST /remember  → write the caller's PRIVATE memory (agent_memory). Trusted, narrow-typed
 *                     data-plane op — agent_memory has no birdshot grant, so the gated path
 *                     (raw qb_query) can never reach it; isolation is by construction.
 *   POST /mine      → read the caller's PRIVATE memory (WHERE agent_role = caller).
 *   POST /subscribe → register a pub/sub pattern (shared subscriptions).
 *   POST /inbox     → the caller's notifications (WHERE to_role = caller).
 *   POST /query     → raw governed SQL over the shared tables. birdshot enforces — a
 *                     reference to agent_memory (ungranted) is denied, leak-proof.
 *
 * Auth: each route resolves the caller (API-key agent or delegated OAuth) and binds
 * agent_role server-side. The data plane stays private (reached only via the DATAPLANE
 * service binding). The session JWT (kid → the pushed JWKS) is the quack TOKEN and never
 * leaves the server.
 */
import { z } from 'zod';
import { Hono } from 'hono';
import { importJWK, SignJWT, type JWK } from 'jose';
import { query, queryOne } from '../lib/db';
import type { Env } from '../lib/env';
import type { BirdshotSnapshot } from '../lib/types';
import type { GatewayBoot } from '../lib/gateway-client';
import { resolveGatewayBoot, CatalogNotReadyError, StorageNotReadyError } from '../lib/gateway-boot';
import { resolveCaller, handle, ok, err, parseBody, AuthError, type Caller } from '../lib/cp-shared';

const QB_JWT_TTL_SECONDS = 15 * 60;

// The shared coordination tables every org agent gets RW on. NOTE: agent_memory is
// deliberately ABSENT — it is private per-agent and reached only via the trusted
// remember/mine ops, so the gated path can never read another agent's memory.
const QB_SHARED_TABLES = [
  'observations',
  'notifications',
  'subscriptions',
  'messages',
  'boundaries',
  'objectives',
  'claims',
] as const;

/** Single-quote escape for inlining a value into a DuckDB SQL literal. */
function lit(s: string): string {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/** Build the FULL org birdshot snapshot: every active agent gets RW on the shared tables.
 *  The QuackboardDO is shared per org and applySnapshot does reset→add→commit, so pushing
 *  only the connecting agent would wipe the others — we always push the whole org. */
async function buildOrgQuackboardSnapshot(orgId: string): Promise<BirdshotSnapshot> {
  const agents = await query<{ id: string }>(
    `SELECT id FROM waddling.agent WHERE org_id = $1 AND status = 'active'`,
    [orgId],
  );
  const userRoles: BirdshotSnapshot['userRoles'] = [];
  const roleGrants: BirdshotSnapshot['roleGrants'] = [];
  for (const a of agents.rows) {
    const role = `agent_${a.id}`;
    userRoles.push({ userId: `agent:${a.id}`, role });
    for (const t of QB_SHARED_TABLES) {
      roleGrants.push({ role, tableRef: `main.${t}`, action: 'read' });
      roleGrants.push({ role, tableRef: `main.${t}`, action: 'write' });
    }
  }
  return { userRoles, roleGrants };
}

interface JwksRow {
  id: string;
  publicKey: string;
  privateKey: string;
}

/** Newest jwks row → { kid, publicJwk, privateJwk } (mirrors sessions.ts). */
async function loadSigningKey(): Promise<{
  kid: string;
  publicJwk: { n: string; e: string; kty: string };
  privateJwk: JWK;
}> {
  const row = await queryOne<JwksRow>(
    `SELECT id, "publicKey", "privateKey" FROM "jwks" ORDER BY "createdAt" DESC LIMIT 1`,
  );
  if (!row) {
    throw new AuthError('no_signing_key', 500, 'No JWKS key found — Better Auth jwt plugin must mint one first');
  }
  return { kid: row.id, publicJwk: JSON.parse(row.publicKey), privateJwk: JSON.parse(row.privateKey) };
}

interface QbContext {
  orgId: string;
  datalakeId: string;
  agentId: string;
  /** The attribution value stamped into the data tables (= the agent id). Server-bound. */
  agentRole: string;
  jwt: string;
  gatewayBoot: GatewayBoot;
  snapshot: BirdshotSnapshot;
  auth: { issuer: string; audience: string; mode: 'rs256'; jwks: { kid: string; n: string; e: string }[] };
}

/** Resolve the org's quackboard + acting agent, build the snapshot, mint the agent's JWT. */
async function prepareQbContext(c: Parameters<typeof resolveCaller>[0], env: Env): Promise<QbContext> {
  // allowDelegated=true: a data-plane surface. requireOrg=true: the quackboard is per-org.
  const caller = await resolveCaller(c, true, true);
  const orgId = caller.orgId;

  const ep = await queryOne<{ id: string; status: string }>(
    `SELECT id, status FROM waddling.datalake
       WHERE org_id = $1 AND kind = 'quackboard'
       ORDER BY created_at ASC LIMIT 1`,
    [orgId],
  );
  if (!ep) {
    throw new AuthError('no_quackboard', 404, 'This org has no quackboard — create a quackboard datalake first');
  }
  if (ep.status !== 'running') {
    throw new AuthError('quackboard_not_running', 409, `Quackboard status is ${ep.status}`);
  }

  const agentId = await resolveActingAgent(caller, orgId);

  let boot;
  try {
    boot = await resolveGatewayBoot(env, ep.id);
  } catch (e) {
    if (e instanceof CatalogNotReadyError) throw new AuthError('catalog_provisioning', 503, e.message);
    if (e instanceof StorageNotReadyError) throw new AuthError('storage_unavailable', 503, e.message);
    throw e;
  }
  if (!boot.gatewayBoot?.quackboard) {
    throw new AuthError('not_a_quackboard', 500, 'resolved boot config is not a quackboard');
  }

  const snapshot = await buildOrgQuackboardSnapshot(orgId);
  const { kid, publicJwk, privateJwk } = await loadSigningKey();
  const audience = `qb:${orgId}`;
  const auth = {
    issuer: env.JWT_ISSUER,
    audience,
    mode: 'rs256' as const,
    jwks: [{ kid, n: publicJwk.n, e: publicJwk.e }],
  };

  const key = (await importJWK(privateJwk, 'RS256')) as CryptoKey;
  const principal = `agent:${agentId}`;
  const jwt = await new SignJWT({ id: principal })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setSubject(principal)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(audience)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime(`${QB_JWT_TTL_SECONDS}s`)
    .sign(key);

  return { orgId, datalakeId: ep.id, agentId, agentRole: agentId, jwt, gatewayBoot: boot.gatewayBoot, snapshot, auth };
}

/** Resolve the acting agent: API-key agents are themselves; delegated OAuth callers get a
 *  per-user delegated agent provisioned (idempotent), mirroring sessions.ts. */
async function resolveActingAgent(caller: Caller, orgId: string): Promise<string> {
  if (caller.agentId) return caller.agentId;
  if (caller.delegated) {
    const prov = await queryOne<{ id: string }>(
      `INSERT INTO waddling.agent (org_id, name, description, mode, status, owner_user_id)
       VALUES ($1, $2, $3, 'delegated', 'active', $4)
       ON CONFLICT (org_id, name) DO UPDATE SET last_seen_at = now(), owner_user_id = EXCLUDED.owner_user_id
       RETURNING id`,
      [orgId, `claude:${caller.callerId}`, `Delegated MCP agent for user ${caller.callerId}`, caller.callerId],
    );
    if (!prov) throw new AuthError('agent_provision_failed', 500);
    return prov.id;
  }
  throw new AuthError('agent_required', 400, 'quackboard tools require an agent identity (sk_agent_… key or OAuth token)');
}

async function dpFetch(env: Env, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await env.DATAPLANE.fetch(`https://dataplane${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  let json: any = txt;
  try { json = txt ? JSON.parse(txt) : {}; } catch { /* keep raw */ }
  return { status: res.status, json };
}

/** Push the org's birdshot snapshot + JWKS to the QuackboardDO (boots it if cold). */
async function configureQb(env: Env, ctx: QbContext): Promise<{ status: number; json: any }> {
  return dpFetch(env, '/qb/configure', {
    orgId: ctx.orgId,
    gatewayBoot: ctx.gatewayBoot,
    snapshot: { snapshot: ctx.snapshot, auth: ctx.auth, lakeCatalog: 'quackboard' },
  });
}

/** Run a gated query AS the agent (JWT = quack TOKEN). On a cold-boot / lost-config failure the
 *  container has no JWKS, so quack AUTHENTICATION fails — re-push the snapshot + retry once. A
 *  birdshot AUTHORIZATION deny (auth succeeded, no grant) is a real verdict: do NOT retry it
 *  (retrying would double the audit row and waste a snapshot push). */
async function gatedQuery(env: Env, ctx: QbContext, sql: string): Promise<{ status: number; json: any }> {
  const run = () => dpFetch(env, '/qb/query', {
    orgId: ctx.orgId, gatewayBoot: ctx.gatewayBoot, sql, lakeToken: ctx.jwt,
  });
  let r = await run();
  // Reconfigure+retry only on an authentication/connection failure (cold container lost its
  // JWKS), never on a genuine authorization deny.
  if (r.status !== 200 && !isAuthzDeny(r)) {
    await configureQb(env, ctx);
    r = await run();
  }
  return r;
}

/** A birdshot authorization deny (vs a cold-boot authentication failure): quack reports
 *  "Authorization failed" only after the JWT authenticated. */
function isAuthzDeny(r: { status: number; json: any }): boolean {
  const reason = String(r.json?.reason ?? r.json?.error ?? '');
  return /authoriz/i.test(reason) && !/authentic/i.test(reason);
}

/** Persist one gated query's birdshot audit decision(s) + a usage count, mirroring the lake
 *  path's recordQueryAudit. The drain is process-global + destructive (exactly-once per record);
 *  each record is attributed to ITS own agent via `user` ('agent:<id>'), so interleaved agents'
 *  queries on the shared board still attribute correctly. Best-effort (callers run in waitUntil). */
async function recordQbAudit(env: Env, ctx: QbContext): Promise<void> {
  await query(
    `INSERT INTO waddling.usage_event (org_id, agent_id, datalake_id, kind, quantity)
       VALUES ($1, $2, $3, 'query', 1)`,
    [ctx.orgId, ctx.agentId, ctx.datalakeId],
  );
  const drained = await dpFetch(env, '/qb/audit-drain', { orgId: ctx.orgId });
  const records: any[] = drained.json?.records ?? [];
  if (records.length === 0) return;
  const tuples: string[] = [];
  const params: unknown[] = [];
  let n = 1;
  for (const rec of records) {
    if (rec.event !== 'authorize' && rec.event !== 'authenticate') continue;
    const agentId = rec.user?.startsWith('agent:') ? rec.user.slice('agent:'.length) : rec.user || null;
    tuples.push(
      `($${n++}, to_timestamp($${n++}::double precision / 1e6), 'gateway', $${n++}, $${n++}, $${n++}, $${n++}, $${n++}, $${n++})`,
    );
    params.push(ctx.orgId, rec.tsUs, rec.event, agentId, ctx.datalakeId, rec.decision || null, rec.reason || null, rec.query || null);
  }
  if (tuples.length === 0) return;
  await query(
    `INSERT INTO waddling.audit_event
       (org_id, ts, source, event, agent_id, datalake_id, decision, reason, query)
     VALUES ${tuples.join(', ')}`,
    params,
  );
}

/** Drain + record this gated op's birdshot audit. AWAITED before the response — NOT waitUntil:
 *  runInDbScope calls pool.end() synchronously once the handler returns (lib/db.ts), so a
 *  deferred audit would issue its INSERTs against an already-closing pool and silently drop them.
 *  Wrapped so an audit failure never fails the agent's request. */
async function recordAuditSafe(env: Env, ctx: QbContext): Promise<void> {
  try {
    await recordQbAudit(env, ctx);
  } catch (e) {
    console.log(`[quackboard] audit failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Pull a one-line message out of a node traceback / multiline error for the agent. */
function cleanReason(raw: string): string {
  const errLine = raw.split('\n').find((l) => /error/i.test(l));
  return (errLine ?? raw.split('\n')[0] ?? raw).replace(/^\s*\[?Error:?\s*/i, '').trim().slice(0, 200) || 'query failed';
}

/** Map a gated-query data-plane response to the tool contract, distinguishing a birdshot
 *  denial (403, structured) from a query error (500). */
function gatedResult(c: any, r: { status: number; json: any }) {
  if (r.status === 200) {
    return ok(c, { columns: r.json?.columns ?? [], rows: r.json?.rows ?? [], rowCount: r.json?.rowCount ?? (r.json?.rows?.length ?? 0) });
  }
  const raw = String(r.json?.reason ?? r.json?.error ?? 'query failed');
  if (/authoriz|permission|denied|not allowed|forbidden/i.test(raw)) {
    // The data-plane surfaces birdshot's deny as the quack client's stderr (a node traceback).
    // Replace it with a clean, agent-actionable message; birdshot's structured reason
    // (acl:read:<table>) is preserved in the audit_event log, not here.
    return c.json(
      { error: 'authorization_denied', reason: 'Not permitted by your quackboard ACL (a shared table you lack access to, or private memory — use qb_remember/qb_mine for that).' },
      403,
    );
  }
  return err(c, 'query_failed', 500, cleanReason(raw));
}

const quackboard = new Hono<{ Bindings: Env }>();

quackboard.post('/join', (c) =>
  handle(c, async () => {
    const ctx = await prepareQbContext(c, c.env);
    const cfg = await configureQb(c.env, ctx);
    if (cfg.status !== 200) {
      return err(c, 'quackboard_configure_failed', 502, `data plane /qb/configure → ${cfg.status}: ${JSON.stringify(cfg.json)}`);
    }
    return ok(c, {
      org_id: ctx.orgId,
      agent_id: ctx.agentId,
      shared_tables: QB_SHARED_TABLES,
      protocol:
        'You share a per-org board. observe findings (visible to all), recall to search them, ' +
        'subscribe to patterns + check your inbox for matches, remember/mine for PRIVATE notes only ' +
        'you can read, and qb_query for raw SQL over the shared tables.',
    });
  }),
);

const ObserveSchema = z.object({
  content: z.string().min(1),
  refs: z.array(z.string()).optional(),
  topic: z.string().optional(),
});
quackboard.post('/observe', (c) =>
  handle(c, async () => {
    const ctx = await prepareQbContext(c, c.env);
    const { content, refs, topic } = await parseBody(c, ObserveSchema);
    const refsJson = JSON.stringify(refs ?? []);
    // agent_role is BOUND from the authenticated identity (ctx.agentRole), never the tool args.
    const insert = await gatedQuery(c.env, ctx,
      `INSERT INTO observations(agent_role, content, refs, topic) VALUES (${lit(ctx.agentRole)}, ${lit(content)}, ${lit(refsJson)}::JSON, ${topic ? lit(topic) : 'NULL'})`,
    );
    if (insert.status !== 200) return gatedResult(c, insert);
    // Pub/sub fan-out: notify every OTHER agent whose subscription pattern matches this
    // observation (substring match — robust + no per-write FTS rebuild). Runs as the same
    // agent (write notifications + read subscriptions, both shared/granted).
    const fanout = await gatedQuery(c.env, ctx,
      `INSERT INTO notifications(to_role, sub_id, snippet)
         SELECT s.agent_role, s.id, substr(${lit(content)}, 1, 200)
           FROM subscriptions s
          WHERE s.agent_role <> ${lit(ctx.agentRole)}
            AND ${lit(content)} ILIKE '%' || s.pattern || '%'`,
    );
    const notified = fanout.status === 200 ? (fanout.json?.rows?.[0]?.[0] ?? 0) : 0;
    await recordAuditSafe(c.env, ctx);
    return ok(c, { ok: true, notified });
  }),
);

const RecallSchema = z.object({ query: z.string().min(1), limit: z.number().int().positive().max(100).optional() });
quackboard.post('/recall', (c) =>
  handle(c, async () => {
    const ctx = await prepareQbContext(c, c.env);
    const { query: term, limit } = await parseBody(c, RecallSchema);
    // FTS BM25 ranked recall over the SHARED observations corpus (trusted typed op — see
    // data plane /qb/recall). Returns rows ordered by relevance score, freshest index.
    const r = await dpFetch(c.env, '/qb/recall', {
      orgId: ctx.orgId, gatewayBoot: ctx.gatewayBoot, term, limit: Math.min(limit ?? 20, 100),
    });
    if (r.status !== 200) return err(c, 'recall_failed', 502, `data plane /qb/recall → ${r.status}: ${JSON.stringify(r.json)}`);
    return ok(c, { rows: r.json?.rows ?? [] });
  }),
);

const RememberSchema = z.object({ key: z.string().optional(), content: z.string().min(1) });
quackboard.post('/remember', (c) =>
  handle(c, async () => {
    const ctx = await prepareQbContext(c, c.env);
    const { key, content } = await parseBody(c, RememberSchema);
    // Trusted typed op — agent_role bound server-side; agent_memory carries no birdshot grant.
    const r = await dpFetch(c.env, '/qb/remember', {
      orgId: ctx.orgId, gatewayBoot: ctx.gatewayBoot, agentRole: ctx.agentRole, key, content,
    });
    if (r.status !== 200) return err(c, 'remember_failed', 502, `data plane /qb/remember → ${r.status}: ${JSON.stringify(r.json)}`);
    return ok(c, { ok: true });
  }),
);

const MineSchema = z.object({ key: z.string().optional(), limit: z.number().int().positive().max(500).optional() });
quackboard.post('/mine', (c) =>
  handle(c, async () => {
    const ctx = await prepareQbContext(c, c.env);
    const { key, limit } = await parseBody(c, MineSchema);
    const r = await dpFetch(c.env, '/qb/mine', {
      orgId: ctx.orgId, gatewayBoot: ctx.gatewayBoot, agentRole: ctx.agentRole, key, limit,
    });
    if (r.status !== 200) return err(c, 'mine_failed', 502, `data plane /qb/mine → ${r.status}: ${JSON.stringify(r.json)}`);
    return ok(c, { rows: r.json?.rows ?? [] });
  }),
);

const SubscribeSchema = z.object({ pattern: z.string().min(1), topic: z.string().optional() });
quackboard.post('/subscribe', (c) =>
  handle(c, async () => {
    const ctx = await prepareQbContext(c, c.env);
    const { pattern, topic } = await parseBody(c, SubscribeSchema);
    const r = await gatedQuery(c.env, ctx,
      `INSERT INTO subscriptions(agent_role, pattern, match_type, topic) VALUES (${lit(ctx.agentRole)}, ${lit(pattern)}, 'ilike', ${topic ? lit(topic) : 'NULL'})`,
    );
    if (r.status !== 200) return gatedResult(c, r);
    await recordAuditSafe(c.env, ctx);
    return ok(c, { ok: true });
  }),
);

const InboxSchema = z.object({ limit: z.number().int().positive().max(100).optional() });
quackboard.post('/inbox', (c) =>
  handle(c, async () => {
    const ctx = await prepareQbContext(c, c.env);
    const { limit } = await parseBody(c, InboxSchema);
    const cap = Math.min(limit ?? 20, 100);
    // to_role = caller is bound server-side (convenience scoping; the corpus is shared).
    const r = await gatedQuery(c.env, ctx,
      `SELECT id, sub_id, snippet, ts, is_read FROM notifications
         WHERE to_role = ${lit(ctx.agentRole)} ORDER BY ts DESC LIMIT ${cap}`,
    );
    await recordAuditSafe(c.env, ctx);
    return gatedResult(c, r);
  }),
);

const QuerySchema = z.object({ sql: z.string().min(1) });
quackboard.post('/query', (c) =>
  handle(c, async () => {
    const ctx = await prepareQbContext(c, c.env);
    const { sql } = await parseBody(c, QuerySchema);
    const r = await gatedQuery(c.env, ctx, sql);
    await recordAuditSafe(c.env, ctx);
    return gatedResult(c, r);
  }),
);

export { quackboard };
