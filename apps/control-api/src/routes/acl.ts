/**
 * /api/cp/acl — Hono port of apps/waddling/src/app/api/cp/acl/route.ts +
 * acl/[id]/route.ts (§3e, §6). ACL rule CRUD that triggers a policy recompile.
 *
 * GET  /        → list rules for the caller's org (optionally ?endpointId=&agentId=).
 * POST /        → create a rule (gated by requirePlan(org,'pro') → 402 upgrade_required),
 *                 then recompile the affected (endpoint, agent) policy and push the
 *                 birdshot snapshot to the gateway control channel.
 * GET  /:id     → single rule (org-scoped).
 * DELETE /:id   → delete a rule, recompile, audit the revoke.
 *
 * The DB-side ACL persistence is fully live. The gateway snapshot push is e2e-gated
 * on Stage D (see recompileAndPush) — best-effort, so a rule is persisted even when
 * the gateway is unreachable; the next connect/recompile re-pushes.
 *
 * ttl_seconds is resolved to an absolute expires_at at insert time so the compiler
 * only ever reasons over absolute timestamps.
 *
 * PostHog (upgrade_viewed) is neutered: posthog-node does not bundle/run on workerd
 * (mirrors lib/agent-identity's guarded no-op). Real server-side analytics is a
 * later stage; the upgrade-wall throw still propagates unchanged.
 */
import { z } from 'zod';
import { Hono } from 'hono';
import { query, queryOne } from '../lib/db';
import type { Env } from '../lib/env';
import { requirePlan, UpgradeRequiredError } from '../lib/entitlements';
import {
  compilePolicy,
  type AclRuleRow,
  type CompileResult,
} from '../lib/policy-compiler';
import {
  gatewayClientFor,
  type SnapshotRequest,
  type BirdshotJwk,
} from '../lib/gateway-client';
import { resolveGatewayBoot } from '../lib/gateway-boot';
import { resolveCaller, assertOrg, parseBody, handle, ok, err } from '../lib/cp-shared';

// ── recompile + push helper (ported from acl/recompile.ts) ───────────────────────
// Shared by the POST and DELETE handlers below. Reads the endpoint's signing key +
// all active rules for the endpoint (optionally scoped to one agent), runs the pure
// compiler, and pushes the birdshot snapshot to the gateway. Column/window ACLs ride
// inside that snapshot (`roleConstraints`, enforced by birdshot's bind-walk).

interface RecompileEndpointRow {
  id: string;
  org_id: string;
  status: string;
  gateway_host: string | null;
  quack_port: number | null;
  server_token: string;
}

/** Newest non-expired jwks row → birdshot public JWK (kid/n/e), or null. */
async function loadJwk(): Promise<BirdshotJwk | null> {
  const row = await queryOne<{ id: string; publicKey: string }>(
    `SELECT id, "publicKey" FROM "jwks"
      WHERE "expiresAt" IS NULL OR "expiresAt" > now()
      ORDER BY "createdAt" DESC LIMIT 1`,
  ).catch(() => null);
  if (!row) return null;
  const pub = JSON.parse(row.publicKey) as { n: string; e: string };
  return { kid: row.id, n: pub.n, e: pub.e };
}

/**
 * Recompile the endpoint's FULL policy (every agent) and push it.
 *
 * The push is ALWAYS the whole endpoint — never a single agent's slice. The GatewayDO
 * is shared per endpoint (`gw:<endpointId>`) and applySnapshot does a full
 * birdshot_reset_config → re-add → commit, so pushing one agent's compiled snapshot
 * would WIPE every other agent's grants on the shared gateway. `agentId` is accepted
 * (call-site compatibility / audit) but does NOT narrow the push.
 *
 * Best-effort push: if the gateway is unreachable the rule is still persisted; the
 * next connect/recompile re-pushes. Returns the (full) compile result for the caller.
 */
