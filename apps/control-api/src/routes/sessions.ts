/**
 * /api/cp/sessions — Hono port of apps/waddling/src/app/api/cp/sessions/route.ts +
 * sessions/[id]/route.ts + sessions/[id]/query/route.ts (§1 data-flow step 2, §3e).
 *
 * GET  /          → list this org's sessions (?status=&agentId=).
 * POST /          → connect (the data-plane entry): verify api-key/OAuth/session,
 *                   resolve agent+endpoint, push the FULL-endpoint birdshot snapshot,
 *                   MINT a short-lived RS256 session JWT (jose, kid from the Better
 *                   Auth jwks table), resolve+key the agent's durable workspace, and
 *                   CONFIGURE it in the data plane (boots the WorkspaceSandbox DO,
 *                   restores-from-R2, ATTACHes quack:443 → gateway with the JWT as
 *                   TOKEN). Inserts agent_session, returns a workspace HANDLE.
 * DELETE /        → kill a session: jti denylist on gateway + mark 'killed'.
 * GET  /:id       → single session detail for the dashboard.
 * POST /:id/query → run agent SQL in the agent's workspace (data plane /query). This
 *                   is NOT the retired /gw/query bypass: it forwards to the workspace
 *                   sidecar, whose locked DuckDB reaches the lake ONLY via the
 *                   birdshot-gated quack ATTACH. See the route for the invariant note.
 *
 * The JWT triangle (the load-bearing C/D seam): each connect RE-PUSHES the endpoint's
 * snapshot with the CURRENT signing key (kid), THEN mints the session JWT with the
 * matching kid, THEN configures the workspace with that JWT. Skipping the re-push →
 * "Authentication failed" at ATTACH (a JWT signed by a key birdshot doesn't know).
 *
 * Session JWT claims (§3a + birdshot identity mapping):
 *   id  = agent:<agentId>   ← birdshot reads THIS as the principal
 *   sub = agent:<agentId>   ← belt-and-suspenders
 *   iss = JWT_ISSUER, aud = gw:<datalakeId>, exp = now+15m, jti = <uuid>
 *   header.kid = jwks row id (matches /api/auth/jwks → birdshot_add_jwk)
 * The private key is the plaintext private JWK from the `jwks` table — readable
 * because the jwt plugin runs with disablePrivateKeyEncryption:true (see lib/auth).
 * The JWT is NEVER returned to the agent: it is handed to the data plane's /configure
 * as the quack TOKEN and held only by the workspace DO.
 *
 * The quack `sid` is per-connection and unknown at mint time; the JWT `jti` is the
 * logical session key (agent_session.sid = jti, jwt_jti = jti).
 *
 * Gateway + workspace interactions transport over HTTP+OIDC via gatewayClientFor.
 * PostHog is neutered via lib/agent-identity's captureAgentEvent (guarded no-op on
 * workerd).
 */
import { z } from 'zod';
import { Hono } from 'hono';
import { importJWK, SignJWT, type JWK } from 'jose';
import { query, queryOne, withTransaction } from '../lib/db';
import type { Env } from '../lib/env';
import { grantsForKey, agentSubject } from '../lib/grant-store';
import {
  resolveAgentIdentity,
  captureAgentEvent,
  CAPABILITY,
} from '../lib/agent-identity';
import {
  gatewayClientFor,
  GatewayError,
  type SnapshotRequest,
  type BirdshotJwk,
  type RelayQueryResult,
  type GovernedLoadResult,
} from '../lib/gateway-client';
import {
  resolveWorkspaceForSession,
  ensureWorkspaceKey,
  deriveWorkspaceServerToken,
} from '../lib/workspace-keys';
import { provisionWorkspace, workspaceSlug, workspaceGatewayUrl } from '../lib/provisioner';
import { hasCredit, debitQueryFloor } from '../lib/credits';
import { makePostHog } from '../lib/posthog';
import { resolveGatewayBoot, CatalogNotReadyError, StorageNotReadyError } from '../lib/gateway-boot';
import { loadSigningKey, mintLakeToken, SESSION_TTL_SECONDS as SESSION_TTL_SECONDS_IMPORT } from '../lib/session-jwt';
import { refreshCatalog } from '../lib/catalog-cache';
import { refreshCatalogAndEnqueue } from '../lib/gateway-dispatch';
import type { ConnectResult, QueryResult } from '../lib/types';
import {
  resolveCaller,
  assertOrg,
  parseBody,
  handle,
  ok,
  err,
  AuthError,
} from '../lib/cp-shared';

const SESSION_TTL_SECONDS = SESSION_TTL_SECONDS_IMPORT; // from lib/session-jwt (kept as the connect-path local name)

/**
 * Record one query: count usage + persist the gateway's birdshot audit decision(s).
 *
 * birdshot logs every authorize/authenticate decision (table + allow/deny + the SQL)
 * on the quack path; this drains the per-endpoint gateway's log and writes each as a
 * `source='gateway'` audit_event. Usage is a separate, exact count (one query ran —
 * independent of how many tables it touched, or whether it was allowed). The audit
 * drain is endpoint-GLOBAL, so it may sweep up records from other agents' concurrent
 * queries on the same endpoint — each is attributed to ITS own agent via the record's
 * `user` ('agent:<id>'), which is correct. Best-effort: callers run this in waitUntil
 * and swallow errors so it never affects the query response.
 */
