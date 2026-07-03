/**
 * access-draft — the canonical model behind the AccessManager (Picker + Grant SQL).
 *
 * The control plane's ONLY representation of a key's access is literal GRANT/DENY
 * SQL. So the in-memory model here is an ORDERED list of the key's own statement
 * strings (each carrying its row `id` once persisted). The Picker is a PROJECTION
 * over that list — never a parallel structured model — which is what keeps the two
 * tabs from drifting.
 *
 * This module is PURE (no React, no 'use client'): the same `emitStatement`
 * grammar is imported by the lab mock routes + fixtures so their `sql` is
 * byte-identical to what the client emits. That byte-identity is what makes the
 * string-identity `diffDraft` stable — a stray space would otherwise show up as a
 * phantom add+delete on every save.
 *
 * SQL → structured is NEVER done client-side: the server hands us `parsed` per
 * row (`ParsedStatement | null`). We bind `parsed`; `parsed === null` is a
 * hand-written/exotic form that lives in the read-only "Advanced" bucket.
 */

// ── Vocabulary ──────────────────────────────────────────────────────────────

/** The granular privilege vocabulary birdshot enforces (mirrors control-api). */
export const PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'CREATE',
  'DROP',
  'ALTER',
  'USAGE',
  'EXECUTE',
] as const;
export type Privilege = (typeof PRIVILEGES)[number];

export type AclEffect = 'allow' | 'deny';

// ── Catalog (schema browser) shape ────────────────────────────────────────────
// GET /api/cp/datalakes/:id/catalog → { schemas, fetchedAt, stale? }.
export interface CatalogColumn {
  name: string;
  type: string;
}
export interface CatalogTable {
  name: string;
  columns: CatalogColumn[];
}
export interface CatalogSchema {
  name: string;
  tables: CatalogTable[];
}

// ── Server-decomposed statement (bound directly; never parsed client-side) ────

/** The object a statement targets, as decomposed by the server. */
export type ParsedObject =
  | { schema: string; table: string }
  | { schema: string; allTables: true }
  | { raw: string }
  | null;

/** The subject/role/public a statement grants to. */
export interface ParsedGrantee {
  kind: 'subject' | 'agent' | 'role' | 'public' | 'user' | 'org';
  name: string;
}

/**
 * The server's structured decomposition of one literal statement. Bound directly
 * by the Picker; `parsed === null` on a row means it's exotic → Advanced bucket.
 */
export interface ParsedStatement {
  kind: 'object' | 'membership';
  effect: AclEffect;
  /** SQL keyword the statement leads with (grant | deny). */
  action: string;
  privileges: string[];
  columns: string[] | null;
  object: ParsedObject;
  grantee: ParsedGrantee;
  /** Role name for `kind: 'membership'` (GRANT <role> TO <subject>). */
  role?: string;
}

// ── Response rows (the two endpoints the manager reads) ───────────────────────

/**
 * A stored ACL row from GET /api/cp/acl?datalakeId=&agentId= (returned inside a
 * `{ statements: AclRow[] }` envelope). `sql` is canonical; `stmt` is a legacy
 * alias. The AccessManager reads `id`, `sql`, `parsed`.
 */
export interface AclRow {
  id: string;
  sql: string;
  /** Legacy alias for `sql`. */
  stmt?: string;
  parsed: ParsedStatement | null;
  createdAt: string;
  datalakeId?: string;
  granteeKind?: 'subject' | 'role' | 'public';
  grantee?: string;
  version?: number;
}

/** GET /api/cp/agents/:id/grants → { statements: ResolvedStatement[] } (own ∪ role ∪ PUBLIC). */
export interface ResolvedStatement {
  sql: string;
  parsed: ParsedStatement | null;
  inherited: null | { via: 'role'; role: string } | { via: 'public' };
}

// ── Picker specs → literal SQL (Picker → SQL: always, lossless) ───────────────

export type GranteeSpec =
  | { kind: 'agent'; agentId: string }
  | { kind: 'role'; role: string }
  | { kind: 'public' };

