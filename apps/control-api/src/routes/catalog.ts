/**
 * /api/cp/catalog — per-org managed Postgres catalog (PlanetScale) lifecycle.
 *
 * Each org gets ONE PlanetScale Postgres database (the DuckLake metadata catalog the
 * gateway ATTACHes via `ducklake:postgres:<dsn>`). Provisioning is async, so this is a
 * kick-off + poll surface over the provisioning→ready machine in lib/catalog-provision:
 *
 *   POST /          → provision (idempotent): create the PlanetScale DB if absent,
 *                     insert the 'provisioning' row, return status. Fast.
 *   GET  /          → reconcile + status: advance toward 'ready' (mint password + seal
 *                     DSN once the cluster is up), return the current state. Poll this.
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
  getPlanetScaleClient,
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
    if (!getPlanetScaleClient(c.env)) {
      return err(
        c,
        'planetscale_not_configured',
        503,
        'Managed Postgres catalog is not configured (PLANETSCALE_* env). Set the service token + org to enable.',
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

export { catalog };