async function recordQueryAudit(
  sess: { org_id: string; agent_id: string; datalake_id: string },
  queryId: string,
): Promise<void> {
  // Usage — exactly one query ran in this session. `queryId` is minted once per
  // /query|/etl call (synchronously, before this best-effort waitUntil), so a retry
  // or redelivery of this insert is a no-op (UNIQUE org_id+idempotency_key, migration
  // 018) instead of an over-count. Same id keys the per-query floor debit.
  await query(
    `INSERT INTO waddling.usage_event (org_id, agent_id, datalake_id, kind, quantity, idempotency_key)
       VALUES ($1, $2, $3, 'query', 1, $4)
     ON CONFLICT (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
    [sess.org_id, sess.agent_id, sess.datalake_id, queryId],
  );

  // Drain birdshot's audit log from the per-endpoint gateway and persist each record.
  const drained = await gatewayClientFor().drainAudit(sess.datalake_id);
  const records = drained?.records ?? [];
  if (records.length === 0) return;

  const tuples: string[] = [];
  const params: unknown[] = [];
  let n = 1;
  for (const rec of records) {
    if (rec.event !== 'authorize' && rec.event !== 'authenticate') continue;
    // user = 'agent:<agentId>' → the principal birdshot enforced as.
    const agentId = rec.user?.startsWith('agent:') ? rec.user.slice('agent:'.length) : rec.user || null;
    // ts comes from birdshot as epoch MICROSECONDS (preserve the real access time).
    tuples.push(
      `($${n++}, to_timestamp($${n++}::double precision / 1e6), 'gateway', $${n++}, $${n++}, $${n++}, $${n++}, $${n++}, $${n++})`,
    );
    params.push(
      sess.org_id,
      rec.tsUs,
      rec.event,
      agentId,
      sess.datalake_id,
      rec.decision || null,
      rec.reason || null,
      rec.query || null,
    );
  }
  if (tuples.length === 0) return;
  await query(
    `INSERT INTO waddling.audit_event
       (org_id, ts, source, event, agent_id, datalake_id, decision, reason, query)
     VALUES ${tuples.join(', ')}`,
    params,
  );
}

/** Bucket a birdshot denial message into a metadata-only reason class for telemetry —
 *  never the raw message, so no table/column names leave the control plane in events. */
function classifyDenial(msg: string): 'column' | 'table' | 'revoked' | 'expired' {
  const m = msg.toLowerCase();
  if (m.includes('column')) return 'column';
  if (m.includes('revok')) return 'revoked';
  if (m.includes('expir')) return 'expired';
  return 'table';
}

// One-key-per-agent runtime policy (agent-auth.md §cardinality). Claude gives the
// server no per-conversation id, so the credential IS the agent instance: a key may
// hold at most one live session.
//  - 'supersede' (default): a new connect kills the agent's prior live session.
//  - 'reject': a second concurrent connect is refused (409).
// The original read process.env.WADDLING_AGENT_SESSION_POLICY at module load; there
// is no ambient env on workerd, so this is resolved per-request from c.env inside the
// handler (a module-load read would always be undefined → silently always-supersede).
function sessionPolicy(env: Env): 'supersede' | 'reject' {
  return env.WADDLING_AGENT_SESSION_POLICY === 'reject' ? 'reject' : 'supersede';
}

// Accept `endpointId` too: the MCP waddling_connect tool (an external agent-facing
// contract) still sends the legacy key. Either resolves to the datalake id.
const ConnectSchema = z
  .object({
    datalakeId: z.string().min(1).optional(),
    endpointId: z.string().min(1).optional(),
    agentId: z.string().optional(),
  })
  .refine((s) => Boolean(s.datalakeId || s.endpointId), {
    message: 'datalakeId (or endpointId) is required',
  });
const KillSchema = z.object({ sessionId: z.string().min(1), reason: z.string().optional() });

interface EndpointRow {
  id: string;
  org_id: string;
  slug: string;
  status: string;
  server_token: string;
  gateway_url: string | null;
}

interface SessionListRow {
  id: string;
  org_id: string;
  agent_id: string;
  datalake_id: string;
  sid: string;
  status: 'active' | 'expired' | 'revoked' | 'killed';
  granted_roles: string[];
  started_at: string;
  expires_at: string;
}

interface SessionDetailRow {
  id: string;
  org_id: string;
  sid: string;
  status: 'active' | 'expired' | 'revoked' | 'killed';
  granted_roles: string[];
  started_at: string;
  expires_at: string;
  agent_id: string;
  agent_name: string | null;
  owner: string | null;
  datalake_id: string;
  endpoint_name: string | null;
}

const sessions = new Hono<{ Bindings: Env }>();

/** GET → list this org's sessions, optionally filtered by ?status= and ?agentId=. */
sessions.get('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const u = new URL(c.req.url);
    const status = u.searchParams.get('status');
    const agentId = u.searchParams.get('agentId');

    const rows = await query<SessionListRow>(
      `SELECT id, org_id, agent_id, datalake_id, sid, status, granted_roles, started_at, expires_at
         FROM waddling.agent_session
        WHERE org_id = $1
          AND ($2::text IS NULL OR status = $2)
          AND ($3::text IS NULL OR agent_id = $3)
        ORDER BY started_at DESC
        LIMIT 200`,
      [caller.orgId, status, agentId],
    );
    const list = rows.rows.map((r) => ({
      id: r.id,
      orgId: r.org_id,
      agentId: r.agent_id,
      datalakeId: r.datalake_id,
      sid: r.sid,
      status: r.status,
      grantedRoles: r.granted_roles,
      startedAt: r.started_at,
      expiresAt: r.expires_at,
    }));
    return ok(c, { sessions: list });
  }),
);

sessions.post('/', (c) =>
  handle(c, async () => {
    // allowDelegated=true: this is the one data-plane route OAuth/MCP tokens may use.
    // requireOrg=false: the org is derived from the chosen endpoint below.
    const caller = await resolveCaller(c, false, true);
    const connectBody = await parseBody(c, ConnectSchema);
    const datalakeId = (connectBody.datalakeId ?? connectBody.endpointId)!;
    const requestedAgentId = connectBody.agentId;

    const endpoint = await queryOne<EndpointRow>(
      `SELECT id, org_id, slug, status, server_token, gateway_url
         FROM waddling.datalake WHERE id = $1`,
      [datalakeId],
    );
    if (!endpoint) return err(c, 'endpoint_not_found', 404);
    if (endpoint.status !== 'running') {
      return err(c, 'endpoint_not_running', 409, `Endpoint status is ${endpoint.status}`);
    }

    // Prepaid credit gate at CONNECT. The per-query cutoff alone can't bound the dominant
    // cost: a session is the unit that accrues wall-clock COGS, so a zero-balance org must
    // be refused a NEW session here (not just its first query). Fail-open if no balance row
    // exists yet (legacy/un-granted org) — see lib/credits.hasCredit.
    if (!(await hasCredit(endpoint.org_id))) {
      return err(
        c,
        'insufficient_credits',
        402,
        'Org credit balance is exhausted — top up credits to start a new session.',
      );
    }

    // Resolve the acting agent + session origin per caller type:
    //  * API-key agent      → itself; origin='agent' (one-key-per-agent enforced).
    //  * delegated (OAuth)  → provision a per-user delegated agent; origin='delegated'.
    //  * dashboard user     → run-as a named agent; origin='run-as' (inspection).
    let agentId: string;
    let origin: 'agent' | 'run-as' | 'delegated';
    if (caller.agentId) {
      assertOrg(caller, endpoint.org_id);
      agentId = caller.agentId;
      origin = 'agent';
    } else if (caller.delegated) {
      // Tenant isolation: the consenting human must belong to the endpoint's org.
      const member = await queryOne<{ one: number }>(
        `SELECT 1 AS one FROM "member" WHERE "userId" = $1 AND "organizationId" = $2`,
        [caller.callerId, endpoint.org_id],
      );
      if (!member) {
        return err(c, 'forbidden', 403, 'Delegating user is not a member of this endpoint’s org');
      }
      // Idempotent upsert on (org_id, name) — deterministic per user, so concurrent
      // first-connects don't race to insert. No API key (api_key_id stays NULL).
      const prov = await queryOne<{ id: string }>(
        `INSERT INTO waddling.agent (org_id, name, description, mode, status, owner_user_id)
         VALUES ($1, $2, $3, 'delegated', 'active', $4)
         ON CONFLICT (org_id, name) DO UPDATE SET last_seen_at = now(), owner_user_id = EXCLUDED.owner_user_id
         RETURNING id`,
        [endpoint.org_id, `claude:${caller.callerId}`, `Delegated MCP agent for user ${caller.callerId}`, caller.callerId],
      );
      if (!prov) return err(c, 'agent_provision_failed', 500);
      agentId = prov.id;
      origin = 'delegated';
    } else {
      assertOrg(caller, endpoint.org_id);
      if (!requestedAgentId) {
        return err(
          c,
          'agent_required',
          400,
          'connect requires an agent: an sk_agent_… API key, an OAuth token, or an agentId to run as',
        );
      }
      const target = await queryOne<{ org_id: string }>(
        `SELECT org_id FROM waddling.agent WHERE id = $1`,
        [requestedAgentId],
      );
      if (!target) return err(c, 'agent_not_found', 404);
      assertOrg(caller, target.org_id);
      agentId = requestedAgentId;
      origin = 'run-as';
    }

    // Full AAP identity (id, name, mode, on-behalf-of) for the JWT + trace.
    const identity = await resolveAgentIdentity(agentId);
    if (!identity) return err(c, 'agent_not_found', 404);
    // Delegating human for THIS action: delegated/run-as → the caller; autonomous →
    // the API-key owner resolved on the identity.
    const onBehalfOf = origin === 'agent' ? identity.onBehalfOf : caller.callerId;

    // One-key-per-agent enforcement (real agent connections only). Find the agent's
    // existing live sessions; reject or supersede per policy. The unique index is the
    // race backstop (concurrent connects → loser gets 23505 → 409 below).
    let toSupersede: { id: string; jwt_jti: string }[] = [];
    if (origin === 'agent') {
      // Scoped to (agent, endpoint): one live session per agent PER endpoint. Reap
      // expired-but-'active' rows first so they neither false-reject nor block the
      // one-active unique index.
      await query(
        `UPDATE waddling.agent_session SET status='expired', ended_at=now()
          WHERE agent_id = $1 AND datalake_id = $2 AND status = 'active'
            AND origin = 'agent' AND expires_at <= now()`,
        [agentId, datalakeId],
      );
      const existing = await query<{ id: string; jwt_jti: string }>(
        `SELECT id, jwt_jti FROM waddling.agent_session
          WHERE agent_id = $1 AND datalake_id = $2 AND status = 'active' AND origin = 'agent'`,
        [agentId, datalakeId],
      );
      if (existing.rows.length > 0 && sessionPolicy(c.env) === 'reject') {
        return err(
          c,
          'agent_session_in_use',
          409,
          'This agent already has an active session. One key per agent — create a separate agent for a second concurrent instance.',
        );
      }
      toSupersede = existing.rows;
    }

    // Pull-model (spec §13): the gateway is CONFIG-only — birdshot pulls this agent's literal
    // GRANT/DENY SQL from the shared store itself. The connect gate is simply "does this key
    // have ANY statement in the store?" (subject ∪ PUBLIC ∪ transitive roles). `granted` is the
    // literal statement list, rendered verbatim by the UI — there is no compile.
    await refreshCatalog(endpoint).catch(() => null);
    const statements = await grantsForKey(datalakeId, agentSubject(agentId));
    const granted = { statements };
    if (statements.length === 0) {
      return err(
        c,
        'no_grants',
        403,
        'This agent has no grants on this endpoint — an admin must author a GRANT (POST /api/cp/acl) before it can connect',
      );
    }

    // Push CONFIG (auth/JWKS/lakeCatalog/grantStoreDsn) to the gateway control channel
    // (HTTP+OIDC → boots gw:<datalakeId> if cold). No grant tuples — birdshot pulls them.
    const { kid, publicJwk, privateJwk } = await loadSigningKey();
    const gw = gatewayClientFor(endpoint);
    const jwks: BirdshotJwk[] = [{ kid, n: publicJwk.n, e: publicJwk.e }];

    // Resolve the endpoint's real lake boot config (catalog DSN + per-endpoint metadata
    // schema + object-store creds). On a cold gateway the data plane injects this so the
    // gateway ATTACHes the endpoint's REAL DuckLake; with no real catalog it falls back to
    // the offline demo (lakeCatalog 'memory'). A still-provisioning managed catalog is a
    // retryable 503 (the org's PlanetScale DB isn't ready yet).
    let boot;
    try {
      boot = await resolveGatewayBoot(c.env, datalakeId);
    } catch (e) {
      if (e instanceof CatalogNotReadyError) {
        return err(c, 'catalog_provisioning', 503, e.message);
      }
      if (e instanceof StorageNotReadyError) {
        return err(c, 'storage_unavailable', 503, e.message);
      }
      throw e;
    }

    const snapshotReq: SnapshotRequest = {
      datalakeId,
      auth: {
        issuer: c.env.JWT_ISSUER,
        audience: `gw:${datalakeId}`,
        mode: 'rs256',
        jwks,
      },
      lakeCatalog: boot.lakeCatalog,
      grantStoreDsn: c.env.BIRDSHOT_STORE_DSN,
      gatewayBoot: boot.gatewayBoot,
    };
    // connect AWAITS the push (a session must not be minted against a gateway that never
    // received its config + JWKS); a failure surfaces as 500. This is the first leg of the JWT
    // triangle — the JWT minted just below carries `kid` and is verified against THIS pushed
    // JWKS at ATTACH. Grants are NOT here: birdshot pulls them from the store at authorize.
    await gw.pushSnapshot(snapshotReq);

    // Mint the RS256 session JWT (jose) with custom claims + kid header.
    const key = (await importJWK(privateJwk, 'RS256')) as CryptoKey;
    const principal = `agent:${agentId}`;
    const jti = crypto.randomUUID();
    // AAP identity claims ride INSIDE the gateway session JWT (resolve-and-restamp).
    // `id`/`sub` stay = agent:<id> (birdshot's principal); the gateway ignores the
    // extra claims, so its verification path is unchanged.
    const claims: Record<string, unknown> = {
      id: principal,
      mode: identity.mode,
      cap: CAPABILITY.connect,
    };
    if (onBehalfOf) claims.act = onBehalfOf; // delegating human
    const sessionJwt = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid })
      .setSubject(principal)
      .setIssuer(c.env.JWT_ISSUER)
      .setAudience(`gw:${datalakeId}`)
      .setIssuedAt()
      .setJti(jti)
      .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
      .sign(key);

    // Resolve the agent's durable workspace (default-per-endpoint) + vend its 32-byte
    // encryption key (generated lazily, sealed in Postgres; NEVER returned to the
    // agent). Then CONFIGURE the workspace in the data plane: boot the WorkspaceSandbox
    // DO, restore-from-R2, and ATTACH quack:443 → gateway with the session JWT as the
    // quack TOKEN. This is the second + third legs of the JWT triangle — the JWT (kid)
    // is verified against the JWKS pushed above. The key + JWT cross ONLY into the data
    // plane (the DO holds them); neither is ever returned to the agent. A configure
    // failure surfaces as 500 BEFORE any session row is written (fail-safe: the agent's
    // prior live session, if any, stays intact since the supersede is in the insert txn
    // below).
    const ws = await resolveWorkspaceForSession(endpoint.org_id, datalakeId, agentId);
    const workspaceKey = await ensureWorkspaceKey(ws.workspaceId, agentId);
    // Provision (or wake) the per-(workspace, agent) Cloud Run workspace service. It opens the
    // agent's ENCRYPTED durable .duckdb (restored from GCS) and will relay the governed lake. The
    // slug is a deterministic hash of (workspaceId, agentId), so a reconnect just wakes the existing
    // service; the encryption key crosses ONLY into the service env, never back to the agent.
    let wsUrl: string;
    try {
      const prov = await provisionWorkspace(c.env, {
        slug: workspaceSlug(ws.workspaceId, agentId),
        workspaceId: ws.workspaceId,
        agentId,
        encryptionKey: workspaceKey,
        // Per-(workspace, agent) derived token — NOT the datalake-wide endpoint.server_token — so a
        // workspace container holds no cross-tenant secret (see deriveWorkspaceServerToken). The
        // workspace's quack_serve is loopback-only and birdshot RS256 is the real auth gate, so this
        // value is never presented on the wire; it only satisfies quack_serve's required token arg.
        serverToken: deriveWorkspaceServerToken(workspaceKey),
        // The workspace's recorded compute size drives the provisioned Cloud Run cpu/memory and
        // the per-second billing rate charged against this session.
        size: ws.size,
      });
      wsUrl = prov.url;
    } catch (e) {
      return err(
        c,
        'workspace_provisioning',
        503,
        `workspace not ready — retry connect: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // Configure the lake relay: the workspace ATTACHes 'quack:<lake public router host>' with the
    // agent's lake-JWT (sessionJwt, aud gw:<datalakeId>). Lake reads relayed through the workspace
    // are then gated at the LAKE under the agent's real identity. The ws→lake hop is quack through
    // the PUBLIC router (quack carries no OIDC header — the router mints it for the private gw hop).
    const routerSuffix = c.env.ROUTER_HOST_SUFFIX || 'getwaddling.com';
    const lakeProxy = `gw-${endpoint.slug}.${routerSuffix}:443`;
    const wsClient = gatewayClientFor({ gateway_url: wsUrl });
    // A freshly-provisioned ws service's run.invoker binding takes up to a minute+ to propagate to
    // Cloud Run's invoke-enforcement layer, so the first configure-lake right after a CREATE can 403
    // even though control-api already HAS invoker (the binding shows in get-iam-policy immediately).
    // Retry a few times on 403; if still not ready, return a retryable 503 so the agent's
    // connect-retry loop waits out the rest of propagation.
    let cfg: { ok: boolean; lakeAttached?: boolean; error?: string } | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        cfg = await wsClient.configureLake({ lakeProxy, lakeToken: sessionJwt, disableSsl: false });
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (e instanceof GatewayError && e.status === 403) {
          if (attempt < 5) {
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }
          return err(
            c,
            'workspace_provisioning',
            503,
            `workspace IAM still propagating — retry connect: ${msg}`,
          );
        }
        return err(c, 'lake_attach_failed', 502, `workspace configure-lake failed: ${msg}`);
      }
    }
    if (cfg?.ok !== true) {
      return err(
        c,
        'lake_attach_failed',
        502,
        `workspace configured but the lake quack ATTACH did not succeed: ${JSON.stringify(cfg)}`,
      );
    }

    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
    const grantedRoles = [`agent_${agentId}`];
    // Supersede the agent's prior live session(s) and insert the new one atomically,
    // so the one-active-per-agent unique index holds. A concurrent connect that loses
    // the race trips the index (23505) → 409 below.
    let inserted: { id: string } | null;
    try {
      inserted = await withTransaction(async (q) => {
        if (origin === 'agent' && toSupersede.length > 0) {
          await q(
            `UPDATE waddling.agent_session SET status='superseded', ended_at=now()
              WHERE id = ANY($1::text[])`,
            [toSupersede.map((s) => s.id)],
          );
        }
        const r = await q<{ id: string }>(
          `INSERT INTO waddling.agent_session
             (org_id, agent_id, datalake_id, sid, jwt_jti, status, granted_roles, origin, ip, user_agent, expires_at, compute_size)
           VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10,$11)
           RETURNING id`,
          [
            endpoint.org_id,
            agentId,
            datalakeId,
            jti, // sid = jti (quack sid unknown until ATTACH)
            jti,
            grantedRoles,
            origin,
            c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null,
            c.req.header('user-agent') || null,
            expiresAt.toISOString(),
            ws.size, // billed at this size's per-second rate (COMPUTE_SIZES)
          ],
        );
        return r.rows[0] ?? null;
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        return err(
          c,
          'agent_session_in_use',
          409,
          'Concurrent connect for the same agent key — one live session per agent.',
        );
      }
      throw e;
    }

    // Revoke the displaced sessions' JWTs at the gateway (jti denylist) so the old
    // token can't keep querying until its exp; audit + trace each supersede.
    if (origin === 'agent' && toSupersede.length > 0) {
      for (const s of toSupersede) {
        try {
          // e2e-gated on Stage D gateway reachability — best-effort; the session is
          // already marked superseded in the DB regardless.
          await gw.revoke({
            datalakeId,
            kind: 'jti',
            id: s.jwt_jti,
            reason: 'superseded by new connect (one-key-per-agent)',
          });
        } catch {
          // gateway may be down; the session is already marked superseded.
        }
        await query(
          `INSERT INTO waddling.audit_event
             (org_id, source, event, agent_id, session_id, datalake_id, decision, reason, actor, agent_mode, on_behalf_of, capability)
           VALUES ($1,'control-plane','revoke',$2,$3,$4,'deny',$5,$6,$7,$8,$9)`,
          [
            endpoint.org_id, agentId, s.id, datalakeId,
            'superseded by new connect (one-key-per-agent)',
            caller.callerId, identity.mode, onBehalfOf ?? null, CAPABILITY.connect,
          ],
        );
      }
      captureAgentEvent({
        identity,
        orgId: endpoint.org_id,
        event: 'agent_session_superseded',
        capability: CAPABILITY.connect,
        onBehalfOf,
        datalakeId,
        extra: { superseded_count: toSupersede.length },
      });
    }

    // Audit + last-seen + trace — AAP identity (mode, on-behalf-of, capability)
    // stamped on the event so a single agent is legible vs others under the same user.
    await query(
      `INSERT INTO waddling.audit_event
         (org_id, source, event, agent_id, session_id, datalake_id, decision, actor, agent_mode, on_behalf_of, capability)
       VALUES ($1,'control-plane','attach',$2,$3,$4,'allow',$5,$6,$7,$8)`,
      [
        endpoint.org_id, agentId, inserted?.id ?? null, datalakeId, caller.callerId,
        identity.mode, onBehalfOf ?? null, CAPABILITY.connect,
      ],
    );
    await query(`UPDATE waddling.agent SET last_seen_at = now() WHERE id = $1`, [agentId]);
    captureAgentEvent({
      identity,
      orgId: endpoint.org_id,
      event: CAPABILITY.connect,
      capability: CAPABILITY.connect,
      onBehalfOf,
      sessionId: inserted?.id ?? jti,
      jti,
      datalakeId,
      // ACL/grant detail kept separate from capability (different layer).
      extra: { granted_statements: granted.statements.length, origin },
    });

    // Activation funnel: the human reached "agent connected to a governed lake". Gated on
    // a human (onBehalfOf): delegated/run-as resolve a user id; autonomous service agents
    // with no owner (e.g. the analytics ETL fleet) have none and are skipped — so the
    // pipeline never counts itself. Metadata-only props (no SQL/rows). Fire-and-forget.
    if (onBehalfOf) {
      let phCtx: { waitUntil(p: Promise<unknown>): void } | undefined;
      try { phCtx = c.executionCtx; } catch { phCtx = undefined; }
      makePostHog(c.env, phCtx).capture({
        distinctId: onBehalfOf,
        event: 'mcp_connect',
        properties: { endpoint_id: datalakeId, ttl_seconds: SESSION_TTL_SECONDS },
        groups: { organization: endpoint.org_id },
      });
    }

    // Return a workspace HANDLE — no attachSql/JWT/key. The agent does not ATTACH the
    // lake itself; its workspace DO does, and the agent queries via
    // POST /api/cp/sessions/:id/query (→ data plane /query).
    const body: ConnectResult = {
      sessionId: inserted?.id ?? jti,
      workspaceId: ws.workspaceId,
      agentId,
      ttlSeconds: SESSION_TTL_SECONDS,
      granted,
    };
    return ok(c, body, 201);
  }),
);

