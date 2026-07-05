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
import { createHash } from 'node:crypto';
import type { Env } from './env';
import { getOrgCatalogDsn } from './catalog-provision';
import { getDatalakeGatewayConfig } from './datalake-secrets';
import { quackboardR2Key } from './gateway-boot';

const LAKE_BUCKET = 'waddling-lake-prod';

// Cloud Run URL suffix — the project-constant `-<hash>-<region>.a.run.app` tail. Deterministic
// per project (same value the router uses via RUN_URL_SUFFIX), so control-api can address a
// workspace service by name without persisting its URL.
const DEFAULT_RUN_URL_SUFFIX = '-ampdswzubq-uw.a.run.app';

/**
 * Deterministic Cloud Run service slug for a per-(workspace, agent) workspace. A short sha256 of
 * `<workspaceId>:<agentId>` — stable (idempotent provision + re-derivable at query/etl time) and a
 * valid Cloud Run name (lowercase hex, well under 63 chars once prefixed with `ws-`).
 */
export function workspaceSlug(workspaceId: string, agentId: string): string {
  return createHash('sha256').update(`${workspaceId}:${agentId}`).digest('hex').slice(0, 32);
}

/**
 * The private run.app URL of a workspace service, computed deterministically from its slug + the
 * project-constant Cloud Run suffix. control-api reaches the workspace's TRUSTED endpoints
 * (/ctrl/configure-lake, /relay-query, /ctrl/checkpoint) directly over OIDC at this URL.
 */
export function workspaceGatewayUrl(env: Env, workspaceId: string, agentId: string): string {
  const suffix = env.CLOUD_RUN_URL_SUFFIX || DEFAULT_RUN_URL_SUFFIX;
  return `https://ws-${workspaceSlug(workspaceId, agentId)}${suffix}`;
}

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

export interface ProvisionQuackboardInput {
  slug: string;
  orgId: string;
  serverToken: string;
  gcsBucket?: string;
  gcsObject?: string;
}

// Provision (create-or-wake) a per-org quackboard Cloud Run service. A quackboard runs the SAME
// parametric gateway image in QUACKBOARD=1 mode: it opens a durable .duckdb (restored/persisted to
// GCS) that IS the shared agent-memory board — no DuckLake, no object-store catalog, no Cloud SQL.
// Like a workspace it reaches no catalog and holds no libpq mTLS creds, so we send no DUCKLAKE/S3
// env, no secretEnv, no lake PEMs. kind 'workspace' just makes the provisioner drop the shared PEM
// secrets + the cloudsql-instances annotation and use the ws- prefix; the QUACKBOARD=1 env is what
// selects the mode. Same OIDC pattern as provisionWorkspace. Idempotent: an existing service is woken.
export async function provisionQuackboard(env: Env, input: ProvisionQuackboardInput): Promise<{ url: string }> {
  if (!env.PROVISIONER_URL) throw new Error('PROVISIONER_URL unset — cannot provision quackboard');

  const gcsBucket = input.gcsBucket ?? LAKE_BUCKET;
  const gcsObject = input.gcsObject ?? quackboardR2Key(input.orgId);

  const envMap: Record<string, string> = {
    QUACKBOARD: '1',
    DUCKDB_DATABASE_PATH: '/tmp/quackboard/qb.duckdb',
    WORKSPACE_GCS_BUCKET: gcsBucket,
    WORKSPACE_GCS_OBJECT: gcsObject,
    GW_SERVER_TOKEN: input.serverToken,
  };

  // OIDC: mint a Google identity token for the provisioner (audience = its URL), same pattern as
  // provisionWorkspace. Local/no-creds ⇒ no token (Cloud Run IAM still gates).
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
    body: JSON.stringify({ slug: input.slug, env: envMap, kind: 'workspace' }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`provisioner ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }
  const out = (await res.json()) as { url?: string };
  if (!out.url) throw new Error('provisioner returned no url');
  return { url: out.url };
}

export interface ProvisionWorkspaceInput {
  slug: string;
  workspaceId: string;
  agentId: string;
  encryptionKey: string;
  serverToken: string;
  gcsBucket?: string;
  gcsObject?: string;
}

// Provision (create-or-wake) a per-(org,agent) workspace Cloud Run service (ws-<slug>).
// A workspace opens an ENCRYPTED durable .duckdb (restored/persisted to GCS) and relays the governed
// lake over the public router. Unlike a gateway it reaches no Cloud SQL catalog and holds no libpq
// mTLS creds, so we send no DUCKLAKE/S3 env, no secretEnv, no lake PEMs: the provisioner
// (kind workspace) omits the shared PEM secrets and the cloudsql-instances annotation. Same OIDC
// pattern as provisionGateway. Idempotent: an existing service is updated/woken.
export async function provisionWorkspace(env: Env, input: ProvisionWorkspaceInput): Promise<{ url: string }> {
  if (!env.PROVISIONER_URL) throw new Error('PROVISIONER_URL unset — cannot provision workspace');

  const gcsBucket = input.gcsBucket ?? LAKE_BUCKET;
  const gcsObject = input.gcsObject ?? `workspace/${input.workspaceId}/db/${input.agentId}.duckdb`;

  // Filesystem-jail rollout gate (see Env.WORKSPACE_FS_JAIL). A global toggle jails every workspace;
  // otherwise the agentId must be in the comma-separated allowlist (canary). The gateway reads
  // WORKSPACE_FS_JAIL from its env and, when set, confines DuckDB file access to the workspace dir.
  const jailCfg = (env.WORKSPACE_FS_JAIL ?? '').trim();
  const fsJail =
    jailCfg !== '' &&
    (/^(1|true|yes|on|all)$/i.test(jailCfg) ||
      jailCfg.split(',').map((s) => s.trim()).includes(input.agentId));

  const envMap: Record<string, string> = {
    WORKSPACE_MODE: '1',
    DUCKDB_DATABASE_PATH: '/tmp/workspace/ws.duckdb',
    WORKSPACE_GCS_BUCKET: gcsBucket,
    WORKSPACE_GCS_OBJECT: gcsObject,
    WORKSPACE_ENCRYPTION_KEY: input.encryptionKey,
    GW_SERVER_TOKEN: input.serverToken,
    ...(fsJail ? { WORKSPACE_FS_JAIL: '1' } : {}),
  };

  // OIDC: mint a Google identity token for the provisioner (audience = its URL), same pattern as
  // provisionGateway. Local/no-creds ⇒ no token (Cloud Run IAM still gates).
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
    body: JSON.stringify({ slug: input.slug, env: envMap, kind: 'workspace' }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`provisioner ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }
  const out = (await res.json()) as { url?: string };
  if (!out.url) throw new Error('provisioner returned no url');
  return { url: out.url };
}
