/**
 * /api/cp/catalog — per-org managed Postgres catalog (GCP Cloud SQL) lifecycle.
 *
 * Each org gets ONE database inside the shared Cloud SQL instance; it is the DuckLake metadata
 * catalog the gateway ATTACHes via `ducklake:postgres:<dsn>`. Provisioning completes in-request
 * (plain SQL over Hyperdrive), so this is a provision + status surface over lib/catalog-provision:
 *
 *   POST /          → provision (idempotent): create the org's database + role if absent, seal
 *                     the DSN, return 'ready' status.
 *   GET  /          → status, return the current state. Poll this.
 *
 * Org-scoped (the caller's active org). The sealed DSN never leaves the server.
 */
import { Hono } from 'hono';
import { queryOne } from '../lib/db';
import type { Env } from '../lib/env';
import { resolveCaller, handle, ok, err } from '../lib/cp-shared';
import {
  provisionOrgCatalog,
  reconcileOrgCatalog,
  cloudSqlReady,
  getOrgCatalogDsn,
} from '../lib/catalog-provision';

const catalog = new Hono<{ Bindings: Env }>();

async function orgSlug(orgId: string): Promise<string | null> {
  const row = await queryOne<{ slug: string }>(
    `SELECT slug FROM "organization" WHERE id = $1`,
    [orgId],
  );
  return row?.slug ?? null;
}

catalog.post('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    if (!cloudSqlReady(c.env)) {
      return err(
        c,
        'cloudsql_not_configured',
        503,
        'Managed Postgres catalog is not configured (PG_HOST). Set the Cloud SQL host to enable.',
      );
    }
    const slug = await orgSlug(caller.orgId);
    if (!slug) return err(c, 'org_not_found', 404);
    const status = await provisionOrgCatalog(c.env, caller.orgId, slug);
    return ok(c, status, status.state === 'provisioning' ? 202 : 200);
  }),
);

catalog.get('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const status = await reconcileOrgCatalog(c.env, caller.orgId);
    if (!status) return err(c, 'not_provisioned', 404, 'No managed catalog for this org yet — POST to provision');
    return ok(c, status);
  }),
);

/**
 * POST /lakeprobe — #9 acceptance gate, driven server-side so no catalog DSN ever leaves
 * the server. Reconciles the caller's org catalog to 'ready', decrypts its DSN, and hands
 * it to the data plane's /lakeprobe (which boots two ducklake ATTACHes with distinct
 * METADATA_SCHEMA inside a real gateway container and asserts cross-endpoint isolation, then
 * drops its probe schemas). Returns only the verdict — never the DSN. Temporary verification
 * surface; safe to remove once #9 is signed off.
 */
catalog.post('/lakeprobe', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const status = await reconcileOrgCatalog(c.env, caller.orgId);
    if (!status || status.state !== 'ready') {
      return err(
        c,
        'catalog_not_ready',
        503,
        `Org catalog state is ${status?.state ?? 'absent'} — provision + wait for 'ready' first`,
      );
    }
    const dsn = await getOrgCatalogDsn(caller.orgId);
    if (!dsn) return err(c, 'catalog_dsn_unavailable', 503, 'Catalog is ready but DSN could not be decrypted');

    const res = await c.env.DATAPLANE.fetch('https://dataplane/lakeprobe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dsn }),
    });
    const json = await res.json().catch(() => ({ error: 'non-json data-plane response' }));
    return c.json(json as Record<string, unknown>, res.status as 200);
  }),
);

/**
 * POST /qbselftest — drive the data plane's quackboard end-to-end self-test (boot → birdshot
 * snapshot → gated write+read → persist to R2 → cold boot → restore → recall). Auth-gated
 * (any authenticated caller); the data plane stays private (reached only via the service
 * binding). The self-test is self-contained (mints its own JWT/JWKS) and touches no real org.
 * Temporary verification surface; safe to remove once the quackboard is signed off.
 */
catalog.post('/qbselftest', (c) =>
  handle(c, async () => {
    await resolveCaller(c);
    const res = await c.env.DATAPLANE.fetch('https://dataplane/qb/selftest', { method: 'POST' });
    const json = await res.json().catch(() => ({ error: 'non-json data-plane response' }));
    return c.json(json as Record<string, unknown>, res.status as 200);
  }),
);

export { catalog };
