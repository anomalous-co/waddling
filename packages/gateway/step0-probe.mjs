// Workspace isolation + encryption probe — answers the two empirical questions that
// branch the per-agent workspace design: (1) what lever isolates the workspace
// DuckDB from the lake's object store without breaking the quack lake ATTACH, and
// (2) whether native ENCRYPTION_KEY works under that posture. Run from
// packages/gateway (needs @duckdb/node-api). Diagnostic; safe to re-run.
//
// The REAL sidecar posture: external access must stay ON (else no extensions load),
// quack + httpfs both LOADed (httpfs = OpenSSL crypto provider for encrypted DBs).
// So isolation can't use enable_external_access=false at create time. We test the
// viable levers and — critically — whether the AGENT (arbitrary workspace SQL) can
// UNDO the lever, which would defeat S1.

import { DuckDBInstance } from "@duckdb/node-api";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 9578;
const TOKEN = "step0-probe-token";
const tmp = mkdtempSync(join(tmpdir(), "step0-"));
const line = (k, v) => console.log(`  ${k.padEnd(52)} ${v}`);
const ok = (b) => (b ? "✅ yes" : "❌ NO");

// ── Gateway-side instance: serve a tiny lake over quack ───────────────────────
const gw = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
const gwc = await gw.connect();
await gwc.run("INSTALL quack; LOAD quack;");
await gwc.run("CREATE TABLE memory.main.orders (id INTEGER, who VARCHAR)");
await gwc.run("INSERT INTO memory.main.orders VALUES (1,'ok'),(2,'fine')");
await gwc.run(`CALL quack_serve('quack:localhost:${PORT}', token := '${TOKEN}')`);

async function fresh() {
  const inst = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
  const con = await inst.connect();
  await con.run("SET autoinstall_known_extensions=false; SET autoload_known_extensions=false;");
  await con.run("LOAD quack; LOAD httpfs;"); // both loaded — the real posture
  return con;
}
async function quackWorks(con) {
  try {
    await con.run(`ATTACH 'quack:localhost:${PORT}' AS lake (TOKEN '${TOKEN}', DISABLE_SSL true)`);
    const r = await con.runAndReadAll("FROM lake.query('FROM memory.main.orders')");
    return { ok: true, rows: r.getRowObjects().length };
  } catch (e) { return { ok: false, err: e.message.split("\n")[0] }; }
}
async function blocked(con, sql) {
  // STRICT: only count it blocked if the LEVER blocked it ("disabled by
  // configuration"). A network error (e.g. 404) means the request went OUT — the
  // lever no-op'd (wrong filesystem name) and exfil is actually open.
  try { await con.runAndReadAll(sql); return false; }
  catch (e) { return String(e.message).includes("disabled by configuration"); }
}
async function canSet(con, sql) {
  try { await con.run(sql); return true; }
  catch { return false; }
}

const S3 = "SELECT * FROM read_csv('s3://nope-bucket/x.csv')";
const HTTP = "SELECT * FROM read_csv('http://example.com/x.csv')";

// ── Lever A: disabled_filesystems (httpfs loaded) ─────────────────────────────
console.log("\n=== Lever A: SET disabled_filesystems='HTTPFileSystem,S3FileSystem' (httpfs loaded) ===");
{
  const con = await fresh();
  await con.run("SET disabled_filesystems='HTTPFileSystem,S3FileSystem';");
  const q = await quackWorks(con);
  line("quack lake ATTACH + query works", q.ok ? `✅ yes (${q.rows} rows)` : `❌ NO — ${q.err}`);
  line("read_csv('s3://…') blocked", ok(await blocked(con, S3)));
  line("read_csv('http://…') blocked", ok(await blocked(con, HTTP)));
  // Can the agent UNDO it? (defeats S1 if yes)
  const reset = await canSet(con, "RESET disabled_filesystems;");
  const setEmpty = await canSet(con, "SET disabled_filesystems='';");
  line("agent can RESET disabled_filesystems", reset ? "⚠️  YES (defeats lever)" : "✅ no");
  line("agent can SET disabled_filesystems=''", setEmpty ? "⚠️  YES (defeats lever)" : "✅ no");
  if (reset || setEmpty) line("  → after undo, http exfil blocked?", ok(await blocked(con, HTTP)));
}

