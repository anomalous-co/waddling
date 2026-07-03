/**
 * /api/cp/acl — literal GRANT/DENY-SQL authoring (spec §13). The SINGLE representation of an
 * agent key's access is literal GRANT/DENY SQL stored in `public.__birdshot_grants` (migration
 * 022), datalake-scoped; birdshot PULLS + enforces it and the UI renders the `stmt` verbatim.
 * There is NO compiler and NO snapshot push here — writing the row + bumping the datalake epoch
 * (both in one txn, via lib/grant-store) is enough; the gateway re-hydrates on its next authorize.
 *
 * GET  /        → list the datalake's literal statements (org-scoped; ?datalakeId= required-ish).
 * POST /        → author one GRANT (effect='allow') or DENY (effect='deny') from granular inputs
 *                 (privilege ∈ SELECT/INSERT/UPDATE/DELETE/TRUNCATE/CREATE/DROP/ALTER/USAGE/EXECUTE/
 *                 DETACH — NO coarse read/write). Guards preserved: billing (requirePlan), tenant
 *                 isolation (assertOrg on datalake + agent), owner/admin gate for subjectKind='user'.
 * GET  /:id     → a single statement row (org-scoped).
 * DELETE /:id   → object grant/deny: DELETE the row + bump epoch. A role-MEMBERSHIP row is instead
 *                 corrected by APPENDING `REVOKE ROLE …` (never deleted — §12f fail-open).
 *
 * The birdshot grantee is BARE (unquoted) — verified against the built extension (a quoted colon
 * grantee lands under the wrong subject-self-role and never enforces).
 */
import { z } from 'zod';
import { Hono } from 'hono';
import { query, queryOne } from '../lib/db';
import type { Env } from '../lib/env';
import { requirePlan, UpgradeRequiredError } from '../lib/entitlements';
import {
  grant, deny, revokeRole,
  applyStatement, deleteGrantById, listStatements,
  agentSubject, GRANULAR_PRIVILEGES,
  type Grantee, type GrantRow,
} from '../lib/grant-store';
import { resolveCaller, assertOrg, parseBody, handle, ok, err } from '../lib/cp-shared';

// Synthetic role names for non-agent subjects (mirrors policy-compiler's birdshotRoleName idea:
// a subject maps to a role that its principals join). Agents grant straight to their JWT subject.
const userRoleName = (userId: string): string => `user_${userId}`;
const orgRoleName = (orgId: string): string => `org_${orgId}`;

const acl = new Hono<{ Bindings: Env }>();

/** Map a stored row to the dashboard's camelCase shape. */
function mapRow(datalakeId: string, r: GrantRow) {
  return {
    id: r.id,
    datalakeId,
    granteeKind: r.grantee_kind,
    grantee: r.grantee,
    stmt: r.stmt,
    version: Number(r.version),
    createdAt: r.created_at,
  };
}

// ── GET / — the datalake's literal statements ──────────────────────────────────────
acl.get('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const url = new URL(c.req.url);
    const datalakeId = url.searchParams.get('datalakeId');
    if (!datalakeId) return err(c, 'datalakeId_required', 400, 'datalakeId query param is required');

    // Tenant-isolate: the datalake must belong to the caller's org.
    const ep = await queryOne<{ org_id: string }>(
      `SELECT org_id FROM waddling.datalake WHERE id = $1`,
      [datalakeId],
    );
    if (!ep) return err(c, 'endpoint_not_found', 404);
    assertOrg(caller, ep.org_id);

    const rows = await listStatements(datalakeId);
    return ok(c, { statements: rows.map((r) => mapRow(datalakeId, r)) });
  }),
);

const GrantInputSchema = z.object({
  datalakeId: z.string().min(1),
  agentId: z.string().optional(),
  subjectKind: z.enum(['agent', 'user', 'org']).default('agent'),
  userId: z.string().optional(),
  // Granular privilege(s) — the enforced birdshot vocabulary. Accept one `privilege` or a
  // `privileges` list; at least one required. NO coarse read/write, NO ALL-PRIVILEGES umbrella.
  privilege: z.enum(GRANULAR_PRIVILEGES).optional(),
  privileges: z.array(z.enum(GRANULAR_PRIVILEGES)).optional(),
  schema: z.string().default('*'),
  table: z.string().default('*'),
  columns: z.array(z.string()).optional(),
  effect: z.enum(['allow', 'deny']).default('allow'),
}).refine((d) => !!d.privilege || (d.privileges && d.privileges.length > 0), {
  message: 'a privilege (or non-empty privileges[]) is required',
}).refine((d) => d.subjectKind !== 'user' || !!d.userId, {
  message: 'userId is required when subjectKind is "user"',
}).refine((d) => d.subjectKind !== 'agent' || !!d.agentId, {
  message: 'agentId is required when subjectKind is "agent"',
});

/** Build the object-ref clause from schema/table (native wildcard for table='*'). */
function objRef(schema: string, table: string): string {
  if (table === '*') return `ALL TABLES IN SCHEMA ${schema}`;
  return `${schema}.${table}`;
}

