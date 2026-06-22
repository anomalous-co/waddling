/**
 * Effective-policy derivation (Plan Part B §2).
 *
 * Two exports:
 *   deriveEffectiveRules — PURE. Intersects a user's acl_rule grants with a
 *     delegation scope to produce per-agent birdshot-ready rows. Unit-tested.
 *   compileEndpointPolicy — DB-bound. Loads all acl_rule rows for a datalake,
 *     enumerates every delegated/owned agent, derives effective rules for each,
 *     unions with direct agent rows, then calls the UNCHANGED compilePolicy.
 *
 * INVARIANT: compilePolicy is never modified here; all derivation lives in this
 * file. Derived rows are never persisted — revoke a user grant and the next
 * connect/recompile shrinks every agent that user owns or consents.
 *
 * Phase 1 note: only read/write capabilities produce birdshot grant rows. All
 * other capabilities (create/drop/alter/read_source/copy_to/copy_from/attach/
 * detach/install/load/etl) are control-plane-only in Phase 1 and MUST NOT be
 * emitted as birdshot verb rows; birdshot cannot enforce them yet (Phase 2).
 */
import { query } from './db';
import { getCachedCatalog } from './catalog-cache';
import {
  compilePolicy,
  type AclRuleRow,
  type AclPolicyRow,
  type CompileResult,
} from './policy-compiler';

// ── Capability taxonomy ──────────────────────────────────────────────────────

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

/**
 * Catalog capabilities (Phase 3): these intersect a user grant with a delegation
 * scope and emit an acl_rule-shaped row carrying `capability` for the compiler to
 * key on. read/write ride the bind-walk; create/drop/alter/detach are parse-layer.
 * `etl` and the non-catalog capabilities (read_source/copy/attach/install/load)
 * never become acl_rule rows — the latter ride acl_policy (deriveEffectivePolicies).
 */
const CATALOG_CAPABILITIES = new Set<Capability>([
  'read',
  'write',
  'create',
  'drop',
  'alter',
  'detach',
]);

/** Capabilities matched by a per-role policy allowlist (acl_policy, not acl_rule). */
const POLICY_CAPABILITIES = new Set<Capability>([
  'read_source',
  'copy_to',
  'copy_from',
  'attach',
  'install',
  'load',
]);

/** The legacy read|write verb a catalog capability maps to (write-class → write). */
function verbForCapability(cap: Capability): 'read' | 'write' {
  return cap === 'write' ? 'write' : 'read';
}

// ── Extended row shapes ──────────────────────────────────────────────────────

/**
 * acl_rule row after migration 010 (adds subject_kind / user_id / capability).
 * Extends AclRuleRow for use inside this file; policy-compiler sees only the
 * base AclRuleRow fields (backward-compatible — no required-field change).
 */
export interface AclRuleRowFull extends AclRuleRow {
  subject_kind: 'agent' | 'user' | 'org';
  user_id: string | null;
  capability: Capability;
}

/**
 * A row from waddling.delegation — per-(user, agent|client_id) scope.
 * Mirrors the migration 010 DDL exactly (no not_before column).
 */
export interface DelegationRow {
  id: string;
  org_id: string;
  user_id: string;
  agent_id: string | null;
  client_id: string | null;
  datalake_id: string | null; // NULL = all datalakes
  schema_name: string;
  table_name: string;
  columns: string[] | null;
  capability: Capability;
  row_limit: number | null;
  window_start: string | null; // "HH:MM:SS" UTC
  window_end: string | null;
  expires_at: Date | string | null;
  created_by: string;
  created_at: Date | string;
}

// ── Resource-selector intersection helpers ──────────────────────────────────

/**
 * Intersect two schema/table selectors (NULL and '*' both mean wildcard).
 * Returns the more-specific value; returns null when the two are disjoint.
 *
 *   ('*', 'sales')   → 'sales'   (one wildcard → other)
 *   ('sales', 'sales') → 'sales' (equal → same)
 *   ('sales', 'hr')  → null      (disjoint)
 */
function intersectSelector(a: string, b: string): string | null {
  const aWild = a === '*';
  const bWild = b === '*';
  if (aWild && bWild) return '*';
  if (aWild) return b;
  if (bWild) return a;
  return a === b ? a : null;
}

