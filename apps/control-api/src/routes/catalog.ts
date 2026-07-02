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

export { catalog };
