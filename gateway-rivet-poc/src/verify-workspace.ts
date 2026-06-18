// Live Rivet verification for the workspace session actor. Drives the actor through
// the Rivet client boundary (configure/query/run/end RPCs) against a real engine,
// with a real quack lake (in-process) and real S3 (MinIO). Proves the thin actor
// wrapper + RPC serialization + S3 durability work end to end — the WorkspaceRunner
// underneath is already covered by workspace-runner.test.mjs.
//
// Run order: rivet-engine (:6420) → tsx src/workspace-registry.ts → MinIO (:9135) →
//            tsx src/verify-workspace.ts

import { createClient } from "rivetkit/client";
import type { registry } from "./workspace-registry.ts";
import { DuckDBInstance } from "@duckdb/node-api";
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";

const RIVET = process.env.RIVET_ENDPOINT ?? "http://localhost:6420";
const LAKE_PORT = 9606, LAKE_TOKEN = "verify-ws-token";
const KEY = "0123456789abcdef0123456789abcdef";
const s3 = {
  endpoint: "localhost:9135", keyId: "minioadmin", secret: "minioadmin",
  region: "us-east-1", useSsl: false, urlStyle: "path", bucket: "waddling-lake",
};

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = "") => { console.log(`  ${c ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); c ? pass++ : fail++; };

async function main(): Promise<void> {
  // provision bucket
  const admin = new S3Client({ endpoint: `http://${s3.endpoint}`, forcePathStyle: true, region: s3.region, credentials: { accessKeyId: s3.keyId, secretAccessKey: s3.secret } });
  try { await admin.send(new CreateBucketCommand({ Bucket: s3.bucket })); } catch (e) { if (!/BucketAlready/.test((e as Error).name)) throw e; }

  // stand up the lake over quack (in this process)
  const lake = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
  const lc = await lake.connect();
  await lc.run("INSTALL quack; LOAD quack;");
  await lc.run("CREATE TABLE memory.main.orders(id INT, who VARCHAR); INSERT INTO memory.main.orders VALUES (1,'a'),(2,'b'),(3,'c');");
  await lc.run(`CALL quack_serve('quack:localhost:${LAKE_PORT}', token := '${LAKE_TOKEN}')`);

  const cfg = { workspaceKey: KEY, lakeProxy: `localhost:${LAKE_PORT}`, lakeToken: LAKE_TOKEN, disableSsl: true, s3 };
  const client = createClient<typeof registry>(RIVET);

  // ── Session 1 through the Rivet actor ───────────────────────────────────────
  const ws = client.workspace.getOrCreate(["ws-verify", "agent-verify"]);
  await ws.configure(cfg);
  check("configure() via Rivet RPC", true);

  const q = await ws.query("FROM lake.query('FROM memory.main.orders')") as { rowCount: number };
  check("query() lake gated through quack (via Rivet)", q.rowCount === 3, `rowCount=${q.rowCount}`);

  // Through Rivet the actor's error is sanitized to "An internal error occurred",
  // so we can only observe that the s3:// read is REJECTED (returns no data). The
  // authoritative proof that the LEVER (not a network error) blocked it — the raw
  // "disabled by configuration" message — is in workspace-runner.test.mjs / sidecar test.
  const exfil = await ws.query("SELECT * FROM read_parquet('s3://nope/x.parquet')").then(() => "RETURNED_DATA").catch(() => "REJECTED");
  check("isolation: s3:// read rejected through the actor (no data)", exfil === "REJECTED");

  // CREATE OR REPLACE so re-runs against the persistent actor + S3 state are idempotent.
  await ws.run("CREATE OR REPLACE TABLE my_scratch AS SELECT * FROM lake.query('FROM memory.main.orders')");
  const sc = await ws.query("SELECT count(*) AS n FROM my_scratch") as { rows: unknown[][] };
  check("scratch built from gated read", Number(sc.rows[0][0]) === 3);

  await ws.snapshot();
  check("snapshot() → checkpoint + upload to S3", true);

  // end the session (checkpoint + upload + drop local), then a fresh session must
  // restore the scratch from S3 — durability across the actor boundary.
  await ws.end();
  const ws2 = client.workspace.getOrCreate(["ws-verify", "agent-verify"]);
  await ws2.configure(cfg);
  const restored = await ws2.query("SELECT count(*) AS n FROM my_scratch") as { rows: unknown[][] };
  check("durable: scratch restored from S3 in a new session", Number(restored.rows[0][0]) === 3, JSON.stringify(restored.rows));
  await ws2.end();

  try { await lc.run(`CALL quack_stop('quack:localhost:${LAKE_PORT}')`); } catch { /* ignore */ }

  console.log(`\n  ${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("verify error:", e); process.exit(1); });