type KillResult =
  | { found: true }
  | { found: false; notFound: true }
  | { found: false; forbidden: true };

/**
 * Shared kill implementation: jti denylist on the gateway + mark 'killed' in the DB
 * + audit event. Returns a discriminated union so callers can map not-found / forbidden
 * to proper HTTP responses without re-fetching. Throws only on unexpected DB errors.
 */
async function killSessionCore(
  sessionId: string,
  callerOrgId: string,
  callerId: string,
  reason: string | undefined,
): Promise<KillResult> {
  const sess = await queryOne<{
    id: string;
    org_id: string;
    datalake_id: string;
    jwt_jti: string;
    agent_id: string;
  }>(
    `SELECT id, org_id, datalake_id, jwt_jti, agent_id
       FROM waddling.agent_session WHERE id = $1`,
    [sessionId],
  );
  if (!sess) return { found: false, notFound: true };
  // Expose as 404 (not 403) to avoid leaking session ids across orgs.
  if (sess.org_id !== callerOrgId) return { found: false, notFound: true };

  const endpoint = await queryOne<EndpointRow>(
    `SELECT id, org_id, status, server_token, gateway_url
       FROM waddling.datalake WHERE id = $1`,
    [sess.datalake_id],
  );
  if (endpoint) {
    try {
      // e2e-gated on Stage D gateway reachability — best-effort; the session is
      // marked 'killed' below regardless so it can't be reused.
      await gatewayClientFor(endpoint).revoke({
        datalakeId: endpoint.id,
        kind: 'jti',
        id: sess.jwt_jti,
        reason: reason ?? 'killed by control plane',
      });
    } catch {
      // gateway may be down; still mark killed so the session can't be reused.
    }
  }

  await query(
    `UPDATE waddling.agent_session SET status='killed', ended_at=now() WHERE id=$1`,
    [sessionId],
  );
  await query(
    `INSERT INTO waddling.audit_event (org_id, source, event, agent_id, session_id, datalake_id, decision, reason, actor)
     VALUES ($1,'control-plane','kill',$2,$3,$4,'deny',$5,$6)`,
    [sess.org_id, sess.agent_id, sessionId, sess.datalake_id, reason ?? null, callerId],
  );

  return { found: true };
}

