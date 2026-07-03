/**
 * Policy versioning — a cheap change signal the gateway refresh alarm polls without
 * re-applying config.
 *
 * PULL-MODEL cutover (spec §13): grants are no longer a compiled BirdshotSnapshot, so the
 * grant version is no longer a hash of grant tuples — it is the datalake's monotonic STORE
 * EPOCH (`public.__birdshot_meta.epoch`, bumped by every grant-store mutation). The auth
 * JWK kid/n/e still folds into a SEPARATE authVersion so JWKS rotation is independently
 * detectable (a new signing key must re-push config even when grants are unchanged). The
 * combined `version` mixes epoch + authVersion.
 */
import { createHash } from 'node:crypto';
import { query } from './db';

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

/** sha256(content).slice(0,16) — short but collision-safe. */
function hash16(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/**
 * Compute the auth version from the JWKS kid/n/e. A new signing key (kid change) or a
 * rotated key (n/e change) yields a different authVersion even when the grants (epoch) are
 * unchanged — so config re-pushes to arm the gateway with the new JWKS. Empty/missing JWKS
 * → 'no-jwks' sentinel (the gateway would be unarmed).
 */
export function authVersionFor(jwks: { kid: string; n: string; e: string }[] | undefined): string {
  if (!jwks || jwks.length === 0) return 'no-jwks';
  return hash16(canonicalJson(jwks));
}

/**
 * The combined version the gateway compares against its last-applied config. Mix the grant
 * store epoch + auth so EITHER changing re-pushes. Format: `<epoch>-<authVersion>`.
 */
export function policyVersionFor(
  epoch: number,
  jwks: { kid: string; n: string; e: string }[] | undefined,
): string {
  return `${epoch}-${authVersionFor(jwks)}`;
}

/**
 * Persist the computed version + timestamp to waddling.datalake.policy_version /
 * policy_compiled_at (migration 013). Best-effort + non-throwing — a cache, not a source of
 * truth. Returns the version string so callers can include it without recomputing.
 */
export async function bumpPolicyVersion(
  datalakeId: string,
  epoch: number,
  jwks: { kid: string; n: string; e: string }[] | undefined,
): Promise<string> {
  const version = policyVersionFor(epoch, jwks);
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
