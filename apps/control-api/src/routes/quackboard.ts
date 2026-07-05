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
 * agent_role server-side. The data plane stays private (reached only via HTTP+OIDC from
 * gatewayClientFor). The session JWT (kid → the pushed JWKS) is the quack TOKEN and never
 * leaves the server.
 */
import { z } from 'zod';
import { Hono } from 'hono';
import { importJWK, SignJWT, type JWK } from 'jose';
import { query, queryOne } from '../lib/db';
import type { Env } from '../lib/env';
import { grant, applyStatement } from '../lib/grant-store';
import {
  gatewayClientFor,
  GatewayError,
  type GatewayBoot,
  type GatewayQueryResult,
  type GatewayAck,
} from '../lib/gateway-client';
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

/** Ensure the quackboard's shared-table grants exist in the store (spec §13 pull model).
 *  A quackboard is a SHARED board: every active agent gets RW on the shared tables — which is
 *  exactly `TO PUBLIC` (reaches every authenticated identity), so no per-agent fan-out and no
 *  per-connect re-push. RW → the granular DML set (SELECT/INSERT/UPDATE/DELETE). Idempotent:
 *  each PUBLIC grant is written ONCE (the store is append-only, so we skip an identical row).
 *  Scoped to the quackboard datalake so birdshot pulls it under set_grant_scope(datalakeId). */
async function ensureQuackboardGrants(datalakeId: string): Promise<void> {
  for (const t of QB_SHARED_TABLES) {
    const stmt = grant({
      privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
      on: `main.${t}`,
      to: 'public',
    });
    const exists = await queryOne<{ one: number }>(
      `SELECT 1 AS one FROM public.__birdshot_grants
        WHERE datalake = $1 AND grantee_kind = 'public' AND stmt = $2 LIMIT 1`,
      [datalakeId, stmt],
    );
    if (!exists) await applyStatement(datalakeId, stmt);
  }
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
  /** The per-org QB gateway's own Cloud Run URL (datalake.gateway_url); selects the HTTP+OIDC target. */
  gatewayUrl: string | null;
  jwt: string;
  gatewayBoot: GatewayBoot;
  auth: { issuer: string; audience: string; mode: 'rs256'; jwks: { kid: string; n: string; e: string }[] };
  /** Read-only grant-store DSN pushed to the QB gateway (config-only §13). */
  grantStoreDsn?: string;
}

