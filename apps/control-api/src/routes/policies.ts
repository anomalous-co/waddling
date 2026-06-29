/**
 * /api/cp/acl-policy — CRUD for waddling.acl_policy (Phase 3): per-subject
 * allowlists for NON-catalog resources (a read_source/copy URI host, an
 * INSTALL/LOAD extension name, an ATTACH target). These compile — via
 * compileEndpointPolicy → birdshot_add_{source,dest,ext,attach}_policy — into the
 * per-role allowlists birdshot matches a CONSTANT literal against. acl_rule gates
 * catalog tables; acl_policy gates everything else.
 *
 * Mirrors routes/acl.ts: owner/admin gate for subject_kind='user', tenant
 * isolation via assertOrg, and a recompile+push on every mutation. The recompile
 * is best-effort (see recompileAndPush) — a policy persists even when the gateway
 * is unreachable; the next connect/recompile re-pushes.
 *
 * HARD INVARIANT (birdshot): a non-catalog resource that can't be pinned to a
 * constant literal is DENIED regardless of any policy here — a policy only WIDENS
 * what an already-constant literal may match.
 */
import { z } from 'zod';
import { Hono } from 'hono';
import { query, queryOne } from '../lib/db';
import type { Env } from '../lib/env';
import { recompileAndEnqueue } from '../lib/gateway-dispatch';
import { resolveCaller, assertOrg, parseBody, handle, ok, err } from '../lib/cp-shared';

// policy_kind ← capability family. Each kind implies which capabilities are valid.
const KIND_CAPABILITIES = {
  source: ['read_source', 'copy_from'],
  dest: ['copy_to'],
  extension: ['install', 'load'],
  attach: ['attach'],
} as const;

const AclPolicySchema = z
  .object({
    datalakeId: z.string().optional(), // omitted/null = all datalakes
    subjectKind: z.enum(['agent', 'user', 'org']).default('agent'),
    agentId: z.string().optional(),
    userId: z.string().optional(),
    policyKind: z.enum(['source', 'dest', 'extension', 'attach']),
    capability: z.enum([
      'read_source',
      'copy_to',
      'copy_from',
      'attach',
      'install',
      'load',
    ]),
    pattern: z.string().min(1),
    expiresAt: z.string().optional(),
  })
  .refine(
    (d) =>
      (KIND_CAPABILITIES[d.policyKind] as readonly string[]).includes(
        d.capability,
      ),
    { message: 'capability does not match policyKind' },
  )
  .refine((d) => d.subjectKind !== 'user' || !!d.userId, {
    message: 'userId is required when subjectKind is "user"',
  })
  .refine((d) => d.subjectKind !== 'agent' || !!d.agentId, {
    message: 'agentId is required when subjectKind is "agent"',
  });

interface PolicyDbRow {
  id: string;
  org_id: string;
  datalake_id: string | null;
  subject_kind: 'agent' | 'user' | 'org';
  agent_id: string | null;
  user_id: string | null;
  policy_kind: 'source' | 'dest' | 'extension' | 'attach';
  capability: string;
  pattern: string;
  expires_at: string | null;
  created_by: string;
  created_at: string;
}

function mapPolicy(r: PolicyDbRow) {
  return {
    id: r.id,
    datalakeId: r.datalake_id ?? undefined,
    subjectKind: r.subject_kind,
    agentId: r.agent_id ?? undefined,
    userId: r.user_id ?? undefined,
    policyKind: r.policy_kind,
    capability: r.capability,
    pattern: r.pattern,
    expiresAt: r.expires_at ?? undefined,
    createdAt: r.created_at,
  };
}

const policies = new Hono<{ Bindings: Env }>();

