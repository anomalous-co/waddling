// Standalone test: a real DuckDB file → persistFile (chunked) → restoreFile must
// be byte-identical (sha256), and the restored bytes must reopen as a valid DB.
// Catches off-by-one reassembly in isolation, before three actor hops hide it.

import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { persistFile, restoreFile, type KvLike } from "./db-persist.ts";

const POC_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const LOCAL = resolve(POC_ROOT, ".local-diag");

const dec = new TextDecoder();
const ks = (k: string | Uint8Array) => (typeof k === "string" ? k : dec.decode(k));

class MockKv implements KvLike {
  m = new Map<string, string | Uint8Array>();
  async put(k: string | Uint8Array, v: string | Uint8Array) { this.m.set(ks(k), v); }
  async get(k: string | Uint8Array) { return (this.m.get(ks(k)) ?? null) as string | Uint8Array | null; }
  async deleteRange(s: Uint8Array, e: Uint8Array) {
    const ss = ks(s), ee = ks(e);
    for (const k of [...this.m.keys()]) if (k >= ss && k < ee) this.m.delete(k);
  }
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

(async () => {
  rmSync(LOCAL, { recursive: true, force: true });
  mkdirSync(LOCAL, { recursive: true });
  const src = resolve(LOCAL, "src.duckdb");

  const inst = await DuckDBInstance.create(src);
  const conn = await inst.connect();
  await conn.run("CREATE TABLE t(id INTEGER, v VARCHAR)");
  await conn.run("INSERT INTO t SELECT i, 'row-' || i FROM range(5000) AS r(i)"); // make it multi-chunk
  await conn.run("CHECKPOINT");

  const original = new Uint8Array(readFileSync(src));
  console.log(`source DB file: ${original.length} bytes (${Math.ceil(original.length / (120 * 1024))} chunks)`);

  const kv = new MockKv();
  const n = await persistFile(kv, original);
  const restored = await restoreFile(kv);
  if (!restored) { console.error("❌ restore returned null"); process.exit(1); }

  const ok = sha(original) === sha(restored);
  console.log(`chunks=${n} sha(original)==sha(restored): ${ok}`);
  if (!ok) { console.error("❌ byte mismatch after chunk round-trip"); process.exit(1); }

  // Bonus: the restored bytes must reopen as a valid DuckDB with the data intact.
  const dst = resolve(LOCAL, "restored.duckdb");
  writeFileSync(dst, restored);
  const inst2 = await DuckDBInstance.create(dst);
  const conn2 = await inst2.connect();
  const rows = (await conn2.runAndReadAll("SELECT count(*) AS n FROM t")).getRowObjects();
  console.log("restored DB reopened, SELECT count(*) →", rows);

  console.log("\n✅ chunk→KV→reassemble is byte-identical and reopens as a valid DB");
  process.exit(0);
})().catch((e) => { console.error("❌", e); process.exit(1); });
