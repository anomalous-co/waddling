/**
 * Live-catalog fixtures for the UX lab, in the CONTROL-API shape the authoring
 * picker consumes:
 *
 *   GET /api/cp/datalakes/:id/catalog → { schemas: [{ name, tables: [{ name,
 *     columns: [{ name, type }] }] }], fetchedAt, stale? }
 *
 * Distinct from the older `datalake-catalog.ts` fixture (keys schema/table, rides
 * the datalake detail response). This one mirrors the unfiltered, admin-only
 * `/catalog` snapshot birdshot serves — the source of truth for the schema browser.
 */

export interface CatalogColumn {
  name: string;
  type: string;
}
export interface CatalogTable {
  name: string;
  columns: CatalogColumn[];
}
export interface CatalogSchema {
  name: string;
  tables: CatalogTable[];
}
export interface CatalogSnapshot {
  schemas: CatalogSchema[];
  fetchedAt: string | null;
  stale?: boolean;
}

const col = (name: string, type: string): CatalogColumn => ({ name, type });

/** Event Lake (dl_01j8events) — a rich, populated catalog. */
const EVENT_LAKE: CatalogSnapshot = {
  fetchedAt: '2026-07-03T09:12:00Z',
  schemas: [
    {
      name: 'analytics',
      tables: [
        {
          name: 'events',
          columns: [
            col('id', 'UUID'),
            col('user_id', 'VARCHAR'),
            col('session_id', 'VARCHAR'),
            col('event_type', 'VARCHAR'),
            col('page', 'VARCHAR'),
            col('created_at', 'TIMESTAMPTZ'),
            col('properties', 'JSON'),
          ],
        },
        {
          name: 'conversions',
          columns: [
            col('id', 'UUID'),
            col('user_id', 'VARCHAR'),
            col('event_id', 'UUID'),
            col('amount', 'DECIMAL(12,4)'),
            col('currency', 'VARCHAR'),
            col('converted_at', 'TIMESTAMPTZ'),
            col('channel', 'VARCHAR'),
          ],
        },
        {
          name: 'sessions',
          columns: [
            col('session_id', 'UUID'),
            col('user_id', 'VARCHAR'),
            col('started_at', 'TIMESTAMPTZ'),
            col('ended_at', 'TIMESTAMPTZ'),
            col('page_views', 'INTEGER'),
          ],
        },
        {
          name: 'orders',
          columns: [
            col('id', 'UUID'),
            col('user_id', 'VARCHAR'),
            col('total', 'DECIMAL(12,4)'),
            col('email', 'VARCHAR'),
            col('created_at', 'TIMESTAMPTZ'),
          ],
        },
        {
          name: 'pii',
          columns: [
            col('user_id', 'VARCHAR'),
            col('email', 'VARCHAR'),
            col('full_name', 'VARCHAR'),
            col('phone', 'VARCHAR'),
          ],
        },
        {
          name: 'public_report',
          columns: [col('metric', 'VARCHAR'), col('value', 'DOUBLE'), col('as_of', 'DATE')],
        },
      ],
    },
    {
      name: 'staging',
      tables: [
        {
          name: 'staging_orders',
          columns: [
            col('id', 'UUID'),
            col('payload', 'JSON'),
            col('ingested_at', 'TIMESTAMPTZ'),
          ],
        },
      ],
    },
    {
      name: 'raw',
      tables: [
        {
          name: 'clickstream',
          columns: [
            col('row_id', 'BIGINT'),
            col('user_id', 'VARCHAR'),
            col('ts', 'TIMESTAMPTZ'),
            col('page', 'VARCHAR'),
            col('raw_payload', 'JSON'),
          ],
        },
      ],
    },
  ],
};

/** Product Catalog (dl_02j8product) — still provisioning, so the snapshot is empty. */
const PRODUCT_LAKE: CatalogSnapshot = {
  fetchedAt: null,
  stale: true,
  schemas: [],
};

const CATALOGS: Record<string, CatalogSnapshot> = {
  dl_01j8events: EVENT_LAKE,
  dl_02j8product: PRODUCT_LAKE,
};

/** Snapshot for a datalake, or an empty "provisioning" payload if unknown. */
export function makeCatalog(datalakeId: string): CatalogSnapshot {
  return CATALOGS[datalakeId] ?? { schemas: [], fetchedAt: null, stale: true };
}