/**
 * Intersect two column allow-lists.
 *   null  → all columns (wildcard)
 *   []    → no columns (empty allow-list: grants nothing)
 *
 * null ∩ X → X   (wildcard yields to the more specific)
 * X ∩ null → X
 * X ∩ Y → common elements (if empty, the grant becomes vacuous — caller drops it)
 */
function intersectColumns(
  a: string[] | null,
  b: string[] | null,
): string[] | null {
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  return a.filter((col) => b.includes(col));
}

/**
 * Intersect two time-of-day windows (UTC "HH:MM[:SS]" strings).
 * null on either side ⇒ no window constraint; use the other side.
 * Both set ⇒ [max(start), min(end)). If start >= end (disjoint or point), drop.
 *
 * Wrap-around windows (end < start) are not modelled in a single row; if
 * the intersection would require multi-interval arithmetic we conservatively
 * drop the rule (fail-closed).
 */
function intersectWindow(
  aStart: string | null,
  aEnd: string | null,
  bStart: string | null,
  bEnd: string | null,
): { start: string; end: string } | null | 'no-constraint' {
  const aHas = aStart != null && aEnd != null;
  const bHas = bStart != null && bEnd != null;

  if (!aHas && !bHas) return 'no-constraint';
  if (!aHas) return { start: bStart!, end: bEnd! };
  if (!bHas) return { start: aStart!, end: aEnd! };

  // Both have windows — take the tighter bound.
  const start = aStart! > bStart! ? aStart! : bStart!;
  const end = aEnd! < bEnd! ? aEnd! : bEnd!;

  if (start >= end) return null; // disjoint or zero-width: drop
  return { start, end };
}

function toIso(v: Date | string | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : v;
}

// ── Core derivation ──────────────────────────────────────────────────────────

/**
 * Derive effective birdshot-ready rules for `agentId` by intersecting
 * the user's ACL grants with their delegation scope for this agent.
 *
 * Rules:
 *  - Only (userGrant, scopeEntry) pairs where the capability matches on BOTH
 *    sides produce an allow row. A grant with no matching scope entry produces
 *    nothing (principle of least privilege).
 *  - Resource selectors are intersected dimension-by-dimension; if either
 *    dimension is disjoint, the pair is dropped.
 *  - Columns: set-intersection (null = all). If the result is an empty set,
 *    the row is dropped (empty allow-list grants nothing).
 *  - row_limit: min of non-null values.
 *  - window: intersection; empty or wrap-around → drop.
 *  - expires_at: min (tightest). not_before: max of user grant side only
 *    (DelegationRow has no not_before column).
 *  - effect='deny' user grants are ALWAYS carried through unchanged (with
 *    agent_id rewritten to agentId, subject_kind='agent') so they suppress
 *    matching allows in compilePolicy's priority/deny-wins pass. Only
 *    read/write-capability denies are rewritten; other capabilities are dropped
 *    (birdshot can't enforce them in Phase 1).
 *  - The output rows are typed as AclRuleRow (not AclRuleRowFull) so they feed
 *    compilePolicy without modification.
 *
 * @param userGrants  subject_kind='user' acl_rule rows for the owner on this datalake.
 * @param scope       waddling.delegation rows for (user, agentId, datalakeId|NULL).
 * @param agentId     The agent whose effective rules are being derived.
 * @param now         Passed through so the function stays pure/unit-testable.
 */
