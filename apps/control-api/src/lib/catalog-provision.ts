/**
 * Per-org managed Postgres catalog — provisioning state machine.
 *
 * Each org gets ONE PlanetScale Postgres database (the DuckLake metadata catalog the
 * gateway ATTACHes via `ducklake:postgres:<dsn>` on :5432). Provisioning is async
 * (PlanetScale create→ready is seconds-to-minutes), so this is a provisioning→ready
 * machine on waddling.org_catalog, NOT an inline await:
 *   1. provisionOrgCatalog — create the PlanetScale DB (idempotent), insert the row
 *      'provisioning', return immediately.
 *   2. reconcileOrgCatalog — on poll, if the cluster is 'ready', mint a branch password,
 *      seal the DSN, flip to 'ready'. The dashboard polls until ready.
 *
 * The sealed DSN is the only secret (AES-256-GCM, same envelope as endpoint_secret); the
 * gateway decrypts it server-side at boot (Stage D wiring). NEVER returned to the browser.
 *
 * PlanetScale Postgres connects to the PG database `postgres` regardless of the PS
 * database (cluster) name — see the Hyperdrive origin (database:"postgres"). Per-endpoint
 * isolation is therefore a distinct DuckLake metadata SCHEMA inside `postgres`
 * (endpoint.catalog_schema), assigned at endpoint create, NOT a separate PG database.
 */
import { query, queryOne } from './db';
import { getCrypto, type SealedSecret } from './secret-crypto';
import type { Env } from './env';
import {
  PlanetScaleClient,
  buildCatalogDsn,
  type PlanetScaleApiConfig,
} from './planetscale';

/** The PG database a PlanetScale Postgres cluster exposes (the cluster name is NOT it). */
const PG_DATABASE = 'postgres';

export type CatalogState = 'provisioning' | 'ready' | 'error';

export interface OrgCatalogStatus {
  orgId: string;
  psDatabase: string;
  state: CatalogState;
  region?: string;
  lastError?: string;
}

/** Build the PlanetScale client from env, or null when the integration is unconfigured
 *  (no service token) — lets callers degrade instead of throwing on every request. */
export function getPlanetScaleClient(env: Env): PlanetScaleClient | null {
  if (!env.PLANETSCALE_SERVICE_TOKEN_ID || !env.PLANETSCALE_SERVICE_TOKEN || !env.PLANETSCALE_ORG) {
    return null;
  }
  const cfg: PlanetScaleApiConfig = {
    tokenId: env.PLANETSCALE_SERVICE_TOKEN_ID,
    token: env.PLANETSCALE_SERVICE_TOKEN,
    organization: env.PLANETSCALE_ORG,
    clusterSize: env.PLANETSCALE_CLUSTER_SIZE || 'PS-5',
    region: env.PLANETSCALE_REGION || undefined,
  };
  return new PlanetScaleClient(cfg);
}

interface CatalogRow {
  org_id: string;
  ps_database: string;
  state: CatalogState;
  region: string | null;
  last_error: string | null;
}

const toStatus = (r: CatalogRow): OrgCatalogStatus => ({
  orgId: r.org_id,
  psDatabase: r.ps_database,
  state: r.state,
  region: r.region ?? undefined,
  lastError: r.last_error ?? undefined,
});

/** Deterministic PlanetScale database name for an org (PS names: lowercase, hyphenated). */
export function psDatabaseName(orgSlug: string): string {
  const slug = orgSlug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `waddling-${slug || 'org'}`.slice(0, 63);
}

/**
 * Ensure the org's catalog database exists. Idempotent: returns the current status if a
 * row already exists; otherwise creates the PlanetScale DB and inserts a 'provisioning'
 * row. Fast (the create call returns before the cluster is ready) — callers then poll
 * reconcileOrgCatalog.
 */
