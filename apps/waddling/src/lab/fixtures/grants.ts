/**
 * Literal GRANT/DENY-SQL fixtures for the UX lab (spec §13). The control plane's
 * single representation of a key's access is literal SQL stored per datalake;
 * birdshot PULLs + enforces it and the UI renders the decomposed statement.
 *
 * These fixtures are STRUCTURED (PickerStatement specs) and derive their `sql`
 * via the shared `emitStatement` grammar + their `parsed` from the same spec — so
 * the lab's server-decomposition is byte-identical to the client's emit (the
 * invariant the string-identity diff depends on). This is the lab stand-in for
 * the control-api's server-side decomposition.
 *
 * Back these lab mocks:
 *   GET /api/cp/agents/:id/grants?datalakeId=  → { statements: ResolvedStatement[] } (own ∪ role ∪ PUBLIC)
 *   GET /api/cp/acl?datalakeId=&agentId=       → AclRow[] (own, deletable rows)
 *   GET /api/cp/acl?datalakeId=                → { statements: GrantStatementRow[] } (legacy, acl page)
 *
 * Real production data comes straight from control-api; these only serve when
 * NEXT_PUBLIC_CONTROL_API_URL is unset (local/lab).
 */
import {
  PRIVILEGES,
  emitStatement,
  parsedFromSpec,
  parsedGranteeFromSpec,
  type AclRow,
  type ParsedStatement,
  type PickerStatement,
  type ResolvedStatement,
} from '@/components/dashboard/access/access-draft';

/** The granular privilege vocabulary birdshot enforces (mirrors control-api). */
export const GRANULAR_PRIVILEGES = PRIVILEGES;
export type AclPrivilege = (typeof PRIVILEGES)[number];

/** Legacy row shape still consumed by the standalone ACL browser page. */
export interface GrantStatementRow {
  id: string;
  datalakeId: string;
  granteeKind: 'subject' | 'role' | 'public';
  grantee: string;
  stmt: string;
  version: number;
  createdAt: string;
}

/** The birdshot subject for an agent = its JWT `sub`. */
export function agentSubject(agentId: string): string {
  return `agent:${agentId}`;
}

/** One structured fixture statement — sql + parsed derived from `stmt`. */
interface FixtureStatement {
  id: string;
  datalakeId: string;
  createdAt: string;
  stmt: PickerStatement;
}

const AGENT_ETL = 'agt_01j8k9m2n3p4q5r6s7t8u9v0w';
const AGENT_BOT = 'agt_02j8k9m2n3p4q5r6s7t8u9v0x';

/**
 * Per-datalake fixture statements across a few subjects — enough to exercise the
 * Picker + Grant SQL panels: table grants, a column grant, a schema wildcard, a
 * DENY carve-out, role membership, a role-scoped grant, and a PUBLIC grant.
 */
