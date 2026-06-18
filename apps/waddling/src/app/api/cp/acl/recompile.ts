/**
 * Recompile + push helper (W1). Shared by acl/route.ts and acl/[id]/route.ts.
 *
 * Reads the endpoint's signing key + all active rules for the endpoint (optionally
 * scoped to one agent), runs the pure compiler, and pushes the birdshot snapshot
 * to the gateway control channel. Column/window ACLs ride inside that snapshot
 * (`roleConstraints`, enforced by birdshot's bind-walk) — there is no separate
 * constraint push anymore.
 */
import { query, queryOne } from '@/lib/db';
import {
  compilePolicy,
  type AclRuleRow,
  type CompileResult,
} from '@/lib/policy-compiler';
import {
  gatewayClientFor,
  type SnapshotRequest,
  type BirdshotJwk,
} from '@/lib/gateway-client';
import { getJwtIssuer } from '@/lib/env';

interface EndpointRow {
  id: string;
  org_id: string;
  status: string;
  gateway_host: string | null;
  quack_port: number | null;
  server_token: string;
}

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
 * Recompile the endpoint's policy and push it. When `agentId` is given, only that
 * agent's rules are recompiled (plus org-wide rules); otherwise all rules for the
 * endpoint are recompiled in one snapshot.
 *
 * Best-effort push: if the gateway is unreachable the rule is still persisted;
 * the next connect/recompile re-pushes. Returns the compile result for the caller.
 */
export async function recompileAndPush(
  endpointId: string,
  agentId?: string,
): Promise<CompileResult> {
  const endpoint = await queryOne<EndpointRow>(
    `SELECT id, org_id, status, gateway_host, quack_port, server_token
       FROM waddling.endpoint WHERE id = $1`,
    [endpointId],
  );

  const rows = await query<AclRuleRow>(
    agentId
      ? `SELECT * FROM waddling.acl_rule WHERE endpoint_id = $1 AND (agent_id = $2 OR agent_id IS NULL)`
      : `SELECT * FROM waddling.acl_rule WHERE endpoint_id = $1`,
    agentId ? [endpointId, agentId] : [endpointId],
  );

  const compiled = compilePolicy(rows.rows, new Date());

  if (endpoint && endpoint.status === 'running') {
    const jwk = await loadJwk();
    const gw = gatewayClientFor(endpoint);
    const snapshotReq: SnapshotRequest = {
      endpointId,
      auth: {
        issuer: getJwtIssuer(),
        audience: `gw:${endpointId}`,
        mode: 'rs256',
        jwks: jwk ? [jwk] : [],
      },
      snapshot: compiled.snapshot,
    };
    try {
      // Column + window ACLs ride inside the snapshot (`roleConstraints`); there
      // is no separate constraint push anymore.
      await gw.pushSnapshot(snapshotReq);
    } catch {
      // gateway down — persisted rule re-pushes on next connect/recompile
    }
  }

  return compiled;
}
