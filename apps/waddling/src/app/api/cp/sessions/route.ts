/**
 * /api/cp/sessions (W1) — agent session lifecycle (§1 data-flow step 2, §3e).
 *
 * POST  → connect: verify api-key/session, resolve agent+endpoint, compile policy,
 *         push birdshot snapshot + gateway constraints, mint a short-lived RS256
 *         session JWT (jose, kid from better-auth jwks), insert agent_session,
 *         return ConnectResult.
 * DELETE → kill a session: jti denylist on gateway + mark agent_session 'killed'.
 *
 * Session JWT claims (§3a + repo.md birdshot identity mapping):
 *   id  = agent:<agentId>   ← birdshot reads THIS as the principal
 *   sub = agent:<agentId>   ← belt-and-suspenders
 *   iss = JWT_ISSUER, aud = gw:<endpointId>, exp = now+15m, jti = <uuid>
 *   header.kid = jwks row id (matches /api/auth/jwks → birdshot_add_jwk)
 *
 * The quack `sid` is per-connection and unknown at mint time; we use the JWT `jti`
 * as the logical session key (agent_session.sid = jti, jwt_jti = jti).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { importJWK, SignJWT, type JWK } from 'jose';
import { query, queryOne, withTransaction } from '@/lib/db';
import { compilePolicy, grantsForAgent, type AclRuleRow } from '@/lib/policy-compiler';
import {
  resolveAgentIdentity,
  captureAgentEvent,
  CAPABILITY,
} from '@/lib/agent-identity';
import {
  gatewayClientFor,
  type SnapshotRequest,
  type BirdshotJwk,
} from '@/lib/gateway-client';
import { getJwtIssuer } from '@/lib/env';
import type { ConnectResult } from '@/lib/types';
import {
  resolveCaller,
  assertOrg,
  parseBody,
  handle,
  ok,
  err,
  AuthError,
} from '../_shared';

const SESSION_TTL_SECONDS = 15 * 60; // 15m (spec default; max 1h)

// One-key-per-agent runtime policy (agent-auth.md §cardinality). Claude gives the
// server no per-conversation id, so the credential IS the agent instance: a key may
// hold at most one live session.
//  - 'supersede' (default): a new connect kills the agent's prior live session
//    (graceful reconnect; genuine concurrency self-limits as the two thrash).
//  - 'reject': a second concurrent connect is refused (409) — loudest signal that a
//    key is being shared; forces a separate agent/key per instance.
// Either way the agent_session_one_active_per_agent unique index is the hard backstop.
const SESSION_POLICY: 'supersede' | 'reject' =
  process.env.WADDLING_AGENT_SESSION_POLICY === 'reject' ? 'reject' : 'supersede';

// `agentId` lets a dashboard USER caller open a session AS a chosen agent
// (run-as-agent, used by the Notebooks view) so they see exactly what that
// agent's ACL allows. Ignored for agent (API-key) callers — they are always
// themselves. Always org-scoped + audited as an impersonation (actor=caller).
const ConnectSchema = z.object({
  endpointId: z.string().min(1),
  agentId: z.string().optional(),
});
const KillSchema = z.object({ sessionId: z.string().min(1), reason: z.string().optional() });

interface EndpointRow {
  id: string;
  org_id: string;
  status: string;
  gateway_host: string | null;
  quack_port: number | null;
  server_token: string;
}

interface JwksRow {
  id: string;
  publicKey: string;
  privateKey: string;
}

/** Newest non-expired jwks row → { kid, publicJwk, privateJwk }. */
async function loadSigningKey(): Promise<{
  kid: string;
  publicJwk: { n: string; e: string; kty: string };
  privateJwk: JWK;
}> {
  // Better Auth's jwks schema has no expiresAt column (keys are rotated, not
  // TTL'd), so just take the newest key by createdAt.
  const row = await queryOne<JwksRow>(
    `SELECT id, "publicKey", "privateKey" FROM "jwks"
      ORDER BY "createdAt" DESC LIMIT 1`,
  );
  if (!row) {
    throw new AuthError(
      'no_signing_key',
      500,
      'No JWKS key found — Better Auth jwt plugin must mint one first',
    );
  }
  return {
    kid: row.id,
    publicJwk: JSON.parse(row.publicKey),
    privateJwk: JSON.parse(row.privateKey),
  };
}

