/**
 * Shared gateway-push helper — extracted from routes/acl.ts so that both
 * routes/acl.ts and routes/delegations.ts can recompile and push without
 * copy-pasting the push logic.
 *
 * recompileAndPush always pushes the FULL endpoint policy (every agent) because
 * the GatewayDO is shared per endpoint and applySnapshot does a full
 * birdshot_reset_config → re-add → commit. Pushing a single agent's slice would
 * wipe every other agent's grants on the shared gateway.
 *
 * Uses compileEndpointPolicy (effective-policy.ts) so that derived per-(user,
 * agent) delegation grants are included in every recompile (Phase 1 invariant).
 */
import { queryOne } from './db';
import { compileEndpointPolicy } from './effective-policy';
import { bumpPolicyVersion } from './policy-version';
import type { CompileResult } from './policy-compiler';
import { gatewayClientFor, type SnapshotRequest, type BirdshotJwk } from './gateway-client';
import { resolveGatewayBoot } from './gateway-boot';
import type { Env } from './env';

interface EndpointRow {
  id: string;
  org_id: string;
  status: string;
  server_token: string;
}

/** Newest non-expired jwks row → birdshot public JWK (kid/n/e), or null. */
async function loadJwk(): Promise<BirdshotJwk | null> {
  const row = await queryOne<{ id: string; publicKey: string }>(
    `SELECT id, "publicKey" FROM "jwks"
      WHERE "expiresAt" IS NULL OR "expiresAt" > now()
      ORDER BY "createdAt" DESC LIMIT 1`,
  ).catch(() => null);
  if (!row) return null;
  const pub = JSON.parse(row.publicKey) as { n: string; e: string };
  return { kid: row.id, n: pub.n, e: pub.e };
}

/**
 * Recompile the endpoint's FULL policy (every agent) via compileEndpointPolicy
 * and push it to the gateway. Best-effort by default: a gateway failure leaves the
 * rule persisted for the next connect/recompile to re-push, and the failure is
 * reported via the returned `pushError` field (NOT thrown).
 *
 * Pass `{ surfacePushError: true }` (the admin refresh-policy path) to instead
 * RE-THROW the gateway error so the caller can surface a 502 to the admin rather
 * than silently reporting best-effort success.
 *
 * When datalakeId is NULL (e.g. a global-scope delegation) we cannot push to a
 * specific gateway — skip the push, return a trivial empty compile result. The
 * next per-endpoint connect/recompile picks it up (consistent with best-effort
 * posture).
 *
 * Returns the CompileResult augmented with push telemetry: `pushed` is true only
 * when a snapshot was actually delivered to a running gateway; `pushError` carries
 * the reason on a best-effort failure; `pushSkipped` is true when no push was
 * attempted (null datalake, or a non-running endpoint).
 */
export interface RecompileResult extends CompileResult {
  /** true only when a snapshot was delivered to a running gateway. */
  pushed?: boolean;
  /** best-effort failure reason (only when surfacePushError is false). */
  pushError?: string;
  /** true when no push was attempted (null datalake / non-running endpoint). */
  pushSkipped?: boolean;
}

export interface RecompileOptions {
  /** Re-throw gateway push errors instead of swallowing + reporting via pushError.
   *  Used by the admin refresh-policy endpoint so a failed push surfaces as 502. */
  surfacePushError?: boolean;
}

export async function recompileAndPush(
  c: { env: Env },
  datalakeId: string | null,
  opts: RecompileOptions = {},
): Promise<RecompileResult> {
  if (!datalakeId) {
    return { snapshot: { roleGrants: [], userRoles: [], roleConstraints: [] }, constraints: [], activeAgentIds: [], pushSkipped: true };
  }

  const endpoint = await queryOne<EndpointRow>(
    `SELECT id, org_id, status, server_token
       FROM waddling.datalake WHERE id = $1`,
    [datalakeId],
  );

  const compiled = await compileEndpointPolicy(datalakeId, new Date());

  // Cache the compiled version on the datalake row (migration 013) so the refresh
  // alarm (Step 11) can poll one column. Best-effort + non-throwing. Computed from
  // the same jwks the push below uses, so the cached version matches what landed.
  const jwk = await loadJwk();
  const jwksArr = jwk ? [jwk] : undefined;
  const version = await bumpPolicyVersion(datalakeId, compiled.snapshot, jwksArr);

  if (endpoint && endpoint.status === 'running') {
    const gw = gatewayClientFor(endpoint);
    try {
      const boot = await resolveGatewayBoot(c.env, datalakeId);
      const snapshotReq: SnapshotRequest = {
        datalakeId,
        auth: {
          issuer: c.env.JWT_ISSUER,
          audience: `gw:${datalakeId}`,
          mode: 'rs256',
          jwks: jwksArr ?? [],
        },
        snapshot: compiled.snapshot,
        lakeCatalog: boot.lakeCatalog,
        gatewayBoot: boot.gatewayBoot,
      };
      await gw.pushSnapshot(snapshotReq);
      return { ...compiled, pushed: true };
    } catch (e) {
      // gateway down / catalog provisioning — persisted rule re-pushes on next connect/recompile.
      // The admin refresh path opts out of swallowing so a failed push is visible.
      if (opts.surfacePushError) throw e;
      return { ...compiled, pushed: false, pushError: e instanceof Error ? e.message : String(e) };
    }
  }

  // endpoint missing or not running — no push attempted; the rule re-pushes on the
  // next connect/recompile once the gateway is running.
  return { ...compiled, pushed: false, pushSkipped: true };
}
