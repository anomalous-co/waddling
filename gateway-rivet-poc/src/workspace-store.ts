// Encrypted-workspace persistence to object storage (S3 API: MinIO local, R2 prod).
//
// The session actor (Node) — NOT the sidecar's DuckDB — does this I/O: the
// workspace instance runs with disabled_filesystems='HTTPFileSystem,S3FileSystem',
// so it cannot touch S3 at all (by design — that's the S1 isolation boundary). The
// actor restores the encrypted file before spawning the sidecar and uploads it back
// after a checkpoint. The bytes are already AES-GCM ciphertext (native ENCRYPTION_KEY),
// so they are encrypted at rest in the bucket with no extra step here.
//
// Layout: s3://<bucket>/workspace/<workspaceId>/db/<agentId>.duckdb

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

export interface S3StoreConfig {
  /** Host[:port] without scheme, e.g. 'minio:9000' or '<acct>.r2.cloudflarestorage.com'. */
  endpoint: string;
  keyId: string;
  secret: string;
  region: string;
  /** false for MinIO local, true for R2. */
  useSsl: boolean;
  /** MinIO needs path-style; R2 works with either. */
  urlStyle: "path" | "vhost";
  /** Bucket holding the workspace files (the lake bucket with a workspace/ prefix, or a dedicated one). */
  bucket: string;
}

/** S3 object key for a workspace DB: workspace/<workspaceId>/db/<agentId>.duckdb */
export function workspaceKey(workspaceId: string, agentId: string): string {
  return `workspace/${workspaceId}/db/${agentId}.duckdb`;
}

export class WorkspaceStore {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(cfg: S3StoreConfig) {
    const clientCfg: S3ClientConfig = {
      endpoint: `${cfg.useSsl ? "https" : "http"}://${cfg.endpoint}`,
      forcePathStyle: cfg.urlStyle === "path",
      region: cfg.region,
      credentials: { accessKeyId: cfg.keyId, secretAccessKey: cfg.secret },
    };
    this.s3 = new S3Client(clientCfg);
    this.bucket = cfg.bucket;
  }

  /**
   * Download the encrypted workspace file. Returns null when the object does not
   * exist yet (first-ever session for this (workspace, agent) — the sidecar then
   * creates a fresh encrypted DB via the ENCRYPTION_KEY ATTACH).
   */
  async download(key: string): Promise<Uint8Array | null> {
    try {
      const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!out.Body) return null;
      return await out.Body.transformToByteArray();
    } catch (err: unknown) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /** Upload (overwrite) the encrypted workspace file. One writer per key (the actor). */
  async upload(key: string, bytes: Uint8Array): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: "application/octet-stream",
      }),
    );
  }
}

/** S3 "object absent" — NoSuchKey/NotFound name or a 404 status. */
function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === "NoSuchKey" || e.name === "NotFound" || e.$metadata?.httpStatusCode === 404;
}

/** Derive the bucket name from a DuckLake DATA_PATH like 's3://waddling-lake/prefix/'. */
export function bucketFromDataPath(dataPath: string): string {
  const m = /^s3:\/\/([^/]+)/i.exec(dataPath);
  if (!m) throw new Error(`cannot derive bucket from non-s3 DATA_PATH: ${dataPath}`);
  return m[1];
}
