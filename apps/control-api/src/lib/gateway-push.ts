/**
 * Shared gateway CONFIG-push helper (pull-model cutover, spec §13).
 *
 * The gateway no longer receives compiled grant tuples: birdshot PULLS literal GRANT/DENY
 * SQL from the ATTACHed Postgres store and freshness-validates it itself. So this push
 * shrinks to CONFIG ONLY — auth (issuer/audience/JWKS), the lake catalog alias, the
 * read-only grant-store DSN (scoped to the datalake), and the boot payload. There is no
 * `compileEndpointPolicy` / `BirdshotSnapshot` anywhere in the grant path anymore.
 *
 * pushConfig (exported as recompileAndPush for call-site stability) always pushes the
 * endpoint's config. Best-effort by default: a gateway failure leaves grants durable in the
 * store (the gateway re-pulls on its next authorize / connect) and is reported via
 * `pushError`. Pass `{ surfacePushError: true }` (admin refresh-policy / the dispatch drain)
 * to RE-THROW instead.
 */
import { queryOne } from './db';
import { bumpPolicyVersion } from './policy-version';
import { epochFor } from './grant-store';
import { gatewayClientFor, type SnapshotRequest, type BirdshotJwk } from './gateway-client';
import { resolveGatewayBoot } from './gateway-boot';
import { refreshCatalog, type CatalogEndpoint } from './catalog-cache';
import type { Env } from './env';

interface EndpointRow {
  id: string;
  org_id: string;
  status: string;
  server_token: string;
  gateway_url: string | null;
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

/** Outcome of a config push. `pushed` is true only when config reached a running gateway. */
export interface RecompileResult {
  pushed?: boolean;
  /** best-effort failure reason (only when surfacePushError is false). */
  pushError?: string;
  /** true when no push was attempted (null datalake / non-running endpoint). */
  pushSkipped?: boolean;
  /** the datalake's current grant-store epoch (grant version), for callers/telemetry. */
  epoch?: number;
}

export interface RecompileOptions {
  /** Re-throw gateway push errors instead of swallowing + reporting via pushError. */
  surfacePushError?: boolean;
}

/**
 * Push the endpoint's CONFIG (auth/JWKS/lakeCatalog/grantStoreDsn) to its gateway. Named
 * recompileAndPush for call-site stability, but it compiles NOTHING — grants live in the
 * store and the gateway pulls them.
 */
export async function recompileAndPush(
  c: { env: Env },
  datalakeId: string | null,
  opts: RecompileOptions = {},
): Promise<RecompileResult> {
  if (!datalakeId) {
    return { pushSkipped: true };
  }

  const endpoint = await queryOne<EndpointRow>(
    `SELECT id, org_id, status, server_token, gateway_url
       FROM waddling.datalake WHERE id = $1`,
    [datalakeId],
  );

  const jwk = await loadJwk();
  const jwksArr = jwk ? [jwk] : undefined;
  const epoch = await epochFor(datalakeId).catch(() => 0);
  // Cache the version (epoch + auth) on the datalake row so the refresh alarm can poll one
  // column. Best-effort + non-throwing.
  await bumpPolicyVersion(datalakeId, epoch, jwksArr);

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
        lakeCatalog: boot.lakeCatalog,
        grantStoreDsn: c.env.BIRDSHOT_STORE_DSN,
        gatewayBoot: boot.gatewayBoot,
      };
      await gw.pushSnapshot(snapshotReq);
      return { pushed: true, epoch };
    } catch (e) {
      if (opts.surfacePushError) throw e;
      return { pushed: false, epoch, pushError: e instanceof Error ? e.message : String(e) };
    }
  }

  return { pushed: false, epoch, pushSkipped: true };
}

/**
 * Change-tracked catalog refresh + conditional config re-push. Called after a governed
 * catalog-mutating statement when the gateway is warm: pull the fresh catalog, and IF it
 * changed, re-push config. (In the pull model this no longer re-folds wildcard grants — the
 * gateway resolves `ALL TABLES IN SCHEMA` natively — but a changed catalog can still warrant
 * a config re-arm.) Best-effort — never throws into the caller.
 */
export async function refreshCatalogAndRecompile(
  c: { env: Env },
  datalakeId: string,
  endpoint: CatalogEndpoint,
): Promise<void> {
  try {
    const r = await refreshCatalog(endpoint);
    if (r?.changed) await recompileAndPush(c, datalakeId);
  } catch {
    /* best-effort: the next connect/recompile picks up the fresh catalog anyway */
  }
}
