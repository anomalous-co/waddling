/**
 * Policy versioning — a stable content hash of a compiled BirdshotSnapshot so the
 * gateway refresh alarm (Step 11) can cheaply detect "nothing changed" without
 * re-applying. The version is a 16-char hex prefix of sha256 over a CANONICAL
 * JSON serialization of the snapshot (sorted keys + sorted arrays), so two
 * compilations producing the same grants/roles/constraints/policies hash equally
 * regardless of row-fetch order or object key insertion order.
 *
 * This is the keystone of the hybrid-refresh "dynamic ACL" model (Steps 9–12):
 * birdshot's grants stay in-memory + applySnapshot-driven, but the control plane
 * now exposes the current compiled policy + its version on demand, and the
 * GatewayPoolDO alarm (Step 11) re-applies only when the version changes. No C++
 * changes, no per-query Postgres coupling.
 *
 * The auth JWK kid/n/e are folded into a SEPARATE authVersion so JWKS rotation is
 * independently detectable — a new signing key must re-push even if the grants
 * are byte-identical (the gateway would otherwise reject JWTs signed by the new
 * kid). The combined `version` mixes grantVersion + authVersion.
 */
import { createHash } from 'node:crypto';
import { query } from './db';
import type { BirdshotSnapshot } from './types';

/** Canonical JSON: keys sorted ascending, arrays sorted by their JSON form. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).sort().join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

/** sha256(content).slice(0,16) — short but collision-safe for policy versions. */
function hash16(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/**
 * Compute the grant-only version (roleGrants + userRoles + roleConstraints +
 * policies). Stable across compilations with identical effective policy
 * regardless of row order. Exposed as `grantVersion` on /policy.
 */
export function grantVersionFor(snapshot: BirdshotSnapshot): string {
  const payload = {
    roleGrants: snapshot.roleGrants ?? [],
    userRoles: snapshot.userRoles ?? [],
    roleConstraints: snapshot.roleConstraints ?? [],
    policies: snapshot.policies ?? [],
  };
  return hash16(canonicalJson(payload));
}

/**
 * Compute the auth version from the JWKS kid/n/e. A new signing key (kid change)
 * or a rotated key (n/e change) yields a different authVersion even when the
 * grants are unchanged — so the alarm re-pushes to arm the gateway with the new
 * JWKS. Empty/missing JWKS → 'no-jwks' sentinel (the gateway would be unarmed).
 */
export function authVersionFor(jwks: { kid: string; n: string; e: string }[] | undefined): string {
  if (!jwks || jwks.length === 0) return 'no-jwks';
  return hash16(canonicalJson(jwks));
}

/**
 * The combined version the gateway compares against its last-applied version. Mix
 * grants + auth so EITHER changing re-pushes. Format: `<grantVersion>-<authVersion>`.
 */
export function policyVersionFor(
  snapshot: BirdshotSnapshot,
  jwks: { kid: string; n: string; e: string }[] | undefined,
): string {
  return `${grantVersionFor(snapshot)}-${authVersionFor(jwks)}`;
}

/**
 * Persist the computed version + timestamp to waddling.datalake.policy_version /
 * policy_compiled_at (migration 013). Called by recompileAndPush AND GET /policy so
 * a direct DB edit to acl_rule (bypassing recompileAndPush) is still surfaced: the
 * alarm's next poll recomputes the version and detects the delta vs this cached
 * row. Best-effort + non-throwing — the version is a cache, not a source of truth;
 * a write failure here must never break a push or a policy read. Returns the
 * version string so callers can include it in their response without recomputing.
 */
export async function bumpPolicyVersion(
  datalakeId: string,
  snapshot: BirdshotSnapshot,
  jwks: { kid: string; n: string; e: string }[] | undefined,
): Promise<string> {
  const version = policyVersionFor(snapshot, jwks);
  try {
    await query(
      `UPDATE waddling.datalake
          SET policy_version = $1, policy_compiled_at = now()
        WHERE id = $2`,
      [version, datalakeId],
    );
  } catch {
    /* best-effort cache write — see JSDoc */
  }
  return version;
}
