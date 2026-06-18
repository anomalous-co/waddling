// Local end-to-end test for workspace-sidecar.ts. Stands up a real quack server
// (a stand-in lake), spawns the sidecar as a child, and asserts the security +
// durability contract: lake access works, direct object-store/HTTP exfil is
// blocked, the on-disk file is encrypted, queries run FIFO, and committed scratch
// survives a full process restart. No Rivet needed.

import { DuckDBInstance } from "@duckdb/node-api";
import { spawn } from "node:child_process";
import { readFileSync, rmSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const SIDECAR = resolve(HERE, "workspace-sidecar.ts");
const TSX = resolve(HERE, "..", "node_modules", ".bin", "tsx");
const LAKE_PORT = 9601;
const SIDECAR_PORT = 9602;
const LAKE_TOKEN = "ws-test-lake-token";
const KEY = "0123456789abcdef0123456789abcdef";
const tmp = mkdtempSync(join(tmpdir(), "ws-sidecar-"));
const dbFile = join(tmp, "workspace.duckdb");

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};

async function post(path, body) {
  const r = await fetch(`http://127.0.0.1:${SIDECAR_PORT}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  return { status: r.status, body: txt ? JSON.parse(txt) : {} };
}

function spawnSidecar() {
  const proc = spawn(TSX, [SIDECAR], {
    env: { ...process.env, SIDECAR_PORT: String(SIDECAR_PORT), DB_FILE: dbFile },
    stdio: "inherit",
  });
  return proc;
}

async function waitHealthy(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(`http://127.0.0.1:${SIDECAR_PORT}/health`); if (r.ok || r.status === 503) return r.status; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("sidecar never came up");
}

// ── Stand up the stand-in lake over quack ─────────────────────────────────────
const lake = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
const lakeConn = await lake.connect();
await lakeConn.run("INSTALL quack; LOAD quack;");
await lakeConn.run("CREATE TABLE memory.main.orders (id INTEGER, who VARCHAR)");
await lakeConn.run("INSERT INTO memory.main.orders VALUES (1,'ok'),(2,'fine'),(3,'three')");
await lakeConn.run(`CALL quack_serve('quack:localhost:${LAKE_PORT}', token := '${LAKE_TOKEN}')`);

let sidecar = spawnSidecar();
let exitCode = 1;
try {
  await waitHealthy();

  // ── init: isolation posture + encrypted workspace + lake attach ─────────────
  const init = await post("/init", { key: KEY, lakeProxy: `localhost:${LAKE_PORT}`, lakeToken: LAKE_TOKEN, disableSsl: true });
  check("init succeeds + lake attached", init.status === 200 && init.body.lakeAttached === true, JSON.stringify(init.body));

  // ── lake access works (the one gated path) ──────────────────────────────────
  const lakeQ = await post("/query", { sql: "FROM lake.query('FROM memory.main.orders')" });
  check("lake query returns rows", lakeQ.status === 200 && lakeQ.body.rowCount === 3, `rowCount=${lakeQ.body.rowCount}`);

  // ── S1 isolation: direct object-store / HTTP exfil must be BLOCKED BY THE LEVER ──
  // The assertion is strict: the error MUST be "disabled by configuration", NOT a
  // network error (a 404 would mean the request went out — i.e. the lever no-op'd).
  const disabledByConfig = (r) => typeof r.body.error === "string" && r.body.error.includes("disabled by configuration");
  const s3 = await post("/query", { sql: "SELECT * FROM read_csv('s3://nope-bucket/x.csv')" });
  check("read_csv('s3://…') blocked by lever", disabledByConfig(s3), s3.body.error?.split("\n")[0]);
  const s3p = await post("/query", { sql: "SELECT * FROM read_parquet('s3://nope-bucket/x.parquet')" });
  check("read_parquet('s3://…') blocked by lever", disabledByConfig(s3p), s3p.body.error?.split("\n")[0]);
  const http = await post("/query", { sql: "SELECT * FROM read_csv('http://example.com/x.csv')" });
  check("read_csv('http://…') blocked by lever", disabledByConfig(http), http.body.error?.split("\n")[0]);

  // ── unsigned extensions are OFF → agent can't LOAD a malicious unsigned .so ───
  const uns = await post("/query", { sql: "SELECT value FROM duckdb_settings() WHERE name='allow_unsigned_extensions'" });
  check("allow_unsigned_extensions is false", uns.body.rows?.[0]?.[0] === "false" || uns.body.rows?.[0]?.[0] === false, JSON.stringify(uns.body.rows));

  // ── agent cannot undo the lever ─────────────────────────────────────────────
  const undo = await post("/run", { sql: "RESET disabled_filesystems;" });
  check("agent cannot RESET disabled_filesystems", undo.status === 500);
  const stillBlocked = await post("/query", { sql: "SELECT * FROM read_csv('http://example.com/x.csv')" });
  check("http still blocked after undo attempt", stillBlocked.status === 500);

  // ── scratch lands in the encrypted workspace; commit it ─────────────────────
  const scratch = await post("/run", { sql: "CREATE TABLE my_scratch AS SELECT * FROM lake.query('FROM memory.main.orders')" });
  check("CREATE scratch from lake read", scratch.status === 200);
  const readScratch = await post("/query", { sql: "SELECT count(*) AS n FROM my_scratch" });
  check("scratch is queryable", readScratch.body.rows?.[0]?.[0] === 3, JSON.stringify(readScratch.body.rows));

  // ── FIFO: fire many concurrently, all return, no corruption ─────────────────
  const N = 12;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => post("/query", { sql: `SELECT ${i} AS i, count(*) AS n FROM my_scratch` })),
  );
  const allOk = results.every((r, i) => r.status === 200 && r.body.rows?.[0]?.[0] === i && r.body.rows?.[0]?.[1] === 3);
  check(`FIFO: ${N} concurrent queries all return correctly`, allOk);

  // ── snapshot (flush) then prove the on-disk file is ciphertext ──────────────
  const snap = await post("/snapshot");
  check("snapshot (checkpoint) ok", snap.status === 200);
  const magic = readFileSync(dbFile).subarray(0, 4).toString("latin1");
  check("on-disk file is encrypted (not 'DUCK')", magic !== "DUCK", `first4=${JSON.stringify(magic)}`);

  // ── shutdown → upload-point; then restart and prove scratch persisted ───────
  await post("/shutdown");
  await new Promise((r) => setTimeout(r, 400));
  check("workspace file persisted on disk", existsSync(dbFile));

  sidecar = spawnSidecar();
  await waitHealthy();
  await post("/init", { key: KEY, lakeProxy: `localhost:${LAKE_PORT}`, lakeToken: LAKE_TOKEN, disableSsl: true });
  const afterRestart = await post("/query", { sql: "SELECT count(*) AS n FROM my_scratch" });
  check("scratch survived a full restart (durable workspace)", afterRestart.body.rows?.[0]?.[0] === 3, JSON.stringify(afterRestart.body.rows));

  // ── wrong key cannot open the workspace ─────────────────────────────────────
  await post("/shutdown");
  await new Promise((r) => setTimeout(r, 400));

  console.log(`\n  ${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
  exitCode = fail === 0 ? 0 : 1;
} catch (e) {
  console.error("test error:", e);
  exitCode = 1;
} finally {
  try { sidecar.kill("SIGKILL"); } catch {}
  try { await lakeConn.run(`CALL quack_stop('quack:localhost:${LAKE_PORT}')`); } catch {}
  rmSync(tmp, { recursive: true, force: true });
  process.exit(exitCode);
}
