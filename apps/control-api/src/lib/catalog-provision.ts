/**
 * Per-org managed Postgres catalog — provisioning state machine (GCP Cloud SQL).
 *
 * Each org gets ONE database inside the single shared Cloud SQL instance (database-per-org).
 * That database is the DuckLake metadata catalog the gateway ATTACHes via
 * `ducklake:postgres:<dsn>` on :5432. Provisioning is plain SQL over the request's Hyperdrive
 * pool (see lib/cloudsql), which completes in-request, so:
 *   1. provisionOrgCatalog — create the org database + role (idempotent), seal the minted DSN,
 *      write the row straight to 'ready'. On failure, record 'error'.
 *   2. reconcileOrgCatalog — retained for API compatibility (the dashboard polls it); since
 *      provisioning completes synchronously it just returns the current status.
 *
 * The sealed DSN is the only secret (AES-256-GCM, same envelope as datalake_secret); the
 * gateway decrypts it server-side at boot and adds the mTLS cert paths. NEVER returned to the
 * browser.
 *
 * Per-datalake isolation inside the org's database is a distinct DuckLake metadata SCHEMA
 * (datalake.catalog_schema), assigned at datalake create — NOT a separate database.
 */
import { query, queryOne } from './db';
import { getCrypto, type SealedSecret } from './secret-crypto';
import type { Env } from './env';
import { cloudSqlConfigured, provisionOrgDatabase } from './cloudsql';

export type CatalogState = 'provisioning' | 'ready' | 'error';

export interface OrgCatalogStatus {
  orgId: string;
  /** The per-org database name (inside the shared Cloud SQL instance) backing this catalog. */
  database: string;
  state: CatalogState;
  region?: string;
  lastError?: string;
}

/** True when the shared Cloud SQL instance is configured (PG_HOST set) — lets callers degrade
 *  instead of throwing on every request. */
export function cloudSqlReady(env: Env): boolean {
  return cloudSqlConfigured(env);
}

interface CatalogRow {
  org_id: string;
  database_name: string | null;
  state: CatalogState;
  region: string | null;
  last_error: string | null;
}

const toStatus = (r: CatalogRow): OrgCatalogStatus => ({
  orgId: r.org_id,
  database: r.database_name ?? '',
  state: r.state,
  region: r.region ?? undefined,
  lastError: r.last_error ?? undefined,
});

/**
 * Ensure the org's catalog database exists. Idempotent: returns the current status if a
 * 'ready' row already exists; otherwise provisions the org database + role on the shared
 * Cloud SQL instance, seals the minted DSN, and writes the row straight to 'ready'. Records
 * 'error' on failure so the dashboard can surface it. `orgSlug` is accepted for call-site
 * compatibility but no longer used — the database name derives deterministically from orgId.
 */
export async function provisionOrgCatalog(
  env: Env,
  orgId: string,
  orgSlug: string,
): Promise<OrgCatalogStatus> {
  void orgSlug;
  const existing = await queryOne<CatalogRow>(
    `SELECT org_id, database_name, state, region, last_error FROM waddling.org_catalog WHERE org_id = $1`,
    [orgId],
  );
  if (existing && existing.state === 'ready') return toStatus(existing);

  if (!cloudSqlConfigured(env)) {
    throw new Error('Cloud SQL integration not configured (PG_HOST)');
  }

  try {
    const { database, dsn } = await provisionOrgDatabase(env, orgId);
    const sealed: SealedSecret = getCrypto().sealJson({ dsn });
    const row = await queryOne<CatalogRow>(
      `INSERT INTO waddling.org_catalog
         (org_id, database_name, state, region, dsn_iv, dsn_auth_tag, dsn_ciphertext)
       VALUES ($1, $2, 'ready', $3, $4, $5, $6)
       ON CONFLICT (org_id) DO UPDATE SET
         database_name = EXCLUDED.database_name, state = 'ready',
         dsn_iv = EXCLUDED.dsn_iv, dsn_auth_tag = EXCLUDED.dsn_auth_tag,
         dsn_ciphertext = EXCLUDED.dsn_ciphertext, last_error = NULL, updated_at = now()
       RETURNING org_id, database_name, state, region, last_error`,
      [orgId, database, null, sealed.iv, sealed.authTag, sealed.ciphertext],
    );
    return toStatus(row!);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await query(
      `INSERT INTO waddling.org_catalog (org_id, database_name, state, region, last_error)
         VALUES ($1, NULL, 'error', $2, $3)
       ON CONFLICT (org_id) DO UPDATE SET state='error', last_error=$3, updated_at=now()`,
      [orgId, null, msg.slice(0, 500)],
    );
    throw e;
  }
}

/**
 * Retained for API compatibility (the dashboard polls until 'ready'). Provisioning completes
 * in-request, so this just returns the current status (and re-attempts a stuck
 * 'provisioning'/'error' row by re-provisioning).
 */
export async function reconcileOrgCatalog(env: Env, orgId: string): Promise<OrgCatalogStatus | null> {
  const row = await queryOne<CatalogRow>(
    `SELECT org_id, database_name, state, region, last_error FROM waddling.org_catalog WHERE org_id = $1`,
    [orgId],
  );
  if (!row) return null;
  if (row.state === 'ready') return toStatus(row);
  // Stuck provisioning/error — re-attempt (idempotent). The org slug is irrelevant now, so
  // pass orgId for the unused slug param.
  return provisionOrgCatalog(env, orgId, orgId).catch(() => toStatus(row));
}

interface DsnRow { dsn_iv: Buffer | null; dsn_auth_tag: Buffer | null; dsn_ciphertext: Buffer | null }

/**
 * Decrypt and return the org's catalog DSN (for the gateway boot wiring). Null until the
 * catalog is 'ready'. Server-only — NEVER returned to the browser or the agent. The stored
 * DSN already carries `sslmode=verify-ca`; the gateway appends the mTLS cert paths at ATTACH.
 */
export async function getOrgCatalogDsn(orgId: string): Promise<string | null> {
  const row = await queryOne<DsnRow>(
    `SELECT dsn_iv, dsn_auth_tag, dsn_ciphertext FROM waddling.org_catalog
      WHERE org_id = $1 AND state = 'ready'`,
    [orgId],
  );
  if (!row || !row.dsn_iv || !row.dsn_auth_tag || !row.dsn_ciphertext) return null;
  const sealed: SealedSecret = { iv: row.dsn_iv, authTag: row.dsn_auth_tag, ciphertext: row.dsn_ciphertext };
  const dsn = getCrypto().openJson<{ dsn: string }>(sealed).dsn;
  // Defensive: a DSN sealed without an sslmode would let the gateway ATTACH fall back to a
  // plaintext connection the mTLS-only instance rejects. Ensure verify-ca is present.
  return /sslmode=/.test(dsn) ? dsn : `${dsn} sslmode=verify-ca`;
}
