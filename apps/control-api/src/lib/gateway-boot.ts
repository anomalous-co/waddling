/**
 * Per-endpoint gateway boot resolver — assembles the lake config the data plane injects
 * into the gateway container at cold boot (so it ATTACHes the endpoint's REAL DuckLake
 * rather than the offline demo).
 *
 * Catalog modes, in resolution order:
 *   • managed-postgres — the per-org PlanetScale Postgres catalog (getOrgCatalogDsn) shared
 *     across the org's endpoints, each isolated by its own METADATA_SCHEMA (catalog_schema,
 *     lazily assigned `ep_<id>` if NULL). This is the production managed path.
 *   • byo-postgres     — the customer's own Postgres catalog DSN (endpoint 'catalog' secret).
 *   • local-file       — a local DuckLake catalog file (host-native demo; not durable on CF).
 *   • none             — no real catalog: fall back to the data plane's offline demo lake.
 *
 * Lake CREDENTIALS (catalog DSN + object-store secret) travel ONLY to the trusted gateway,
 * never to the locked workspace. The object store (s3://) creds come from the endpoint's
 * storage secret; the catalog DSN from the org/endpoint catalog secret. All server-side.
 */
import { query, queryOne } from './db';
import { getEndpointGatewayConfig } from './endpoint-secrets';
import { getOrgCatalogDsn } from './catalog-provision';
import type { GatewayBoot } from './gateway-client';
import type { Env } from './env';
import { getR2Faucet, orgBucketName } from './r2-faucet';

/** A managed-postgres endpoint requires the managed R2 faucet for its lake data. */
export class StorageNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageNotReadyError';
  }
}

export class CatalogNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogNotReadyError';
  }
}

export interface ResolvedGatewayBoot {
  /** Catalog birdshot resolves agent table refs against: the lake alias for a real lake,
   *  'memory' for the offline demo. */
  lakeCatalog: string;
  /** Boot config injected at the gateway container. Undefined ⇒ demo (no real lake). */
  gatewayBoot?: GatewayBoot;
}

interface EndpointCatalogRow {
  org_id: string;
  server_token: string;
  catalog_mode: string | null;
  catalog_schema: string | null;
}

const LAKE_ALIAS = 'lake';

/** Deterministic per-endpoint metadata schema (PG-identifier-safe). */
export function endpointMetadataSchema(endpointId: string): string {
  return `ep_${endpointId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

/**
 * Resolve the boot config + birdshot lake catalog for an endpoint. Throws
 * CatalogNotReadyError when the endpoint is configured for the managed catalog but the
 * org's catalog is still provisioning (the caller maps that to a retryable 503).
 */
export async function resolveGatewayBoot(env: Env, endpointId: string): Promise<ResolvedGatewayBoot> {
  const ep = await queryOne<EndpointCatalogRow>(
    `SELECT org_id, server_token, catalog_mode, catalog_schema
       FROM waddling.endpoint WHERE id = $1`,
    [endpointId],
  );
  if (!ep) return { lakeCatalog: 'memory' };

  const cfg = await getEndpointGatewayConfig(endpointId);
  if (!cfg) return { lakeCatalog: 'memory' };

  const s3: GatewayBoot['s3'] | undefined = cfg.s3
    ? {
        endpoint: cfg.s3.endpoint,
        keyId: cfg.s3.keyId,
        secret: cfg.s3.secret,
        region: cfg.s3.region,
        useSsl: cfg.s3.useSsl,
        urlStyle: cfg.s3.urlStyle,
      }
    : undefined;

  const base: GatewayBoot = {
    serverToken: ep.server_token,
    dataPath: cfg.ducklakeDataPath,
    alias: LAKE_ALIAS,
    encrypted: cfg.encrypted,
    s3,
  };

  // (a) managed-postgres: shared per-org catalog + per-endpoint metadata schema, with
  // managed R2 storage minted by the faucet (per-org bucket, per-endpoint prefix scope).
  if (ep.catalog_mode === 'managed-postgres') {
    const dsn = await getOrgCatalogDsn(ep.org_id);
    if (!dsn) {
      throw new CatalogNotReadyError(
        `org ${ep.org_id} managed catalog is still provisioning — retry shortly`,
      );
    }
    const schema = ep.catalog_schema ?? (await ensureEndpointSchema(endpointId));

    // Managed lake data: provision the org's R2 bucket + mint SHORT-LIVED creds scoped to
    // exactly this endpoint's prefix. The gateway never sees a broad account credential.
    const faucet = getR2Faucet(env);
    if (!faucet) {
      throw new StorageNotReadyError('managed storage requires the R2 faucet (R2_FAUCET_TOKEN / R2_PARENT_ACCESS_KEY_ID)');
    }
    const slug = await orgSlugFor(ep.org_id);
    const bucket = orgBucketName(slug);
    await faucet.ensureBucket(bucket);
    const prefix = `${endpointId}/`;
    const creds = await faucet.mintScopedCreds(bucket, {
      permission: 'object-read-write',
      ttlSeconds: 604_800, // 7d (max) — covers a long-lived gateway between cold boots
      prefixes: [prefix],
    });
    const s3host = env.R2_ENDPOINT.replace(/^https?:\/\//, '');

    return {
      lakeCatalog: LAKE_ALIAS,
      gatewayBoot: {
        serverToken: ep.server_token,
        dataPath: `s3://${bucket}/${prefix}`,
        alias: LAKE_ALIAS,
        encrypted: cfg.encrypted,
        catalogDsn: dsn,
        metadataSchema: schema,
        s3: {
          endpoint: s3host,
          keyId: creds.accessKeyId,
          secret: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
          region: 'auto',
          useSsl: true,
          urlStyle: 'path', // R2 S3 endpoint, path-style (matches the dataplane presign)
        },
      },
    };
  }

  // (b) byo-postgres: customer's own catalog DSN (from getEndpointGatewayConfig).
  if (cfg.ducklakeCatalogDsn) {
    return {
      lakeCatalog: LAKE_ALIAS,
      gatewayBoot: {
        ...base,
        catalogDsn: cfg.ducklakeCatalogDsn,
        metadataSchema: ep.catalog_schema ?? undefined,
      },
    };
  }

  // (c) local-file catalog (demo / host-native).
  if (cfg.ducklakeCatalogFile) {
    return {
      lakeCatalog: LAKE_ALIAS,
      gatewayBoot: { ...base, catalogFile: cfg.ducklakeCatalogFile },
    };
  }

  // (d) nothing real configured — the offline demo.
  return { lakeCatalog: 'memory' };
}

/** The org's slug (for the deterministic bucket name). Falls back to the org id. */
async function orgSlugFor(orgId: string): Promise<string> {
  const row = await queryOne<{ slug: string }>(`SELECT slug FROM "organization" WHERE id = $1`, [orgId]);
  return row?.slug ?? orgId;
}

/** Lazily assign + persist a deterministic metadata schema for an endpoint that has none. */
async function ensureEndpointSchema(endpointId: string): Promise<string> {
  const schema = endpointMetadataSchema(endpointId);
  await query(
    `UPDATE waddling.endpoint SET catalog_schema = $2 WHERE id = $1 AND catalog_schema IS NULL`,
    [endpointId, schema],
  );
  return schema;
}
