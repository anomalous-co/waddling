/**
 * Per-org managed Postgres catalog — provisioning state machine (Neon).
 *
 * Each org gets ONE Neon PROJECT (an isolated, autoscaling, scale-to-zero Postgres). Its
 * database is the DuckLake metadata catalog the gateway ATTACHes via `ducklake:postgres:<dsn>`
 * on :5432. Neon's createProject returns the connection_uri (with password) in the SAME
 * response, so provisioning is effectively synchronous:
 *   1. provisionOrgCatalog — create the Neon project (idempotent), seal the DSN, write the
 *      row straight to 'ready'. On failure, record 'error'.
 *   2. reconcileOrgCatalog — retained for API compatibility (the dashboard polls it); since
 *      provisioning is synchronous it just returns the current status.
 *
 * The sealed DSN is the only secret (AES-256-GCM, same envelope as datalake_secret); the
 * gateway decrypts it server-side at boot. NEVER returned to the browser.
 *
 * Per-datalake isolation inside the org's project is a distinct DuckLake metadata SCHEMA
 * (datalake.catalog_schema), assigned at datalake create — NOT a separate database.
 */
import { query, queryOne } from './db';
import { getCrypto, type SealedSecret } from './secret-crypto';
import type { Env } from './env';
import { NeonClient, neonDsnFromUri, type NeonApiConfig } from './neon';

export type CatalogState = 'provisioning' | 'ready' | 'error';

export interface OrgCatalogStatus {
  orgId: string;
  /** The Neon project id backing this org's catalog. */
  neonProjectId: string;
  state: CatalogState;
  region?: string;
  lastError?: string;
}

/** Build the Neon client from env, or null when unconfigured (no API key) — lets callers
 *  degrade instead of throwing on every request. */
export function getNeonClient(env: Env): NeonClient | null {
  if (!env.NEON_API_KEY) return null;
  const cfg: NeonApiConfig = {
    apiKey: env.NEON_API_KEY,
    regionId: env.NEON_REGION_ID || undefined,
    pgVersion: env.NEON_PG_VERSION ? Number(env.NEON_PG_VERSION) : undefined,
  };
  return new NeonClient(cfg);
}

interface CatalogRow {
  org_id: string;
  neon_project_id: string;
  state: CatalogState;
  region: string | null;
  last_error: string | null;
}

const toStatus = (r: CatalogRow): OrgCatalogStatus => ({
  orgId: r.org_id,
  neonProjectId: r.neon_project_id,
  state: r.state,
  region: r.region ?? undefined,
  lastError: r.last_error ?? undefined,
});

/** Deterministic Neon project name for an org (lowercase, hyphenated, ≤63 chars). */
export function catalogProjectName(orgSlug: string): string {
  const slug = orgSlug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `waddling-${slug || 'org'}`.slice(0, 63);
}

/**
 * Ensure the org's catalog project exists. Idempotent: returns the current status if a row
 * already exists; otherwise creates the Neon project, seals the returned DSN, and writes the
 * row straight to 'ready' (Neon returns the connection_uri synchronously). Records 'error'
 * on failure so the dashboard can surface it.
 */
export async function provisionOrgCatalog(
  env: Env,
  orgId: string,
  orgSlug: string,
): Promise<OrgCatalogStatus> {
  const existing = await queryOne<CatalogRow>(
    `SELECT org_id, neon_project_id, state, region, last_error FROM waddling.org_catalog WHERE org_id = $1`,
    [orgId],
  );
  if (existing && existing.state === 'ready') return toStatus(existing);

  const client = getNeonClient(env);
  if (!client) {
    throw new Error('Neon integration not configured (NEON_API_KEY)');
  }

  const name = catalogProjectName(orgSlug);
  try {
    const created = await client.createProject(name);
    const dsn = neonDsnFromUri(created.connectionUri);
    const sealed: SealedSecret = getCrypto().sealJson({ dsn });
    const row = await queryOne<CatalogRow>(
      `INSERT INTO waddling.org_catalog
         (org_id, neon_project_id, state, region, dsn_iv, dsn_auth_tag, dsn_ciphertext)
       VALUES ($1, $2, 'ready', $3, $4, $5, $6)
       ON CONFLICT (org_id) DO UPDATE SET
         neon_project_id = EXCLUDED.neon_project_id, state = 'ready',
         dsn_iv = EXCLUDED.dsn_iv, dsn_auth_tag = EXCLUDED.dsn_auth_tag,
         dsn_ciphertext = EXCLUDED.dsn_ciphertext, last_error = NULL, updated_at = now()
       RETURNING org_id, neon_project_id, state, region, last_error`,
      [orgId, created.projectId, env.NEON_REGION_ID || null, sealed.iv, sealed.authTag, sealed.ciphertext],
    );
    return toStatus(row!);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await query(
      `INSERT INTO waddling.org_catalog (org_id, neon_project_id, state, region, last_error)
         VALUES ($1, $2, 'error', $3, $4)
       ON CONFLICT (org_id) DO UPDATE SET state='error', last_error=$4, updated_at=now()`,
      [orgId, '', env.NEON_REGION_ID || null, msg.slice(0, 500)],
    );
    throw e;
  }
}

/**
 * Retained for API compatibility (the dashboard polls until 'ready'). Provisioning is
 * synchronous on Neon, so this just returns the current status (and re-attempts a stuck
 * 'provisioning'/'error' row by re-provisioning).
 */
export async function reconcileOrgCatalog(env: Env, orgId: string): Promise<OrgCatalogStatus | null> {
  const row = await queryOne<CatalogRow>(
    `SELECT org_id, neon_project_id, state, region, last_error FROM waddling.org_catalog WHERE org_id = $1`,
    [orgId],
  );
  if (!row) return null;
  if (row.state === 'ready') return toStatus(row);
  // Stuck provisioning/error — re-attempt (idempotent). orgSlug is unknown here, so reuse
  // the deterministic project name from the stored id's absence by deriving from orgId.
  return provisionOrgCatalog(env, orgId, orgId).catch(() => toStatus(row));
}

interface DsnRow { dsn_iv: Buffer | null; dsn_auth_tag: Buffer | null; dsn_ciphertext: Buffer | null }

/**
 * Decrypt and return the org's catalog DSN (for the gateway boot wiring). Null until the
 * catalog is 'ready'. Server-only — NEVER returned to the browser or the agent.
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
  // Heal DSNs sealed before sslrootcert=system was added (verify-full without a root cert
  // fails the ducklake:postgres ATTACH in the gateway container).
  if (/sslmode=verify-full/.test(dsn) && !/sslrootcert=/.test(dsn)) {
    return `${dsn} sslrootcert=system`;
  }
  return dsn;
}
