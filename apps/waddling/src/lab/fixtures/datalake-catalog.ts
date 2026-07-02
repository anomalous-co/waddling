import type { DatalakeDetail } from '@/lib/types';

/**
 * CatalogColumn — a column in a catalog table.
 */
export interface CatalogColumn {
  name: string;
  type: string;
}

/**
 * CatalogTable — lab-local type.
 * GUESSED: DatalakeDetail does not carry catalog info. This extends it for the
 * connect wizard's "Scope access" step (Step 3). The real /api/cp/datalakes/:id
 * endpoint does not yet return catalog; it will need a separate /catalog endpoint
 * or an `include=catalog` query param once the feature lands.
 */
export interface CatalogTable {
  table: string;
  /** Number of columns in the table (for display). */
  columnCount: number;
  /** Full column definitions (name + type). Lab-local; not yet returned by the real API. */
  columns?: CatalogColumn[];
  /** Estimated row count. Lab-local; not yet returned by the real API. */
  rowEstimate?: number;
}

export interface CatalogSchema {
  schema: string;
  tables: CatalogTable[];
}

/**
 * GatewayInfo — gateway endpoint metadata for a data lake.
 * Lab-local extension; the real DatalakeDetail does not yet carry this.
 * In production this will likely come from a separate /gateway endpoint
 * or as part of the expanded datalake detail response.
 */
export interface GatewayInfo {
  /** The quack: host agents connect to (without scheme). */
  endpointUrl: string;
  region: string;
  /** Subset of SemanticStatus that applies to a gateway. */
  status: 'active' | 'provisioning' | 'error' | 'idle';
}

/**
 * DatalakeDetailWithCatalog — lab-local extension of DatalakeDetail.
 * GUESSED: extends the real type with catalog, gateway, and stats fields populated
 * by the mock handler. Real production endpoint may surface these via separate calls
 * or query params.
 */
export interface DatalakeDetailWithCatalog extends DatalakeDetail {
  catalog: CatalogSchema[];
  /** Gateway endpoint metadata. Lab-local. */
  gateway?: GatewayInfo;
  /** Total bytes stored (all schemas combined). Lab-local. */
  sizeBytes?: number;
  /** Total table count (derived from catalog). Lab-local; prefer catalog.reduce() for truth. */
  tableCount?: number;
}

/**
 * Fixture lake detail for the Event Lake (dl_01j8events).
 * 2 schemas, 5 tables — rich column data for the catalog section.
 */
