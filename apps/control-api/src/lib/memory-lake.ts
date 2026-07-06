/**
 * The org's memory lake — the `kind='quackboard'` datalake every paid org gets
 * by default. It is the product's core promise ("your agents remember"), so it
 * must exist without any dashboard ritual:
 *
 *   • onboarding /provision creates it eagerly right after payment, and
 *   • prepareQbContext (routes/quackboard.ts) creates it lazily when an agent's
 *     first memory call arrives before the dashboard was ever opened.
 *
 * It is exempt from the plan's endpoint quota (see routes/datalakes.ts) and
 * capped at one per org by the partial unique index
 * `datalake_one_quackboard_per_org` (migration 023) — the INSERT here rides
 * ON CONFLICT DO NOTHING against that index, so concurrent first-touch calls
 * converge on a single row.
 */
import type { Env } from './env';
import { query, queryOne } from './db';
import { provisionGateway, type ProvisionableDatalake } from './provisioner';
import { provisionOrgCatalog } from './catalog-provision';

export interface MemoryLakeRow {
  id: string;
  status: string;
  gateway_url: string | null;
}

const MEMORY_LAKE_NAME = 'Memory';
const MEMORY_LAKE_SLUG = 'memory';

/**
 * Return the org's memory lake, creating (and gateway-provisioning) it if absent.
 * Also heals a row whose gateway deploy failed at create time (gateway_url null):
 * provisionGateway is idempotent (create-or-wake), so re-running it is safe.
 */
export async function ensureMemoryLake(env: Env, orgId: string): Promise<MemoryLakeRow> {
  let row = await queryOne<MemoryLakeRow & { catalog_mode: string | null; slug: string }>(
    `SELECT id, status, gateway_url, catalog_mode, slug FROM waddling.datalake
      WHERE org_id = $1 AND kind = 'quackboard'
      ORDER BY created_at ASC LIMIT 1`,
    [orgId],
  );

  // In-place migration of a LEGACY local-file board (catalog_mode != 'managed-postgres', e.g. the
  // old 'config' + data_path='quackboard' shape) to a managed DuckLake. Re-shape the row and clear
  // gateway_url so the block below re-provisions it as a gw-<slug> memory-lake gateway. Additive:
  // the old ws-<slug> service + its GCS .duckdb are left untouched (recoverable), nothing is
  // dropped here — the board just re-homes onto a fresh governed DuckLake.
  if (row && row.catalog_mode !== 'managed-postgres') {
    const slugRow = await queryOne<{ slug: string }>(`SELECT slug FROM "organization" WHERE id = $1`, [orgId]);
    try {
      await provisionOrgCatalog(env, orgId, slugRow?.slug ?? orgId);
    } catch {
      /* already provisioned / transient */
    }
    const catalogSchema = `dl_${row.slug.replace(/-/g, '_')}`;
    await query(
      `UPDATE waddling.datalake
          SET catalog_mode = 'managed-postgres', catalog_schema = COALESCE(catalog_schema, $2),
              data_path = 'managed-r2', encrypted = true, gateway_url = NULL, updated_at = now()
        WHERE id = $1`,
      [row.id, catalogSchema],
    );
    row = { ...row, catalog_mode: 'managed-postgres', gateway_url: null };
  }

  if (!row) {
    // The memory lake is a REAL managed DuckLake (managed-postgres catalog + GCS storage),
    // shaped exactly like a "+ new datalake" managed lake — only kind='quackboard' (the board
    // marker: quota-exempt, one-per-org, hidden from the lake picker) and the MEMORY_LAKE
    // provisioner flag differ. Its 8 coordination namespaces are governed tables in lake.main.
    const serverToken = `srv_${crypto.randomUUID().replace(/-/g, '')}`;
    // The org's shared Neon catalog must exist before the gateway ATTACHes its DuckLake
    // (managed-postgres). Idempotent + synchronous; best-effort (connect re-checks readiness).
    const slugRow = await queryOne<{ slug: string }>(`SELECT slug FROM "organization" WHERE id = $1`, [orgId]);
    try {
      await provisionOrgCatalog(env, orgId, slugRow?.slug ?? orgId);
    } catch {
      /* already provisioned / transient — resolveGatewayBoot re-checks via getOrgCatalogDsn */
    }
    // Suffix the slug on (org_id, slug) collision — an org may already have a regular lake named
    // 'memory'. The quackboard uniqueness itself is the partial index (ON CONFLICT target below).
    for (const slug of [MEMORY_LAKE_SLUG, `${MEMORY_LAKE_SLUG}-${orgId.slice(0, 6)}`]) {
      const catalogSchema = `dl_${slug.replace(/-/g, '_')}`;
      try {
        await query(
          `INSERT INTO waddling.datalake
             (org_id, name, slug, catalog_dsn, data_path, region, encrypted, server_token, status,
              storage_provider, storage_endpoint, storage_region, storage_url_style, storage_use_ssl,
              catalog_mode, catalog_schema, kind)
           VALUES ($1,$2,$3,'','managed-r2','auto',true,$4,'running',
                   'config','','auto','path',false,'managed-postgres',$5,'quackboard')
           ON CONFLICT (org_id) WHERE kind = 'quackboard' DO NOTHING`,
          [orgId, MEMORY_LAKE_NAME, slug, serverToken, catalogSchema],
        );
        break;
      } catch (e) {
        // unique_violation on (org_id, slug) → retry with the suffixed slug;
        // anything else is real.
        const code = (e as { code?: string }).code;
        if (code !== '23505') throw e;
      }
    }
    row = await queryOne<MemoryLakeRow & { catalog_mode: string | null; slug: string }>(
      `SELECT id, status, gateway_url, catalog_mode, slug FROM waddling.datalake
        WHERE org_id = $1 AND kind = 'quackboard'
        ORDER BY created_at ASC LIMIT 1`,
      [orgId],
    );
    if (!row) throw new Error('memory lake insert raced and no row is visible');
  }

  // Deploy (or wake) the per-org memory-lake gateway when the row has no recorded URL yet.
  // Same managed-DuckLake gateway as any lake (gw-<slug>: cloudsql + PEM + catalog + s3), plus
  // MEMORY_LAKE=1 so it bootstraps the board schema into lake.main. Idempotent (create-or-wake).
  if (!row.gateway_url && env.PROVISIONER_URL) {
    const dl = await queryOne<ProvisionableDatalake>(
      `SELECT id, org_id, slug, server_token, catalog_schema, catalog_mode, encrypted
         FROM waddling.datalake WHERE id = $1`,
      [row.id],
    );
    if (dl) {
      const { url } = await provisionGateway(env, dl, { memoryLake: true });
      await query(`UPDATE waddling.datalake SET gateway_url = $1, updated_at = now() WHERE id = $2`, [
        url,
        row.id,
      ]);
      row = { ...row, gateway_url: url };
    }
  }

  return row;
}