async function recompileAndPush(
  c: { env: Env },
  endpointId: string,
  _agentId?: string,
): Promise<CompileResult> {
  const endpoint = await queryOne<RecompileEndpointRow>(
    `SELECT id, org_id, status, gateway_host, quack_port, server_token
       FROM waddling.endpoint WHERE id = $1`,
    [endpointId],
  );

  const rows = await query<AclRuleRow>(
    `SELECT * FROM waddling.acl_rule WHERE endpoint_id = $1`,
    [endpointId],
  );

  const compiled = compilePolicy(rows.rows, new Date());

  if (endpoint && endpoint.status === 'running') {
    const jwk = await loadJwk();
    const gw = gatewayClientFor(endpoint);
    try {
      // Carry the endpoint's real lake boot config + birdshot catalog so that if THIS
      // push is the one that cold-boots the gateway, it ATTACHes the real DuckLake (not
      // the demo). resolveGatewayBoot may report the managed catalog still provisioning;
      // skip the push then (the rule is persisted; connect/recompile re-pushes later).
      const boot = await resolveGatewayBoot(endpointId);
      const snapshotReq: SnapshotRequest = {
        endpointId,
        auth: {
          issuer: c.env.JWT_ISSUER,
          audience: `gw:${endpointId}`,
          mode: 'rs256',
          jwks: jwk ? [jwk] : [],
        },
        snapshot: compiled.snapshot,
        lakeCatalog: boot.lakeCatalog,
        gatewayBoot: boot.gatewayBoot,
      };
      // Best-effort: pushes over the DATAPLANE binding to the per-endpoint GatewayDO.
      // Column + window ACLs ride inside the snapshot (`roleConstraints`); there is no
      // separate constraint push. A failure leaves the rule persisted for the next
      // connect/recompile to re-push.
      await gw.pushSnapshot(snapshotReq);
    } catch {
      // gateway down / catalog provisioning — persisted rule re-pushes on next connect/recompile
    }
  }

  return compiled;
}

// ── Routes ───────────────────────────────────────────────────────────────────────

interface AclRuleDbRow {
  id: string;
  endpoint_id: string;
  agent_id: string | null;
  schema_name: string;
  table_name: string;
  columns: string[] | null;
  verb: 'read' | 'write';
  effect: 'allow' | 'deny';
  row_limit: number | null;
  ttl_seconds: number | null;
  window_start: string | null;
  window_end: string | null;
  expires_at: string | null;
  priority: number;
  created_at: string;
}

/** Map a waddling.acl_rule DB row to the dashboard's camelCase AclRuleRow. */
function mapRule(r: AclRuleDbRow) {
  return {
    id: r.id,
    endpointId: r.endpoint_id,
    agentId: r.agent_id ?? undefined,
    schemaName: r.schema_name,
    tableName: r.table_name,
    columns: r.columns ?? undefined,
    verb: r.verb,
    effect: r.effect,
    rowLimit: r.row_limit ?? undefined,
    ttlSeconds: r.ttl_seconds ?? undefined,
    windowStart: r.window_start ?? undefined,
    windowEnd: r.window_end ?? undefined,
    expiresAt: r.expires_at ?? undefined,
    priority: r.priority,
    createdAt: r.created_at,
  };
}

const AclRuleSchema = z.object({
  endpointId: z.string().min(1),
  agentId: z.string().optional(),
  schema: z.string().default('*'),
  table: z.string().default('*'),
  columns: z.array(z.string()).optional(),
  verb: z.enum(['read', 'write']),
  effect: z.enum(['allow', 'deny']).default('allow'),
  rowLimit: z.number().int().positive().optional(),
  ttlSeconds: z.number().int().positive().optional(),
  window: z.object({ start: z.string(), end: z.string() }).optional(),
  notBefore: z.string().optional(),
  expiresAt: z.string().optional(),
});

interface RuleRow {
  id: string;
  org_id: string;
  endpoint_id: string;
  agent_id: string | null;
}

const acl = new Hono<{ Bindings: Env }>();

acl.get('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const url = new URL(c.req.url);
    const endpointId = url.searchParams.get('endpointId');
    const agentId = url.searchParams.get('agentId');

    const rows = await query<AclRuleDbRow>(
      `SELECT * FROM waddling.acl_rule
        WHERE org_id = $1
          AND ($2::text IS NULL OR endpoint_id = $2)
          AND ($3::text IS NULL OR agent_id = $3)
        ORDER BY priority ASC, created_at DESC`,
      [caller.orgId, endpointId, agentId],
    );
    return ok(c, { rules: rows.rows.map(mapRule) });
  }),
);