export const FIXTURE_LAKE_DETAIL_EVENT: DatalakeDetailWithCatalog = {
  id: 'dl_01j8events',
  name: 'Event Lake',
  slug: 'event-lake',
  status: 'running',
  dataPath: 's3://waddling-events/',
  region: 'us-west-1',
  runtime: { state: 'running', replicas: 2 },
  sizeBytes: 18_294_906_880, // ~17 GB
  gateway: {
    endpointUrl: 'dl-01j8events.gw.getwaddling.com',
    region: 'us-west-1',
    status: 'active',
  },
  catalog: [
    {
      schema: 'analytics',
      tables: [
        {
          table: 'events',
          columnCount: 12,
          rowEstimate: 42_500_000,
          columns: [
            { name: 'event_id', type: 'UUID' },
            { name: 'user_id', type: 'VARCHAR' },
            { name: 'session_id', type: 'VARCHAR' },
            { name: 'event_type', type: 'VARCHAR' },
            { name: 'page', type: 'VARCHAR' },
            { name: 'ts', type: 'TIMESTAMPTZ' },
            { name: 'properties', type: 'JSON' },
            { name: 'device', type: 'VARCHAR' },
            { name: 'browser', type: 'VARCHAR' },
            { name: 'os', type: 'VARCHAR' },
            { name: 'country', type: 'VARCHAR' },
            { name: 'revenue', type: 'DECIMAL(12,4)' },
          ],
        },
        {
          table: 'conversions',
          columnCount: 8,
          rowEstimate: 1_200_000,
          columns: [
            { name: 'conversion_id', type: 'UUID' },
            { name: 'user_id', type: 'VARCHAR' },
            { name: 'session_id', type: 'VARCHAR' },
            { name: 'event_id', type: 'UUID' },
            { name: 'amount', type: 'DECIMAL(12,4)' },
            { name: 'currency', type: 'VARCHAR' },
            { name: 'ts', type: 'TIMESTAMPTZ' },
            { name: 'channel', type: 'VARCHAR' },
          ],
        },
        {
          table: 'sessions',
          columnCount: 6,
          rowEstimate: 8_300_000,
          columns: [
            { name: 'session_id', type: 'UUID' },
            { name: 'user_id', type: 'VARCHAR' },
            { name: 'started_at', type: 'TIMESTAMPTZ' },
            { name: 'ended_at', type: 'TIMESTAMPTZ' },
            { name: 'page_views', type: 'INTEGER' },
            { name: 'duration_secs', type: 'INTEGER' },
          ],
        },
      ],
    },
    {
      schema: 'raw',
      tables: [
        {
          table: 'clickstream',
          columnCount: 18,
          rowEstimate: 210_000_000,
          columns: [
            { name: 'row_id', type: 'BIGINT' },
            { name: 'user_id', type: 'VARCHAR' },
            { name: 'session_id', type: 'VARCHAR' },
            { name: 'ts', type: 'TIMESTAMPTZ' },
            { name: 'page', type: 'VARCHAR' },
            { name: 'element_id', type: 'VARCHAR' },
            { name: 'element_type', type: 'VARCHAR' },
            { name: 'x', type: 'INTEGER' },
            { name: 'y', type: 'INTEGER' },
            { name: 'scroll_y', type: 'INTEGER' },
            { name: 'viewport_w', type: 'INTEGER' },
            { name: 'viewport_h', type: 'INTEGER' },
            { name: 'referrer', type: 'VARCHAR' },
            { name: 'utm_source', type: 'VARCHAR' },
            { name: 'utm_medium', type: 'VARCHAR' },
            { name: 'utm_campaign', type: 'VARCHAR' },
            { name: 'device_fingerprint', type: 'VARCHAR' },
            { name: 'raw_payload', type: 'JSON' },
          ],
        },
        {
          table: 'impressions',
          columnCount: 9,
          rowEstimate: 95_000_000,
          columns: [
            { name: 'impression_id', type: 'UUID' },
            { name: 'user_id', type: 'VARCHAR' },
            { name: 'session_id', type: 'VARCHAR' },
            { name: 'asset_id', type: 'VARCHAR' },
            { name: 'asset_type', type: 'VARCHAR' },
            { name: 'ts', type: 'TIMESTAMPTZ' },
            { name: 'visible_ms', type: 'INTEGER' },
            { name: 'position', type: 'INTEGER' },
            { name: 'clicked', type: 'BOOLEAN' },
          ],
        },
      ],
    },
  ],
};

/**
 * Fixture lake detail for the Product Catalog lake (dl_02j8product).
 * Still provisioning — catalog is empty by design.
 */
export const FIXTURE_LAKE_DETAIL_PRODUCT: DatalakeDetailWithCatalog = {
  id: 'dl_02j8product',
  name: 'Product Catalog',
  slug: 'product-catalog',
  status: 'provisioning',
  dataPath: 's3://waddling-product/',
  region: 'us-west-1',
  runtime: { state: 'provisioning', replicas: 0 },
  sizeBytes: 0,
  gateway: {
    endpointUrl: 'dl-02j8product.gw.getwaddling.com',
    region: 'us-west-1',
    status: 'provisioning',
  },
  catalog: [],
};

/** All fixture lake details keyed by lake ID. */
export const FIXTURE_LAKE_DETAILS: Record<string, DatalakeDetailWithCatalog> = {
  [FIXTURE_LAKE_DETAIL_EVENT.id]: FIXTURE_LAKE_DETAIL_EVENT,
  [FIXTURE_LAKE_DETAIL_PRODUCT.id]: FIXTURE_LAKE_DETAIL_PRODUCT,
};
