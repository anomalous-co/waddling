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
 *                 DETACH — NO coarse read/write). Guards preserved: billing (dynamicAcl entitlement), tenant
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
import { requireEntitlement, UpgradeRequiredError } from '../lib/entitlements';
import {
  grant, deny, revokeRole, grantRole, granteeFromInput,
  applyStatement, deleteGrantById, listStatements,
  agentSubject, GRANULAR_PRIVILEGES,
  type Grantee, type GrantRow,
} from '../lib/grant-store';
import { parseStatement } from '../lib/grant-parse';
import { resolveCaller, assertOrg, parseBody, handle, ok, err } from '../lib/cp-shared';

// Synthetic role names for non-agent subjects (mirrors policy-compiler's birdshotRoleName idea:
// a subject maps to a role that its principals join). Agents grant straight to their JWT subject.
const userRoleName = (userId: string): string => `user_${userId}`;
const orgRoleName = (orgId: string): string => `org_${orgId}`;

const acl = new Hono<{ Bindings: Env }>();

/**
 * Map a stored row to the dashboard's camelCase shape. `sql` is the canonical field the new
 * grant UX reads; `parsed` is the server-side decomposition (null for exotic/hand-written SQL →
 * the UI's read-only "Advanced" bucket). `stmt` is kept ADDITIVELY for older consumers.
 */
function mapRow(datalakeId: string, r: GrantRow) {
  return {
    id: r.id,
    datalakeId,
    granteeKind: r.grantee_kind,
    grantee: r.grantee,
    sql: r.stmt,
    stmt: r.stmt, // legacy alias
    parsed: parseStatement(r.stmt),
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
    const agentId = url.searchParams.get('agentId');
    if (!datalakeId) return err(c, 'datalakeId_required', 400, 'datalakeId query param is required');

    // Tenant-isolate: the datalake must belong to the caller's org.
    const ep = await queryOne<{ org_id: string }>(
      `SELECT org_id FROM waddling.datalake WHERE id = $1`,
      [datalakeId],
    );
    if (!ep) return err(c, 'endpoint_not_found', 404);
    assertOrg(caller, ep.org_id);

    // When ?agentId= is present, scope to THAT key's OWN rows (grant-ux-plan §4.1 — the Grant SQL
    // tab's editable, deletable-by-id list); role/PUBLIC/other-subject rows are excluded. Without
    // agentId, return the whole datalake's statement set (admin/datalake-wide view).
    let rows = await listStatements(datalakeId);
    if (agentId) {
      const subject = agentSubject(agentId);
      rows = rows.filter((r) => r.grantee_kind === 'subject' && r.grantee === subject);
    }
    return ok(c, { statements: rows.map((r) => mapRow(datalakeId, r)) });
  }),
);

// The new discriminated grantee (grant-ux-plan §4/§8.1). Object grants target one of three:
//   agent  → GRANT … TO agent:<id>   role → GRANT … TO ROLE <r>   public → GRANT … TO PUBLIC
const TargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), agentId: z.string().min(1) }),
  z.object({ kind: z.literal('role'), role: z.string().min(1) }),
  z.object({ kind: z.literal('public') }),
]);

const GrantInputSchema = z.object({
  datalakeId: z.string().min(1),
  // ── raw statement (Grant SQL power tab — highest precedence): the literal statement is
  // stored verbatim, so a power user can author anything the picker can't express ──
  sql: z.string().min(1).optional(),
  // ── membership authoring: GRANT <role> TO agent:<id> ──
  membership: z.object({ role: z.string().min(1), agentId: z.string().min(1) }).optional(),
  // ── new discriminated object-grant target ──
  target: TargetSchema.optional(),
  // ── legacy subject fields (fallback path — kept for deploy-transition safety) ──
  agentId: z.string().optional(),
  subjectKind: z.enum(['agent', 'user', 'org']).optional(),
  userId: z.string().optional(),
  // Granular privilege(s) — the enforced birdshot vocabulary. Accept one `privilege` or a
  // `privileges` list; at least one required for object grants. NO coarse read/write.
  privilege: z.enum(GRANULAR_PRIVILEGES).optional(),
  privileges: z.array(z.enum(GRANULAR_PRIVILEGES)).optional(),
  schema: z.string().default('*'),
  table: z.string().default('*'),
  allTablesInSchema: z.boolean().optional(),
  columns: z.array(z.string()).optional(),
  effect: z.enum(['allow', 'deny']).default('allow'),
});

/** Build the object-ref clause from schema/table (native wildcard for table='*'). */
function objRef(schema: string, table: string, allTablesInSchema?: boolean): string {
  if (allTablesInSchema || table === '*') return `ALL TABLES IN SCHEMA ${schema}`;
  return `${schema}.${table}`;
}

