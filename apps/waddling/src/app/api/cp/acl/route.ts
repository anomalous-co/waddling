/**
 * /api/cp/acl (W1) — ACL rule CRUD that triggers policy recompile (§3e, §6).
 *
 * GET  → list rules for the caller's org (optionally ?endpointId=&agentId=).
 * POST → create a rule (gated by requirePlan(org,'pro') → 402 upgrade_required),
 *        then recompile the affected (endpoint, agent) policy and push both the
 *        birdshot snapshot and the gateway constraint table.
 *
 * ttl_seconds is resolved to an absolute expires_at at insert time so the compiler
 * only ever reasons over absolute timestamps.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne } from '@/lib/db';
import { requirePlan, UpgradeRequiredError } from '@/lib/entitlements';
import { getPostHogServer } from '@/lib/posthog-server';
import { recompileAndPush } from './recompile';
import {
  resolveCaller,
  assertOrg,
  parseBody,
  handle,
  ok,
  err,
} from '../_shared';

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

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const url = new URL(req.url);
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
    return ok({ rules: rows.rows.map(mapRule) });
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const input = await parseBody(req, AclRuleSchema);

    // Free tier may not create dynamic ACL rules.
    // Emit upgrade_viewed before throwing so the funnel records the wall hit.
    try {
      await requirePlan(caller.orgId, 'pro');
    } catch (e) {
      if (e instanceof UpgradeRequiredError) {
        getPostHogServer().capture({
          distinctId: caller.callerId,
          event: 'upgrade_viewed',
          properties: { required_plan: e.required, current_plan: e.current, surface: 'acl_create' },
          groups: { organization: caller.orgId },
        });
      }
      throw e;
    }

    // Tenant-isolate the endpoint (and agent, if present).
    const endpoint = await queryOne<{ org_id: string }>(
      `SELECT org_id FROM waddling.endpoint WHERE id = $1`,
      [input.endpointId],
    );
    if (!endpoint) return err('endpoint_not_found', 404);
    assertOrg(caller, endpoint.org_id);

    if (input.agentId) {
      const agent = await queryOne<{ org_id: string }>(
        `SELECT org_id FROM waddling.agent WHERE id = $1`,
        [input.agentId],
      );
      if (!agent) return err('agent_not_found', 404);
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

    const compiled = await recompileAndPush(input.endpointId, input.agentId);

    await query(
      `INSERT INTO waddling.audit_event (org_id, source, event, agent_id, endpoint_id, decision, actor)
       VALUES ($1,'control-plane','grant',$2,$3,'allow',$4)`,
      [caller.orgId, input.agentId ?? null, input.endpointId, caller.callerId],
    );

    return ok(
      {
        rule: created ? mapRule(created) : null,
        ruleId: created?.id,
        compiledGrants: compiled.snapshot,
      },
      201,
    );
  });
}
