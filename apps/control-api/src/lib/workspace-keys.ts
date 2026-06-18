/**
 * Workspace resolution + key custody
 * (ported from apps/waddling/src/lib/workspace-keys.ts, migration 006).
 *
 * A workspace is a first-class object (m2m with agents); each (workspace, agent)
 * pair owns one durable, natively-encrypted DuckDB file. This module is the single
 * server-side seam for:
 *   1. resolving which workspace an agent's session acts in (default-per-endpoint,
 *      or a named workspace), ensuring the m2m membership + db_uri,
 *   2. vending the per-(workspace, agent) 32-byte encryption key — generated lazily,
 *      stored ENVELOPE-ENCRYPTED (secret-crypto, same model as endpoint secrets),
 *      and returned ONLY to the session actor, NEVER to the agent.
 *
 * The S3 coords the actor persists to are derived from the endpoint's own storage
 * config (getEndpointGatewayConfig) — the workspace file lives in the lake bucket
 * under a sibling `workspace/` prefix.
 *
 * Workers difference vs the original: seal/open come from `getCrypto()` (the
 * per-isolate pair built from env — see secret-crypto.ts) rather than a
 * module-singleton import; signatures are unchanged. Current logic is preserved
 * faithfully — the per-team-R2 rework is Stage C (see the marker below).
 */
import { randomBytes } from 'node:crypto';
import { query, queryOne } from './db';
import { getCrypto, type SealedSecret } from './secret-crypto';
import { getEndpointGatewayConfig } from './endpoint-secrets';

export interface ResolvedWorkspace {
  workspaceId: string;
  agentId: string;
  /** s3://<bucket>/workspace/<workspaceId>/db/<agentId>.duckdb */
  dbUri: string;
}

/** S3 coords for the session actor's WorkspaceStore (mirrors workspace-store S3StoreConfig). */
export interface WorkspaceS3Config {
  endpoint: string;
  keyId: string;
  secret: string;
  region: string;
  useSsl: boolean;
  urlStyle: 'path' | 'vhost';
  bucket: string;
}

const DEFAULT_WORKSPACE = 'default';

const workspaceKey = (workspaceId: string, agentId: string): string =>
  `workspace/${workspaceId}/db/${agentId}.duckdb`;

/** Derive the bucket from a DuckLake DATA_PATH like 's3://waddling-lake/prefix/'. */
export function bucketFromDataPath(dataPath: string): string {
  const m = /^s3:\/\/([^/]+)/i.exec(dataPath);
  if (!m) throw new Error(`workspace persistence needs an s3:// DATA_PATH, got: ${dataPath}`);
  return m[1];
}

/**
 * Resolve (creating if needed) the workspace this session acts in, and ensure the
 * agent's m2m membership + db_uri. `name` selects a specific workspace; default is
 * one shared 'default' workspace per (org, endpoint).
 */
export async function resolveWorkspaceForSession(
  orgId: string,
  endpointId: string,
  agentId: string,
  name: string = DEFAULT_WORKSPACE,
): Promise<ResolvedWorkspace> {
  // Upsert the workspace (org, name) bound to this endpoint.
  let ws = await queryOne<{ id: string; data_path: string }>(
    `SELECT w.id, e.data_path
       FROM waddling.workspace w
       JOIN waddling.endpoint e ON e.id = w.endpoint_id
      WHERE w.org_id = $1 AND w.name = $2 AND w.endpoint_id = $3`,
    [orgId, name, endpointId],
  );
  if (!ws) {
    const created = await queryOne<{ id: string }>(
      `INSERT INTO waddling.workspace (org_id, name, endpoint_id)
         VALUES ($1, $2, $3)
       ON CONFLICT (org_id, name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [orgId, name, endpointId],
    );
    const dp = await queryOne<{ data_path: string }>(
      `SELECT data_path FROM waddling.endpoint WHERE id = $1`,
      [endpointId],
    );
    ws = { id: created!.id, data_path: dp!.data_path };
  }

  // db_uri is informational for the CF data plane: the dataplane owns the actual workspace
  // file I/O (presigned URLs against its own R2 bucket), so this is NOT a storage coord.
  // A managed endpoint's data_path is a marker (the faucet sets the real lake path at boot),
  // so don't require s3:// here — fall back to a logical bucket for the uri.
  const wsBucket = /^s3:\/\//i.test(ws.data_path) ? bucketFromDataPath(ws.data_path) : 'managed-workspace';
  const dbUri = `s3://${wsBucket}/${workspaceKey(ws.id, agentId)}`;

  // Ensure the m2m membership + db_uri (idempotent).
  await query(
    `INSERT INTO waddling.workspace_agent (workspace_id, agent_id, db_uri)
       VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, agent_id)
       DO UPDATE SET db_uri = COALESCE(waddling.workspace_agent.db_uri, EXCLUDED.db_uri)`,
    [ws.id, agentId, dbUri],
  );

  return { workspaceId: ws.id, agentId, dbUri };
}

interface KeyRow { key_iv: Buffer | null; key_auth_tag: Buffer | null; key_ciphertext: Buffer | null }

/**
 * Vend the per-(workspace, agent) 32-byte key (hex). Generated + sealed on first
 * use, decrypted thereafter. Server-only; the result is handed to the session actor
 * and never returned to the agent.
 */
export async function ensureWorkspaceKey(workspaceId: string, agentId: string): Promise<string> {
  const row = await queryOne<KeyRow>(
    `SELECT key_iv, key_auth_tag, key_ciphertext
       FROM waddling.workspace_agent WHERE workspace_id = $1 AND agent_id = $2`,
    [workspaceId, agentId],
  );
  if (row && row.key_iv && row.key_auth_tag && row.key_ciphertext) {
    const sealed: SealedSecret = { iv: row.key_iv, authTag: row.key_auth_tag, ciphertext: row.key_ciphertext };
    return getCrypto().openJson<{ key: string }>(sealed).key;
  }
  // Generate a fresh 32-byte key (64 hex chars) and seal it.
  const key = randomBytes(32).toString('hex');
  const s = getCrypto().sealJson({ key });
  await query(
    `UPDATE waddling.workspace_agent
        SET key_iv = $3, key_auth_tag = $4, key_ciphertext = $5
      WHERE workspace_id = $1 AND agent_id = $2`,
    [workspaceId, agentId, s.iv, s.authTag, s.ciphertext],
  );
  return key;
}

/** Build the actor's S3 persistence coords from the endpoint's storage config. */
export async function getWorkspaceS3Config(endpointId: string): Promise<WorkspaceS3Config> {
  // Stage C rework: point at per-team R2 bucket, not the customer lake bucket. The
  // current logic (preserved) derives the workspace file's S3 coords from the
  // endpoint's own BYO storage config — workspace files share the lake bucket under
  // a `workspace/` prefix. Stage C moves durable workspaces to a waddling-owned
  // per-team R2 bucket (DO-minted presigned URLs), decoupling them from the
  // customer's lake storage; repoint here then.
  const cfg = await getEndpointGatewayConfig(endpointId);
  if (!cfg || cfg.localData || !cfg.s3) {
    throw new Error('workspace persistence requires an s3:// endpoint with storage credentials');
  }
  return {
    endpoint: cfg.s3.endpoint,
    keyId: cfg.s3.keyId,
    secret: cfg.s3.secret,
    region: cfg.s3.region,
    useSsl: cfg.s3.useSsl,
    urlStyle: cfg.s3.urlStyle,
    bucket: bucketFromDataPath(cfg.ducklakeDataPath),
  };
}
