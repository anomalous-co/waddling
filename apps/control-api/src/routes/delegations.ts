/**
 * /api/cp/delegations — self-service per-(user, agent|client_id) delegation CRUD.
 *
 * A delegation row says: "I (userId) permit this agent/client to act on my behalf
 * with at most [capability] on [datalake/schema/table], subject to [constraints]."
 * Derived effective grants (owner's grants ∩ delegation scope) are computed at
 * connect/recompile by compileEndpointPolicy and NEVER persisted.
 *
 * GET  /        → caller's own delegation rows + caller's own user-subject acl_rule
 *                 grants (so the UI can show what they may delegate). Filter: ?datalakeId=
 * POST /        → create a delegation for the caller. Validated/clamped to the caller's
 *                 own grants at the store level (deriveEffectiveRules is the backstop).
 *                 Exactly one of agentId / clientId is required.
 * DELETE /:id   → org-scoped + own-row delete, recompile + push.
 */
import { z } from 'zod';
import { Hono } from 'hono';
import { query, queryOne } from '../lib/db';
import type { Env } from '../lib/env';
import { recompileAndPush } from '../lib/gateway-push';
import { resolveCaller, assertOrg, parseBody, handle, ok, err } from '../lib/cp-shared';

// Full capability taxonomy — matches the migration 010 CHECK constraint exactly.
const CAPABILITY_VALUES = [
  'read', 'write', 'create', 'drop', 'alter',
  'read_source', 'copy_to', 'copy_from',
  'attach', 'detach', 'install', 'load', 'etl',
] as const;

interface DelegationDbRow {
  id: string;
  org_id: string;
  user_id: string;
  agent_id: string | null;
  client_id: string | null;
  datalake_id: string | null;
  schema_name: string;
  table_name: string;
  columns: string[] | null;
  capability: string;
  row_limit: number | null;
  window_start: string | null;
  window_end: string | null;
  expires_at: string | null;
  created_by: string;
  created_at: string;
}

function mapDelegation(r: DelegationDbRow) {
  return {
    id: r.id,
    orgId: r.org_id,
    userId: r.user_id,
    agentId: r.agent_id ?? undefined,
    clientId: r.client_id ?? undefined,
    datalakeId: r.datalake_id ?? undefined,
    schemaName: r.schema_name,
    tableName: r.table_name,
    columns: r.columns ?? undefined,
    capability: r.capability,
    rowLimit: r.row_limit ?? undefined,
    windowStart: r.window_start ?? undefined,
    windowEnd: r.window_end ?? undefined,
    expiresAt: r.expires_at ?? undefined,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

const DelegationSchema = z
  .object({
    agentId: z.string().optional(),
    clientId: z.string().optional(),
    datalakeId: z.string().optional(),
    schema: z.string().default('*'),
    table: z.string().default('*'),
    columns: z.array(z.string()).optional(),
    capability: z.enum(CAPABILITY_VALUES).default('read'),
    rowLimit: z.number().int().positive().optional(),
    window: z.object({ start: z.string(), end: z.string() }).optional(),
    expiresAt: z.string().optional(),
  })
  .refine(
    (d) => !!(d.agentId || d.clientId),
    { message: 'Exactly one of agentId or clientId is required' },
  );

const delegations = new Hono<{ Bindings: Env }>();

delegations.get('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const url = new URL(c.req.url);
    const datalakeId = url.searchParams.get('datalakeId');
    const scope = url.searchParams.get('scope');

    // scope=org → every delegation across ALL principals in the org (the Agents ▸
    // Delegations admin tab). Owner/admin only; enforced here, not just hidden in UI.
    if (scope === 'org') {
      const member = await queryOne<{ role: string }>(
        `SELECT role FROM "member" WHERE "userId" = $1 AND "organizationId" = $2`,
        [caller.callerId, caller.orgId],
      );
      const roles = (member?.role ?? '').split(',').map((r) => r.trim());
      if (!roles.some((r) => r === 'owner' || r === 'admin')) {
        return err(c, 'forbidden', 403, 'Owner or admin role required to view all delegations');
      }
      const rows = await query<DelegationDbRow & { agent_name: string | null }>(
        `SELECT d.*, a.name AS agent_name
           FROM waddling.delegation d
           LEFT JOIN waddling.agent a ON a.id = d.agent_id
          WHERE d.org_id = $1 AND ($2::text IS NULL OR d.datalake_id = $2)
          ORDER BY d.created_at DESC`,
        [caller.orgId, datalakeId],
      );
      return ok(c, {
        delegations: rows.rows.map((r) => ({ ...mapDelegation(r), agentName: r.agent_name ?? undefined })),
      });
    }

    // Own delegation rows.
    const delegationRows = await query<DelegationDbRow>(
      `SELECT * FROM waddling.delegation
        WHERE org_id = $1
          AND user_id = $2
          AND ($3::text IS NULL OR datalake_id = $3)
        ORDER BY created_at DESC`,
      [caller.orgId, caller.callerId, datalakeId],
    );

    // Own user-subject acl_rule grants (so the UI can show what may be delegated).
    const grantRows = await query<Record<string, unknown>>(
      `SELECT * FROM waddling.acl_rule
        WHERE org_id = $1
          AND subject_kind = 'user'
          AND user_id = $2
          AND ($3::text IS NULL OR datalake_id = $3)
        ORDER BY priority ASC, created_at DESC`,
      [caller.orgId, caller.callerId, datalakeId],
    );

    return ok(c, {
      delegations: delegationRows.rows.map(mapDelegation),
      grants: grantRows.rows,
    });
  }),
);

