/**
 * Policy compiler (§3e, W1) — PURE & unit-testable.
 *
 * Turns active `acl_rule` rows for one (endpoint, agent-set) into:
 *   1. a `BirdshotSnapshot` (table-level read/write grants → birdshot)        [§3d row 1]
 *   2. a gateway constraint table (column/rowLimit/window → gateway proxy)     [§3d cols 5–7]
 *
 * The split is the load-bearing design decision (§3): birdshot ONLY does
 * table-level allow + revoke; columns/rows/windows are bypassable via views, so
 * they're enforced by the gateway query proxy instead. The compiler emits both
 * halves; the caller (api/cp/sessions, api/cp/acl) pushes each to its channel
 * (POST /gw/snapshot, POST /gw/constraints).
 *
 * `now` is injected so the pure function does the `not_before ≤ now < expires_at`
 * + time-of-day window filtering itself — which is exactly what makes it testable.
 *
 * birdshot role naming (§3a): one synthetic per-agent role `agent_<agentId>`, and
 * the JWT principal `agent:<agentId>` is mapped to it via add_user_role. Static
 * fallback roles (reader/writer) are not emitted here — they pre-exist in birdshot.
 */
import type { BirdshotSnapshot, BirdshotCatalogCapability } from './types';

// ── Capability taxonomy ───────────────────────────────────────────────────────
// The full grantable vocabulary (mirrors the acl_rule / acl_policy CHECK + the
// birdshot enum). `etl` is control-plane sugar — NOT a birdshot primitive — so it
// is never emitted to the snapshot (it would be expanded to create+read_source at
// authoring time if we surface it).
export type Capability =
  | 'read'
  | 'write'
  | 'create'
  | 'drop'
  | 'alter'
  | 'read_source'
  | 'copy_to'
  | 'copy_from'
  | 'attach'
  | 'detach'
  | 'install'
  | 'load'
  | 'etl';

/** Capabilities keyed to a CATALOG resource (schema.table[.db]) → roleGrants. */
const CATALOG_CAPABILITIES = new Set<Capability>([
  'read',
  'write',
  'create',
  'drop',
  'alter',
  'detach',
]);

/** Capabilities authorized at the PARSE layer (not the bind-walk). A column-
 *  constrained read cannot safely coexist with any of these for the same role
 *  until the bind-walk routing lands (see compilePolicy fail-closed guard). */
const PARSE_AUTHORIZED_CATALOG = new Set<Capability>([
  'create',
  'drop',
  'alter',
  'detach',
]);

/** Capabilities keyed to a NON-catalog resource (URI/extension name) → policies. */
const POLICY_CAPABILITIES = new Set<Capability>([
  'read_source',
  'copy_to',
  'copy_from',
  'attach',
  'install',
  'load',
]);

/** Map a policy capability to the birdshot policy family (snapshot.policies.kind). */
function policyKindFor(
  cap: Capability,
): 'source' | 'dest' | 'extension' | 'attach' | null {
  switch (cap) {
    case 'read_source':
    case 'copy_from':
      return 'source';
    case 'copy_to':
      return 'dest';
    case 'install':
    case 'load':
      return 'extension';
    case 'attach':
      return 'attach';
    default:
      return null;
  }
}

/**
 * Compiled per-(agent,table) column/row/window metadata. NOT pushed to the gateway
 * (column + window ACLs ride the birdshot snapshot's `roleConstraints`); this only
 * feeds the in-app SessionGrant `granted` view via {@link grantsForAgent}, so the
 * agent is told which columns/limits apply to each table it was granted.
 */
export interface CompiledConstraint {
  agentId: string;
  schema: string;
  table: string;
  /** Allow-listed columns; undefined ⇒ all columns of the granted table. */
  columns?: string[];
  /** Hard cap on returned rows; undefined ⇒ no cap. */
  rowLimit?: number;
  /** Time-of-day window (UTC, "HH:MM"/"HH:MM:SS"). */
  window?: { start: string; end: string };
  /** Absolute validity bounds (ISO-8601). */
  notBefore?: string;
  expiresAt?: string;
}