// ── POST / — author one literal GRANT/DENY ─────────────────────────────────────────
acl.post('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const input = await parseBody(c, GrantInputSchema);

    // Feature gate: per-agent access control is the `dynamicAcl` entitlement — free lacks it,
    // starter+ have it (plans.ts). This is the PRODUCT'S CORE MECHANIC, not a Pro upsell, so it
    // gates on the entitlement (tracks the plan catalog) rather than a hard requirePlan('pro'),
    // which locked every starter org out of managing its own agents. Only enforced when billing
    // is actually configured — placeholder Stripe ⇒ skip so we don't lock everyone out.
    const billingOn = !!c.env.STRIPE_SECRET_KEY && !/placeholder/i.test(c.env.STRIPE_SECRET_KEY);
    if (billingOn) {
      try {
        await requireEntitlement(caller.orgId, 'dynamicAcl');
      } catch (e) {
        if (e instanceof UpgradeRequiredError) { /* analytics deferred on workerd */ }
        throw e;
      }
    }

    // Resolve the authoring path + statement. Precedence: membership > new target > legacy
    // subjectKind. `requiresAdmin` = the non-agent-target owner/admin gate (roles/public/user
    // are org-wide, so treat them like the old subjectKind='user' gate). `agentIdToCheck` is
    // tenant-isolated below when the statement targets a concrete agent.
    let stmt: string;
    let auditEvent: 'grant' | 'deny';
    let auditAgentId: string | null = null;
    let requiresAdmin = false;
    let agentIdToCheck: string | undefined;

    if (input.sql) {
      // Raw literal statement (Grant SQL power tab). Validate it's a recognized construct,
      // store it verbatim. Admin gate: only a parseable object/membership grant that targets a
      // concrete agent:<id> subject is self-serve; role/PUBLIC/other/unparseable targets are
      // org-wide → admin-gated (can't silently escalate via a pasted statement).
      const raw = input.sql.trim();
      const p = parseStatement(raw);
      if (!p && !/^\s*(GRANT|DENY|REVOKE|UNDENY)\b/i.test(raw)) {
        return err(c, 'invalid_sql', 400, 'sql must be a GRANT/DENY/REVOKE/UNDENY statement');
      }
      stmt = raw;
      auditEvent = /^\s*deny\b/i.test(raw) ? 'deny' : 'grant';
      const subj = p?.grantee.kind === 'subject' ? p.grantee.name : null;
      if (subj && subj.startsWith('agent:')) {
        agentIdToCheck = subj.slice('agent:'.length);
        auditAgentId = agentIdToCheck;
      } else {
        requiresAdmin = true; // role / PUBLIC / other subject / unparseable → admin only
      }
    } else if (input.membership) {
      // Role membership is org-wide role management → admin-gated. `GRANT <role> TO agent:<id>`
      // (matches the DELETE membership-detect regex so a later revoke appends `REVOKE ROLE …`).
      requiresAdmin = true;
      agentIdToCheck = input.membership.agentId;
      auditAgentId = input.membership.agentId;
      auditEvent = 'grant';
      stmt = grantRole(input.membership.role, agentSubject(input.membership.agentId));
    } else {
      const privileges = input.privileges && input.privileges.length
        ? input.privileges
        : (input.privilege ? [input.privilege] : []);
      if (privileges.length === 0) {
        return err(c, 'privilege_required', 400, 'a privilege (or non-empty privileges[]) is required');
      }

      let to: Grantee;
      if (input.target) {
        requiresAdmin = input.target.kind !== 'agent';
        if (input.target.kind === 'agent') {
          agentIdToCheck = input.target.agentId;
          auditAgentId = input.target.agentId;
        }
        to = granteeFromInput(input.target);
      } else {
        // Legacy subjectKind path (agent | user | org).
        const subjectKind = input.subjectKind ?? 'agent';
        if (subjectKind === 'user' && !input.userId) {
          return err(c, 'userId_required', 400, 'userId is required when subjectKind is "user"');
        }
        if (subjectKind === 'agent' && !input.agentId) {
          return err(c, 'agentId_required', 400, 'agentId is required when subjectKind is "agent"');
        }
        requiresAdmin = subjectKind === 'user';
        if (subjectKind === 'agent') {
          agentIdToCheck = input.agentId;
          auditAgentId = input.agentId ?? null;
        }
        to =
          subjectKind === 'agent'
            ? { subject: agentSubject(input.agentId!) }
            : subjectKind === 'user'
              ? { role: userRoleName(input.userId!) }
              : { role: orgRoleName(caller.orgId) };
      }

      const opts = {
        privileges,
        columns: input.columns,
        on: objRef(input.schema, input.table, input.allTablesInSchema),
        to,
      };
      stmt = input.effect === 'deny' ? deny(opts) : grant(opts);
      auditEvent = input.effect === 'deny' ? 'deny' : 'grant';
    }

    // Owner/admin gate for non-agent targets (roles, PUBLIC, user subjects, membership).
    if (requiresAdmin) {
      const member = await queryOne<{ role: string }>(
        `SELECT role FROM "member" WHERE "userId" = $1 AND "organizationId" = $2`,
        [caller.callerId, caller.orgId],
      );
      if (!member || !['owner', 'admin'].includes(member.role)) {
        return err(c, 'forbidden', 403, 'Only org owners and admins may author role/PUBLIC grants');
      }
    }

    // Tenant isolation: datalake (and agent, if the statement targets one) must be in the org.
    const endpoint = await queryOne<{ org_id: string }>(
      `SELECT org_id FROM waddling.datalake WHERE id = $1`,
      [input.datalakeId],
    );
    if (!endpoint) return err(c, 'endpoint_not_found', 404);
    assertOrg(caller, endpoint.org_id);

    if (agentIdToCheck) {
      const agent = await queryOne<{ org_id: string }>(
        `SELECT org_id FROM waddling.agent WHERE id = $1`,
        [agentIdToCheck],
      );
      if (!agent) return err(c, 'agent_not_found', 404);
      assertOrg(caller, agent.org_id);
    }

    await applyStatement(input.datalakeId, stmt);

    await query(
      `INSERT INTO waddling.audit_event (org_id, source, event, agent_id, datalake_id, decision, actor)
       VALUES ($1,'control-plane',$2,$3,$4,$5,$6)`,
      [
        caller.orgId,
        auditEvent,
        auditAgentId,
        input.datalakeId,
        auditEvent === 'deny' ? 'deny' : 'allow',
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