delegations.post('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const input = await parseBody(c, DelegationSchema);

    // Gate: caller must have at least one user-subject grant to delegate anything.
    // The exact intersection (deriveEffectiveRules) is the backstop; here we only
    // enforce "the user has some grants" to prevent creating meaningless delegations.
    const hasGrants = await queryOne<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM waddling.acl_rule
          WHERE org_id = $1
            AND subject_kind = 'user'
            AND user_id = $2
            AND ($3::text IS NULL OR datalake_id = $3)
       ) AS exists`,
      [caller.orgId, caller.callerId, input.datalakeId ?? null],
    );
    if (!hasGrants?.exists) {
      return err(c, 'forbidden', 403, 'No user-subject grants to delegate from');
    }

    // Tenant-isolate datalake if provided.
    if (input.datalakeId) {
      const lake = await queryOne<{ org_id: string }>(
        `SELECT org_id FROM waddling.datalake WHERE id = $1`,
        [input.datalakeId],
      );
      if (!lake) return err(c, 'endpoint_not_found', 404);
      assertOrg(caller, lake.org_id);
    }

    // Tenant-isolate agentId if provided.
    if (input.agentId) {
      const agent = await queryOne<{ org_id: string }>(
        `SELECT org_id FROM waddling.agent WHERE id = $1`,
        [input.agentId],
      );
      if (!agent) return err(c, 'agent_not_found', 404);
      assertOrg(caller, agent.org_id);
    }

    const created = await queryOne<DelegationDbRow>(
      `INSERT INTO waddling.delegation
         (org_id, user_id, agent_id, client_id, datalake_id,
          schema_name, table_name, columns, capability,
          row_limit, window_start, window_end, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        caller.orgId,
        caller.callerId,
        input.agentId ?? null,
        input.clientId ?? null,
        input.datalakeId ?? null,
        input.schema,
        input.table,
        input.columns ?? null,
        input.capability,
        input.rowLimit ?? null,
        input.window?.start ?? null,
        input.window?.end ?? null,
        input.expiresAt ?? null,
        caller.callerId,
      ],
    );

    // Push the recompiled policy. When datalakeId is NULL (all-lakes scope),
    // recompileAndPush skips the push (best-effort; next connect/recompile picks up).
    const compiled = await recompileAndPush(c, input.datalakeId ?? null);

    return ok(
      c,
      {
        delegation: created ? mapDelegation(created) : null,
        delegationId: created?.id,
        compiledGrants: compiled.snapshot,
      },
      201,
    );
  }),
);

delegations.delete('/:id', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');

    const row = await queryOne<DelegationDbRow>(
      `SELECT * FROM waddling.delegation WHERE id = $1`,
      [id],
    );
    if (!row) return err(c, 'delegation_not_found', 404);

    // Org-scoped isolation.
    assertOrg(caller, row.org_id);

    // Own-row gate: only the delegating user may revoke their own delegation.
    if (row.user_id !== caller.callerId) {
      return err(c, 'forbidden', 403, 'You may only delete your own delegations');
    }

    await query(`DELETE FROM waddling.delegation WHERE id = $1`, [id]);

    const compiled = await recompileAndPush(c, row.datalake_id);

    return ok(c, { success: true, delegationId: id, compiledGrants: compiled.snapshot });
  }),
);

export { delegations };
