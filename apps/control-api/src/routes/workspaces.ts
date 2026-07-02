/**
 * /api/cp/workspaces — workspace lifecycle admin endpoints (Step 2 of the gateway-
 * lifecycle plan). These are the recovery levers for a workspace whose DuckDB got
 * locked or whose container hibernated, so a normal reconnect can't restore it.
 *
 * GET  /                          → list this org's workspaces (+ live session counts).
 * POST /:wsId/agents/:agentId/destroy     → dataplane POST /end (destroy the container +
 *                                            its session), so the next connect bootstraps
 *                                            a FRESH workspace file. Recovers the
 *                                            `lock_configuration has been locked` deadlock.
 * POST /:wsId/agents/:agentId/reconfigure → dataplane POST /configure with
 *                                            `lockConfiguration:false` + a freshly-minted
 *                                            lakeToken, so a SURVIVING container can be
 *                                            re-ATTACHed without destroying it.
 *
 * Tenant isolation: the route resolves the (workspace, agent) → (org, datalake) from the
 * DB and asserts both belong to the caller's org before touching the data plane. An agent
 * API-key caller may only operate on its own (workspace, agent) pair (like the query
 * route's caller.agentId !== sess.agent_id guard); dashboard users may operate on any
 * workspace in their org.
 *
 * These are NOT in the agent-facing MCP surface — they are admin/ops recovery tools,
 * surfaced via the Internal MCP server (Step 6) and the dashboard (Step 8).
 */
import { z } from 'zod';
import { Hono } from 'hono';
import { query, queryOne } from '../lib/db';
import type { Env } from '../lib/env';
import { resolveCaller, assertOrg, handle, ok, err, AuthError } from '../lib/cp-shared';
import { resolveAgentIdentity } from '../lib/agent-identity';
import { mintLakeToken, loadSigningKey } from '../lib/session-jwt';
import { gatewayClientFor } from '../lib/gateway-client';
import { workspaceGatewayUrl } from '../lib/provisioner';
import { resolveGatewayBoot, CatalogNotReadyError, StorageNotReadyError } from '../lib/gateway-boot';
import type { SnapshotRequest, BirdshotJwk } from '../lib/gateway-client';
import { compileEndpointPolicy } from '../lib/effective-policy';

const workspaces = new Hono<{ Bindings: Env }>();

interface WsOwnershipRow {
  ws_org_id: string;
  ws_datalake_id: string;
  ws_name: string;
  agent_org_id: string;
  agent_id: string;
  agent_name: string | null;
}

/**
 * Resolve + tenant-isolate a (workspace, agent) pair to its (org, datalake). Returns null
 * (→ 404, never 403, to avoid leaking ids across orgs) if either side is missing or
 * belongs to another org. A single query joins workspace → datalake → org and
 * workspace_agent → agent → org, so both halves are checked atomically.
 */
async function loadOwnedPair(
  workspaceId: string,
  agentId: string,
): Promise<WsOwnershipRow | null> {
  return queryOne<WsOwnershipRow>(
    `SELECT w.org_id AS ws_org_id, w.datalake_id AS ws_datalake_id, w.name AS ws_name,
            a.org_id AS agent_org_id, wa.agent_id AS agent_id, a.name AS agent_name
       FROM waddling.workspace w
       JOIN waddling.workspace_agent wa ON wa.workspace_id = w.id
       JOIN waddling.agent a             ON a.id = wa.agent_id
      WHERE w.id = $1 AND wa.agent_id = $2`,
    [workspaceId, agentId],
  );
}

/** GET / → list this org's workspaces with live-session counts + datalake name. */
workspaces.get('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const rows = await query<{
      workspace_id: string;
      workspace_name: string;
      datalake_id: string;
      datalake_name: string;
      agent_id: string;
      agent_name: string | null;
      active_sessions: string;
      last_session_at: string | null;
    }>(
      `SELECT w.id AS workspace_id, w.name AS workspace_name,
              d.id AS datalake_id, d.name AS datalake_name,
              wa.agent_id AS agent_id, a.name AS agent_name,
              COALESCE(ss.active_sessions, '0') AS active_sessions,
              ss.last_session_at
         FROM waddling.workspace w
         JOIN waddling.datalake d        ON d.id = w.datalake_id
         JOIN waddling.workspace_agent wa ON wa.workspace_id = w.id
         JOIN waddling.agent a           ON a.id = wa.agent_id
    LEFT JOIN (SELECT agent_id, datalake_id,
                      count(*)::text AS active_sessions,
                      max(started_at) AS last_session_at
                 FROM waddling.agent_session
                WHERE status = 'active'
                GROUP BY agent_id, datalake_id) ss
              ON ss.agent_id = wa.agent_id AND ss.datalake_id = w.datalake_id
        WHERE w.org_id = $1
        ORDER BY w.created_at DESC, wa.created_at DESC`,
      [caller.orgId],
    );
    return ok(c, {
      workspaces: rows.rows.map((r) => ({
        workspaceId: r.workspace_id,
        workspaceName: r.workspace_name,
        datalakeId: r.datalake_id,
        datalakeName: r.datalake_name,
        agentId: r.agent_id,
        agentName: r.agent_name ?? undefined,
        activeSessions: Number(r.active_sessions),
        lastSessionAt: r.last_session_at,
      })),
    });
  }),
);

