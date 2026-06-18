// Live round-trip test for workspace-store.ts against a real S3 (MinIO on :9133).
// Validates the @aws-sdk/client-s3 endpoint/path-style config + the GET/PUT/absent
// paths. Bucket is auto-created via CreateBucket (the store assumes the bucket exists
// in prod; the test provisions it).

import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
import { WorkspaceStore, workspaceKey, bucketFromDataPath } from "./workspace-store.ts";

const cfg = {
  endpoint: "localhost:9133",
  keyId: "minioadmin",
  secret: "minioadmin",
  region: "us-east-1",
  useSsl: false,
  urlStyle: "path",
  bucket: "waddling-lake",
};

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => { console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`); cond ? pass++ : fail++; };

// provision bucket
const admin = new S3Client({ endpoint: `http://${cfg.endpoint}`, forcePathStyle: true, region: cfg.region, credentials: { accessKeyId: cfg.keyId, secretAccessKey: cfg.secret } });
try { await admin.send(new CreateBucketCommand({ Bucket: cfg.bucket })); } catch (e) { if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(e.name)) throw e; }

const store = new WorkspaceStore(cfg);

check("bucketFromDataPath parses s3:// path", bucketFromDataPath("s3://waddling-lake/prefix/") === "waddling-lake");
const key = workspaceKey("ws-123", "agent-abc");
check("workspaceKey layout", key === "workspace/ws-123/db/agent-abc.duckdb", key);

// absent → null
const missing = await store.download(key);
check("download of absent object returns null", missing === null);

// upload random bytes (stand-in for an encrypted DB file)
const bytes = new Uint8Array(64 * 1024);
for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
await store.upload(key, bytes);
check("upload succeeds", true);

// download → byte-identical
const got = await store.download(key);
const identical = got && got.length === bytes.length && got.every((b, i) => b === bytes[i]);
check("download returns byte-identical content", identical, `len=${got?.length}`);

// overwrite (single-writer semantics)
const bytes2 = new Uint8Array([1, 2, 3, 4, 5]);
await store.upload(key, bytes2);
const got2 = await store.download(key);
check("overwrite replaces content", got2 && got2.length === 5 && got2[0] === 1);

console.log(`\n  ${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
