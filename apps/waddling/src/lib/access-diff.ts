/**
 * Pure diff between an agent's CURRENT access and the access an editor wants, so the
 * UI can issue the minimal set of mutations. Two independent channels:
 *
 *  - catalog grants  → acl_rule  (POST/DELETE /api/cp/acl)        keyed (lake,schema,table,cap)
 *  - source/ext policies → acl_policy (POST/DELETE /api/cp/acl-policy) keyed (lake,cap,pattern)
 *
 * Each is identity-keyed (no in-place update needed): a changed grant is a delete + a
 * create. Kept pure + dependency-free so it is trivially unit-testable.
 */

// Catalog capabilities ride acl_rule (bind-walk enforced). POLICY capabilities ride
// acl_policy (parse-walk allowlists with a pattern). Mirrors policy-compiler.ts.
export type CatalogCapability = 'read' | 'write' | 'create' | 'drop' | 'alter' | 'detach';
export type PolicyCapability =
  | 'read_source'
  | 'copy_from'
  | 'copy_to'
  | 'attach'
  | 'install'
  | 'load';
export type PolicyKind = 'source' | 'dest' | 'extension' | 'attach';

export const CATALOG_CAPABILITIES: CatalogCapability[] = [
  'read',
  'write',
  'create',
  'drop',
  'alter',
  'detach',
];

/** The policy capabilities, in display order, grouped under their birdshot kind. */
export const POLICY_CAPABILITIES: PolicyCapability[] = [
  'read_source',
  'copy_from',
  'copy_to',
  'attach',
  'install',
  'load',
];

/** capability → birdshot policy kind. Mirrors control-api KIND_CAPABILITIES. */
export function policyKindFor(cap: PolicyCapability): PolicyKind {
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
  }
}

/** Helper text for a policy capability's pattern box. */
export function policyPatternHint(cap: PolicyCapability): string {
  switch (cap) {
    case 'read_source':
    case 'copy_from':
      return "an https host (e.g. api.example.com) — or, for object storage, the EXACT s3:// glob the read uses (e.g. s3://bucket/prefix/**/*.parquet). Bucket names and '*' wildcards are NOT host-matched for s3.";
    case 'copy_to':
      return 'an https host the export may write to';
    case 'install':
    case 'load':
      return 'an extension name (e.g. httpfs)';
    case 'attach':
      return 'an https host or DSN the ATTACH may reach';
  }
}

/** One catalog grant target with the verbs granted on it (the editor's working unit). */
export interface GrantTarget {
  datalakeId: string;
  schema: string;
  table: string;
  caps: CatalogCapability[];
}

/** One source/extension policy (an acl_policy row, kind derived from capability). */
export interface PolicyEntry {
  datalakeId: string;
  capability: PolicyCapability;
  pattern: string;
}

/** The full desired access state the editor edits. */
export interface AccessModel {
  grants: GrantTarget[];
  policies: PolicyEntry[];
}

/** An acl_rule as returned by GET /api/cp/acl (catalog rows carry an id for deletion). */
export interface ExistingRule {
  id: string;
  datalakeId: string;
  schema: string;
  table: string;
  capability: string;
}

/** An acl_policy as returned by GET /api/cp/acl-policy. */
export interface ExistingPolicy {
  id: string;
  datalakeId?: string;
  capability: string;
  pattern: string;
}

/** A single (lake,schema,table,capability) catalog grant to POST. */
export interface RuleCreate {
  datalakeId: string;
  schema: string;
  table: string;
  capability: CatalogCapability;
}

export interface AccessDiff {
  createRules: RuleCreate[];
  deleteRuleIds: string[];
  createPolicies: PolicyEntry[];
  deletePolicyIds: string[];
}

const ruleKey = (r: { datalakeId: string; schema: string; table: string; capability: string }) =>
  `${r.datalakeId}|${r.schema}|${r.table}|${r.capability}`;
const policyKey = (p: { datalakeId?: string; capability: string; pattern: string }) =>
  `${p.datalakeId ?? ''}|${p.capability}|${p.pattern}`;

const isCatalog = (c: string): c is CatalogCapability =>
  (CATALOG_CAPABILITIES as string[]).includes(c);

/** Flatten the editor's per-target grants into individual (…,capability) rows. */
export function flattenGrants(grants: GrantTarget[]): RuleCreate[] {
  const out: RuleCreate[] = [];
  const seen = new Set<string>();
  for (const g of grants) {
    for (const cap of g.caps) {
      const r = { datalakeId: g.datalakeId, schema: g.schema, table: g.table, capability: cap };
      const k = ruleKey(r);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(r);
      }
    }
  }
  return out;
}