interface SessionListRow {
  id: string;
  org_id: string;
  agent_id: string;
  endpoint_id: string;
  sid: string;
  status: 'active' | 'expired' | 'revoked' | 'killed';
  granted_roles: string[];
  started_at: string;
  expires_at: string;
}

/** GET → list this org's sessions, optionally filtered by ?status= and ?agentId=. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const u = new URL(req.url);
    const status = u.searchParams.get('status');
    const agentId = u.searchParams.get('agentId');

    const rows = await query<SessionListRow>(
      `SELECT id, org_id, agent_id, endpoint_id, sid, status, granted_roles, started_at, expires_at
         FROM waddling.agent_session
        WHERE org_id = $1
          AND ($2::text IS NULL OR status = $2)
          AND ($3::text IS NULL OR agent_id = $3)
        ORDER BY started_at DESC
        LIMIT 200`,
      [caller.orgId, status, agentId],
    );
    const sessions = rows.rows.map((r) => ({
      id: r.id,
      orgId: r.org_id,
      agentId: r.agent_id,
      endpointId: r.endpoint_id,
      sid: r.sid,
      status: r.status,
      grantedRoles: r.granted_roles,
      startedAt: r.started_at,
      expiresAt: r.expires_at,
    }));
    return ok({ sessions });
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    // allowDelegated=true: this is the one data-plane route OAuth/MCP tokens may use.
    // requireOrg=false: the org is derived from the chosen endpoint below.
    const caller = await resolveCaller(req, false, true);
    const { endpointId, agentId: requestedAgentId } = await parseBody(req, ConnectSchema);

    const endpoint = await queryOne<EndpointRow>(
      `SELECT id, org_id, status, gateway_host, quack_port, server_token
         FROM waddling.endpoint WHERE id = $1`,
      [endpointId],
    );
    if (!endpoint) return err('endpoint_not_found', 404);
    if (endpoint.status !== 'running') {
      return err('endpoint_not_running', 409, `Endpoint status is ${endpoint.status}`);
    }

    // Resolve the acting agent + session origin per caller type:
    //  * API-key agent      → itself; origin='agent' (one-key-per-agent enforced).
    //  * delegated (OAuth)  → provision a per-user delegated agent; origin='delegated'
    //                         (exempt — Claude gives no per-instance id, no key).
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
        return err('forbidden', 403, 'Delegating user is not a member of this endpoint’s org');
      }
      // Idempotent upsert on (org_id, name) — deterministic per user, so concurrent
      // first-connects don't race to insert. No API key (api_key_id stays NULL).
      const prov = await queryOne<{ id: string }>(
        `INSERT INTO waddling.agent (org_id, name, description, mode, status)
         VALUES ($1, $2, $3, 'delegated', 'active')
         ON CONFLICT (org_id, name) DO UPDATE SET last_seen_at = now()
         RETURNING id`,
        [endpoint.org_id, `claude:${caller.callerId}`, `Delegated MCP agent for user ${caller.callerId}`],
      );
      if (!prov) return err('agent_provision_failed', 500);
      agentId = prov.id;
      origin = 'delegated';
    } else {
      assertOrg(caller, endpoint.org_id);
      if (!requestedAgentId) {
        return err(
          'agent_required',
          400,
          'connect requires an agent: an sk_agent_… API key, an OAuth token, or an agentId to run as',
        );
      }
      const target = await queryOne<{ org_id: string }>(
        `SELECT org_id FROM waddling.agent WHERE id = $1`,
        [requestedAgentId],
      );
      if (!target) return err('agent_not_found', 404);
      assertOrg(caller, target.org_id);
      agentId = requestedAgentId;
      origin = 'run-as';
    }

    // Full AAP identity (id, name, mode, on-behalf-of) for the JWT + trace.
    const identity = await resolveAgentIdentity(agentId);
    if (!identity) return err('agent_not_found', 404);
    // Delegating human for THIS action: delegated/run-as → the caller; autonomous →
    // the API-key owner resolved on the identity.
    const onBehalfOf = origin === 'agent' ? identity.onBehalfOf : caller.callerId;

    // One-key-per-agent enforcement (real agent connections only). Find the agent's
    // existing live sessions; reject or supersede per policy. The unique index is the
    // race backstop (concurrent connects → loser gets 23505 → 409 below).
    let toSupersede: { id: string; jwt_jti: string }[] = [];
    if (origin === 'agent') {
      // Scoped to (agent, endpoint): one live session per agent PER endpoint, so an
      // agent may fan out across endpoints but can't share a key on the same one.
      // Reap expired-but-'active' rows first so they neither false-reject nor block
      // the one-active unique index.
      await query(
        `UPDATE waddling.agent_session SET status='expired', ended_at=now()
          WHERE agent_id = $1 AND endpoint_id = $2 AND status = 'active'
            AND origin = 'agent' AND expires_at <= now()`,
        [agentId, endpointId],
      );
      const existing = await query<{ id: string; jwt_jti: string }>(
        `SELECT id, jwt_jti FROM waddling.agent_session
          WHERE agent_id = $1 AND endpoint_id = $2 AND status = 'active' AND origin = 'agent'`,
        [agentId, endpointId],
      );
      if (existing.rows.length > 0 && SESSION_POLICY === 'reject') {
        return err(
          'agent_session_in_use',
          409,
          'This agent already has an active session. One key per agent — create a separate agent for a second concurrent instance.',
        );
      }
      toSupersede = existing.rows;
    }

    // Compile active rules for this (endpoint, agent).
    const now = new Date();
    const ruleRows = await query<AclRuleRow>(
      `SELECT * FROM waddling.acl_rule
        WHERE endpoint_id = $1 AND (agent_id = $2 OR agent_id IS NULL)`,
      [endpointId, agentId],
    );
    const compiled = compilePolicy(ruleRows.rows, now);
    const granted = grantsForAgent(compiled, agentId);
    if (granted.tables.length === 0) {
      return err(
        'no_grants',
        403,
        'Agent has no active ACL rules for this endpoint',
      );
    }

    // Push the birdshot policy snapshot to the gateway control channel. Column +
    // window ACLs ride INSIDE the snapshot (`roleConstraints`) and are enforced by
    // birdshot's bind-walk — there is no separate constraint push anymore.
    const { kid, publicJwk, privateJwk } = await loadSigningKey();
    const gw = gatewayClientFor(endpoint);
    const jwks: BirdshotJwk[] = [{ kid, n: publicJwk.n, e: publicJwk.e }];
    const snapshotReq: SnapshotRequest = {
      endpointId,
      auth: {
        issuer: getJwtIssuer(),
        audience: `gw:${endpointId}`,
        mode: 'rs256',
        jwks,
      },
      snapshot: compiled.snapshot,
    };
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
      .setIssuer(getJwtIssuer())
      .setAudience(`gw:${endpointId}`)
      .setIssuedAt()
      .setJti(jti)
      .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
      .sign(key);

    const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
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
             (org_id, agent_id, endpoint_id, sid, jwt_jti, status, granted_roles, origin, ip, user_agent, expires_at)
           VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10)
           RETURNING id`,
          [
            endpoint.org_id,
            agentId,
            endpointId,
            jti, // sid = jti (quack sid unknown until ATTACH)
            jti,
            grantedRoles,
            origin,
            req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
            req.headers.get('user-agent') || null,
            expiresAt.toISOString(),
          ],
        );
        return r.rows[0] ?? null;
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        return err(
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
          await gw.revoke({
            endpointId,
            kind: 'jti',
            id: s.jwt_jti,
            reason: 'superseded by new connect (one-key-per-agent)',
          });
        } catch {
          // gateway may be down; the session is already marked superseded.
        }
        await query(
          `INSERT INTO waddling.audit_event
             (org_id, source, event, agent_id, session_id, endpoint_id, decision, reason, actor, agent_mode, on_behalf_of, capability)
           VALUES ($1,'control-plane','revoke',$2,$3,$4,'deny',$5,$6,$7,$8,$9)`,
          [
            endpoint.org_id, agentId, s.id, endpointId,
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
        endpointId,
        extra: { superseded_count: toSupersede.length },
      });
    }

    const host = endpoint.gateway_host ?? 'localhost';
    const port = endpoint.quack_port ?? 9500;
    const quackUri = `quack:${host}:${port}`;
    // quack ATTACH does NOT accept inline TOKEN/DISABLE_SSL — use CREATE SECRET.
    // The catalog alias 'lake' shadows the server's default catalog (same name);
    // query through lake.query('...') with full server-side paths (lake.sales.orders).
    const attachSql = [
      `CREATE SECRET (TYPE quack, TOKEN '${sessionJwt}', SCOPE '${quackUri}');`,
      `ATTACH '${quackUri}' AS lake (disable_ssl true);`,
      `-- query via: FROM lake.query('FROM lake.sales.orders LIMIT 5')`,
    ].join('\n');

    // Audit + last-seen + trace — AAP identity (mode, on-behalf-of, capability)
    // stamped on the event so a single agent is legible vs others under the same user.
    await query(
      `INSERT INTO waddling.audit_event
         (org_id, source, event, agent_id, session_id, endpoint_id, decision, actor, agent_mode, on_behalf_of, capability)
       VALUES ($1,'control-plane','attach',$2,$3,$4,'allow',$5,$6,$7,$8)`,
      [
        endpoint.org_id, agentId, inserted?.id ?? null, endpointId, caller.callerId,
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
      endpointId,
      // ACL/grant detail kept separate from capability (different layer).
      extra: { granted_tables: granted.tables.length, origin },
    });

    const body: ConnectResult = {
      sessionId: inserted?.id ?? jti,
      attachSql,
      sessionJwt,
      endpoint: { host, port },
      ttlSeconds: SESSION_TTL_SECONDS,
      granted,
    };
    return ok(body, 201);
  });
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const { sessionId, reason } = await parseBody(req, KillSchema);

    const sess = await queryOne<{
      id: string;
      org_id: string;
      endpoint_id: string;
      jwt_jti: string;
      agent_id: string;
    }>(
      `SELECT id, org_id, endpoint_id, jwt_jti, agent_id
         FROM waddling.agent_session WHERE id = $1`,
      [sessionId],
    );
    if (!sess) return err('session_not_found', 404);
    assertOrg(caller, sess.org_id);

    const endpoint = await queryOne<EndpointRow>(
      `SELECT id, org_id, status, gateway_host, quack_port, server_token
         FROM waddling.endpoint WHERE id = $1`,
      [sess.endpoint_id],
    );
    if (endpoint) {
      try {
        await gatewayClientFor(endpoint).revoke({
          endpointId: endpoint.id,
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
      `INSERT INTO waddling.audit_event (org_id, source, event, agent_id, session_id, endpoint_id, decision, reason, actor)
       VALUES ($1,'control-plane','kill',$2,$3,$4,'deny',$5,$6)`,
      [sess.org_id, sess.agent_id, sessionId, sess.endpoint_id, reason ?? null, caller.callerId],
    );

    return ok({ success: true, affectedSessions: 1 });
  });
}