// ── POST / — author one literal GRANT/DENY ─────────────────────────────────────────
acl.post('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const input = await parseBody(c, GrantInputSchema);

    // Billing gate (only when billing is actually configured — placeholder Stripe ⇒ skip so
    // we don't lock everyone out; mirrors the previous acl.ts + auth.ts stripeConfigured check).
    const billingOn = !!c.env.STRIPE_SECRET_KEY && !/placeholder/i.test(c.env.STRIPE_SECRET_KEY);
    if (billingOn) {
      try {
        await requirePlan(caller.orgId, 'pro');
      } catch (e) {
        if (e instanceof UpgradeRequiredError) { /* analytics deferred on workerd */ }
        throw e;
      }
    }

    // Owner/admin gate for user-subject grants.
    if (input.subjectKind === 'user') {
      const member = await queryOne<{ role: string }>(
        `SELECT role FROM "member" WHERE "userId" = $1 AND "organizationId" = $2`,
        [caller.callerId, caller.orgId],
      );
      if (!member || !['owner', 'admin'].includes(member.role)) {
        return err(c, 'forbidden', 403, 'Only org owners and admins may assign user-subject grants');
      }
    }

    // Tenant isolation: datalake (and agent, if present) must belong to the caller's org.
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

    // Resolve the grantee: agent → its JWT subject (bare colon id); user/org → a synthetic role
    // its principals join (mirrors the old subject_kind → role mapping).
    const to: Grantee =
      input.subjectKind === 'agent'
        ? { subject: agentSubject(input.agentId!) }
        : input.subjectKind === 'user'
          ? { role: userRoleName(input.userId!) }
          : { role: orgRoleName(caller.orgId) };

    const privileges = input.privileges && input.privileges.length ? input.privileges : [input.privilege!];
    const opts = {
      privileges,
      columns: input.columns,
      on: objRef(input.schema, input.table),
      to,
    };
    const stmt = input.effect === 'deny' ? deny(opts) : grant(opts);

    await applyStatement(input.datalakeId, stmt);

    await query(
      `INSERT INTO waddling.audit_event (org_id, source, event, agent_id, datalake_id, decision, actor)
       VALUES ($1,'control-plane',$2,$3,$4,$5,$6)`,
      [
        caller.orgId,
        input.effect === 'deny' ? 'deny' : 'grant',
        input.agentId ?? null,
        input.datalakeId,
        input.effect === 'deny' ? 'deny' : 'allow',
        caller.callerId,
      ],
    );

    return ok(c, { statement: stmt }, 201);
  }),
);

// ── GET /:id — a single statement row (org-scoped) ─────────────────────────────────
acl.get('/:id', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    const row = await queryOne<GrantRow & { datalake: string }>(
      `SELECT g.id, g.datalake, g.grantee_kind, g.grantee, g.stmt, g.version, g.created_at
         FROM public.__birdshot_grants g
         JOIN waddling.datalake d ON d.id = g.datalake
        WHERE g.id = $1 AND d.org_id = $2`,
      [id, caller.orgId],
    );
    if (!row) return err(c, 'statement_not_found', 404);
    return ok(c, { statement: mapRow(row.datalake, row) });
  }),
);

// ── DELETE /:id — object grant/deny: delete the row + bump epoch. Membership: append REVOKE ROLE.
acl.delete('/:id', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');

    // Org-scope the row before touching it.
    const row = await queryOne<{ datalake: string; stmt: string; grantee: string }>(
      `SELECT g.datalake, g.stmt, g.grantee
         FROM public.__birdshot_grants g
         JOIN waddling.datalake d ON d.id = g.datalake
        WHERE g.id = $1 AND d.org_id = $2`,
      [id, caller.orgId],
    );
    if (!row) return err(c, 'statement_not_found', 404);

    // A role-membership row (`GRANT <role> TO <subject>`, no ON) must NOT be deleted — that
    // leaves a stale user_roles edge that fails OPEN (§12f). Append `REVOKE ROLE …` instead.
    const membership = row.stmt.match(/^\s*GRANT\s+([A-Za-z0-9_:-]+)\s+TO\s+([A-Za-z0-9_.:-]+)\s*;?\s*$/i);
    const isMembership = membership && !/\bON\b/i.test(row.stmt);
    if (isMembership) {
      await applyStatement(row.datalake, revokeRole(membership![1], membership![2]));
    } else {
      const deleted = await deleteGrantById(row.datalake, id);
      if (deleted == null) return err(c, 'statement_not_found', 404);
    }

    await query(
      `INSERT INTO waddling.audit_event (org_id, source, event, agent_id, datalake_id, decision, actor)
       VALUES ($1,'control-plane','revoke',NULL,$2,'deny',$3)`,
      [caller.orgId, row.datalake, caller.callerId],
    );

    return ok(c, { success: true, id });
  }),
);

export { acl };