/** Seed an editor model from the existing acl_rule + acl_policy rows. */
export function modelFromExisting(rules: ExistingRule[], policies: ExistingPolicy[]): AccessModel {
  const byTarget = new Map<string, GrantTarget>();
  for (const r of rules) {
    if (!isCatalog(r.capability)) continue; // policy caps live on acl_policy, not here
    const tkey = `${r.datalakeId}|${r.schema}|${r.table}`;
    let g = byTarget.get(tkey);
    if (!g) {
      g = { datalakeId: r.datalakeId, schema: r.schema, table: r.table, caps: [] };
      byTarget.set(tkey, g);
    }
    if (!g.caps.includes(r.capability)) g.caps.push(r.capability);
  }
  const pol: PolicyEntry[] = [];
  const seenP = new Set<string>();
  for (const p of policies) {
    if (!(POLICY_CAPABILITIES as string[]).includes(p.capability)) continue;
    const e = {
      datalakeId: p.datalakeId ?? '',
      capability: p.capability as PolicyCapability,
      pattern: p.pattern,
    };
    const k = policyKey(e);
    if (!seenP.has(k)) {
      seenP.add(k);
      pol.push(e);
    }
  }
  return { grants: [...byTarget.values()], policies: pol };
}

/**
 * Merge `add`'s grants into `base` (union of caps per (lake,schema,table) target).
 * Used to overlay a proposed-access diff onto an agent's current grants so the editor
 * renders the proposal as pending additions. Policies are left untouched (the
 * request-access proposal is catalog-only).
 */
export function mergeGrants(base: GrantTarget[], add: GrantTarget[]): GrantTarget[] {
  const out = base.map((g) => ({ ...g, caps: [...g.caps] }));
  for (const a of add) {
    const match = out.find(
      (g) => g.datalakeId === a.datalakeId && g.schema === a.schema && g.table === a.table,
    );
    if (match) {
      for (const cap of a.caps) if (!match.caps.includes(cap)) match.caps.push(cap);
    } else {
      out.push({ ...a, caps: [...a.caps] });
    }
  }
  return out;
}

/**
 * Decode a base64url-encoded access proposal (carried on the `?propose=` deep link the
 * `waddling_request_access` MCP tool returns) into an AccessModel. Catalog grants only —
 * unknown caps and malformed entries are dropped, and a parse failure returns null.
 */
export function decodeProposal(param: string): AccessModel | null {
  try {
    const b64 = param.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const obj = JSON.parse(new TextDecoder().decode(bytes)) as Partial<AccessModel>;
    const raw = Array.isArray(obj.grants) ? obj.grants : [];
    const grants: GrantTarget[] = raw
      .filter(
        (g): g is GrantTarget =>
          !!g &&
          typeof g.datalakeId === 'string' &&
          typeof g.schema === 'string' &&
          typeof g.table === 'string' &&
          Array.isArray(g.caps),
      )
      .map((g) => ({
        datalakeId: g.datalakeId,
        schema: g.schema,
        table: g.table,
        caps: g.caps.filter((c): c is CatalogCapability =>
          (CATALOG_CAPABILITIES as string[]).includes(c),
        ),
      }))
      .filter((g) => g.caps.length > 0);
    return { grants, policies: [] };
  } catch {
    return null;
  }
}

/** Compute the minimal create/delete set to move from `existing` rows to `desired`. */
export function diffAccess(
  existingRules: ExistingRule[],
  existingPolicies: ExistingPolicy[],
  desired: AccessModel,
): AccessDiff {
  const desiredRules = flattenGrants(desired.grants);
  const desiredRuleKeys = new Set(desiredRules.map(ruleKey));
  const existingRuleKeys = new Map<string, string>(); // key → id (catalog rows only)
  for (const r of existingRules) {
    if (isCatalog(r.capability)) existingRuleKeys.set(ruleKey(r), r.id);
  }

  const createRules = desiredRules.filter((r) => !existingRuleKeys.has(ruleKey(r)));
  const deleteRuleIds = existingRules
    .filter((r) => isCatalog(r.capability) && !desiredRuleKeys.has(ruleKey(r)))
    .map((r) => r.id);

  const desiredPolicies = desired.policies.filter((p) => p.pattern.trim().length > 0);
  const desiredPolicyKeys = new Set(desiredPolicies.map(policyKey));
  const existingPolicyKeys = new Map<string, string>();
  for (const p of existingPolicies) {
    if ((POLICY_CAPABILITIES as string[]).includes(p.capability)) {
      existingPolicyKeys.set(policyKey(p), p.id);
    }
  }

  const createPolicies = desiredPolicies.filter((p) => !existingPolicyKeys.has(policyKey(p)));
  const deletePolicyIds = existingPolicies
    .filter(
      (p) =>
        (POLICY_CAPABILITIES as string[]).includes(p.capability) &&
        !desiredPolicyKeys.has(policyKey(p)),
    )
    .map((p) => p.id);

  return { createRules, deleteRuleIds, createPolicies, deletePolicyIds };
}
