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
 * and push it to the gateway. Best-effort: a gateway failure leaves the rule
 * persisted for the next connect/recompile to re-push.
 *
 * When datalakeId is NULL (e.g. a global-scope delegation) we cannot push to a
 * specific gateway — skip the push, return a trivial empty compile result. The
 * next per-endpoint connect/recompile picks it up (consistent with best-effort
 * posture).
 */
export async function recompileAndPush(
  c: { env: Env },
  datalakeId: string | null,
): Promise<CompileResult> {
  if (!datalakeId) {
    return { snapshot: { roleGrants: [], userRoles: [], roleConstraints: [] }, constraints: [], activeAgentIds: [] };
  }

  const endpoint = await queryOne<EndpointRow>(
    `SELECT id, org_id, status, server_token
       FROM waddling.datalake WHERE id = $1`,
    [datalakeId],
  );

  const compiled = await compileEndpointPolicy(datalakeId, new Date());

  if (endpoint && endpoint.status === 'running') {
    const jwk = await loadJwk();
    const gw = gatewayClientFor(endpoint);
    try {
      const boot = await resolveGatewayBoot(c.env, datalakeId);
      const snapshotReq: SnapshotRequest = {
        datalakeId,
        auth: {
          issuer: c.env.JWT_ISSUER,
          audience: `gw:${datalakeId}`,
          mode: 'rs256',
          jwks: jwk ? [jwk] : [],
        },
        snapshot: compiled.snapshot,
        lakeCatalog: boot.lakeCatalog,
        gatewayBoot: boot.gatewayBoot,
      };
      await gw.pushSnapshot(snapshotReq);
    } catch {
      // gateway down / catalog provisioning — persisted rule re-pushes on next connect/recompile
    }
  }

  return compiled;
}