export function deriveEffectiveRules(
  userGrants: AclRuleRowFull[],
  scope: DelegationRow[],
  agentId: string,
  now: Date,
): AclRuleRow[] {
  const derived: AclRuleRow[] = [];

  for (const grant of userGrants) {
    // ── Deny preservation ────────────────────────────────────────────────────
    // A user-level deny is carried to the agent directly, regardless of scope.
    // This means an agent can never exceed its owner: if the owner has been
    // denied something, the agent is denied it too. Only CATALOG capabilities
    // (read/write/create/drop/alter/detach) are carried — birdshot has no deny
    // mechanism for the allowlist-based policy capabilities (a missing pattern
    // IS the deny), and `etl` is control-plane sugar, so those are dropped.
    if (grant.effect === 'deny') {
      if (!CATALOG_CAPABILITIES.has(grant.capability)) continue;
      derived.push({
        ...grant,
        agent_id: agentId,
        subject_kind: 'agent' as const,
        user_id: null,
        capability: grant.capability,
        verb: verbForCapability(grant.capability),
      } as AclRuleRow);
      continue;
    }

    // ── Allow intersection ────────────────────────────────────────────────────
    // An allow grant is granted to the agent only if both:
    //   1. The grant's capability matches at least one scope entry, AND
    //   2. The resource selectors overlap.
    // Only CATALOG capabilities become acl_rule rows here; non-catalog policy
    // capabilities ride deriveEffectivePolicies (acl_policy ∩ scope).
    if (!CATALOG_CAPABILITIES.has(grant.capability)) continue;

    for (const entry of scope) {
      // Capability must match on both sides.
      if (entry.capability !== grant.capability) continue;

      // Resource intersection: schema then table.
      const schema = intersectSelector(grant.schema_name, entry.schema_name);
      if (schema === null) continue;

      const table = intersectSelector(grant.table_name, entry.table_name);
      if (table === null) continue;

      // Column intersection.
      const cols = intersectColumns(grant.columns, entry.columns);
      // Empty array = empty allow-list = grants nothing; drop.
      if (cols !== null && cols.length === 0) continue;

      // row_limit: min of non-null.
      const rowLimit =
        grant.row_limit !== null && entry.row_limit !== null
          ? Math.min(grant.row_limit, entry.row_limit)
          : grant.row_limit !== null
            ? grant.row_limit
            : entry.row_limit;

      // Window intersection.
      const win = intersectWindow(
        grant.window_start,
        grant.window_end,
        entry.window_start,
        entry.window_end,
      );
      if (win === null) continue; // disjoint window: drop
      const windowStart =
        win === 'no-constraint' ? null : win.start;
      const windowEnd =
        win === 'no-constraint' ? null : win.end;

      // expires_at: min (tightest).
      const grantExpiry = toIso(grant.expires_at);
      const entryExpiry = toIso(entry.expires_at);
      let expiresAt: string | null;
      if (grantExpiry && entryExpiry) {
        expiresAt = grantExpiry < entryExpiry ? grantExpiry : entryExpiry;
      } else {
        expiresAt = grantExpiry ?? entryExpiry;
      }

      // not_before: comes from the user grant side only (DelegationRow has none).
      const notBefore = grant.not_before;

      const row: AclRuleRow = {
        // Identity fields
        id: `derived:${grant.id}:${entry.id}`,
        org_id: grant.org_id,
        datalake_id: grant.datalake_id,
        agent_id: agentId,
        // Resource
        schema_name: schema,
        table_name: table,
        columns: cols,
        // Capability + legacy verb / effect
        capability: grant.capability,
        verb: verbForCapability(grant.capability),
        effect: 'allow',
        // Constraints
        row_limit: rowLimit,
        ttl_seconds: null, // already resolved to expires_at above
        window_start: windowStart,
        window_end: windowEnd,
        not_before: notBefore,
        expires_at: expiresAt,
        // Priority: inherit from the user grant (lower = stronger).
        priority: grant.priority,
      };
      derived.push(row);
    }
  }

  return derived;
}

// ── acl_policy (non-catalog resource) derivation ─────────────────────────────

/**
 * A waddling.acl_policy row after migration 012 — the per-subject allowlist for a
 * non-catalog resource (a read_source/copy URI, an install/load extension, an
 * attach target). Mirrors the migration DDL.
 */
export interface AclPolicyRowFull {
  id: string;
  org_id: string;
  datalake_id: string | null;
  subject_kind: 'agent' | 'user' | 'org';
  agent_id: string | null;
  user_id: string | null;
  policy_kind: 'source' | 'dest' | 'extension' | 'attach';
  capability: Capability;
  pattern: string;
  expires_at: Date | string | null;
  created_by: string;
  created_at: Date | string;
}

/**
 * Derive effective non-catalog policies for `agentId` by intersecting the owner's
 * acl_policy rows with their delegation scope.
 *
 * A delegation row has no `pattern` column — it cannot narrow a host/extension
 * allowlist — so the intersection is purely on CAPABILITY (and datalake): the
 * agent inherits the owner's pattern for any policy capability the owner delegated
 * to it. This preserves "agent ⊆ owner": the agent can only reach a resource the
 * owner already allowlisted, and only via a capability the owner explicitly
 * delegated. expires_at is the tightest of the policy's and the scope entry's.
 */