/** A row from `waddling.acl_rule` (snake_case, as read from Postgres). */
export interface AclRuleRow {
  id: string;
  org_id: string;
  datalake_id: string;
  agent_id: string | null; // null = org-wide
  schema_name: string;
  table_name: string;
  columns: string[] | null;
  verb: 'read' | 'write';
  /**
   * The grant's capability. Optional for backward-compat: callers that predate
   * the full taxonomy (and the unit tests) omit it, and the compiler falls back
   * to `verb`. Migration 010 backfilled `capability := verb` for existing rows,
   * so a row loaded from Postgres always carries it. Non-catalog capabilities
   * (read_source/copy/attach/install) never appear here — they ride acl_policy.
   */
  capability?: Capability;
  effect: 'allow' | 'deny';
  row_limit: number | null;
  ttl_seconds: number | null;
  window_start: string | null; // "HH:MM:SS" (UTC)
  window_end: string | null;
  not_before: Date | string | null;
  expires_at: Date | string | null;
  priority: number;
}

/**
 * A row destined for a birdshot per-role POLICY allowlist (non-catalog resource).
 * Sourced from waddling.acl_policy (direct agent/org rows) or derived from a
 * user's policies ∩ delegation scope. `agent_id` keys it to a synthetic role,
 * exactly like AclRuleRow; org-wide (`agent_id IS NULL`) rows are skipped (the
 * compiler has no agent roster to fan out to — same limitation as roleGrants).
 */
export interface AclPolicyRow {
  id: string;
  agent_id: string | null;
  policy_kind: 'source' | 'dest' | 'extension' | 'attach';
  capability: Capability;
  pattern: string;
  expires_at: Date | string | null;
}

export interface CompileResult {
  snapshot: BirdshotSnapshot;
  constraints: CompiledConstraint[];
  /** agentIds that ended up with at least one active allow grant. */
  activeAgentIds: string[];
}

export const birdshotRoleName = (agentId: string): string => `agent_${agentId}`;
export const birdshotPrincipal = (agentId: string): string => `agent:${agentId}`;

function toDate(v: Date | string | null): Date | null {
  if (v == null) return null;
  return v instanceof Date ? v : new Date(v);
}

