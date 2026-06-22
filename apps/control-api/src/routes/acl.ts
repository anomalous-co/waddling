/**
 * /api/cp/acl — Hono port of apps/waddling/src/app/api/cp/acl/route.ts +
 * acl/[id]/route.ts (§3e, §6). ACL rule CRUD that triggers a policy recompile.
 *
 * GET  /        → list rules for the caller's org (optionally ?datalakeId=&agentId=
 *                 &subjectKind=&userId=).
 * POST /        → create a rule. When subjectKind='user', requires the caller to be
 *                 an org owner or admin. Recompiles the affected endpoint policy and
 *                 pushes the birdshot snapshot to the gateway control channel.
 * GET  /:id     → single rule (org-scoped).
 * DELETE /:id   → delete a rule, recompile, audit the revoke.
 *
 * The DB-side ACL persistence is fully live. The gateway snapshot push is e2e-gated
 * on Stage D (see recompileAndPush in lib/gateway-push) — best-effort, so a rule is
 * persisted even when the gateway is unreachable; the next connect/recompile re-pushes.
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
import { recompileAndPush } from '../lib/gateway-push';
import { resolveCaller, assertOrg, parseBody, handle, ok, err } from '../lib/cp-shared';

// ── Routes ───────────────────────────────────────────────────────────────────────

interface AclRuleDbRow {
  id: string;
  datalake_id: string;
  agent_id: string | null;
  subject_kind: 'agent' | 'user' | 'org';
  user_id: string | null;
  capability: string;
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
    datalakeId: r.datalake_id,
    agentId: r.agent_id ?? undefined,
    subjectKind: r.subject_kind,
    userId: r.user_id ?? undefined,
    capability: r.capability,
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

// Full capability taxonomy, matching the migration 010 CHECK constraint exactly.
const CAPABILITY_VALUES = [
  'read', 'write', 'create', 'drop', 'alter',
  'read_source', 'copy_to', 'copy_from',
  'attach', 'detach', 'install', 'load', 'etl',
] as const;

const AclRuleSchema = z.object({
  datalakeId: z.string().min(1),
  agentId: z.string().optional(),
  subjectKind: z.enum(['agent', 'user', 'org']).default('agent'),
  userId: z.string().optional(),
  capability: z.enum(CAPABILITY_VALUES).default('read'),
  schema: z.string().default('*'),
  table: z.string().default('*'),
  columns: z.array(z.string()).optional(),
  // Legacy read|write verb. Optional now that `capability` is the source of truth;
  // the compiler keys on capability and only falls back to verb. Auto-derived from
  // capability when omitted (write-class → write, else read) so authoring a
  // create/drop/read_source grant needs no filler verb.
  verb: z.enum(['read', 'write']).optional(),
  effect: z.enum(['allow', 'deny']).default('allow'),
  rowLimit: z.number().int().positive().optional(),
  ttlSeconds: z.number().int().positive().optional(),
  window: z.object({ start: z.string(), end: z.string() }).optional(),
  notBefore: z.string().optional(),
  expiresAt: z.string().optional(),
}).refine((d) => d.subjectKind !== 'user' || !!d.userId, {
  message: 'userId is required when subjectKind is "user"',
});

interface RuleRow {
  id: string;
  org_id: string;
  datalake_id: string;
  agent_id: string | null;
}

const acl = new Hono<{ Bindings: Env }>();

acl.get('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const url = new URL(c.req.url);
    const datalakeId = url.searchParams.get('datalakeId');
    const agentId = url.searchParams.get('agentId');
    const subjectKind = url.searchParams.get('subjectKind');
    const userId = url.searchParams.get('userId');

    const rows = await query<AclRuleDbRow>(
      `SELECT * FROM waddling.acl_rule
        WHERE org_id = $1
          AND ($2::text IS NULL OR datalake_id = $2)
          AND ($3::text IS NULL OR agent_id = $3)
          AND ($4::text IS NULL OR subject_kind = $4)
          AND ($5::text IS NULL OR user_id = $5)
        ORDER BY priority ASC, created_at DESC`,
      [caller.orgId, datalakeId, agentId, subjectKind, userId],
    );
    return ok(c, { rules: rows.rows.map(mapRule) });
  }),
);

acl.post('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const input = await parseBody(c, AclRuleSchema);

    // Free tier may not create dynamic ACL rules — BUT only gate on a plan when billing
    // is actually configured. With placeholder Stripe keys there is no way to buy a plan,
    // so requiring one would lock everyone out; skip the gate until real pricing exists
    // (mirrors auth.ts's stripeConfigured check).
    const billingOn = !!c.env.STRIPE_SECRET_KEY && !/placeholder/i.test(c.env.STRIPE_SECRET_KEY);
    if (billingOn) {
      try {
        await requirePlan(caller.orgId, 'pro');
      } catch (e) {
        if (e instanceof UpgradeRequiredError) {
          // analytics deferred on workerd — no upgrade_viewed event emitted.
        }
        throw e;
      }
    }

    // When subjectKind='user', only org owners/admins may assign user-subject grants.
    if (input.subjectKind === 'user') {
      const member = await queryOne<{ role: string }>(
        `SELECT role FROM "member"
          WHERE "userId" = $1 AND "organizationId" = $2`,
        [caller.callerId, caller.orgId],
      );
      if (!member || !['owner', 'admin'].includes(member.role)) {
        return err(c, 'forbidden', 403, 'Only org owners and admins may assign user-subject grants');
      }
    }

    // Tenant-isolate the endpoint (and agent, if present).
    const endpoint = await queryOne<{ org_id: string }>(
      `SELECT org_id FROM waddling.datalake WHERE id = $1`,
      [input.datalakeId],
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

    // Legacy verb is a filler for non-read/write capabilities (the compiler keys
    // on capability). Derive it when omitted so the NOT NULL column is satisfied.
    const verb: 'read' | 'write' =
      input.verb ?? (input.capability === 'write' ? 'write' : 'read');

    // Resolve ttl_seconds → absolute expires_at (prefer explicit expiresAt).
    let expiresAt: string | null = input.expiresAt ?? null;
    if (!expiresAt && input.ttlSeconds) {
      expiresAt = new Date(Date.now() + input.ttlSeconds * 1000).toISOString();
    }

    const created = await queryOne<AclRuleDbRow>(
      `INSERT INTO waddling.acl_rule
         (org_id, datalake_id, agent_id, subject_kind, user_id, capability,
          schema_name, table_name, columns, verb, effect,
          row_limit, ttl_seconds, window_start, window_end, not_before, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        caller.orgId,
        input.datalakeId,
        input.agentId ?? null,
        input.subjectKind,
        input.userId ?? null,
        input.capability,
        input.schema,
        input.table,
        input.columns ?? null,
        verb,
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

    const compiled = await recompileAndPush(c, input.datalakeId);

    await query(
      `INSERT INTO waddling.audit_event (org_id, source, event, agent_id, datalake_id, decision, actor)
       VALUES ($1,'control-plane','grant',$2,$3,'allow',$4)`,
      [caller.orgId, input.agentId ?? null, input.datalakeId, caller.callerId],
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

// PATCH /:id — edit an existing rule IN PLACE (no delete+recreate). Mutable: the
// non-targeting dimensions — capability, columns, row limit, effect, time window, and
// expiry (the "continuation" lever: extend/shorten/clear a grant's lifetime). The
// TARGET (datalake/schema/table/subject) is immutable; retargeting = a new rule.
// `undefined` = leave unchanged; an explicit `null` clears (columns/rowLimit/window/
// expiry). Recompiles + pushes like POST/DELETE.
const PatchAclSchema = z.object({
  capability: z.enum(CAPABILITY_VALUES).optional(),
  columns: z.array(z.string()).nullable().optional(),
  rowLimit: z.number().int().positive().nullable().optional(),
  effect: z.enum(['allow', 'deny']).optional(),
  window: z.object({ start: z.string(), end: z.string() }).nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  ttlSeconds: z.number().int().positive().nullable().optional(),
});

acl.patch('/:id', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    const input = await parseBody(c, PatchAclSchema);

    const rule = await queryOne<RuleRow>(
      `SELECT id, org_id, datalake_id, agent_id FROM waddling.acl_rule WHERE id = $1`,
      [id],
    );
    if (!rule) return err(c, 'rule_not_found', 404);
    assertOrg(caller, rule.org_id);

    const sets: string[] = [];
    const params: unknown[] = [];
    let n = 1;
    if (input.capability !== undefined) {
      sets.push(`capability = $${n++}`);
      params.push(input.capability);
      // Keep the legacy verb consistent with the new capability (NOT NULL column).
      sets.push(`verb = $${n++}`);
      params.push(input.capability === 'write' ? 'write' : 'read');
    }
    if (input.columns !== undefined) {
      sets.push(`columns = $${n++}`);
      params.push(input.columns); // null clears the allow-list (= all columns)
    }
    if (input.rowLimit !== undefined) {
      sets.push(`row_limit = $${n++}`);
      params.push(input.rowLimit);
    }
    if (input.effect !== undefined) {
      sets.push(`effect = $${n++}`);
      params.push(input.effect);
    }
    if (input.window !== undefined) {
      sets.push(`window_start = $${n++}`, `window_end = $${n++}`);
      params.push(input.window?.start ?? null, input.window?.end ?? null);
    }
    // Expiry (continuation): explicit expiresAt wins; else ttlSeconds → now+ttl; null clears.
    if (input.expiresAt !== undefined) {
      sets.push(`expires_at = $${n++}`);
      params.push(input.expiresAt);
    } else if (input.ttlSeconds !== undefined) {
      sets.push(`expires_at = $${n++}`);
      params.push(input.ttlSeconds === null ? null : new Date(Date.now() + input.ttlSeconds * 1000).toISOString());
    }

    if (sets.length === 0) return err(c, 'no_changes', 400, 'No mutable fields provided');

    params.push(id);
    const updated = await queryOne<AclRuleDbRow>(
      `UPDATE waddling.acl_rule SET ${sets.join(', ')} WHERE id = $${n} RETURNING *`,
      params,
    );

    const compiled = await recompileAndPush(c, rule.datalake_id);

    await query(
      `INSERT INTO waddling.audit_event (org_id, source, event, agent_id, datalake_id, decision, actor)
       VALUES ($1,'control-plane','grant_update',$2,$3,'allow',$4)`,
      [rule.org_id, rule.agent_id, rule.datalake_id, caller.callerId],
    );

    return ok(c, {
      rule: updated ? mapRule(updated) : null,
      ruleId: id,
      compiledGrants: compiled.snapshot,
    });
  }),
);

acl.delete('/:id', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    const rule = await queryOne<RuleRow>(
      `SELECT id, org_id, datalake_id, agent_id FROM waddling.acl_rule WHERE id = $1`,
      [id],
    );
    if (!rule) return err(c, 'rule_not_found', 404);
    assertOrg(caller, rule.org_id);

    await query(`DELETE FROM waddling.acl_rule WHERE id = $1`, [id]);
    const compiled = await recompileAndPush(c, rule.datalake_id);

    await query(
      `INSERT INTO waddling.audit_event (org_id, source, event, agent_id, datalake_id, decision, actor)
       VALUES ($1,'control-plane','revoke',$2,$3,'deny',$4)`,
      [rule.org_id, rule.agent_id, rule.datalake_id, caller.callerId],
    );

    return ok(c, { success: true, ruleId: id, compiledGrants: compiled.snapshot });
  }),
);

export { acl };