export function deriveEffectivePolicies(
  userPolicies: AclPolicyRowFull[],
  scope: DelegationRow[],
  agentId: string,
): AclPolicyRow[] {
  const derived: AclPolicyRow[] = [];

  for (const pol of userPolicies) {
    if (!POLICY_CAPABILITIES.has(pol.capability)) continue;

    // The owner must have delegated this exact policy capability to this agent.
    const matches = scope.filter((e) => e.capability === pol.capability);
    if (matches.length === 0) continue;

    // Tightest expiry across the policy and every matching scope entry.
    let expiresAt = toIso(pol.expires_at);
    for (const e of matches) {
      const eExp = toIso(e.expires_at);
      if (eExp && (!expiresAt || eExp < expiresAt)) expiresAt = eExp;
    }

    derived.push({
      id: `derived:${pol.id}`,
      agent_id: agentId,
      policy_kind: pol.policy_kind,
      capability: pol.capability,
      pattern: pol.pattern,
      expires_at: expiresAt,
    });
  }

  return derived;
}

// ── Database row shapes for enumeration ──────────────────────────────────────

interface AgentEnumerationRow {
  id: string;
  mode: 'delegated' | 'autonomous';
  owner_user_id: string | null; // set by delegated connect path
  name: string; // e.g. 'claude:<userId>' for delegated agents
  api_key_reference_id: string | null; // apikey.referenceId (autonomous owner)
}

// ── compileEndpointPolicy ─────────────────────────────────────────────────────

/**
 * Load all acl_rule rows for `datalakeId`, derive effective grants for every
 * delegated/owned agent live on this datalake, union with direct agent rows,
 * and compile the full endpoint policy via the UNCHANGED compilePolicy.
 *
 * Caller contract:
 *  - Subject=agent rows pass through directly (today's path, unaffected).
 *  - Subject=user rows are the derivation source; they are NEVER emitted as
 *    birdshot rows (compilePolicy skips them via the agent_id IS NULL guard and
 *    they have no agent_id at the DB level — but to be safe we exclude them from
 *    the allRules union entirely).
 *  - Subject=org rows pass through (compilePolicy already skips them via the
 *    `if (!r.agent_id) continue` guard — the "existing org-skip" referenced in
 *    the plan).
 *
 * On a datalake with no user grants and no delegations, this function returns
 * byte-identical output to the current `compilePolicy(rows, now)` call sites.
 */