/**
 * POST /:wsId/agents/:agentId/destroy — destroy the workspace container + its session.
 * The dataplane's /end shuts the sidecar down and frees the container slot; the R2 object
 * is LEFT in place (the next connect restores it). For a hard reset — discard the locked
 * DuckDB file too — pass `purge:true`, which deletes the R2 object so the next connect
 * bootstraps a fresh workspace DB. This is the recovery lever for the
 * `lock_configuration has been locked` deadlock: purge + reconnect = clean slate.
 *
 * Also kills any ACTIVE agent_session rows for the pair (control-plane side) so the
 * dashboard stops showing a live session on a destroyed workspace.
 */
const DestroySchema = z.object({
  purge: z.boolean().default(false),
  reason: z.string().optional(),
});

workspaces.post('/:wsId/agents/:agentId/destroy', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const workspaceId = c.req.param('wsId');
    const agentId = c.req.param('agentId');
    const { purge, reason } = await parseBodySafe(c, DestroySchema);

    const pair = await loadOwnedPair(workspaceId, agentId);
    if (!pair) return err(c, 'workspace_not_found', 404);
    assertOrg(caller, pair.ws_org_id);
    // An agent API-key caller may only destroy its OWN workspace.
    if (caller.agentId && caller.agentId !== agentId) {
      return err(c, 'forbidden', 403, 'An agent may only destroy its own workspace');
    }

    // Flush the workspace's encrypted .duckdb to GCS, then let Cloud Run idle it out (scale to
    // zero) — never hard-destroy the service. Best-effort: a cold/hibernated or not-yet-provisioned
    // service just means there is nothing to flush.
    let shutdown: any = null;
    try {
      const wsUrl = workspaceGatewayUrl(c.env, workspaceId, agentId);
      shutdown = await gatewayClientFor({ gateway_url: wsUrl }).checkpointWorkspace();
    } catch {
      /* container already reclaimed / not yet provisioned — nothing to flush */
    }

    // Kill any active sessions on this (agent, datalake) so the dashboard reflects reality.
    const killed = await queryOne<{ n: string }>(
      `WITH k AS (
         UPDATE waddling.agent_session SET status='killed', ended_at=now()
          WHERE agent_id = $1 AND datalake_id = $2 AND status='active'
          RETURNING id
       )
       SELECT count(*)::text AS n FROM k`,
      [agentId, pair.ws_datalake_id],
    );
    if (Number(killed?.n ?? 0) > 0) {
      await query(
        `INSERT INTO waddling.audit_event (org_id, source, event, agent_id, datalake_id, decision, reason, actor)
         VALUES ($1,'control-plane','workspace_destroy',$2,$3,'deny',$4,$5)`,
        [pair.ws_org_id, agentId, pair.ws_datalake_id,
         `destroyed workspace ${workspaceId}: ${reason ?? 'admin recovery'} (killed ${killed!.n} session)`,
         caller.callerId],
      );
    }

    // purge: delete the R2 workspace object so the next connect bootstraps fresh.
    let purged = false;
    if (purge) {
      try {
        purged = await purgeWorkspaceObject(c.env, workspaceId, agentId);
      } catch {
        /* best-effort — the destroy still succeeded */
      }
    }

    return ok(c, { ok: true, workspaceId, agentId, shutdown, purged, killedSessions: Number(killed?.n ?? 0) });
  }),
);

/**
 * POST /:wsId/agents/:agentId/reconfigure — re-ATTACH the lake into a SURVIVING
 * workspace container WITHOUT destroying it. Reuses the connect flow's snapshot push
 * (so the gateway is armed with the current policy) + dataplane /configure with
 * `lockConfiguration:false`, so the sidecar's /init does not trip the
 * "Cannot change configuration option lock_configuration - the configuration has been
 * locked" error that a plain reconnect hits on a locked DB.
 *
 * This is the lighter-weight recovery than destroy: it keeps the workspace file + any
 * in-memory state, only re-establishing the quack ATTACH with a fresh session JWT. Use
 * destroy when the DuckDB file itself is corrupt/locked at the SQL layer.
 */
