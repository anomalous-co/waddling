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
import { recompileAndEnqueue } from '../lib/gateway-dispatch';
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
    // min(1): an empty string is never a valid lake — reject it cleanly instead of letting
    // it slip past the `if (input.datalakeId)` existence check and FK-violate on insert.
    // Omit the field entirely for an all-lakes delegation.
    datalakeId: z.string().min(1).optional(),
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

    // Tenant-isolate datalake if provided. (Done before the grant logic so auto-grant
    // can only ever materialize rows on a lake the caller's org actually owns.)
    if (input.datalakeId) {
      const lake = await queryOne<{ org_id: string }>(
        `SELECT org_id FROM waddling.datalake WHERE id = $1`,
        [input.datalakeId],
      );
      if (!lake) return err(c, 'endpoint_not_found', 404);
      assertOrg(caller, lake.org_id);
    }

    // A delegation derives from the caller's own user-subject grants (deriveEffectiveRules
    // intersects owner-grants ∩ delegation scope, matching on CAPABILITY). A brand-new org
    // owner has none — they never had a reason to grant themselves access to data they
    // already own — so the OAuth consent flow used to dead-end here: the delegation POST
    // 403'd, the consent form swallowed it, and the agent connected with zero grants. Close
    // that loop: if the caller lacks the backing grant but is an org OWNER/ADMIN (so they
    // have authority over the data), materialize the user-subject grant for EXACTLY the
    // scope being delegated, then proceed. A non-admin still can't self-grant — they need an
    // admin to grant them first.
    //
    // The check is PER-CAPABILITY AND COVERAGE-AWARE: derivation only intersects a
    // delegation against a user-grant of the SAME capability whose selector overlaps the
    // requested resource. Since owners start with NO grants and the backing grants this
    // flow materializes are now per-table (granular consent, not the old `*.*`), a
    // capability-only "has any grant?" gate would wrongly skip: an owner who consented
    // `read` on sales.orders, then `read` on sales.customers, would find the second
    // delegation backed only by the orders grant (orders ∩ customers = ∅ → derives
    // nothing). So we skip materialization only when an existing same-capability grant
    // actually COVERS the requested (schema, table) — a `*.*`, `schema.*`, or exact-match
    // grant — and otherwise materialize the exact requested scope below.
    const hasGrants = await queryOne<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM waddling.acl_rule
          WHERE org_id = $1
            AND subject_kind = 'user'
            AND user_id = $2
            AND ($3::text IS NULL OR datalake_id = $3)
            AND capability = $4
            AND (schema_name = '*' OR schema_name = $5)
            AND (table_name = '*' OR table_name = $6)
            AND effect = 'allow'
       ) AS exists`,
      [caller.orgId, caller.callerId, input.datalakeId ?? null, input.capability, input.schema, input.table],
    );
    if (!hasGrants?.exists) {
      const member = await queryOne<{ role: string }>(
        `SELECT role FROM "member" WHERE "userId" = $1 AND "organizationId" = $2`,
        [caller.callerId, caller.orgId],
      );
      if (!member || !['owner', 'admin'].includes(member.role)) {
        return err(
          c,
          'forbidden',
          403,
          'You need an org owner or admin to grant you access to this data before it can be delegated to an agent.',
        );
      }
      // Target lakes: the specific one, or every lake in the org for an all-lakes ('*')
      // delegation (compileEndpointPolicy matches user-subject grants per datalake_id, so an
      // all-lakes delegation needs a backing grant on each lake to derive anything).
      let lakeIds: string[];
      if (input.datalakeId) {
        lakeIds = [input.datalakeId];
      } else {
        const lakes = await query<{ id: string }>(
          `SELECT id FROM waddling.datalake WHERE org_id = $1`,
          [caller.orgId],
        );
        lakeIds = lakes.rows.map((r) => r.id);
      }
      const verb = input.capability === 'write' ? 'write' : 'read';
      for (const lakeId of lakeIds) {
        // Idempotent: only insert when an equivalent user-subject grant isn't already present
        // (acl_rule has no unique key on this tuple, so guard with NOT EXISTS).
        await query(
          `INSERT INTO waddling.acl_rule
             (org_id, datalake_id, agent_id, subject_kind, user_id, capability,
              schema_name, table_name, columns, verb, effect, created_by)
           SELECT $1, $2, NULL, 'user', $3, $4, $5, $6, NULL, $7, 'allow', $3
            WHERE NOT EXISTS (
              SELECT 1 FROM waddling.acl_rule
               WHERE org_id = $1 AND datalake_id = $2 AND subject_kind = 'user'
                 AND user_id = $3 AND capability = $4
                 AND schema_name = $5 AND table_name = $6 AND effect = 'allow'
            )`,
          [caller.orgId, lakeId, caller.callerId, input.capability, input.schema, input.table, verb],
        );
        await query(
          `INSERT INTO waddling.audit_event (org_id, source, event, datalake_id, decision, actor)
           VALUES ($1, 'control-plane', 'grant', $2, 'allow', $3)`,
          [caller.orgId, lakeId, caller.callerId],
        ).catch(() => {/* audit is best-effort */});
      }
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

    // Idempotent on the identity tuple (principal + lake + scope + capability): the
    // delegation table has no unique key here, and granular consent POSTs one row per
    // (table, capability), so re-approving the same access would otherwise pile up
    // duplicate rows on every reconnect. Guard with NOT EXISTS; on a repeat, fetch and
    // return the existing row so the response still carries a delegation id.
    const insertParams = [
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
    ];
    let created = await queryOne<DelegationDbRow>(
      `INSERT INTO waddling.delegation
         (org_id, user_id, agent_id, client_id, datalake_id,
          schema_name, table_name, columns, capability,
          row_limit, window_start, window_end, expires_at, created_by)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
        WHERE NOT EXISTS (
          SELECT 1 FROM waddling.delegation
           WHERE org_id = $1 AND user_id = $2
             AND agent_id IS NOT DISTINCT FROM $3
             AND client_id IS NOT DISTINCT FROM $4
             AND datalake_id IS NOT DISTINCT FROM $5
             AND schema_name = $6 AND table_name = $7 AND capability = $9
        )
       RETURNING *`,
      insertParams,
    );
    if (!created) {
      created = await queryOne<DelegationDbRow>(
        `SELECT * FROM waddling.delegation
          WHERE org_id = $1 AND user_id = $2
            AND agent_id IS NOT DISTINCT FROM $3
            AND client_id IS NOT DISTINCT FROM $4
            AND datalake_id IS NOT DISTINCT FROM $5
            AND schema_name = $6 AND table_name = $7 AND capability = $8
          ORDER BY created_at DESC
          LIMIT 1`,
        [
          caller.orgId,
          caller.callerId,
          input.agentId ?? null,
          input.clientId ?? null,
          input.datalakeId ?? null,
          input.schema,
          input.table,
          input.capability,
        ],
      );
    }

    // Config-only re-arm (spec §13). NOTE: delegation → literal grant-store SQL is not yet
    // wired (this subsystem still writes waddling.delegation rows, which no longer feed
    // birdshot's pull store). Kept enqueuing so a JWKS/lake change re-arms the gateway.
    await recompileAndEnqueue(c, input.datalakeId ?? null);

    return ok(
      c,
      {
        delegation: created ? mapDelegation(created) : null,
        delegationId: created?.id,
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

    await recompileAndEnqueue(c, row.datalake_id);

    return ok(c, { success: true, delegationId: id });
  }),
);

export { delegations };