acl.post('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const input = await parseBody(c, AclRuleSchema);

    // Free tier may not create dynamic ACL rules. The original emitted an
    // upgrade_viewed PostHog event before re-throwing; that funnel hook is a
    // neutered no-op on workerd (posthog-node does not bundle/run here), so the
    // UpgradeRequiredError simply propagates to handle() → 402 upgrade_required.
    try {
      await requirePlan(caller.orgId, 'pro');
    } catch (e) {
      if (e instanceof UpgradeRequiredError) {
        // analytics deferred on workerd — no upgrade_viewed event emitted.
      }
      throw e;
    }

    // Tenant-isolate the endpoint (and agent, if present).
    const endpoint = await queryOne<{ org_id: string }>(
      `SELECT org_id FROM waddling.endpoint WHERE id = $1`,
      [input.endpointId],
    );
    if (!endpoint) return err(c, 'endpoint_not_found', 404);
    assertOrg(caller, endpoint.org_id);

    if (input.agentId) {
      const agent = await queryOne<{ org_id: string }>(
        `SELECT org_id FROM waddling.agent WHERE id = $1`,
        [input.agentId],
      );
      if (!agent) return err(c, 'agent_not_found', 404);
      assertOrg(caller, agent.org_id);
    }

    // Resolve ttl_seconds → absolute expires_at (prefer explicit expiresAt).
    let expiresAt: string | null = input.expiresAt ?? null;
    if (!expiresAt && input.ttlSeconds) {
      expiresAt = new Date(Date.now() + input.ttlSeconds * 1000).toISOString();
    }

    const created = await queryOne<AclRuleDbRow>(
      `INSERT INTO waddling.acl_rule
         (org_id, endpoint_id, agent_id, schema_name, table_name, columns, verb, effect,
          row_limit, ttl_seconds, window_start, window_end, not_before, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        caller.orgId,
        input.endpointId,
        input.agentId ?? null,
        input.schema,
        input.table,
        input.columns ?? null,
        input.verb,
        input.effect,
        input.rowLimit ?? null,
        input.ttlSeconds ?? null,
        input.window?.start ?? null,
        input.window?.end ?? null,
        input.notBefore ?? null,
        expiresAt,
        caller.callerId,
      ],
    );

    const compiled = await recompileAndPush(c, input.endpointId, input.agentId);

    await query(
      `INSERT INTO waddling.audit_event (org_id, source, event, agent_id, endpoint_id, decision, actor)
       VALUES ($1,'control-plane','grant',$2,$3,'allow',$4)`,
      [caller.orgId, input.agentId ?? null, input.endpointId, caller.callerId],
    );

    return ok(
      c,
      {
        rule: created ? mapRule(created) : null,
        ruleId: created?.id,
        compiledGrants: compiled.snapshot,
      },
      201,
    );
  }),
);

acl.get('/:id', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    const rule = await queryOne<RuleRow & Record<string, unknown>>(
      `SELECT * FROM waddling.acl_rule WHERE id = $1`,
      [id],
    );
    if (!rule) return err(c, 'rule_not_found', 404);
    assertOrg(caller, rule.org_id as string);
    return ok(c, { rule });
  }),
);

acl.delete('/:id', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    const rule = await queryOne<RuleRow>(
      `SELECT id, org_id, endpoint_id, agent_id FROM waddling.acl_rule WHERE id = $1`,
      [id],
    );
    if (!rule) return err(c, 'rule_not_found', 404);
    assertOrg(caller, rule.org_id);

    await query(`DELETE FROM waddling.acl_rule WHERE id = $1`, [id]);
    const compiled = await recompileAndPush(c, rule.endpoint_id, rule.agent_id ?? undefined);

    await query(
      `INSERT INTO waddling.audit_event (org_id, source, event, agent_id, endpoint_id, decision, actor)
       VALUES ($1,'control-plane','revoke',$2,$3,'deny',$4)`,
      [rule.org_id, rule.agent_id, rule.endpoint_id, caller.callerId],
    );

    return ok(c, { success: true, ruleId: id, compiledGrants: compiled.snapshot });
  }),
);

export { acl };