// ── Lever B: disabled_filesystems + lock_configuration=true ───────────────────
console.log("\n=== Lever B: disabled_filesystems + SET lock_configuration=true ===");
{
  const con = await fresh();
  await con.run("SET disabled_filesystems='HTTPFileSystem,S3FileSystem';");
  const locked = await canSet(con, "SET lock_configuration=true;");
  line("lock_configuration=true accepted", ok(locked));
  const q = await quackWorks(con);
  line("quack lake ATTACH + query works (after lock)", q.ok ? `✅ yes (${q.rows} rows)` : `❌ NO — ${q.err}`);
  line("read_csv('s3://…') blocked", ok(await blocked(con, S3)));
  line("read_csv('http://…') blocked", ok(await blocked(con, HTTP)));
  const reset = await canSet(con, "RESET disabled_filesystems;");
  const setEmpty = await canSet(con, "SET disabled_filesystems='';");
  line("agent can RESET disabled_filesystems (after lock)", reset ? "⚠️  YES" : "✅ no");
  line("agent can SET disabled_filesystems='' (after lock)", setEmpty ? "⚠️  YES" : "✅ no");
  if (reset || setEmpty) line("  → after undo, http exfil blocked?", ok(await blocked(con, HTTP)));
}

// ── Lever C: load exts, then SET enable_external_access=false at runtime ───────
console.log("\n=== Lever C: LOAD exts, then SET enable_external_access=false (runtime) ===");
{
  const con = await fresh();
  const flipped = await canSet(con, "SET enable_external_access=false;");
  line("enable_external_access=false accepted at runtime", ok(flipped));
  if (flipped) {
    const q = await quackWorks(con);
    line("quack lake ATTACH + query works (after flip)", q.ok ? `✅ yes (${q.rows} rows)` : `❌ NO — ${q.err}`);
    line("read_csv('s3://…') blocked", ok(await blocked(con, S3)));
    line("read_csv('http://…') blocked", ok(await blocked(con, HTTP)));
    const reEnable = await canSet(con, "SET enable_external_access=true;");
    line("agent can re-enable external_access", reEnable ? "⚠️  YES (defeats lever)" : "✅ no (irreversible)");
  }
}

// ── 0.2 — native encryption under the real posture (httpfs loaded) ────────────
console.log("\n=== 0.2  native ENCRYPTION_KEY workspace (httpfs loaded, disabled_filesystems set) ===");
const dbPath = join(tmp, "ws.duckdb");
const KEY = "0123456789abcdef0123456789abcdef";
{
  const con = await fresh();
  await con.run("SET disabled_filesystems='HTTPFileSystem,S3FileSystem';"); // the isolation lever
  let wrote = false;
  try {
    await con.run(`ATTACH '${dbPath}' AS w (ENCRYPTION_KEY '${KEY}')`);
    await con.run("USE w");
    await con.run("CREATE TABLE scratch AS SELECT 42 AS answer");
    await con.run("CHECKPOINT");
    await con.run("USE memory; DETACH w;");
    wrote = true;
  } catch (e) { line("encrypted ATTACH+write", `❌ NO — ${e.message.split("\n")[0]}`); }
  line("encrypted local ATTACH+write works (with lever on)", ok(wrote));
  if (wrote) {
    // reopen correct key
    const c2 = await fresh();
    let good = false, val;
    try { await c2.run(`ATTACH '${dbPath}' AS w (ENCRYPTION_KEY '${KEY}')`); const r = await c2.runAndReadAll("SELECT answer FROM w.scratch"); good = true; val = r.getRowObjects()[0]?.answer; } catch {}
    line("reopen with correct key", good ? `✅ yes (answer=${val})` : "❌ NO");
    // reopen wrong key
    const c3 = await fresh();
    let bad = false;
    try { await c3.run(`ATTACH '${dbPath}' AS w (ENCRYPTION_KEY 'ffffffffffffffffffffffffffffffff')`); await c3.runAndReadAll("SELECT answer FROM w.scratch"); bad = true; } catch {}
    line("reopen with WRONG key fails", ok(!bad));
    const magic = readFileSync(dbPath).subarray(0, 4).toString("latin1");
    line(`first 4 bytes = ${JSON.stringify(magic)} (plaintext='DUCK')`, ok(magic !== "DUCK"));
  }
}

try { await gwc.run(`CALL quack_stop('quack:localhost:${PORT}')`); } catch {}
rmSync(tmp, { recursive: true, force: true });
process.exit(0);