sessions.delete('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const { sessionId, reason } = await parseBody(c, KillSchema);

    const result = await killSessionCore(sessionId, caller.orgId, caller.callerId, reason);
    if (!result.found) return err(c, 'session_not_found', 404);

    return ok(c, { success: true, affectedSessions: 1 });
  }),
);

/**
 * POST /:id/kill — org-scoped session kill for the dashboard.
 * The dashboard calls POST /api/cp/sessions/:id/kill (not DELETE /). This route
 * implements the same jti-denylist + mark-killed logic as DELETE / but binds the
 * session id to the URL path param instead of the request body. Returns { ok: true }.
 * Body is optional; a `reason` string field is forwarded if present.
 */
sessions.post('/:id/kill', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    let reason: string | undefined;
    try {
      const body = await c.req.json();
      if (body && typeof body.reason === 'string') reason = body.reason;
    } catch {
      // body is optional — a bodyless POST is fine
    }

    const result = await killSessionCore(id, caller.orgId, caller.callerId, reason);
    if (!result.found) return err(c, 'session_not_found', 404);

    return ok(c, { ok: true });
  }),
);

/** GET /:id → single session detail (org-scoped) + its 'query' audit rows. */
sessions.get('/:id', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');

    const s = await queryOne<SessionDetailRow>(
      `SELECT se.id, se.org_id, se.sid, se.status, se.granted_roles,
              se.started_at, se.expires_at,
              se.agent_id, a.name AS agent_name,
              COALESCE(u.name, u.email) AS owner,
              se.datalake_id, e.name AS endpoint_name
         FROM waddling.agent_session se
         LEFT JOIN waddling.agent a  ON a.id = se.agent_id
         LEFT JOIN "apikey" k        ON k.id = a.api_key_id
         LEFT JOIN "user" u          ON u.id = k."referenceId"
         LEFT JOIN waddling.datalake e ON e.id = se.datalake_id
        WHERE se.id = $1`,
      [id],
    );
    if (!s || s.org_id !== caller.orgId) return err(c, 'session_not_found', 404);

    // Who opened the session: the 'attach' audit row's actor (a user id for
    // run-as-agent; an agent id otherwise). Resolve to a display name if a user.
    const attach = await queryOne<{ actor: string | null; actor_name: string | null }>(
      `SELECT ev.actor, COALESCE(u.name, u.email) AS actor_name
         FROM waddling.audit_event ev
         LEFT JOIN "user" u ON u.id = ev.actor
        WHERE ev.session_id = $1 AND ev.event = 'attach'
        ORDER BY ev.ts ASC LIMIT 1`,
      [id],
    );

    const queryRows = await query<{
      ts: string;
      query: string | null;
      decision: 'allow' | 'deny' | null;
      reason: string | null;
    }>(
      `SELECT ts, query, decision, reason
         FROM waddling.audit_event
        WHERE session_id = $1 AND event = 'query'
        ORDER BY ts DESC
        LIMIT 200`,
      [id],
    );

    return ok(c, {
      session: {
        id: s.id,
        sid: s.sid,
        status: s.status,
        startedAt: s.started_at,
        expiresAt: s.expires_at,
        grantedRoles: s.granted_roles,
        agentId: s.agent_id,
        agentName: s.agent_name ?? undefined,
        owner: s.owner ?? undefined,
        datalakeId: s.datalake_id,
        endpointName: s.endpoint_name ?? undefined,
        actor: attach?.actor ?? undefined,
        actorName: attach?.actor_name ?? undefined,
      },
      queries: queryRows.rows.map((r) => ({
        ts: r.ts,
        query: r.query ?? '',
        decision: r.decision ?? undefined,
        reason: r.reason ?? undefined,
      })),
    });
  }),
);

