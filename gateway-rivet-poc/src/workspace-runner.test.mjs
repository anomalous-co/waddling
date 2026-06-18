// Capstone integration test: the full per-(workspace,agent) data path WITHOUT Rivet.
// Real MinIO (S3) + real quack lake + the real sidecar, driven through WorkspaceRunner.
// Proves: lake access is gated through quack; the workspace is isolated (no direct
// object-store/HTTP); scratch commits to the encrypted file; the encrypted file is
// persisted to S3; and a COLD runner (new process-side instance) restores it from S3
// and sees the scratch — the durable-workspace promise, end to end.
//
// Requires MinIO on :9134 (the harness starts/stops it around this script).

import { DuckDBInstance } from "@duckdb/node-api";
import { S3Client, CreateBucketCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceRunner } from "./workspace-runner.ts";

const LAKE_PORT = 9604, LAKE_TOKEN = "runner-test-token";
const KEY = "0123456789abcdef0123456789abcdef";
const tmpRoot = mkdtempSync(join(tmpdir(), "ws-runner-"));
const s3 = {
  endpoint: "localhost:9134", keyId: "minioadmin", secret: "minioadmin",
  region: "us-east-1", useSsl: false, urlStyle: "path", bucket: "waddling-lake",
};

let pass = 0, fail = 0;
const check = (n, c, d = "") => { console.log(`  ${c ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); c ? pass++ : fail++; };

// provision bucket
const admin = new S3Client({ endpoint: `http://${s3.endpoint}`, forcePathStyle: true, region: s3.region, credentials: { accessKeyId: s3.keyId, secretAccessKey: s3.secret } });
try { await admin.send(new CreateBucketCommand({ Bucket: s3.bucket })); } catch (e) { if (!/BucketAlready/.test(e.name)) throw e; }

// stand up the lake over quack
const lake = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
const lc = await lake.connect();
await lc.run("INSTALL quack; LOAD quack;");
await lc.run("CREATE TABLE memory.main.orders(id INT, who VARCHAR); INSERT INTO memory.main.orders VALUES (1,'a'),(2,'b'),(3,'c');");
await lc.run(`CALL quack_serve('quack:localhost:${LAKE_PORT}', token := '${LAKE_TOKEN}')`);

const cfg = { workspaceKey: KEY, lakeProxy: `localhost:${LAKE_PORT}`, lakeToken: LAKE_TOKEN, disableSsl: true, s3 };
let exitCode = 1;
try {
  // ── Session 1: fresh workspace, build scratch from a gated lake read ─────────
  const r1 = new WorkspaceRunner("ws-1", "agent-1", tmpRoot);
  await r1.configure(cfg);
  const lakeQ = await r1.query("FROM lake.query('FROM memory.main.orders')");
  check("session1: lake query gated through quack", lakeQ.rowCount === 3, `rowCount=${lakeQ.rowCount}`);

  // isolation
  const s3try = await r1.query("SELECT * FROM read_parquet('s3://nope/x.parquet')").then(() => null).catch((e) => e.message);
  check("session1: direct s3:// read blocked by lever", typeof s3try === "string" && s3try.includes("disabled by configuration"), s3try?.split("\n")[0]);

  await r1.run("CREATE TABLE my_scratch AS SELECT * FROM lake.query('FROM memory.main.orders')");
  const sc = await r1.query("SELECT count(*) AS n FROM my_scratch");
  check("session1: scratch built from lake read", sc.rows[0][0] === 3);

  await r1.end(); // checkpoint + upload + drop local

  // ── prove the uploaded object is ciphertext, not a plaintext DuckDB file ──────
  const obj = await admin.send(new GetObjectCommand({ Bucket: s3.bucket, Key: "workspace/ws-1/db/agent-1.duckdb" }));
  const head = (await obj.Body.transformToByteArray()).subarray(0, 4);
  check("uploaded workspace object is encrypted (not 'DUCK')", Buffer.from(head).toString("latin1") !== "DUCK", `first4=${JSON.stringify(Buffer.from(head).toString("latin1"))}`);

  // ── Session 2: COLD runner, must restore scratch from S3 ──────────────────────
  const r2 = new WorkspaceRunner("ws-1", "agent-1", mkdtempSync(join(tmpdir(), "ws-runner-cold-")));
  await r2.configure(cfg);
  const afterRestore = await r2.query("SELECT count(*) AS n FROM my_scratch");
  check("session2 (cold): scratch restored from S3 — durable workspace", afterRestore.rows[0][0] === 3, JSON.stringify(afterRestore.rows));
  const stillGated = await r2.query("FROM lake.query('FROM memory.main.orders')");
  check("session2: lake re-attached + gated", stillGated.rowCount === 3);
  await r2.end();

  console.log(`\n  ${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
  exitCode = fail === 0 ? 0 : 1;
} catch (e) {
  console.error("test error:", e);
} finally {
  try { await lc.run(`CALL quack_stop('quack:localhost:${LAKE_PORT}')`); } catch {}
  rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(exitCode);
}