workspaces.post('/:wsId/agents/:agentId/reconfigure', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const workspaceId = c.req.param('wsId');
    const agentId = c.req.param('agentId');

    const pair = await loadOwnedPair(workspaceId, agentId);
    if (!pair) return err(c, 'workspace_not_found', 404);
    assertOrg(caller, pair.ws_org_id);
    if (caller.agentId && caller.agentId !== agentId) {
      return err(c, 'forbidden', 403, 'An agent may only reconfigure its own workspace');
    }

    const datalakeId = pair.ws_datalake_id;

    // Re-push the endpoint's FULL birdshot snapshot (the gateway may have slept and lost
    // its in-memory policy; a reconfigure without this would ATTACH with a JWT the gateway
    // can't verify → "Authentication failed"). Mirrors the connect path's push leg.
    const endpoint = await queryOne<{ id: string; org_id: string; slug: string; status: string; server_token: string }>(
      `SELECT id, org_id, slug, status, server_token FROM waddling.datalake WHERE id = $1`,
      [datalakeId],
    );
    if (!endpoint) return err(c, 'endpoint_not_found', 404);
    if (endpoint.status !== 'running') {
      return err(c, 'endpoint_not_running', 409, `Endpoint status is ${endpoint.status}`);
    }

    const compiled = await compileEndpointPolicy(datalakeId, new Date());
    const { kid, publicJwk } = await loadSigningKey();
    const jwks: BirdshotJwk[] = [{ kid, n: publicJwk.n, e: publicJwk.e }];
    let boot;
    try {
      boot = await resolveGatewayBoot(c.env, datalakeId);
    } catch (e) {
      if (e instanceof CatalogNotReadyError) return err(c, 'catalog_provisioning', 503, e.message);
      if (e instanceof StorageNotReadyError) return err(c, 'storage_unavailable', 503, e.message);
      throw e;
    }
    const snapshotReq: SnapshotRequest = {
      datalakeId,
      auth: { issuer: c.env.JWT_ISSUER, audience: `gw:${datalakeId}`, mode: 'rs256', jwks },
      snapshot: compiled.snapshot,
      lakeCatalog: boot.lakeCatalog,
      gatewayBoot: boot.gatewayBoot,
    };
    await gatewayClientFor(endpoint).pushSnapshot(snapshotReq);

    // Mint a fresh lakeToken (the connect JWT is never stored in plaintext), then re-ATTACH the lake
    // into the surviving workspace via /ctrl/configure-lake (idempotent: it DETACHes + re-ATTACHes).
    const identity = await resolveAgentIdentity(agentId);
    if (!identity) return err(c, 'agent_not_found', 404);
    const lakeToken = await mintLakeToken(c.env, agentId, datalakeId, identity.mode);

    const routerSuffix = c.env.ROUTER_HOST_SUFFIX || 'getwaddling.com';
    const wsUrl = workspaceGatewayUrl(c.env, workspaceId, agentId);
    let cfg: { ok: boolean; lakeAttached?: boolean; error?: string };
    try {
      cfg = await gatewayClientFor({ gateway_url: wsUrl }).configureLake({
        lakeProxy: `gw-${endpoint.slug}.${routerSuffix}:443`,
        lakeToken,
        disableSsl: false,
      });
    } catch (e) {
      return err(c, 'workspace_reconfigure_failed', 502,
        `data plane /ctrl/configure-lake failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (cfg?.ok !== true) {
      return err(c, 'workspace_reconfigure_failed', 502,
        `workspace re-attach did not succeed: ${JSON.stringify(cfg)}`);
    }

    await query(
      `INSERT INTO waddling.audit_event (org_id, source, event, agent_id, datalake_id, decision, actor)
       VALUES ($1,'control-plane','workspace_reconfigure',$2,$3,'allow',$4)`,
      [pair.ws_org_id, agentId, datalakeId, caller.callerId],
    );

    return ok(c, {
      ok: true,
      workspaceId,
      agentId,
      lakeAttached: cfg.lakeAttached === true,
      lockConfiguration: false,
    });
  }),
);

// ── helpers ─────────────────────────────────────────────────────────────────────

/** parseBody that tolerates an empty body (destroy needs no body by default). */
async function parseBodySafe<S extends z.ZodTypeAny>(c: Parameters<typeof handle>[0], schema: S): Promise<z.infer<S>> {
  let raw: unknown = {};
  try { raw = await c.req.json(); } catch { /* empty body → defaults */ }
  const r = schema.safeParse(raw);
  if (!r.success) throw new AuthError('validation_failed', 400, r.error.message);
  return r.data;
}

/** Delete the workspace's R2 object so the next connect bootstraps a fresh DuckDB.
 *  Uses the dataplane's R2 creds via a presigned DELETE (aws4fetch). Best-effort. */
async function purgeWorkspaceObject(env: Env, workspaceId: string, agentId: string): Promise<boolean> {
  const { AwsClient } = await import('aws4fetch');
  const accessKeyId = await env.R2_ACCESS_KEY_ID.get();
  const secretAccessKey = await env.R2_SECRET_ACCESS_KEY.get();
  const client = new AwsClient({ accessKeyId, secretAccessKey, region: env.R2_REGION, service: 's3' });
  const key = `workspace/${workspaceId}/db/${agentId}.duckdb`;
  const url = `${env.R2_ENDPOINT}/${env.R2_BUCKET}/${key}`;
  const res = await client.fetch(url, { method: 'DELETE' });
  // 204 = deleted; 404 = already gone. Both are success for a purge.
  return res.status === 204 || res.status === 404;
}

export { workspaces };