export async function provisionOrgCatalog(
  env: Env,
  orgId: string,
  orgSlug: string,
): Promise<OrgCatalogStatus> {
  const existing = await queryOne<CatalogRow>(
    `SELECT org_id, ps_database, state, region, last_error FROM waddling.org_catalog WHERE org_id = $1`,
    [orgId],
  );
  if (existing) return toStatus(existing);

  const client = getPlanetScaleClient(env);
  if (!client) {
    throw new Error('PlanetScale integration not configured (PLANETSCALE_SERVICE_TOKEN_ID/TOKEN/ORG)');
  }

  const dbName = psDatabaseName(orgSlug);
  try {
    await client.createDatabase(dbName);
  } catch (e) {
    // A 409/422 "already exists" is fine — adopt it (e.g. re-provision after a row loss).
    const msg = e instanceof Error ? e.message : String(e);
    if (!/already exists|422|409/i.test(msg)) {
      // Record the failure so the dashboard can surface it.
      await query(
        `INSERT INTO waddling.org_catalog (org_id, ps_database, state, region, last_error)
           VALUES ($1, $2, 'error', $3, $4)
         ON CONFLICT (org_id) DO UPDATE SET state='error', last_error=$4, updated_at=now()`,
        [orgId, dbName, env.PLANETSCALE_REGION || null, msg.slice(0, 500)],
      );
      throw e;
    }
  }

  const row = await queryOne<CatalogRow>(
    `INSERT INTO waddling.org_catalog (org_id, ps_database, state, region)
       VALUES ($1, $2, 'provisioning', $3)
     ON CONFLICT (org_id) DO UPDATE SET ps_database = EXCLUDED.ps_database, updated_at = now()
     RETURNING org_id, ps_database, state, region, last_error`,
    [orgId, dbName, env.PLANETSCALE_REGION || null],
  );
  return toStatus(row!);
}

/**
 * Advance a 'provisioning' org catalog toward 'ready'. When the PlanetScale cluster is
 * up, mint a branch password, seal the DSN, and flip to 'ready'. Idempotent + safe to
 * call on every poll. Returns the current status.
 */
export async function reconcileOrgCatalog(env: Env, orgId: string): Promise<OrgCatalogStatus | null> {
  const row = await queryOne<CatalogRow>(
    `SELECT org_id, ps_database, state, region, last_error FROM waddling.org_catalog WHERE org_id = $1`,
    [orgId],
  );
  if (!row) return null;
  if (row.state !== 'provisioning') return toStatus(row);

  const client = getPlanetScaleClient(env);
  if (!client) return toStatus(row);

  try {
    const db = await client.getDatabase(row.ps_database);
    if (db.state !== 'ready') return toStatus(row); // still warming up

    // Cluster is up — mint the connection material and seal the DSN.
    const pw = await client.createPassword(row.ps_database);
    const dsn = buildCatalogDsn({
      hostname: pw.hostname,
      username: pw.username,
      password: pw.plainText,
      database: PG_DATABASE,
    });
    const sealed: SealedSecret = getCrypto().sealJson({ dsn });
    const updated = await queryOne<CatalogRow>(
      `UPDATE waddling.org_catalog
          SET state='ready', dsn_iv=$2, dsn_auth_tag=$3, dsn_ciphertext=$4, last_error=NULL, updated_at=now()
        WHERE org_id=$1
        RETURNING org_id, ps_database, state, region, last_error`,
      [orgId, sealed.iv, sealed.authTag, sealed.ciphertext],
    );
    return toStatus(updated!);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await query(
      `UPDATE waddling.org_catalog SET state='error', last_error=$2, updated_at=now() WHERE org_id=$1`,
      [orgId, msg.slice(0, 500)],
    );
    return { orgId, psDatabase: row.ps_database, state: 'error', region: row.region ?? undefined, lastError: msg };
  }
}

interface DsnRow { dsn_iv: Buffer | null; dsn_auth_tag: Buffer | null; dsn_ciphertext: Buffer | null }

/**
 * Decrypt and return the org's catalog DSN (for the gateway boot wiring, Stage D). Null
 * until the catalog is 'ready'. Server-only — NEVER returned to the browser or the agent.
 */
export async function getOrgCatalogDsn(orgId: string): Promise<string | null> {
  const row = await queryOne<DsnRow>(
    `SELECT dsn_iv, dsn_auth_tag, dsn_ciphertext FROM waddling.org_catalog
      WHERE org_id = $1 AND state = 'ready'`,
    [orgId],
  );
  if (!row || !row.dsn_iv || !row.dsn_auth_tag || !row.dsn_ciphertext) return null;
  const sealed: SealedSecret = { iv: row.dsn_iv, authTag: row.dsn_auth_tag, ciphertext: row.dsn_ciphertext };
  return getCrypto().openJson<{ dsn: string }>(sealed).dsn;
}