/** A single object grant/deny row assembled in the Picker. */
export interface ObjectSpec {
  kind: 'object';
  effect: AclEffect;
  privileges: string[];
  columns?: string[] | null;
  object: { schema: string; table: string } | { schema: string; allTables: true };
  grantee: GranteeSpec;
}

/** A role-membership grant (GRANT <role> TO <subject>). */
export interface MembershipSpec {
  kind: 'membership';
  role: string;
  grantee: GranteeSpec;
}

export type PickerStatement = ObjectSpec | MembershipSpec;

export function objectRefSql(object: ObjectSpec['object']): string {
  return 'allTables' in object
    ? `ALL TABLES IN SCHEMA ${object.schema}`
    : `${object.schema}.${object.table}`;
}

export function granteeSql(g: GranteeSpec): string {
  switch (g.kind) {
    case 'agent':
      return `agent:${g.agentId}`;
    case 'role':
      return `ROLE ${g.role}`;
    case 'public':
      return 'PUBLIC';
  }
}

/**
 * Emit exactly one literal statement from a Picker spec. This is THE grammar —
 * mirrored by the lab mock so client-emit === server-stored (see module header).
 */
export function emitStatement(spec: PickerStatement): string {
  if (spec.kind === 'membership') {
    return `GRANT ${spec.role} TO ${granteeSql(spec.grantee)}`;
  }
  const cols = spec.columns && spec.columns.length ? ` (${spec.columns.join(', ')})` : '';
  const privList = spec.privileges.map((p) => `${p}${cols}`).join(', ');
  const verb = spec.effect === 'deny' ? 'DENY' : 'GRANT';
  return `${verb} ${privList} ON ${objectRefSql(spec.object)} TO ${granteeSql(spec.grantee)}`;
}

/** The `POST /api/cp/acl` author body for an object grant (target-based contract). */
export function grantBody(spec: ObjectSpec, datalakeId: string) {
  const target =
    spec.grantee.kind === 'agent'
      ? { kind: 'agent' as const, agentId: spec.grantee.agentId }
      : spec.grantee.kind === 'role'
        ? { kind: 'role' as const, role: spec.grantee.role }
        : { kind: 'public' as const };
  const objectPart =
    'allTables' in spec.object
      ? { schema: spec.object.schema, allTablesInSchema: true as const }
      : { schema: spec.object.schema, table: spec.object.table };
  return {
    datalakeId,
    target,
    privileges: spec.privileges,
    effect: spec.effect,
    ...(spec.columns && spec.columns.length ? { columns: spec.columns } : {}),
    ...objectPart,
  };
}

/** The `POST /api/cp/acl` author body for a role membership. */
export function membershipBody(spec: MembershipSpec, datalakeId: string) {
  const agentId = spec.grantee.kind === 'agent' ? spec.grantee.agentId : undefined;
  return { datalakeId, membership: { role: spec.role, agentId } };
}

/** The `parsed` decomposition of a Picker spec — the inverse of `emitStatement`.
 * NOTE: this decomposes STRUCTURED input the user just assembled — it is NOT a
 * SQL parser (SQL → structured is always server-side). It lets the tree repaint
 * live as the draft is edited, before any Save round-trip. */
export function parsedGranteeFromSpec(g: GranteeSpec): ParsedGrantee {
  if (g.kind === 'agent') return { kind: 'subject', name: `agent:${g.agentId}` };
  if (g.kind === 'role') return { kind: 'role', name: g.role };
  return { kind: 'public', name: '' };
}

export function parsedFromSpec(spec: PickerStatement): ParsedStatement {
  if (spec.kind === 'membership') {
    return {
      kind: 'membership',
      effect: 'allow',
      action: 'grant',
      privileges: [],
      columns: null,
      object: null,
      grantee: parsedGranteeFromSpec(spec.grantee),
      role: spec.role,
    };
  }
  const object =
    'allTables' in spec.object
      ? { schema: spec.object.schema, allTables: true as const }
      : { schema: spec.object.schema, table: spec.object.table };
  return {
    kind: 'object',
    effect: spec.effect,
    action: spec.effect === 'deny' ? 'deny' : 'grant',
    privileges: spec.privileges,
    columns: spec.columns && spec.columns.length ? spec.columns : null,
    object,
    grantee: parsedGranteeFromSpec(spec.grantee),
  };
}