const QuerySchema = z.object({ sql: z.string().min(1) });

/**
 * POST /:id/query — run the agent's SQL in its durable workspace.
 *
 * THE INVARIANT (read before touching this): this is NOT the retired /gw/query proxy.
 * That bypass ran agent SQL on the gateway's TRUSTED control connection, sidestepping
 * birdshot. This route instead forwards to the data plane's POST /query, which runs
 * the SQL inside the agent's WorkspaceSandbox — a LOCKED DuckDB (no S3/HTTP fs, no
 * secrets) whose ONLY lake access is the birdshot-gated quack ATTACH set up at
 * /configure. So agent SQL still reaches the lake through exactly one path. NEVER
 * point this at /gw/* or any trusted connection.
 *
 * The data plane is keyed by (workspaceId, agentId), re-resolved here from the session
 * row (deterministic: the default workspace per (org, endpoint)). A 409 needs_configure
 * means the workspace DO hibernated (the container — hence the ATTACH — is gone); the
 * agent must reconnect (which re-pushes the snapshot + re-configures). We surface that
 * as a structured error rather than transparently reconnecting (the frozen contract).
 */
sessions.post('/:id/query', (c) =>
  handle(c, async () => {
    // allowDelegated=true: a data-plane route. requireOrg=false: org derived from the
    // session row below.
    const caller = await resolveCaller(c, false, true);
    const id = c.req.param('id');
    const { sql } = await parseBody(c, QuerySchema);

    const sess = await queryOne<{
      id: string;
      org_id: string;
      agent_id: string;
      datalake_id: string;
      status: string;
    }>(
      `SELECT id, org_id, agent_id, datalake_id, status
         FROM waddling.agent_session WHERE id = $1`,
      [id],
    );
    if (!sess) return err(c, 'session_not_found', 404);
    // Tenant isolation (works for agent + delegated + user callers — orgId is always
    // resolved). An API-key agent may run ONLY its own session.
    assertOrg(caller, sess.org_id);
    if (caller.agentId && caller.agentId !== sess.agent_id) {
      return err(c, 'forbidden', 403, 'An agent may only query its own session');
    }
    if (sess.status !== 'active') {
      return err(c, 'session_not_active', 409, `Session status is ${sess.status} — reconnect`);
    }

    // Prepaid credit gate, per-query pre-flight. At zero balance, refuse before the query
    // reaches the gateway (402). The locked decision accepts a one-query overshoot: a
    // query already in flight isn't clawed back, and the in-flight session keeps accruing
    // duration until it closes — the connect-time gate bounds the new-session case.
    if (!(await hasCredit(sess.org_id))) {
      return err(
        c,
        'insufficient_credits',
        402,
        'Org credit balance is exhausted — top up credits to continue querying.',
      );
    }

    // Re-resolve the workspace deterministically (idempotent upsert) — the data plane
    // is keyed by (workspaceId, agentId), not the sessionId.
    const ws = await resolveWorkspaceForSession(sess.org_id, sess.datalake_id, sess.agent_id);
    const wsUrl = workspaceGatewayUrl(c.env, ws.workspaceId, sess.agent_id);
    const queryStartedAt = Date.now();
    let r: RelayQueryResult;
    try {
      // Lake READ relayed through the agent's workspace: /relay-query runs on the workspace's trusted
      // connection (which ATTACHed the lake at connect), Form A → Form B for two-table JOINs.
      r = await gatewayClientFor({ gateway_url: wsUrl }).relayQuery(sql);
    } catch (e) {
      // Cold (scaled-to-zero) or unconfigured workspace answers 409 "lake not configured" → the
      // caller must reconnect to re-provision + re-ATTACH. The query never reached the lake, so
      // there is nothing to record.
      if (e instanceof GatewayError && e.status === 409) {
        return c.json(
          {
            error: 'needs_configure',
            reason:
              'Your workspace went cold (the service scaled to zero or lost its lake attach). Call waddling_connect again to re-establish it, then retry the query.',
          },
          409,
        );
      }
      return err(
        c,
        'query_failed',
        502,
        `data plane /relay-query failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const queryDurationMs = Date.now() - queryStartedAt;

    // The query reached the gateway (allowed, denied, or errored at the workspace) →
    // count it + drain birdshot's audit decision(s). Best-effort, AFTER the response
    // (waitUntil) so it never adds latency or fails the query; a denial is the most
    // important audit row, so this runs before the deny/error branches below too.
    let exCtx: { waitUntil(p: Promise<unknown>): void } | undefined;
    try { exCtx = c.executionCtx; } catch { exCtx = undefined; }
    // One stable id for this executed query, minted synchronously (before the
    // best-effort waitUntil work) so it survives a retry. It keys BOTH the usage_event
    // row (idempotent insert) and the per-query floor debit, so a redelivery can't
    // over-count either.
    const queryId = crypto.randomUUID();
    const recording = recordQueryAudit(sess, queryId).catch((e) => {
      console.log(`[sessions] recordQueryAudit failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (exCtx) exCtx.waitUntil(recording);

    // Activation funnel (data plane). Gated on a human behind the session: the delegated
    // caller is the user; otherwise the agent's owner. Owner-less service agents (e.g. the
    // analytics ETL fleet) resolve to null and are skipped — so the pipeline never counts
    // itself. Props are metadata-only (decision / duration_ms / bucketed reason) — never
    // SQL text or rows. Always runs in waitUntil; never affects the query path.
    const fireActivation = async (decision: 'allow' | 'deny', denyReason?: string): Promise<void> => {
      try {
        const human = caller.delegated
          ? caller.callerId
          : (await resolveAgentIdentity(sess.agent_id))?.onBehalfOf ?? null;
        if (!human) return;
        const ph = makePostHog(c.env, exCtx);
        ph.capture({
          distinctId: human,
          event: 'query_executed',
          properties: { decision, duration_ms: queryDurationMs },
          groups: { organization: sess.org_id },
        });
        if (decision === 'deny') {
          ph.capture({
            distinctId: human,
            event: 'denial_hit',
            properties: { reason: denyReason ?? 'table' },
            groups: { organization: sess.org_id },
          });
        }
        // first_query — once per person. Await the audit insert above so THIS query's
        // usage_event row is counted, making "exactly 1" a deterministic first-query test
        // (no race with the concurrent insert). $set_once also keeps the person property
        // idempotent as a backstop.
        await recording.catch(() => {});
        const cnt = await queryOne<{ n: string }>(
          `SELECT count(*)::text AS n FROM waddling.usage_event WHERE agent_id = $1 AND kind = 'query'`,
          [sess.agent_id],
        ).catch(() => null);
        if (cnt && Number(cnt.n) === 1) {
          ph.capture({
            distinctId: human,
            event: 'first_query',
            properties: { $set_once: { first_query_at: new Date().toISOString() } },
            groups: { organization: sess.org_id },
          });
        }
      } catch {
        // activation telemetry must never affect the query path.
      }
    };

    // Per-query floor debit — minor + best-effort (the dominant session-duration charge is
    // billed durably by the sweeper). Keyed by the stable queryId so a retry charges the
    // floor exactly once per query (one floor per executed query, no double on redelivery).
    const flooring = debitQueryFloor(sess.org_id, sess.id, queryId).catch((e) => {
      console.log(`[sessions] query floor debit failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (exCtx) exCtx.waitUntil(flooring);

    // The relay returns ok:false with an error string on a birdshot denial (or a query error).
    // Map an authorization failure to the structured authorization_denied shape the agent surface
    // knows (so mcp-external can show table + reason instead of a raw 500).
    if (r.ok !== true) {
      const msg = String(r.error ?? '');
      if (/authoriz|permission|denied|not allowed/i.test(msg)) {
        if (exCtx) exCtx.waitUntil(fireActivation('deny', classifyDenial(msg)));
        return c.json({ error: 'authorization_denied', reason: msg }, 403);
      }
      return err(c, 'query_failed', 500, msg || 'workspace query failed');
    }

    // /relay-query → { ok, columns, rows:[arrays], rowCount, form }. Map to the QueryResult
    // contract (no truncation — birdshot's column/row enforcement already bounded the result
    // at the lake).
    const result: QueryResult = {
      columns: r.columns ?? [],
      rows: r.rows ?? [],
      rowCount: r.rowCount ?? (r.rows?.length ?? 0),
      truncated: false,
    };
    if (exCtx) exCtx.waitUntil(fireActivation('allow'));
    return ok(c, result);
  }),
);

const EtlSchema = z.object({ sql: z.string().min(1) });

/** POST /:id/etl → a GOVERNED lake WRITE (CTAS / read_source ingest). Unlike /query — which
 *  runs in the sealed, no-egress workspace and federates lake reads through quack — an ETL
 *  statement needs egress AND a durable lake write, neither of which the workspace nor the
 *  gated quack serving path (memory catalog only) can do. It runs on the gateway replica's
 *  TRUSTED connection, but only AFTER birdshot_authorize (the same hook quack uses) allows the
 *  exact statement — denies happen from the parse literal, before any read_source fetch. The
 *  session JWT (minted fresh, same principal) is the lakeToken; the director guarantees the
 *  chosen replica is armed with this agent's snapshot grants. */
sessions.post('/:id/etl', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c, false, true);
    const id = c.req.param('id');
    const { sql } = await parseBody(c, EtlSchema);

    const sess = await queryOne<{
      id: string; org_id: string; agent_id: string; datalake_id: string; status: string;
    }>(
      `SELECT id, org_id, agent_id, datalake_id, status
         FROM waddling.agent_session WHERE id = $1`,
      [id],
    );
    if (!sess) return err(c, 'session_not_found', 404);
    assertOrg(caller, sess.org_id);
    if (caller.agentId && caller.agentId !== sess.agent_id) {
      return err(c, 'forbidden', 403, 'An agent may only run ETL on its own session');
    }
    if (sess.status !== 'active') {
      return err(c, 'session_not_active', 409, `Session status is ${sess.status} — reconnect`);
    }

    // Prepaid credit gate, pre-flight (same contract as /query). ETL also runs egress +
    // a durable lake write, so refuse at zero before any of that work begins.
    if (!(await hasCredit(sess.org_id))) {
      return err(
        c,
        'insufficient_credits',
        402,
        'Org credit balance is exhausted — top up credits to continue running ETL.',
      );
    }

    const identity = await resolveAgentIdentity(sess.agent_id);
    if (!identity) return err(c, 'agent_not_found', 404);
    const lakeToken = await mintLakeToken(c.env, sess.agent_id, sess.datalake_id, identity.mode);
    // Lake WRITE goes DIRECT to the lake gateway's /governed-load — the trusted connection that owns
    // the DuckLake catalog + GCS creds. The workspace holds no lake storage creds and cannot persist a
    // lake write; birdshot authorizes the exact statement at the lake under the agent's lake-JWT.
    const endpoint = await queryOne<{ gateway_url: string | null }>(
      `SELECT gateway_url FROM waddling.datalake WHERE id = $1`,
      [sess.datalake_id],
    );
    let j: GovernedLoadResult;
    try {
      j = await gatewayClientFor({ gateway_url: endpoint?.gateway_url }).governedLoad(lakeToken, sql);
    } catch (e) {
      return err(
        c,
        'etl_failed',
        502,
        `data plane /governed-load failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // Best-effort audit AFTER the response (waitUntil) — never adds latency or fails the call.
    let exCtx: { waitUntil(p: Promise<unknown>): void } | undefined;
    try { exCtx = c.executionCtx; } catch { exCtx = undefined; }
    // Stable per-statement id (see /query) — idempotent usage_event + floor debit.
    const queryId = crypto.randomUUID();
    const recording = recordQueryAudit(sess, queryId).catch((e) => {
      console.log(`[sessions] recordEtlAudit failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (exCtx) exCtx.waitUntil(recording);

    // Per-query floor debit for the ETL statement (best-effort; duration billed by sweeper).
    // Keyed by queryId so a retry charges the floor exactly once.
    const flooring = debitQueryFloor(sess.org_id, sess.id, queryId).catch((e) => {
      console.log(`[sessions] etl floor debit failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (exCtx) exCtx.waitUntil(flooring);

    // /governed-load → { ok, phase, authorizeDecision, error? }.
    if (j.ok !== true) {
      if (j.phase === 'authorize' || j.authorizeDecision === 'deny') {
        return c.json(
          { error: 'authorization_denied', reason: j.error ?? 'not authorized for this statement' },
          403,
        );
      }
      if (j.phase === 'authenticate') {
        return c.json(
          { error: 'needs_connect', reason: 'Session token rejected — call waddling_connect again, then retry.' },
          409,
        );
      }
      return err(c, 'etl_failed', 500, j.error ?? 'governed load failed');
    }
    // Change-tracked catalog refresh: an ETL statement may CREATE/DROP a lake table, so the
    // gateway is warm right now — re-pull + upsert the cached catalog so the authoring picker
    // (and any covering wildcard grant) sees the new shape. Routes a changed catalog through
    // the DURABLE dispatch outbox (enqueue + retry on the cron drain) rather than a direct
    // best-effort push, so a dropped recompile push is retried instead of silently lost.
    // Awaited (not waitUntil) because c.executionCtx is absent on the MCP-loopback path, so
    // waitUntil silently no-ops; ETL is not latency-critical. Internally best-effort (never
    // throws), so it can't fail the ETL response.
    await refreshCatalogAndEnqueue(c, sess.datalake_id, {
      id: sess.datalake_id,
      org_id: sess.org_id,
      status: 'running',
      server_token: '',
      gateway_url: endpoint?.gateway_url ?? null,
    });
    return ok(c, { ok: true, phase: j.phase ?? 'done', authorizeDecision: j.authorizeDecision ?? 'allow' });
  }),
);

export { sessions };