/** Resolve the org's quackboard + acting agent, build the snapshot, mint the agent's JWT. */
async function prepareQbContext(c: Parameters<typeof resolveCaller>[0], env: Env): Promise<QbContext> {
  // allowDelegated=true: a data-plane surface. requireOrg=true: the quackboard is per-org.
  const caller = await resolveCaller(c, true, true);
  const orgId = caller.orgId;

  const ep = await queryOne<{ id: string; status: string; gateway_url: string | null }>(
    `SELECT id, status, gateway_url FROM waddling.datalake
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

  await ensureQuackboardGrants(ep.id);
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

  return { orgId, datalakeId: ep.id, agentId, agentRole: agentId, gatewayUrl: ep.gateway_url, jwt, gatewayBoot: boot.gatewayBoot, auth, grantStoreDsn: env.BIRDSHOT_STORE_DSN };
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

/** The HTTP+OIDC client for THIS org's QB gateway (selected by datalake.gateway_url), same
 *  transport as the lake/workspace path. All QB data-plane calls go through here. */
function gw(ctx: QbContext) {
  return gatewayClientFor({ gateway_url: ctx.gatewayUrl });
}

/** Push the org's birdshot snapshot + JWKS to the QB gateway (boots/re-arms it if cold).
 *  Mirrors the lake path: pushSnapshot(SnapshotRequest). Throws GatewayError on non-2xx. */
async function configureQb(ctx: QbContext): Promise<GatewayAck> {
  // A freshly-provisioned QB gateway's run.invoker binding can take ~1-3 min to propagate to Cloud
  // Run's invoke-enforcement layer, so the first snapshot push after create may 403 even though
  // control-api already HAS invoker (the binding shows in get-iam-policy immediately). Retry on 403
  // with backoff — the same race the workspace connect path handles.
  for (let attempt = 0; ; attempt++) {
    try {
      return await gw(ctx).pushSnapshot({
        datalakeId: ctx.datalakeId,
        auth: ctx.auth,
        lakeCatalog: 'quackboard',
        grantStoreDsn: ctx.grantStoreDsn,
        gatewayBoot: ctx.gatewayBoot,
      });
    } catch (e) {
      if (e instanceof GatewayError && e.status === 403 && attempt < 5) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      throw e;
    }
  }
}

/** Run a gated query AS the agent (JWT = quack TOKEN). /query is HTTP-200-ALWAYS — the outcome is
 *  in the BODY ({ ok, rows, rowCount, error, authorizeDecision, phase }). On a cold-boot / lost-
 *  config failure the container has no JWKS, so quack AUTHENTICATION fails and the body carries
 *  phase === 'authenticate' — re-push the snapshot (re-arm) + retry once. A birdshot AUTHORIZATION
 *  deny (ok:false, authorizeDecision 'deny') is a real verdict: never retried. A genuine transport
 *  failure throws GatewayError (caller wraps). */
async function gatedQuery(ctx: QbContext, sql: string): Promise<GatewayQueryResult> {
  let r = await gw(ctx).qbGatedQuery(ctx.jwt, sql);
  if (r.phase === 'authenticate') {
    await configureQb(ctx);
    r = await gw(ctx).qbGatedQuery(ctx.jwt, sql);
  }
  return r;
}

/** Persist one gated query's birdshot audit decision(s) + a usage count, mirroring the lake
 *  path's recordQueryAudit. The drain is process-global + destructive (exactly-once per record);
 *  each record is attributed to ITS own agent via `user` ('agent:<id>'), so interleaved agents'
 *  queries on the shared board still attribute correctly. Best-effort (callers run in waitUntil). */
async function recordQbAudit(ctx: QbContext): Promise<void> {
  // Stable per-op id for the idempotency_key column (migration 018) — keeps the
  // quackboard usage row shaped like the lake path. This op is awaited (not waitUntil)
  // and un-billed, so a fresh id per call is sufficient; the ON CONFLICT guard makes
  // the insert a no-op if the same key ever recurs.
  await query(
    `INSERT INTO waddling.usage_event (org_id, agent_id, datalake_id, kind, quantity, idempotency_key)
       VALUES ($1, $2, $3, 'query', 1, $4)
     ON CONFLICT (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
    [ctx.orgId, ctx.agentId, ctx.datalakeId, crypto.randomUUID()],
  );
  const drained = await gw(ctx).drainAudit(ctx.datalakeId);
  const records: any[] = drained.records ?? [];
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
async function recordAuditSafe(ctx: QbContext): Promise<void> {
  try {
    await recordQbAudit(ctx);
  } catch (e) {
    console.log(`[quackboard] audit failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Flush the board to GCS after a successful mutation, so it survives Cloud Run scale-to-zero.
 *  /ctrl/checkpoint does CHECKPOINT + gcsUpload (enabled for quackboard mode by the entrypoint
 *  durability guard). Best-effort: waitUntil when the platform offers it (CF), else AWAIT — on
 *  Cloud Run there is no waitUntil and a fire-and-forget would race scale-to-zero and lose the
 *  flush. The promise swallows its own failure so a checkpoint error never fails the mutation. */
async function checkpointBoard(c: any, ctx: QbContext): Promise<void> {
  const run = gw(ctx).checkpointWorkspace().then(
    () => {},
    (e) => console.log(`[quackboard] checkpoint failed: ${e instanceof Error ? e.message : String(e)}`),
  );
  let exCtx: { waitUntil(p: Promise<unknown>): void } | undefined;
  try { exCtx = c.executionCtx; } catch { exCtx = undefined; }
  if (exCtx) { exCtx.waitUntil(run); return; }
  await run;
}

/** Pull a one-line message out of a node traceback / multiline error for the agent. */
function cleanReason(raw: string): string {
  const errLine = raw.split('\n').find((l) => /error/i.test(l));
  return (errLine ?? raw.split('\n')[0] ?? raw).replace(/^\s*\[?Error:?\s*/i, '').trim().slice(0, 200) || 'query failed';
}

/** Map a gated-query data-plane response to the tool contract, distinguishing a birdshot
 *  denial (403, structured) from a query error (500). /query is HTTP-200-ALWAYS, so the verdict
 *  lives in the BODY: key on r.ok — never treat ok:false as empty-rows success. rows are
 *  ROW-OBJECTS now; derive the columns list from the first row's keys for the tool contract. */
function gatedResult(c: any, r: GatewayQueryResult) {
  if (r.ok) {
    const rows = r.rows ?? [];
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return ok(c, { columns, rows, rowCount: r.rowCount ?? rows.length });
  }
  // ok:false is a real failure — a birdshot AUTHORIZATION deny (authorizeDecision 'deny', the
  // authoritative signal) OR a pre-hook parse-walk/forbidden-class denial (the authorize hook
  // never fired, so authorizeDecision is null/allow but the error text names the denial) OR a
  // plain query error. The dual check catches both denial shapes.
  const raw = String(r.error ?? 'query failed');
  if (r.authorizeDecision === 'deny' || /authoriz|permission|denied|not allowed|forbidden/i.test(raw)) {
    // birdshot's structured reason (acl:read:<table>) is preserved in the audit_event log, not here.
    return c.json(
      { error: 'authorization_denied', reason: 'Not permitted by your quackboard ACL (a shared table you lack access to, or private memory — use qb_remember/qb_mine for that).' },
      403,
    );
  }
  return err(c, 'query_failed', 500, cleanReason(raw));
}

const quackboard = new Hono<{ Bindings: Env }>();

// GET — owner-facing detection: does this org have a quackboard yet? Powers the
// control-plane UI's "create your quackboard" flow (there is exactly one QB per
// org). Resolves the caller with the PLAIN owner path (resolveCaller), NOT
// prepareQbContext — the tool routes below bind an agent identity and would 400
// an owner's cookie session with agent_required. Returns the single QB row or null.
quackboard.get('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const row = await queryOne<{ id: string; name: string; slug: string; status: string }>(
      `SELECT id, name, slug, status FROM waddling.datalake
        WHERE org_id = $1 AND kind = 'quackboard' ORDER BY created_at ASC LIMIT 1`,
      [caller.orgId],
    );
    return ok(c, { quackboard: row ?? null });
  }),
);

quackboard.post('/join', (c) =>
  handle(c, async () => {
    const ctx = await prepareQbContext(c, c.env);
    try {
      const ack = await configureQb(ctx);
      if (!ack.ok) return err(c, 'quackboard_configure_failed', 502, `snapshot push not acked: ${JSON.stringify(ack)}`);
    } catch (e) {
      if (e instanceof GatewayError) return err(c, 'quackboard_configure_failed', 502, e.message);
      throw e;
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
    let insert: GatewayQueryResult;
    let fanout: GatewayQueryResult;
    try {
      // agent_role is BOUND from the authenticated identity (ctx.agentRole), never the tool args.
      insert = await gatedQuery(ctx,
        `INSERT INTO observations(agent_role, content, refs, topic) VALUES (${lit(ctx.agentRole)}, ${lit(content)}, ${lit(refsJson)}::JSON, ${topic ? lit(topic) : 'NULL'})`,
      );
      if (!insert.ok) return gatedResult(c, insert);
      // Pub/sub fan-out: notify every OTHER agent whose subscription pattern matches this
      // observation (substring match — robust + no per-write FTS rebuild). Runs as the same
      // agent (write notifications + read subscriptions, both shared/granted).
      fanout = await gatedQuery(ctx,
        `INSERT INTO notifications(to_role, sub_id, snippet)
           SELECT s.agent_role, s.id, substr(${lit(content)}, 1, 200)
             FROM subscriptions s
            WHERE s.agent_role <> ${lit(ctx.agentRole)}
              AND ${lit(content)} ILIKE '%' || s.pattern || '%'`,
      );
    } catch (e) {
      if (e instanceof GatewayError) return err(c, 'observe_failed', 502, e.message);
      throw e;
    }
    // rows are ROW-OBJECTS; a gated INSERT returns a single { Count: n } row — read the first
    // value of the first row (robust to the count column's name).
    const notified = fanout.ok ? Number(Object.values(fanout.rows?.[0] ?? {})[0] ?? 0) : 0;
    await recordAuditSafe(ctx);
    await checkpointBoard(c, ctx);
    return ok(c, { ok: true, notified });
  }),
);

const RecallSchema = z.object({ query: z.string().min(1), limit: z.number().int().positive().max(100).optional() });
quackboard.post('/recall', (c) =>
  handle(c, async () => {
    const ctx = await prepareQbContext(c, c.env);
    const { query: term, limit } = await parseBody(c, RecallSchema);
    // FTS BM25 ranked recall over the SHARED observations corpus (trusted typed op — see
    // data plane /ctrl/qb-recall). Returns rows ordered by relevance score, freshest index.
    try {
      const r = await gw(ctx).qbRecall({ term, limit: Math.min(limit ?? 20, 100) });
      return ok(c, { rows: r?.rows ?? [] });
    } catch (e) {
      if (e instanceof GatewayError) return err(c, 'recall_failed', 502, e.message);
      throw e;
    }
  }),
);

const RememberSchema = z.object({ key: z.string().optional(), content: z.string().min(1) });
quackboard.post('/remember', (c) =>
  handle(c, async () => {
    const ctx = await prepareQbContext(c, c.env);
    const { key, content } = await parseBody(c, RememberSchema);
    // Trusted typed op — agent_role bound server-side; agent_memory carries no birdshot grant.
    try {
      await gw(ctx).qbRemember({ agentRole: ctx.agentRole, key, content });
    } catch (e) {
      if (e instanceof GatewayError) return err(c, 'remember_failed', 502, e.message);
      throw e;
    }
    await checkpointBoard(c, ctx);
    return ok(c, { ok: true });
  }),
);

const MineSchema = z.object({ key: z.string().optional(), limit: z.number().int().positive().max(500).optional() });
quackboard.post('/mine', (c) =>
  handle(c, async () => {
    const ctx = await prepareQbContext(c, c.env);
    const { key, limit } = await parseBody(c, MineSchema);
    try {
      const r = await gw(ctx).qbMine({ agentRole: ctx.agentRole, key, limit });
      return ok(c, { rows: r?.rows ?? [] });
    } catch (e) {
      if (e instanceof GatewayError) return err(c, 'mine_failed', 502, e.message);
      throw e;
    }
  }),
);

const SubscribeSchema = z.object({ pattern: z.string().min(1), topic: z.string().optional() });
quackboard.post('/subscribe', (c) =>
  handle(c, async () => {
    const ctx = await prepareQbContext(c, c.env);
    const { pattern, topic } = await parseBody(c, SubscribeSchema);
    let r: GatewayQueryResult;
    try {
      r = await gatedQuery(ctx,
        `INSERT INTO subscriptions(agent_role, pattern, match_type, topic) VALUES (${lit(ctx.agentRole)}, ${lit(pattern)}, 'ilike', ${topic ? lit(topic) : 'NULL'})`,
      );
    } catch (e) {
      if (e instanceof GatewayError) return err(c, 'subscribe_failed', 502, e.message);
      throw e;
    }
    if (!r.ok) return gatedResult(c, r);
    await recordAuditSafe(ctx);
    await checkpointBoard(c, ctx);
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
    let r: GatewayQueryResult;
    try {
      r = await gatedQuery(ctx,
        `SELECT id, sub_id, snippet, ts, is_read FROM notifications
           WHERE to_role = ${lit(ctx.agentRole)} ORDER BY ts DESC LIMIT ${cap}`,
      );
    } catch (e) {
      if (e instanceof GatewayError) return err(c, 'inbox_failed', 502, e.message);
      throw e;
    }
    await recordAuditSafe(ctx);
    return gatedResult(c, r);
  }),
);

const QuerySchema = z.object({ sql: z.string().min(1) });
quackboard.post('/query', (c) =>
  handle(c, async () => {
    const ctx = await prepareQbContext(c, c.env);
    const { sql } = await parseBody(c, QuerySchema);
    let r: GatewayQueryResult;
    try {
      r = await gatedQuery(ctx, sql);
    } catch (e) {
      if (e instanceof GatewayError) return err(c, 'query_failed', 502, e.message);
      throw e;
    }
    await recordAuditSafe(ctx);
    return gatedResult(c, r);
  }),
);

export { quackboard };