// ── The draft (ordered own statements) + string-identity diff ─────────────────

export interface DraftStatement {
  sql: string;
  parsed: ParsedStatement | null;
  /** Present iff this statement is already persisted (carries the deletable row id). */
  id?: string;
}

export interface DraftDiff {
  /** New statement strings to POST. */
  added: DraftStatement[];
  /** Persisted rows to DELETE (removed from the draft). */
  removed: { id: string; sql: string }[];
}

/** Build a draft from the loaded own ACL rows. */
export function draftFromRows(rows: AclRow[]): DraftStatement[] {
  return rows.map((r) => ({ sql: r.sql, parsed: r.parsed, id: r.id }));
}

/** Build one draft statement from a Picker spec (sql + parsed, no id yet). */
export function draftFromSpec(spec: PickerStatement): DraftStatement {
  return { sql: emitStatement(spec), parsed: parsedFromSpec(spec) };
}

/**
 * The POST /api/cp/acl author body for one draft statement.
 *  - `parsed === null` (raw/exotic) → `{ datalakeId, sql }` (raw escape hatch).
 *  - membership → `{ datalakeId, membership }`.
 *  - object → target-based body; a subject grant uses `subjectAgentId` (omitted in
 *    create, where the server defaults the target to the new agent).
 */
export function authorBody(
  stmt: DraftStatement,
  datalakeId: string,
  opts: { subjectAgentId?: string } = {},
): Record<string, unknown> {
  const { parsed, sql } = stmt;
  if (!parsed) return { datalakeId, sql };
  if (parsed.kind === 'membership') {
    return { datalakeId, membership: { role: parsed.role ?? '', agentId: opts.subjectAgentId } };
  }
  const target =
    parsed.grantee.kind === 'role'
      ? { kind: 'role' as const, role: parsed.grantee.name }
      : parsed.grantee.kind === 'public'
        ? { kind: 'public' as const }
        : opts.subjectAgentId
          ? { kind: 'agent' as const, agentId: opts.subjectAgentId }
          : undefined;
  const obj = parsed.object;
  const objectPart =
    obj && 'allTables' in obj
      ? { schema: obj.schema, allTablesInSchema: true }
      : obj && 'table' in obj
        ? { schema: obj.schema, table: obj.table }
        : {};
  return {
    datalakeId,
    ...(target ? { target } : {}),
    privileges: parsed.privileges,
    ...(parsed.columns && parsed.columns.length ? { columns: parsed.columns } : {}),
    effect: parsed.effect,
    ...objectPart,
  };
}

/**
 * Diff two drafts by statement-string identity → the minimal DELETE + POST set.
 * A changed statement is a delete + a create (identity-keyed, no in-place update).
 */
export function diffDraft(existing: DraftStatement[], draft: DraftStatement[]): DraftDiff {
  const existingBySql = new Map(existing.map((s) => [s.sql, s]));
  const draftSql = new Set(draft.map((s) => s.sql));
  const added = draft.filter((s) => !existingBySql.has(s.sql));
  const removed = existing
    .filter((s) => s.id != null && !draftSql.has(s.sql))
    .map((s) => ({ id: s.id as string, sql: s.sql }));
  return { added, removed };
}

// ── Effective-state / provenance resolver (the trust element, P2/P6) ──────────
//
// Node status is computed CLIENT-SIDE from the server's `parsed` fields over the
// full resolved set (own ∪ role ∪ PUBLIC ∪ denies) — never by re-parsing SQL.

export type Provenance = 'direct' | 'role' | 'public';

/** One normalized object grant/deny fact used to paint the tree. */
export interface GrantFact {
  effect: AclEffect;
  privileges: string[];
  columns: string[] | null;
  scope:
    | { type: 'table'; schema: string; table: string }
    | { type: 'schema'; schema: string }
    | { type: 'raw'; raw: string };
  provenance: Provenance;
  role?: string;
}

