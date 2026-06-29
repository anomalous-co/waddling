/**
 * Per-endpoint gateway provisioning client.
 *
 * Each datalake gets its OWN private Cloud Run gateway (gw-<slug>, max-instances=1) so tenants are
 * isolated at the container level. control-api does NOT hold run.admin; it calls the dedicated
 * provisioner service (which does) over service-to-service OIDC. The provisioner is private and only
 * control-api's SA has run.invoker on it, so Cloud Run IAM is the auth boundary.
 *
 * Storage is GCS (managed): DuckLake DATA_PATH = s3://waddling-lake-prod/<datalakeId>/ via the GCS
 * S3-interop endpoint; the HMAC creds are the SHARED gcs-hmac-* Secret Manager secrets the gateway
 * references (not per-endpoint). The catalog is the per-org Cloud SQL database (managed-postgres) or
 * the customer DSN (byo-postgres). The gateway creates its DuckLake metadata schema on ATTACH.
 */
import type { Env } from './env';
import { getOrgCatalogDsn } from './catalog-provision';
import { getDatalakeGatewayConfig } from './datalake-secrets';

const LAKE_BUCKET = 'waddling-lake-prod';

export interface ProvisionableDatalake {
  id: string;
  org_id: string;
  slug: string;
  server_token: string;
  catalog_schema: string | null;
  catalog_mode: string | null;
  encrypted: boolean;
}

export async function provisionGateway(env: Env, dl: ProvisionableDatalake): Promise<{ url: string }> {
  if (!env.PROVISIONER_URL) throw new Error('PROVISIONER_URL unset — cannot provision per-endpoint gateway');

  // Catalog DSN: the per-org Cloud SQL database (managed) or the customer's own (byo).
  let catalogDsn: string | null = null;
  if (dl.catalog_mode === 'byo-postgres') {
    const cfg = await getDatalakeGatewayConfig(dl.id);
    catalogDsn = cfg?.ducklakeCatalogDsn || null;
  } else {
    catalogDsn = await getOrgCatalogDsn(dl.org_id);
  }
  if (!catalogDsn) throw new Error('catalog DSN not ready — org catalog still provisioning?');

  const envMap: Record<string, string> = {
    GW_SERVER_TOKEN: dl.server_token,
    DUCKLAKE_CATALOG_DSN: catalogDsn,
    DUCKLAKE_METADATA_SCHEMA: dl.catalog_schema ?? `dl_${dl.slug.replace(/-/g, '_')}`,
    DUCKLAKE_DATA_PATH: `s3://${LAKE_BUCKET}/${dl.id}/`,
    DUCKLAKE_ALIAS: 'lake',
    DUCKLAKE_ENCRYPTED: String(dl.encrypted ?? false),
    S3_ENDPOINT: 'storage.googleapis.com',
    S3_REGION: 'us-west1',
    S3_USE_SSL: 'true',
    S3_URL_STYLE: 'path',
  };
  // Shared GCS HMAC creds (same secrets gw-bringup references) — not per-endpoint.
  const secretEnv: Record<string, string> = { S3_KEY_ID: 'gcs-hmac-key-id', S3_SECRET: 'gcs-hmac-secret' };

  // OIDC: mint a Google identity token for the provisioner (audience = its URL), same pattern as
  // gateway-client uses to reach the gateways. Local/no-creds ⇒ no token (Cloud Run IAM still gates).
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  try {
    const { GoogleAuth } = await import('google-auth-library');
    const client = await new GoogleAuth().getIdTokenClient(env.PROVISIONER_URL);
    Object.assign(headers, await client.getRequestHeaders(`${env.PROVISIONER_URL}/provision`));
  } catch {
    /* no creds (local) — proceed unauthenticated; a private provisioner will 403 */
  }

  const res = await fetch(`${env.PROVISIONER_URL}/provision`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ slug: dl.slug, env: envMap, secretEnv }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`provisioner ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }
  const out = (await res.json()) as { url?: string };
  if (!out.url) throw new Error('provisioner returned no url');
  return { url: out.url };
}
