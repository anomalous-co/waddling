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
import { getDatalakeGatewayConfig } from './datalake-secrets';
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
  kind: string;
}

const LAKE_ALIAS = 'lake';
const QUACKBOARD_ALIAS = 'quackboard';

/** R2 object key for an org's durable quackboard .duckdb file. */
export function quackboardR2Key(orgId: string): string {
  return `quackboard/${orgId}/quackboard.duckdb`;
}

/** Deterministic per-endpoint metadata schema (PG-identifier-safe). */
export function endpointMetadataSchema(datalakeId: string): string {
  return `ep_${datalakeId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

/**
 * Resolve the boot config + birdshot lake catalog for an endpoint. Throws
 * CatalogNotReadyError when the endpoint is configured for the managed catalog but the
 * org's catalog is still provisioning (the caller maps that to a retryable 503).
 */
export async function resolveGatewayBoot(env: Env, datalakeId: string): Promise<ResolvedGatewayBoot> {
  const ep = await queryOne<EndpointCatalogRow>(
    `SELECT org_id, server_token, catalog_mode, catalog_schema, kind
       FROM waddling.datalake WHERE id = $1`,
    [datalakeId],
  );
  if (!ep) return { lakeCatalog: 'memory' };

  // Quackboard: no DuckLake, no object store. The served DuckDB IS the durable store; the
  // data plane restores/persists it from R2 at `r2Key`. birdshot still boots + enforces, so
  // birdshot resolves agent table refs against the served db's own catalog (QUACKBOARD_ALIAS).
  if (ep.kind === 'quackboard') {
    return {
      lakeCatalog: QUACKBOARD_ALIAS,
      gatewayBoot: {
        serverToken: ep.server_token,
        alias: QUACKBOARD_ALIAS,
        quackboard: true,
        r2Key: quackboardR2Key(ep.org_id),
      },
    };
  }

  const cfg = await getDatalakeGatewayConfig(datalakeId);
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

  // (a) managed-postgres: shared per-org Neon catalog + per-datalake metadata schema. Storage
  // is independent: a BYO bucket (the datalake carries real S3 creds) OR managed R2 minted by
  // the faucet. The catalog is managed either way.
  if (ep.catalog_mode === 'managed-postgres') {
    const dsn = await getOrgCatalogDsn(ep.org_id);
    if (!dsn) {
      throw new CatalogNotReadyError(
        `org ${ep.org_id} managed catalog is still provisioning — retry shortly`,
      );
    }
    const schema = ep.catalog_schema ?? (await ensureEndpointSchema(datalakeId));

    // BYO object storage + managed Neon catalog: use the datalake's own bucket + creds (base
    // already carries cfg.ducklakeDataPath + cfg.s3). No faucet needed.
    if (cfg.s3 && cfg.s3.keyId && cfg.s3.secret) {
      return {
        lakeCatalog: LAKE_ALIAS,
        gatewayBoot: { ...base, catalogDsn: dsn, metadataSchema: schema },
      };
    }

    // Managed lake data lives in GCS now, provisioned into the per-endpoint gateway's deploy env
    // by the provisioner; gatewayBoot is inert on the wire (the gateway reads its catalog + storage
    // from env, not the snapshot). So when the legacy R2 faucet is absent the push needs only the
    // catalog alias + schema — no bucket/cred minting. (The R2 path below is kept for any legacy
    // R2-faucet deployment.)
    const faucet = getR2Faucet(env);
    if (!faucet) {
      return {
        lakeCatalog: LAKE_ALIAS,
        gatewayBoot: { ...base, catalogDsn: dsn, metadataSchema: schema },
      };
    }
    const slug = await orgSlugFor(ep.org_id);
    const bucket = orgBucketName(slug);
    await faucet.ensureBucket(bucket);
    const prefix = `${datalakeId}/`;
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

  // (b) byo-postgres: customer's own catalog DSN (from getDatalakeGatewayConfig).
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
async function ensureEndpointSchema(datalakeId: string): Promise<string> {
  const schema = endpointMetadataSchema(datalakeId);
  await query(
    `UPDATE waddling.datalake SET catalog_schema = $2 WHERE id = $1 AND catalog_schema IS NULL`,
    [datalakeId, schema],
  );
  return schema;
}