const FIXTURE_STATEMENTS: FixtureStatement[] = [
  // ── dl_01j8events — analytics-etl ───────────────────────────────────────────
  {
    id: 'grant_01j8events01',
    datalakeId: 'dl_01j8events',
    createdAt: '2026-05-15T10:00:00Z',
    stmt: {
      kind: 'object',
      effect: 'allow',
      privileges: ['SELECT'],
      object: { schema: 'analytics', table: 'events' },
      grantee: { kind: 'agent', agentId: AGENT_ETL },
    },
  },
  {
    id: 'grant_01j8events02',
    datalakeId: 'dl_01j8events',
    createdAt: '2026-05-15T10:01:00Z',
    stmt: {
      kind: 'object',
      effect: 'allow',
      privileges: ['SELECT'],
      columns: ['id', 'converted_at'],
      object: { schema: 'analytics', table: 'conversions' },
      grantee: { kind: 'agent', agentId: AGENT_ETL },
    },
  },
  {
    id: 'grant_01j8events03',
    datalakeId: 'dl_01j8events',
    createdAt: '2026-05-15T10:02:00Z',
    stmt: {
      kind: 'object',
      effect: 'allow',
      privileges: ['INSERT', 'UPDATE'],
      object: { schema: 'analytics', table: 'conversions' },
      grantee: { kind: 'agent', agentId: AGENT_ETL },
    },
  },
  {
    id: 'grant_01j8events04',
    datalakeId: 'dl_01j8events',
    createdAt: '2026-05-15T10:03:00Z',
    stmt: {
      kind: 'object',
      effect: 'deny',
      privileges: ['SELECT'],
      object: { schema: 'analytics', table: 'pii' },
      grantee: { kind: 'agent', agentId: AGENT_ETL },
    },
  },
  // Role membership the ETL key holds — pulls the role-scoped grant below into its resolved set.
  {
    id: 'grant_01j8events07',
    datalakeId: 'dl_01j8events',
    createdAt: '2026-06-01T08:32:00Z',
    stmt: { kind: 'membership', role: 'analyst', grantee: { kind: 'agent', agentId: AGENT_ETL } },
  },
  // ── dl_01j8events — insight-bot ─────────────────────────────────────────────
  {
    id: 'grant_01j8events05',
    datalakeId: 'dl_01j8events',
    createdAt: '2026-06-01T08:30:00Z',
    stmt: {
      kind: 'object',
      effect: 'allow',
      privileges: ['SELECT'],
      object: { schema: 'analytics', allTables: true },
      grantee: { kind: 'agent', agentId: AGENT_BOT },
    },
  },
  // ── dl_01j8events — role-scoped grant + PUBLIC (inherited sources) ───────────
  {
    id: 'grant_01j8events06',
    datalakeId: 'dl_01j8events',
    createdAt: '2026-06-01T08:31:00Z',
    stmt: {
      kind: 'object',
      effect: 'allow',
      privileges: ['SELECT'],
      object: { schema: 'analytics', table: 'sessions' },
      grantee: { kind: 'role', role: 'analyst' },
    },
  },
  {
    id: 'grant_01j8events08',
    datalakeId: 'dl_01j8events',
    createdAt: '2026-06-01T08:33:00Z',
    stmt: {
      kind: 'object',
      effect: 'allow',
      privileges: ['USAGE'],
      object: { schema: 'analytics', table: 'public_report' },
      grantee: { kind: 'public' },
    },
  },
];

const ownerKind = (s: PickerStatement): 'subject' | 'role' | 'public' =>
  s.grantee.kind === 'agent' ? 'subject' : s.grantee.kind;

/** GET /api/cp/acl?datalakeId=&agentId= → the key's own deletable rows (envelope). */
export function makeAclRows(datalakeId: string, agentId?: string): AclRow[] {
  const subject = agentId ? agentSubject(agentId) : null;
  return FIXTURE_STATEMENTS.filter((f) => f.datalakeId === datalakeId)
    .filter((f) => {
      if (!subject) return true;
      return f.stmt.grantee.kind === 'agent' && agentSubject(f.stmt.grantee.agentId) === subject;
    })
    .map((f, i) => {
      const sql = emitStatement(f.stmt);
      return {
        id: f.id,
        datalakeId: f.datalakeId,
        granteeKind: ownerKind(f.stmt),
        grantee: parsedGranteeFromSpec(f.stmt.grantee).name,
        sql,
        stmt: sql, // legacy alias
        parsed: parsedFromSpec(f.stmt),
        version: i + 1,
        createdAt: f.createdAt,
      };
    });
}

/** GET /api/cp/agents/:id/grants → resolved own ∪ (held) role ∪ PUBLIC. */
export function makeResolvedGrants(agentId: string, datalakeId: string): ResolvedStatement[] {
  const subject = agentSubject(agentId);
  const rows = FIXTURE_STATEMENTS.filter((f) => f.datalakeId === datalakeId);

  const own = rows.filter((f) => f.stmt.grantee.kind === 'agent' && agentSubject(f.stmt.grantee.agentId) === subject);
  const heldRoles = new Set(
    own.filter((f) => f.stmt.kind === 'membership').map((f) => (f.stmt as { role: string }).role),
  );
  const roleRows = rows.filter((f) => f.stmt.grantee.kind === 'role' && heldRoles.has((f.stmt.grantee as { role: string }).role));
  const publicRows = rows.filter((f) => f.stmt.grantee.kind === 'public');

  const out: ResolvedStatement[] = [];
  const seen = new Set<string>();
  const push = (f: FixtureStatement, inherited: ResolvedStatement['inherited']) => {
    const sql = emitStatement(f.stmt);
    if (seen.has(sql)) return;
    seen.add(sql);
    out.push({ sql, parsed: parsedFromSpec(f.stmt), inherited });
  };
  for (const f of own) push(f, null);
  for (const f of roleRows) push(f, { via: 'role', role: (f.stmt.grantee as { role: string }).role });
  for (const f of publicRows) push(f, { via: 'public' });
  return out;
}

