// GCS persistence helpers for workspace mode: fetch a SA Bearer token from the GCP metadata
// server, then GET/PUT a single object so the workspace .duckdb file survives container
// replacement. The gateway SA (gateway-run@...) has storage.objectAdmin on the workspace bucket.
//
// Object names with slashes (e.g. "org/agent.duckdb") are handled correctly:
//   encodeURIComponent encodes "/" → "%2F" in both the URL path segment and the name query param.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Fetch a short-lived Bearer token from the GCP metadata server using the default SA. */
async function getAccessToken(): Promise<string> {
  const r = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`GCP metadata token fetch failed: ${r.status} ${body}`);
  }
  const j = (await r.json()) as { access_token: string };
  return j.access_token;
}

/**
 * Download a GCS object to a local file.
 * Returns true on success, false on 404 (object not yet created = first boot → start fresh).
 * Throws on any other HTTP error so a misconfigured bucket or permission denial surfaces loudly.
 */
export async function gcsDownload(bucket: string, object: string, destPath: string): Promise<boolean> {
  const token = await getAccessToken();
  // encodeURIComponent encodes "/" → "%2F" so "org/agent.duckdb" resolves to the right object.
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return false;
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`GCS download failed: ${r.status} ${body}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, buf);
  console.log(`[gcs] restored gs://${bucket}/${object} → ${destPath} (${buf.length} bytes)`);
  return true;
}

/**
 * Upload a local file to GCS (simple media upload — not resumable).
 * Suitable for small workspace files (typically < 100 MB).
 * Overwrites any existing object at the same path.
 */
export async function gcsUpload(bucket: string, object: string, srcPath: string): Promise<void> {
  const token = await getAccessToken();
  const data = readFileSync(srcPath);
  // encodeURIComponent encodes "/" → "%2F" in the name query param so GCS stores the object
  // with its full hierarchical name (e.g. "bringup/ws.duckdb"), not split at the slash.
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(object)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
    },
    body: data,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`GCS upload failed: ${r.status} ${body}`);
  }
  console.log(`[gcs] persisted ${srcPath} → gs://${bucket}/${object} (${data.length} bytes)`);
}