export async function compileEndpointPolicy(
  datalakeId: string,
  now: Date,
): Promise<CompileResult> {
  // Load every acl_rule row for the endpoint (all subject_kinds).
  const { rows } = await query<AclRuleRowFull>(
    `SELECT * FROM waddling.acl_rule WHERE datalake_id = $1`,
    [datalakeId],
  );

  // Split by subject_kind.
  const directRows = rows.filter((r) => r.subject_kind !== 'user');
  const userGrantRows = rows.filter((r) => r.subject_kind === 'user');

  // Load every acl_policy row (non-catalog allowlists) for the endpoint, scoped to
  // this datalake OR global (datalake_id IS NULL). Split the same way as acl_rule:
  // direct (agent/org) → straight to the compiler; user → the policy derivation
  // source (intersected with each agent's delegation scope, never a principal).
  const { rows: polRows } = await query<AclPolicyRowFull>(
    `SELECT * FROM waddling.acl_policy
      WHERE datalake_id = $1 OR datalake_id IS NULL`,
    [datalakeId],
  );
  const directPolicies: AclPolicyRow[] = polRows
    .filter((p) => p.subject_kind !== 'user')
    .map((p) => ({
      id: p.id,
      agent_id: p.agent_id,
      policy_kind: p.policy_kind,
      capability: p.capability,
      pattern: p.pattern,
      expires_at: p.expires_at,
    }));
  const userPolicyRows = polRows.filter((p) => p.subject_kind === 'user');

  // Enumerate every delegated and autonomous-owned agent live on this datalake.
  // A "live" agent is one with an active or recent agent_session on this datalake,
  // OR whose owner has user-subject grants here. We enumerate from waddling.agent
  // directly — any agent that has a delegation row for this datalake is in scope.
  //
  // Delegated agents: mode='delegated'; owner = owner_user_id (set at connect time).
  //   Fallback: parse name 'claude:<userId>' when owner_user_id is not yet populated
  //   (the column exists but sessions.ts didn't set it before Phase 1 deploy).
  // Autonomous agents: mode='autonomous'; owner = apikey.referenceId.
  //
  // We enumerate the union of:
  //   a) agents that own a delegation row for (datalakeId OR NULL datalake).
  //   b) agents whose owner has user-subject grants on this datalake.
  // This ensures we derive rules for every agent that COULD get effective grants;
  // if the intersection is empty, no rows are emitted for that agent (still correct).
  const agentRows = await query<AgentEnumerationRow>(
    `SELECT DISTINCT ON (a.id)
            a.id,
            a.mode,
            a.owner_user_id,
            a.name,
            k."referenceId" AS api_key_reference_id
       FROM waddling.agent a
       LEFT JOIN "apikey" k ON k.id = a.api_key_id
      WHERE a.org_id = (SELECT org_id FROM waddling.datalake WHERE id = $1)
        AND a.status = 'active'
        AND (
          -- Has a delegation row scoped to this datalake or global
          EXISTS (
            SELECT 1 FROM waddling.delegation d
             WHERE d.agent_id = a.id
               AND (d.datalake_id = $1 OR d.datalake_id IS NULL)
          )
          OR
          -- Owner has a user-subject grant on this datalake (owner_user_id populated)
          (a.owner_user_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM waddling.acl_rule ar
             WHERE ar.datalake_id = $1
               AND ar.subject_kind = 'user'
               AND ar.user_id = a.owner_user_id
          ))
          OR
          -- Owner resolved via name 'claude:<userId>' (fallback before owner_user_id set)
          (a.mode = 'delegated' AND a.owner_user_id IS NULL AND EXISTS (
            SELECT 1 FROM waddling.acl_rule ar
             WHERE ar.datalake_id = $1
               AND ar.subject_kind = 'user'
               AND ar.user_id = CASE
                     WHEN a.name LIKE 'claude:%' THEN substring(a.name FROM 8)
                     ELSE NULL
                   END
          ))
          OR
          -- Autonomous agent whose API-key owner has a user-subject grant
          (a.mode = 'autonomous' AND k."referenceId" IS NOT NULL AND EXISTS (
            SELECT 1 FROM waddling.acl_rule ar
             WHERE ar.datalake_id = $1
               AND ar.subject_kind = 'user'
               AND ar.user_id = k."referenceId"
          ))
        )`,
    [datalakeId],
  );

  const derivedRows: AclRuleRow[] = [];
  const derivedPolicies: AclPolicyRow[] = [];

  for (const agent of agentRows.rows) {
    // Resolve the owner user id for this agent.
    let ownerId: string | null = null;
    if (agent.mode === 'delegated') {
      ownerId =
        agent.owner_user_id ??
        (agent.name.startsWith('claude:')
          ? agent.name.slice('claude:'.length)
          : null);
    } else {
      // autonomous
      ownerId = agent.api_key_reference_id;
    }

    if (!ownerId) continue; // no resolvable owner — skip

    // User grants + policies for this owner (from the already-loaded rows).
    const uGrants = userGrantRows.filter((r) => r.user_id === ownerId);
    const uPolicies = userPolicyRows.filter((p) => p.user_id === ownerId);
    if (uGrants.length === 0 && uPolicies.length === 0) continue;

    // Delegation scope: all entries for (userId, agentId, datalakeId|NULL).
    const { rows: scopeRows } = await query<DelegationRow>(
      `SELECT * FROM waddling.delegation
        WHERE user_id = $1
          AND agent_id = $2
          AND (datalake_id = $3 OR datalake_id IS NULL)`,
      [ownerId, agent.id, datalakeId],
    );
    if (scopeRows.length === 0) continue;

    if (uGrants.length > 0) {
      derivedRows.push(...deriveEffectiveRules(uGrants, scopeRows, agent.id, now));
    }
    if (uPolicies.length > 0) {
      derivedPolicies.push(
        ...deriveEffectivePolicies(uPolicies, scopeRows, agent.id),
      );
    }
  }

  // Union: direct (agent + org) rows ∪ derived. User rows are excluded — they were
  // only the derivation source, never birdshot rows. Same split for policies.
  const allRules: AclRuleRow[] = [...directRows, ...derivedRows];
  const allPolicies: AclPolicyRow[] = [...directPolicies, ...derivedPolicies];

  // Load the cached lake catalog so the compiler can expand read/write wildcards
  // into concrete refs (broad "entire schema/lake" grants → matching lake-qualified
  // grants). If no snapshot is cached yet, the compiler keeps the literal-wildcard
  // behavior (no regression) until the catalog populates.
  const cached = await getCachedCatalog(datalakeId);
  return compilePolicy(allRules, now, allPolicies, cached?.snapshot);
}
