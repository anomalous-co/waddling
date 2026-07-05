/**
 * Cached lake catalog (waddling.datalake_catalog) — the data source for the ACL
 * authoring picker. The control-api Worker has no lake egress; only the data-plane
 * gateway can introspect the live DuckLake. So we cache the gateway's catalog
 * snapshot here and serve it instantly, refreshing it on catalog-mutating events.
 *
 * NAMES + TYPES ONLY — never row data (bounded management-metadata exception to the
 * "control plane stores no agent data" rule; required to MANAGE access).
 */
import { query, queryOne } from './db';
import { gatewayClientFor, GatewayError, type GatewayCatalog } from './gateway-client';

export interface CachedCatalog {
  snapshot: GatewayCatalog;
  contentHash: string;
  fetchedAt: string;
}

/** Endpoint row shape gatewayClientFor + the catalog fetch need. */
export interface CatalogEndpoint {
  id: string;
  org_id: string;
  status: string;
  server_token: string;
  // Per-endpoint Cloud Run gateway URL — REQUIRED so the catalog fetch targets THIS lake's gateway
  // (gatewayClientFor falls back to the bringup gateway when absent, fetching the wrong catalog).
  gateway_url?: string | null;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Read the cached snapshot for a datalake, or null if none has been fetched yet. */
export async function getCachedCatalog(datalakeId: string): Promise<CachedCatalog | null> {
  const row = await queryOne<{ snapshot: GatewayCatalog; content_hash: string; fetched_at: string }>(
    `SELECT snapshot, content_hash, fetched_at
       FROM waddling.datalake_catalog WHERE datalake_id = $1`,
    [datalakeId],
  );
  if (!row) return null;
  return { snapshot: row.snapshot, contentHash: row.content_hash, fetchedAt: row.fetched_at };
}

/** True when a fetched catalog carries no schemas (or no tables under any schema). */
function isEmptyCatalog(cat: GatewayCatalog): boolean {
  const schemas = cat?.schemas ?? [];
  return schemas.length === 0 || schemas.every((s) => (s.tables?.length ?? 0) === 0);
}

/**
 * Fetch the live catalog from the gateway and upsert the cache iff the content
 * changed (cheap content_hash compare avoids a write on every tick). Returns the
 * fresh snapshot, or null if the gateway was unreachable (cold/stopped/unconfigured)
 * — callers degrade to the cached snapshot or an empty catalog.
 *
 * NEVER-WIPE-TO-EMPTY guard: a gateway that answers 200 mid-boot (before the DuckLake
 * ATTACH completes) returns `{ schemas: [] }`. Blindly upserting that would clobber a
 * good cached snapshot and blank the authoring picker. So when the FRESH result is empty
 * but a NON-EMPTY snapshot is already cached, we keep the cached one (no write, fetched_at
 * unchanged) and return it with changed:false. A genuinely empty lake (nothing cached yet,
 * or the cache is already empty) still caches the empty result — that is a real state, not
 * a regression.
 */
export async function refreshCatalog(
  endpoint: CatalogEndpoint,
): Promise<{ snapshot: GatewayCatalog; changed: boolean } | null> {
  let cat: GatewayCatalog;
  try {
    cat = await gatewayClientFor(endpoint).catalog(endpoint.id);
  } catch (e) {
    if (e instanceof GatewayError) return null;
    throw e;
  }
  const hash = await sha256Hex(JSON.stringify(cat));
  const existing = await queryOne<{ content_hash: string; snapshot: GatewayCatalog }>(
    `SELECT content_hash, snapshot FROM waddling.datalake_catalog WHERE datalake_id = $1`,
    [endpoint.id],
  );

  // Never wipe a populated cache with a transient empty read (gateway still warming up).
  if (existing && isEmptyCatalog(cat) && !isEmptyCatalog(existing.snapshot)) {
    return { snapshot: existing.snapshot, changed: false };
  }

  const changed = !existing || existing.content_hash !== hash;
  if (changed) {
    await query(
      `INSERT INTO waddling.datalake_catalog (datalake_id, snapshot, content_hash, fetched_at)
         VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (datalake_id) DO UPDATE
         SET snapshot = EXCLUDED.snapshot,
             content_hash = EXCLUDED.content_hash,
             fetched_at = now()`,
      [endpoint.id, JSON.stringify(cat), hash],
    );
  }
  return { snapshot: cat, changed };
}
