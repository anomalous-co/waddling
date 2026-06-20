/**
 * Endpoint credential store + gateway-config accessor
 * (ported from apps/waddling/src/lib/datalake-secrets.ts, migration 005).
 *
 * THE CONTRACT: `getDatalakeGatewayConfig(datalakeId)` decrypts an endpoint's
 * stored credentials and returns the exact shape the data-plane gateway consumes
 * (packages/gateway config.s3 + DuckLake catalog/data fields). This is the single
 * server-side seam between the control plane's secret store and the gateway boot
 * path — swap the storage mechanism (Secret Manager, KMS, …) behind it without
 * touching callers.
 *
 * Secrets are envelope-encrypted (secret-crypto). Non-secret descriptor fields
 * (endpoint host, region, url style) live on the endpoint row. NEVER expose any
 * of this to the browser (mirrors the `// never send server_token` rule).
 *
 * Workers difference vs the original: the original imported a module-singleton
 * `sealJson`/`openJson`. Here those come from `getCrypto()` (the per-isolate pair
 * built from env via initCrypto — see secret-crypto.ts). The BYTEA
 * {iv, authTag, ciphertext} round-trip is byte-for-byte unchanged, so secrets
 * sealed by either codebase interoperate.
 */
import { query, queryOne } from './db';
import { getCrypto, type SealedSecret } from './secret-crypto';

export type SecretKind = 'storage' | 'catalog';

/** Object-store credentials (the 'storage' secret). */
export interface StorageCreds {
  keyId: string;
  secret: string;
  sessionToken?: string;
}

/** BYO postgres catalog DSN (the 'catalog' secret). */
export interface CatalogCreds {
  dsn: string;
}

interface SecretRow {
  iv: Buffer;
  auth_tag: Buffer;
  ciphertext: Buffer;
}

const toSealed = (r: SecretRow): SealedSecret => ({
  iv: r.iv,
  authTag: r.auth_tag,
  ciphertext: r.ciphertext,
});

/** Encrypt + upsert one credential payload for an endpoint. */
export async function putEndpointSecret(
  datalakeId: string,
  kind: SecretKind,
  payload: StorageCreds | CatalogCreds,
): Promise<void> {
  const s = getCrypto().sealJson(payload);
  await query(
    `INSERT INTO waddling.datalake_secret (datalake_id, kind, iv, auth_tag, ciphertext)
       VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (datalake_id, kind)
       DO UPDATE SET iv = $3, auth_tag = $4, ciphertext = $5, updated_at = now()`,
    [datalakeId, kind, s.iv, s.authTag, s.ciphertext],
  );
}

/** Resolved gateway config for one endpoint — mirrors packages/gateway config.s3. */
export interface DatalakeGatewayConfig {
  /** Postgres DSN for the DuckLake catalog ('' in managed-local mode). */
  ducklakeCatalogDsn: string;
  /** Local DuckLake catalog file ('' unless managed-local). */
  ducklakeCatalogFile: string;
  /** DATA_PATH: 's3://bucket/prefix/' or a local dir. */
  ducklakeDataPath: string;
  /** True when DATA_PATH is local (no object-store secret needed). */
  localData: boolean;
  /** ENCRYPTED ducklake attach. */
  encrypted: boolean;
  /** Object-store secret. Undefined for local data. keyId/secret '' for credential_chain. */
  s3?: {
    provider: 'config' | 'credential_chain';
    endpoint: string;
    keyId: string;
    secret: string;
    sessionToken?: string;
    region: string;
    useSsl: boolean;
    urlStyle: 'path' | 'vhost';
  };
}

interface EndpointStorageRow {
  data_path: string;
  encrypted: boolean;
  storage_provider: string | null;
  storage_endpoint: string | null;
  storage_region: string | null;
  storage_url_style: 'path' | 'vhost' | null;
  storage_use_ssl: boolean | null;
  catalog_mode: string | null;
  catalog_file: string | null;
}

/**
 * Decrypt an endpoint's credentials into the gateway's runtime config shape.
 * Returns null if the endpoint doesn't exist. Server-only.
 */
export async function getDatalakeGatewayConfig(
  datalakeId: string,
): Promise<DatalakeGatewayConfig | null> {
  const ep = await queryOne<EndpointStorageRow>(
    `SELECT data_path, encrypted, storage_provider, storage_endpoint, storage_region,
            storage_url_style, storage_use_ssl, catalog_mode, catalog_file
       FROM waddling.datalake WHERE id = $1`,
    [datalakeId],
  );
  if (!ep) return null;

  const secrets = await query<SecretRow & { kind: SecretKind }>(
    `SELECT kind, iv, auth_tag, ciphertext FROM waddling.datalake_secret WHERE datalake_id = $1`,
    [datalakeId],
  );
  const byKind = new Map(secrets.rows.map((r) => [r.kind, r]));

  const localData = !/^s3:\/\//i.test(ep.data_path);

  let s3: DatalakeGatewayConfig['s3'];
  if (!localData && ep.storage_provider) {
    const provider = ep.storage_provider as 'config' | 'credential_chain';
    const creds =
      provider === 'config' && byKind.has('storage')
        ? getCrypto().openJson<StorageCreds>(toSealed(byKind.get('storage')!))
        : { keyId: '', secret: '' };
    s3 = {
      provider,
      endpoint: ep.storage_endpoint ?? '',
      region: ep.storage_region ?? 'auto',
      useSsl: ep.storage_use_ssl ?? true,
      urlStyle: ep.storage_url_style ?? 'vhost',
      ...creds,
    };
  }

  let ducklakeCatalogDsn = '';
  if (ep.catalog_mode === 'byo-postgres' && byKind.has('catalog')) {
    ducklakeCatalogDsn = getCrypto().openJson<CatalogCreds>(toSealed(byKind.get('catalog')!)).dsn;
  }

  return {
    ducklakeCatalogDsn,
    ducklakeCatalogFile: ep.catalog_file ?? '',
    ducklakeDataPath: ep.data_path,
    localData,
    encrypted: ep.encrypted,
    s3,
  };
}
