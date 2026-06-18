/**
 * /api/cp/endpoints/[id]/provision — LOCAL/DEV provisioning stand-in for W3.
 *
 * Production endpoint boot (Cloud Run container, port pool, DNS, status
 * reconciliation) is the W3 deployment workstream and is intentionally NOT built
 * here. This route closes the local UX loop: it resolves the endpoint's stored
 * credentials through `getEndpointGatewayConfig` (proving the encrypted BYO
 * storage creds + managed catalog decrypt into a valid gateway config), then
 * marks the endpoint `running` with a localhost gateway address so the dashboard
 * provisioning poll completes. It does NOT start a real gateway process.
 *
 * Guarded to non-production so it can never flip prod endpoints green by fiat.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { getNodeEnv } from '@/lib/env';
import { getEndpointGatewayConfig } from '@/lib/endpoint-secrets';
import { resolveCaller, assertOrg, handle, ok, err } from '../../../_shared';

const LOCAL_GATEWAY_HOST = 'localhost';
const LOCAL_QUACK_PORT = 9500;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return handle(async () => {
    if (getNodeEnv() === 'production') {
      return err('not_available', 403, 'Dev provisioning is disabled in production (W3 owns boot)');
    }
    const caller = await resolveCaller(req);
    const { id } = await ctx.params;

    const owned = await queryOne<{ org_id: string; status: string }>(
      `SELECT org_id, status FROM waddling.endpoint WHERE id = $1`,
      [id],
    );
    if (!owned) return err('endpoint_not_found', 404);
    assertOrg(caller, owned.org_id);

    // Resolve + validate stored credentials (decrypts BYO storage / catalog).
    const cfg = await getEndpointGatewayConfig(id);
    if (!cfg) return err('endpoint_not_found', 404);
    if (!cfg.localData && cfg.s3?.provider === 'config' && !cfg.s3.secret) {
      return err('missing_storage_secret', 422, 'Object-store credentials did not resolve');
    }

    await query(
      `UPDATE waddling.endpoint
          SET status = 'running', gateway_host = $2, quack_port = $3, updated_at = now()
        WHERE id = $1`,
      [id, LOCAL_GATEWAY_HOST, LOCAL_QUACK_PORT],
    );

    // Echo the resolved config WITHOUT secrets, so a developer can confirm the
    // credential plumbing without exposing keys to the browser.
    return ok({
      status: 'running',
      gatewayHost: LOCAL_GATEWAY_HOST,
      quackPort: LOCAL_QUACK_PORT,
      resolved: {
        dataPath: cfg.ducklakeDataPath,
        localData: cfg.localData,
        catalogMode: cfg.ducklakeCatalogFile ? 'managed-local' : 'byo-postgres',
        storage: cfg.s3
          ? {
              provider: cfg.s3.provider,
              endpoint: cfg.s3.endpoint,
              region: cfg.s3.region,
              urlStyle: cfg.s3.urlStyle,
              useSsl: cfg.s3.useSsl,
              hasCredentials: Boolean(cfg.s3.secret),
            }
          : null,
      },
    });
  });
}