/** Normalize a parsed OBJECT statement into a GrantFact (membership → null). */
export function factFromParsed(
  parsed: ParsedStatement,
  inherited: ResolvedStatement['inherited'],
): GrantFact | null {
  if (parsed.kind !== 'object' || !parsed.object) return null;
  const provenance: Provenance =
    inherited == null ? 'direct' : inherited.via === 'role' ? 'role' : 'public';
  const role = inherited != null && inherited.via === 'role' ? inherited.role : undefined;
  const obj = parsed.object;
  const scope: GrantFact['scope'] =
    'allTables' in obj
      ? { type: 'schema', schema: obj.schema }
      : 'schema' in obj
        ? { type: 'table', schema: obj.schema, table: obj.table }
        : { type: 'raw', raw: obj.raw };
  return {
    effect: parsed.effect,
    privileges: parsed.privileges,
    columns: parsed.columns,
    scope,
    provenance,
    role,
  };
}

/** Held role names, from membership statements in the resolved set. */
export function heldRoles(statements: ResolvedStatement[]): string[] {
  const roles = new Set<string>();
  for (const s of statements) {
    if (s.parsed && s.parsed.kind === 'membership' && s.parsed.role) roles.add(s.parsed.role);
  }
  return [...roles];
}

export type NodeStatus =
  | { status: 'none' }
  | {
      status: 'allowed';
      via: 'direct' | 'schema' | 'role' | 'public';
      privileges: string[];
      columns: string[] | null;
      role?: string;
    }
  | { status: 'denied'; via: 'direct' | 'carve-out'; role?: string };

const VIA_RANK: Record<'direct' | 'schema' | 'role' | 'public', number> = {
  direct: 3,
  schema: 2,
  role: 1,
  public: 0,
};

function allowVia(fact: GrantFact, atTable: boolean): 'direct' | 'schema' | 'role' | 'public' {
  if (fact.provenance === 'public') return 'public';
  if (fact.provenance === 'role') return 'role';
  // direct: distinguish an exact-table grant from a schema-wildcard one.
  return fact.scope.type === 'schema' && atTable ? 'schema' : 'direct';
}

/**
 * Resolve the effective status of a node. `table === null` → a schema node
 * (only schema-wildcard facts on that schema apply). `table` set → a table node
 * (exact-table facts + schema-wildcard facts covering it). Deny-wins.
 */
export function nodeStatus(facts: GrantFact[], schema: string, table: string | null): NodeStatus {
  const matches = facts.filter((f) => {
    if (f.scope.type === 'raw') return false;
    if (f.scope.type === 'schema') return f.scope.schema === schema;
    // table-scoped fact
    return table !== null && f.scope.schema === schema && f.scope.table === table;
  });
  if (matches.length === 0) return { status: 'none' };

  const denies = matches.filter((f) => f.effect === 'deny');
  const allows = matches.filter((f) => f.effect === 'allow');

  if (denies.length > 0) {
    // A table-specific deny sitting under a broader (schema-wildcard) allow is a
    // carve-out; anything else reads as an explicit deny.
    const tableDeny = denies.find((f) => f.scope.type === 'table');
    const broaderAllow = allows.find((f) => f.scope.type === 'schema');
    if (table !== null && tableDeny && broaderAllow) {
      return { status: 'denied', via: 'carve-out', role: broaderAllow.role };
    }
    return { status: 'denied', via: 'direct' };
  }

  const atTable = table !== null;
  let best: GrantFact | null = null;
  let bestRank = -1;
  for (const f of allows) {
    const rank = VIA_RANK[allowVia(f, atTable)];
    if (rank > bestRank) {
      bestRank = rank;
      best = f;
    }
  }
  if (!best) return { status: 'none' };
  const via = allowVia(best, atTable);
  // Union privileges across the winning provenance tier so "SELECT, INSERT" reads whole.
  const privileges = [
    ...new Set(allows.filter((f) => allowVia(f, atTable) === via).flatMap((f) => f.privileges)),
  ];
  return { status: 'allowed', via, privileges, columns: best.columns, role: best.role };
}