/** GET /api/cp/acl?datalakeId= (no agentId) → legacy shape for the ACL browser page. */
export function makeLegacyRows(datalakeId: string): GrantStatementRow[] {
  return FIXTURE_STATEMENTS.filter((f) => f.datalakeId === datalakeId).map((f, i) => ({
    id: f.id,
    datalakeId: f.datalakeId,
    granteeKind: ownerKind(f.stmt),
    grantee: parsedGranteeFromSpec(f.stmt.grantee).name,
    stmt: emitStatement(f.stmt),
    version: i + 1,
    createdAt: f.createdAt,
  }));
}

/** Author one statement from a POST body (target- or membership-based, or raw sql). */
export function authorFromBody(body: AclPostBody): { id: string; sql: string; parsed: ParsedStatement | null; createdAt: string } {
  const id = `grant_${Math.random().toString(16).slice(2, 10)}`;
  const createdAt = new Date().toISOString();

  // Raw SQL escape hatch (SQL tab paste/hand-authoring) — preserved verbatim, parsed unknown.
  if (typeof body.sql === 'string' && body.sql.trim()) {
    return { id, sql: body.sql.trim(), parsed: null, createdAt };
  }

  if (body.membership) {
    const spec: PickerStatement = {
      kind: 'membership',
      role: body.membership.role,
      grantee: body.membership.agentId
        ? { kind: 'agent', agentId: body.membership.agentId }
        : { kind: 'public' },
    };
    return { id, sql: emitStatement(spec), parsed: parsedFromSpec(spec), createdAt };
  }

  const grantee = bodyGrantee(body);
  const object: { schema: string; table: string } | { schema: string; allTables: true } =
    body.allTablesInSchema
      ? { schema: body.schema ?? '*', allTables: true }
      : { schema: body.schema ?? '*', table: body.table ?? '*' };
  const spec: PickerStatement = {
    kind: 'object',
    effect: body.effect === 'deny' ? 'deny' : 'allow',
    privileges: (body.privileges ?? []).filter((p) => (PRIVILEGES as readonly string[]).includes(p)),
    columns: body.columns && body.columns.length ? body.columns : null,
    object,
    grantee,
  };
  return { id, sql: emitStatement(spec), parsed: parsedFromSpec(spec), createdAt };
}

function bodyGrantee(body: AclPostBody): PickerStatement['grantee'] {
  const t = body.target;
  if (t?.kind === 'role') return { kind: 'role', role: t.role };
  if (t?.kind === 'public') return { kind: 'public' };
  if (t?.kind === 'agent') return { kind: 'agent', agentId: t.agentId };
  // Legacy body (subjectKind/agentId) — keep the old authoring path working.
  if (body.agentId) return { kind: 'agent', agentId: body.agentId };
  return { kind: 'public' };
}

/** The union of POST /api/cp/acl bodies the lab mock accepts (new + legacy + raw). */
export interface AclPostBody {
  datalakeId?: string;
  // new target-based
  target?:
    | { kind: 'agent'; agentId: string }
    | { kind: 'role'; role: string }
    | { kind: 'public' };
  membership?: { role: string; agentId?: string };
  privileges?: string[];
  columns?: string[];
  schema?: string;
  table?: string;
  allTablesInSchema?: boolean;
  effect?: 'allow' | 'deny';
  // raw SQL escape hatch
  sql?: string;
  // legacy
  agentId?: string;
  subjectKind?: 'agent' | 'user' | 'org';
}