policies.get('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const url = new URL(c.req.url);
    const datalakeId = url.searchParams.get('datalakeId');
    const agentId = url.searchParams.get('agentId');
    const subjectKind = url.searchParams.get('subjectKind');
    const userId = url.searchParams.get('userId');

    const rows = await query<PolicyDbRow>(
      `SELECT * FROM waddling.acl_policy
        WHERE org_id = $1
          AND ($2::text IS NULL OR datalake_id = $2)
          AND ($3::text IS NULL OR agent_id = $3)
          AND ($4::text IS NULL OR subject_kind = $4)
          AND ($5::text IS NULL OR user_id = $5)
        ORDER BY created_at DESC`,
      [caller.orgId, datalakeId, agentId, subjectKind, userId],
    );
    return ok(c, { policies: rows.rows.map(mapPolicy) });
  }),
);

policies.post('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const input = await parseBody(c, AclPolicySchema);

    // Only org owners/admins may assign user-subject policies (mirrors acl.ts).
    if (input.subjectKind === 'user') {
      const member = await queryOne<{ role: string }>(
        `SELECT role FROM "member" WHERE "userId" = $1 AND "organizationId" = $2`,
        [caller.callerId, caller.orgId],
      );
      if (!member || !['owner', 'admin'].includes(member.role)) {
        return err(c, 'forbidden', 403, 'Only org owners and admins may assign user-subject policies');
      }
    }

    // Tenant-isolate the datalake (if scoped) and agent (if present).
    if (input.datalakeId) {
      const endpoint = await queryOne<{ org_id: string }>(
        `SELECT org_id FROM waddling.datalake WHERE id = $1`,
        [input.datalakeId],
      );
      if (!endpoint) return err(c, 'endpoint_not_found', 404);
      assertOrg(caller, endpoint.org_id);
    }
    if (input.agentId) {
      const agent = await queryOne<{ org_id: string }>(
        `SELECT org_id FROM waddling.agent WHERE id = $1`,
        [input.agentId],
      );
      if (!agent) return err(c, 'agent_not_found', 404);
      assertOrg(caller, agent.org_id);
    }

    const created = await queryOne<PolicyDbRow>(
      `INSERT INTO waddling.acl_policy
         (org_id, datalake_id, subject_kind, agent_id, user_id,
          policy_kind, capability, pattern, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        caller.orgId,
        input.datalakeId ?? null,
        input.subjectKind,
        input.agentId ?? null,
        input.userId ?? null,
        input.policyKind,
        input.capability,
        input.pattern,
        input.expiresAt ?? null,
        caller.callerId,
      ],
    );

    // Recompile only the affected datalake. A global (datalake-less) policy can
    // touch every endpoint; recompiling all of them on one insert is deferred —
    // the next per-endpoint connect/recompile picks it up.
    const compiled = input.datalakeId
      ? await recompileAndEnqueue(c, input.datalakeId)
      : null;

    await query(
      `INSERT INTO waddling.audit_event (org_id, source, event, agent_id, datalake_id, decision, actor)
       VALUES ($1,'control-plane','grant',$2,$3,'allow',$4)`,
      [caller.orgId, input.agentId ?? null, input.datalakeId ?? null, caller.callerId],
    );

    return ok(
      c,
      {
        policy: created ? mapPolicy(created) : null,
        policyId: created?.id,
        compiledGrants: compiled?.snapshot ?? null,
      },
      201,
    );
  }),
);

policies.delete('/:id', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    const row = await queryOne<PolicyDbRow>(
      `SELECT * FROM waddling.acl_policy WHERE id = $1`,
      [id],
    );
    if (!row) return err(c, 'policy_not_found', 404);
    assertOrg(caller, row.org_id);

    await query(`DELETE FROM waddling.acl_policy WHERE id = $1`, [id]);
    const compiled = row.datalake_id
      ? await recompileAndEnqueue(c, row.datalake_id)
      : null;

    await query(
      `INSERT INTO waddling.audit_event (org_id, source, event, agent_id, datalake_id, decision, actor)
       VALUES ($1,'control-plane','revoke',$2,$3,'deny',$4)`,
      [row.org_id, row.agent_id, row.datalake_id, caller.callerId],
    );

    return ok(c, { success: true, policyId: id, compiledGrants: compiled?.snapshot ?? null });
  }),
);

export { policies };