/** Parse "HH:MM[:SS]" → minutes-since-midnight; null on bad input. */
function timeToMinutes(t: string | null): number | null {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Is `now` inside the (possibly wrap-around) UTC time-of-day window? */
function inTimeWindow(
  now: Date,
  start: string | null,
  end: string | null,
): boolean {
  const s = timeToMinutes(start);
  const e = timeToMinutes(end);
  if (s == null || e == null) return true; // no window ⇒ always open
  const cur = now.getUTCHours() * 60 + now.getUTCMinutes();
  // Same-day window [s,e); wrap-around (e<s) means "overnight".
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e;
}

/** True iff the rule is temporally active at `now` (absolute + time-of-day). */
export function isRuleActive(rule: AclRuleRow, now: Date): boolean {
  const nb = toDate(rule.not_before);
  const ex = toDate(rule.expires_at);
  if (nb && now < nb) return false;
  if (ex && now >= ex) return false;
  if (!inTimeWindow(now, rule.window_start, rule.window_end)) return false;
  return true;
}

const tableRef = (r: AclRuleRow): string => `${r.schema_name}.${r.table_name}`;

/** A grant's capability — explicit `capability` if present, else the legacy `verb`. */
const capOf = (r: AclRuleRow): Capability => (r.capability ?? r.verb) as Capability;

// Catalog shape for wildcard expansion (names only; GatewayCatalog is a structural
// supertype, so a cached snapshot is assignable here directly).
export interface CompileCatalog {
  schemas: { name: string; tables: { name: string }[] }[];
}

// Capabilities enforced via birdshot's BIND-walk against the lake-CATALOG-qualified
// bound ref (`lake.<schema>.<table>`). A schema/table WILDCARD grant (`main.*`) does
// NOT match a lake-qualified bound ref (only the `.*` prefix branch fires, and it is
// catalog-sensitive), so for these caps we EXPAND the wildcard into concrete
// `schema.table` refs from the real catalog — which DO match via the exact/suffix
// branch. The parse-authorized caps (create/drop/alter/detach) are matched on the
// PARSE-walk against bare refs and target new/named objects, so they keep their
// wildcard and are deliberately NOT expanded (expanding `create` would forbid
// creating any NOT-yet-existing table). birdshot itself is never loosened.
//
// KNOWN ASYMMETRY (intentional, not a bug to fix here): `drop`/`alter` are
// parse-authorized, so a broad `drop main.*` grant stays literal and matches only
// BARE refs on the parse-walk — a `DROP TABLE lake.main.foo` (the catalog-qualified
// form the MCP tells agents to use) under `drop main.*` would be denied. `read` is
// the proven need this phase; drop/alter target existing objects too and could join
// this set later, but are out of scope now. Documented so the denial isn't mysterious.
const BIND_WALK_CAPABILITIES = new Set<Capability>(['read', 'write']);

/**
 * Expand `read`/`write` wildcard rules (`schema='*'` and/or `table='*'`) into one
 * concrete rule per matching real table, preserving every field (capability/effect/
 * columns/limits/window/priority/agent) so precedence + deny carve-outs still work.
 * A wildcard that matches zero real tables emits nothing (covers nothing — honest;
 * the authoring UI blocks zero-match grants). Only applied when a catalog is known;
 * with no catalog the caller keeps today's literal-wildcard behavior.
 */
export function expandBindWalkWildcards(rules: AclRuleRow[], catalog: CompileCatalog): AclRuleRow[] {
  const bySchema = new Map<string, { real: string; tables: string[] }>();
  for (const s of catalog.schemas) {
    bySchema.set(s.name.toLowerCase(), { real: s.name, tables: s.tables.map((t) => t.name) });
  }
  const out: AclRuleRow[] = [];
  for (const r of rules) {
    const cap = capOf(r);
    const schemaWild = r.schema_name === '*';
    const tableWild = r.table_name === '*';
    if (!BIND_WALK_CAPABILITIES.has(cap) || (!schemaWild && !tableWild)) {
      out.push(r); // concrete, or a non-bind-walk capability → unchanged
      continue;
    }
    const schemas = schemaWild
      ? [...bySchema.values()]
      : bySchema.has(r.schema_name.toLowerCase())
        ? [bySchema.get(r.schema_name.toLowerCase())!]
        : [];
    for (const s of schemas) {
      const tables = tableWild ? s.tables : [r.table_name];
      for (const t of tables) {
        out.push({ ...r, schema_name: s.real, table_name: t });
      }
    }
    // zero matches ⇒ no grant emitted (covers nothing)
  }
  return out;
}

/**
 * Compile active rules → birdshot snapshot + gateway constraints.
 *
 * Precedence (§3c): at the same (agent, table, verb) selector, **deny wins over
 * allow** and a lower `priority` number is stronger. A denied selector emits no
 * birdshot grant (default-deny does the rest) and no constraint.
 *
 * Limitation (documented): birdshot's allow-only model can't express a concrete
 * deny carved out of a wildcard allow (e.g. allow `sales.*` but deny `sales.pii`)
 * because the grant is on the wildcard ref. Such carve-outs require catalog
 * expansion the control plane doesn't have; deny is honored only at an equal-or-
 * finer selector than the matching allow. The demo (§8) uses allow-list columns,
 * not deny rules, so this is unexercised.
 */
export function compilePolicy(
  rules: AclRuleRow[],
  now: Date,
  policyRows: AclPolicyRow[] = [],
  catalog?: CompileCatalog,
): CompileResult {
  // Expand read/write wildcards into concrete refs against the real catalog (so a
  // broad "entire schema/lake" grant authorizes lake-qualified reads WITHOUT
  // loosening birdshot). With no catalog, keep the literal-wildcard behavior.
  const active = (catalog ? expandBindWalkWildcards(rules, catalog) : rules).filter((r) =>
    isRuleActive(r, now),
  );

  // Key = agentId|tableRef|capability. Keep the strongest rule (lower priority
  // wins; deny beats allow on tie).
  type Resolved = AclRuleRow;
  const winner = new Map<string, Resolved>();
  for (const r of active) {
    const agent = r.agent_id ?? '*';
    const key = `${agent} ${tableRef(r)} ${capOf(r)}`;
    const prev = winner.get(key);
    if (!prev) {
      winner.set(key, r);
      continue;
    }
    if (r.priority < prev.priority) {
      winner.set(key, r);
    } else if (r.priority === prev.priority) {
      // deny wins on a true tie
      if (prev.effect === 'allow' && r.effect === 'deny') winner.set(key, r);
    }
  }

  const roleGrants: BirdshotSnapshot['roleGrants'] = [];
  const userRoles: BirdshotSnapshot['userRoles'] = [];
  const roleConstraints: NonNullable<BirdshotSnapshot['roleConstraints']> = [];
  const policies: NonNullable<BirdshotSnapshot['policies']> = [];
  const constraints: CompiledConstraint[] = [];
  const seenAgents = new Set<string>();
  const seenGrant = new Set<string>();
  const seenPolicy = new Set<string>();
  // Per-role bookkeeping for the fail-closed guard (Phase 3 prerequisite #2).
  const rolesWithColumnConstraint = new Set<string>();
  const rolesWithParseAuthorized = new Set<string>();

  // Ensure a per-agent role exists + is mapped to its JWT principal. Shared by the
  // grant loop and the policy loop (a policy-only agent still needs its userRole).
  const ensureRole = (agentId: string): string => {
    const role = birdshotRoleName(agentId);
    if (!seenAgents.has(agentId)) {
      seenAgents.add(agentId);
      userRoles.push({ userId: birdshotPrincipal(agentId), role });
    }
    return role;
  };

  for (const r of winner.values()) {
    if (r.effect !== 'allow') continue; // deny ⇒ omit grant (default-deny)
    // LIMITATION (documented): org-wide rules (agent_id IS NULL) produce no grants
    // here because birdshot grants are keyed to a synthetic per-agent role
    // (agent_<id>) and the pure compiler has no agent roster to fan out to. The
    // caller scopes by a concrete agentId (api/cp/sessions, recompile) so per-agent
    // rules cover the demo + Pro flows. Org-wide fan-out would require passing the
    // org's active agent list into compilePolicy — deferred (see W1 report).
    if (!r.agent_id) continue;

    const cap = capOf(r);
    // Only CATALOG capabilities become roleGrants. A policy capability (read_source/
    // copy/attach/install/load) or `etl` on an acl_rule row has no catalog resource
    // to key on — skip it (acl_policy is the channel for non-catalog resources).
    if (!CATALOG_CAPABILITIES.has(cap)) continue;

    const role = ensureRole(r.agent_id);
    if (PARSE_AUTHORIZED_CATALOG.has(cap)) rolesWithParseAuthorized.add(role);

    // A fully-wildcard DDL grant (create/drop/alter/detach on `*.*`) means "any
    // object". birdshot's RefMatch treats a bare `*` as match-everything, but `*.*`
    // falls into the `.*`-prefix branch and matches NOTHING (no real ref starts with
    // the literal "*."), so such grants silently authorized nothing — which is why an
    // agent with `create:*.*` still couldn't CREATE a new table. Emit `*` so the grant
    // means what it says. SCOPED to parse-authorized DDL caps: read/write keep their
    // catalog expansion (and stay fail-closed as literal `*.*` when the catalog is
    // unknown) — they are NEVER broadened to `*`, since that would expose row data.
    const ref =
      PARSE_AUTHORIZED_CATALOG.has(cap) && r.schema_name === '*' && r.table_name === '*'
        ? '*'
        : tableRef(r);
    const grantKey = `${role} ${ref} ${cap}`;
    if (!seenGrant.has(grantKey)) {
      seenGrant.add(grantKey);
      roleGrants.push({
        role,
        tableRef: ref,
        action: cap as BirdshotCatalogCapability,
      });
    }

    // Gateway-enforced constraints (only meaningful when something is constrained).
    if (
      (r.columns && r.columns.length > 0) ||
      r.row_limit != null ||
      r.window_start != null ||
      r.not_before != null ||
      r.expires_at != null
    ) {
      constraints.push({
        agentId: r.agent_id,
        schema: r.schema_name,
        table: r.table_name,
        columns: r.columns && r.columns.length > 0 ? r.columns : undefined,
        rowLimit: r.row_limit ?? undefined,
        window:
          r.window_start && r.window_end
            ? { start: r.window_start, end: r.window_end }
            : undefined,
        notBefore: toDate(r.not_before)?.toISOString(),
        expiresAt: toDate(r.expires_at)?.toISOString(),
      });
    }

    // birdshot-enforced constraints (Phase 2): ONLY columns + window — these are
    // what bind-walk enforces at the gateway authz hook. rowLimit (dropped) and
    // notBefore/expiresAt (compile-time + JWT) are deliberately NOT pushed here.
    // Emit only when there's something to enforce; a grant with neither stays a
    // plain table grant. Multiple entries for the same (role,table) — e.g. a read
    // rule and a write rule each carrying columns — are fail-safe: birdshot ANDs
    // them (a column must satisfy EVERY matching constraint), i.e. intersection.
    const hasCols = !!(r.columns && r.columns.length > 0);
    const hasWindow = r.window_start != null && r.window_end != null;
    if (hasCols) rolesWithColumnConstraint.add(role);
    if (hasCols || hasWindow) {
      roleConstraints.push({
        role,
        tableRef: tableRef(r),
        columns: hasCols ? r.columns! : undefined,
        window: hasWindow
          ? { start: r.window_start!, end: r.window_end! }
          : undefined,
      });
    }
  }

  // ── Non-catalog policies (Phase 3): acl_policy → per-role allowlists. ──────────
  // Expiry-filtered (no window/columns on a policy). Org-wide (agent_id IS NULL)
  // rows are skipped for the same reason grants are (no agent roster to fan out).
  for (const p of policyRows) {
    const ex = toDate(p.expires_at);
    if (ex && now >= ex) continue;
    if (!p.agent_id) continue;
    if (!POLICY_CAPABILITIES.has(p.capability)) continue;
    const kind = policyKindFor(p.capability);
    if (!kind) continue;

    const role = ensureRole(p.agent_id);
    rolesWithParseAuthorized.add(role); // every policy rides the parse path
    const pKey = `${role} ${kind} ${p.pattern}`;
    if (!seenPolicy.has(pKey)) {
      seenPolicy.add(pKey);
      policies.push({ role, kind, pattern: p.pattern });
    }
  }

  // ── FAIL-CLOSED guard (Phase 3 prerequisite #2). ──────────────────────────────
  // A column-constrained grant enforces its allow-list via the bind-walk on plain
  // SELECT, but via the OLD parse-walk approximations on the parse-authorized path
  // (CTAS/COPY) — where a missed column attribution under-denies. Until catalog
  // reads are routed back through the bind-walk on that path (a birdshot C++
  // change), a role that mixes a column allow-list with any parse-authorized
  // capability (create/drop/alter/detach) or policy is NOT safely enforceable.
  //
  // Fail-closed is PER-ROLE, not per-endpoint: drop just the offending role's
  // grants + policies (deny that one agent) and keep compiling everyone else.
  // compileEndpointPolicy compiles every agent on the endpoint in one call, so
  // throwing here would brick the whole endpoint — and at authoring time the
  // acl_rule row is already persisted, so the brick would be permanent. A normal
  // ETL config (column-constrained read + create + read_source on one role) trips
  // this, so it must degrade gracefully, not take the endpoint down.
  const trippedRoles = new Set<string>();
  for (const role of rolesWithColumnConstraint) {
    if (rolesWithParseAuthorized.has(role)) trippedRoles.add(role);
  }

  let outGrants = roleGrants;
  let outConstraints = roleConstraints;
  let outPolicies = policies;
  let outUserRoles = userRoles;
  let outConstraintViews = constraints;
  let activeAgentIds = [...seenAgents];
  if (trippedRoles.size > 0) {
    const trippedAgents = new Set<string>();
    for (const role of trippedRoles) {
      console.warn(
        `[policy-compiler] fail-closed: dropping role ${role} — it mixes a column ` +
          `allow-list with a parse-authorized capability/policy (create/drop/alter/` +
          `detach/source/dest/attach/extension). The parse-path column check is ` +
          `approximate; this agent is denied until catalog reads route through the ` +
          `bind-walk. Other agents on the endpoint are unaffected.`,
      );
    }
    for (const aid of seenAgents) {
      if (trippedRoles.has(birdshotRoleName(aid))) trippedAgents.add(aid);
    }
    outGrants = roleGrants.filter((g) => !trippedRoles.has(g.role));
    outConstraints = roleConstraints.filter((rc) => !trippedRoles.has(rc.role));
    outPolicies = policies.filter((p) => !trippedRoles.has(p.role));
    outUserRoles = userRoles.filter((ur) => !trippedRoles.has(ur.role));
    outConstraintViews = constraints.filter((cv) => !trippedAgents.has(cv.agentId));
    activeAgentIds = activeAgentIds.filter((aid) => !trippedAgents.has(aid));
  }

  return {
    snapshot: {
      roleGrants: outGrants,
      userRoles: outUserRoles,
      roleConstraints: outConstraints,
      policies: outPolicies,
    },
    constraints: outConstraintViews,
    activeAgentIds,
  };
}

/**
 * Build a SessionGrant view (for ConnectResult.granted / whoami) from the compiled
 * birdshot grants + constraints for a single agent. Merges read/write verbs per
 * table and attaches column/rowLimit constraints.
 */
export function grantsForAgent(
  result: CompileResult,
  agentId: string,
): import('./types').SessionGrant {
  const role = birdshotRoleName(agentId);
  const byTable = new Map<
    string,
    {
      schema: string;
      table: string;
      verbs: Set<'read' | 'write'>;
      columns?: string[];
      rowLimit?: number;
    }
  >();

  // Non-read/write catalog capabilities (create/drop/alter/detach) the agent holds.
  // Not table "verbs" — they ride wildcard refs and target new/named objects — but
  // surfaced separately so an agent on an EMPTY lake (no read/write tables to list)
  // still learns it can bootstrap tables.
  const ddlCaps = new Set<'create' | 'drop' | 'alter' | 'detach'>();
  for (const g of result.snapshot.roleGrants) {
    if (g.role !== role) continue;
    const [schema, table] = g.tableRef.split('.');
    const key = g.tableRef;
    // SessionGrant.verbs is read/write only (the human-facing view). Catalog
    // capabilities (create/drop/alter/detach) are real grants but not surfaced as
    // a table "verb" here; collect them into `capabilities` instead.
    if (g.action !== 'read' && g.action !== 'write') {
      if (g.action === 'create' || g.action === 'drop' || g.action === 'alter' || g.action === 'detach') {
        ddlCaps.add(g.action);
      }
      continue;
    }
    const e = byTable.get(key) ?? { schema, table, verbs: new Set() };
    e.verbs.add(g.action);
    byTable.set(key, e);
  }
  for (const c of result.constraints) {
    if (c.agentId !== agentId) continue;
    const key = `${c.schema}.${c.table}`;
    const e = byTable.get(key);
    if (!e) continue;
    if (c.columns) e.columns = c.columns;
    if (c.rowLimit != null) e.rowLimit = c.rowLimit;
  }

  return {
    tables: [...byTable.values()].map((e) => ({
      schema: e.schema,
      table: e.table,
      verbs: [...e.verbs],
      columns: e.columns,
      rowLimit: e.rowLimit,
    })),
    capabilities: ddlCaps.size > 0 ? [...ddlCaps] : undefined,
  };
}
