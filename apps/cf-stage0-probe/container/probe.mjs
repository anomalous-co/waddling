// In-container probe harness — runs ENTIRELY inside the linux/amd64 image so that
// "in-container" is faithful: the stand-in quack lake, the spawned sidecar, and
// all assertions share one localhost. (Splitting lake-on-host / sidecar-in-container
// would force host.docker.internal and stop proving the in-container posture.)
//
// Covers probes #2 (extensions load + versions), #3 (isolation levers identical
// in-container, incl. token-unreadable + secret-free env), and the in-container
// half of #4 (native encryption + local round-trip). The cross-CONTAINER file
// round-trip (the R2 stand-in for #4) is driven by run.sh around this script:
//   GENERATE mode writes an encrypted workspace file and exits;
//   REOPEN   mode opens a file produced by a *different* container and asserts.
//
// Modes (env PROBE_MODE):
//   "full"     (default) — probes #2/#3 + #4 in-container; also writes the encrypted
//                          workspace to OUT_DB for the cross-container test.
//   "reopen"   — only reopen IN_DB (copied from another container) with KEY and
//                assert scratch survived + wrong key fails. (probe #4 R2 stand-in)

import { DuckDBInstance } from "@duckdb/node-api";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIDECAR = join(HERE, "sidecar.mjs");
const MODE = process.env.PROBE_MODE || "full";

const LAKE_PORT = 9601;
const SIDECAR_PORT = 9602;
const LAKE_TOKEN = "ws-probe-lake-token-7c1f";
const KEY = "0123456789abcdef0123456789abcdef";
const WRONG_KEY = "ffffffffffffffffffffffffffffffff";
const DB_FILE = process.env.OUT_DB || "/tmp/workspace.duckdb";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
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

function spawnSidecar(dbFile) {
  // IMPORTANT: spawn with a MINIMAL env. We deliberately do NOT inherit the full
  // process.env, and we set a marker secret on the PARENT to prove it does not
  // leak into the child. Only operational, NON-SECRET vars cross the boundary:
  //   SIDECAR_PORT, DB_FILE  — the sidecar's two required inputs;
  //   PATH                   — so `node` resolves;
  //   HOME                   — DuckDB's `INSTALL` writes to ~/.duckdb; without a
  //                            HOME it errors "Can't find the home directory".
  //                            HOME is not a secret. (In the real DO data plane
  //                            the image pre-bakes the extensions and the entry-
  //                            point runs with a HOME, so INSTALL is a cache hit.)
  return spawn("node", [SIDECAR], {
    env: {
      SIDECAR_PORT: String(SIDECAR_PORT),
      DB_FILE: dbFile,
      PATH: process.env.PATH,
      HOME: process.env.HOME || "/root",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
}

async function waitHealthy(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(`http://127.0.0.1:${SIDECAR_PORT}/health`); if (r.ok || r.status === 503) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("sidecar never came up");
}

// ───────────────────────── REOPEN mode (cross-container) ──────────────────────
if (MODE === "reopen") {
  const IN_DB = process.env.IN_DB;
  if (!IN_DB || !existsSync(IN_DB)) { console.error("reopen: IN_DB missing:", IN_DB); process.exit(1); }
  console.log(`\n=== Probe #4 (cross-container): reopen file produced by a DIFFERENT container ===`);

  // Open directly with DuckDB (no lake needed) — the sidecar posture for reopen.
  const inst = await DuckDBInstance.create(":memory:");
  const c = await inst.connect();
  await c.run("INSTALL httpfs; LOAD httpfs;"); // crypto provider for encrypted reopen
  let good = false, n;
  try {
    await c.run(`ATTACH '${IN_DB}' AS w (ENCRYPTION_KEY '${KEY}')`);
    const r = await c.runAndReadAll("SELECT count(*) AS n FROM w.my_scratch");
    n = Number(r.getRowObjects()[0]?.n);
    good = n === 3;
  } catch (e) { console.error("reopen error:", e.message.split("\n")[0]); }
  check("encrypted file from another container reopens with key (scratch survived)", good, `rows=${n}`);

  const inst2 = await DuckDBInstance.create(":memory:");
  const c2 = await inst2.connect();
  await c2.run("INSTALL httpfs; LOAD httpfs;");
  let wrongFailed = false;
  try { await c2.run(`ATTACH '${IN_DB}' AS w (ENCRYPTION_KEY '${WRONG_KEY}')`); await c2.runAndReadAll("SELECT 1 FROM w.my_scratch"); }
  catch { wrongFailed = true; }
  check("wrong key fails on the cross-container file", wrongFailed);

  console.log(`\n  ${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

// ───────────────────────── FULL mode (#2 / #3 / #4) ───────────────────────────

// Mark a secret on the PARENT env so we can later prove it does NOT reach the
// child sidecar process (a container has /proc, so this matters).
process.env.LAKE_SECRET_CANARY = "do-not-leak-" + LAKE_TOKEN;

// ── Probe #2: extensions load in-container + report versions ──────────────────
console.log("\n=== Probe #2: DuckDB v1.5.3 + quack + httpfs load in-container ===");
const probeInst = await DuckDBInstance.create(":memory:");
const pc = await probeInst.connect();
{
  const ver = await pc.runAndReadAll("PRAGMA version");
  const vrow = ver.getRowObjects()[0];
  const duckVer = String(vrow.library_version ?? vrow.version ?? JSON.stringify(vrow));
  check("DuckDB library_version is v1.5.3", duckVer.includes("1.5.3"), duckVer);

  await pc.run("INSTALL quack; LOAD quack;");
  await pc.run("INSTALL httpfs; LOAD httpfs;");
  const ext = await pc.runAndReadAll(
    "SELECT extension_name, extension_version, loaded, installed FROM duckdb_extensions() WHERE extension_name IN ('quack','httpfs') ORDER BY extension_name",
  );
  const rows = ext.getRowObjects();
  const quack = rows.find((r) => r.extension_name === "quack");
  const httpfs = rows.find((r) => r.extension_name === "httpfs");
  check("quack loaded in-container", !!quack && quack.loaded === true, quack ? `v=${quack.extension_version}` : "absent");
  check("httpfs loaded in-container", !!httpfs && httpfs.loaded === true, httpfs ? `v=${httpfs.extension_version}` : "absent");
}

// ── Stand up the stand-in lake over quack (in-process, in-container) ───────────
const lake = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
const lakeConn = await lake.connect();
await lakeConn.run("INSTALL quack; LOAD quack;");
await lakeConn.run("CREATE TABLE memory.main.orders (id INTEGER, who VARCHAR)");
await lakeConn.run("INSERT INTO memory.main.orders VALUES (1,'ok'),(2,'fine'),(3,'three')");
await lakeConn.run(`CALL quack_serve('quack:localhost:${LAKE_PORT}', token := '${LAKE_TOKEN}')`);

let sidecar = spawnSidecar(DB_FILE);
let exitCode = 1;
try {
  await waitHealthy();

  // ── init: isolation posture + encrypted workspace + lake attach ─────────────
  const init = await post("/init", { key: KEY, lakeProxy: `localhost:${LAKE_PORT}`, lakeToken: LAKE_TOKEN, disableSsl: true });
  check("init succeeds + lake attached", init.status === 200 && init.body.lakeAttached === true, JSON.stringify(init.body));

  // ── Probe #3a: lake access works (the one gated path) ───────────────────────
  const lakeQ = await post("/query", { sql: "FROM lake.query('FROM memory.main.orders')" });
  check("FROM lake.query(...) returns rows", lakeQ.status === 200 && lakeQ.body.rowCount === 3, `rowCount=${lakeQ.body.rowCount}`);

  // ── Probe #3b: direct object-store / HTTP exfil BLOCKED BY THE LEVER ─────────
  // STRICT: error MUST be "disabled by configuration", NOT a network error/404
  // (which would mean the request went out — i.e. the lever no-op'd).
  const disabledByConfig = (r) => typeof r.body.error === "string" && r.body.error.includes("disabled by configuration");
  const s3 = await post("/query", { sql: "SELECT * FROM read_csv('s3://nope-bucket/x.csv')" });
  check("read_csv('s3://…') blocked by configuration (not network)", disabledByConfig(s3), s3.body.error?.split("\n")[0]);
  const s3p = await post("/query", { sql: "SELECT * FROM read_parquet('s3://nope-bucket/x.parquet')" });
  check("read_parquet('s3://…') blocked by configuration", disabledByConfig(s3p), s3p.body.error?.split("\n")[0]);
  const http = await post("/query", { sql: "SELECT * FROM read_csv('http://example.com/x.csv')" });
  check("read_csv('http://…') blocked by configuration", disabledByConfig(http), http.body.error?.split("\n")[0]);

  // ── Probe #3c: unsigned extensions OFF ──────────────────────────────────────
  const uns = await post("/query", { sql: "SELECT value FROM duckdb_settings() WHERE name='allow_unsigned_extensions'" });
  check("allow_unsigned_extensions reads false", uns.body.rows?.[0]?.[0] === "false" || uns.body.rows?.[0]?.[0] === false, JSON.stringify(uns.body.rows));

  // ── Probe #3d: agent cannot UNDO the lever ──────────────────────────────────
  const undo = await post("/run", { sql: "RESET disabled_filesystems;" });
  check("agent cannot RESET disabled_filesystems", undo.status === 500, `status=${undo.status}`);
  const stillBlocked = await post("/query", { sql: "SELECT * FROM read_csv('http://example.com/x.csv')" });
  check("http still blocked after undo attempt", disabledByConfig(stillBlocked));

  // ── Probe #3e (NEW): agent SQL cannot read the lake TOKEN ────────────────────
  // The quack TOKEN is an ATTACH parameter, NOT a DuckDB SECRET — so it should be
  // absent from duckdb_secrets() entirely. Assert the secrets table holds no row
  // whose value/content exposes the token, and that settings don't carry it either.
  const secretsQ = await post("/query", { sql: "SELECT * FROM duckdb_secrets()" });
  const secretsBlob = JSON.stringify(secretsQ.body.rows ?? []);
  check("duckdb_secrets() does not expose the lake TOKEN", !secretsBlob.includes(LAKE_TOKEN), `rows=${secretsQ.body.rowCount ?? 0}`);
  const settingsQ = await post("/query", { sql: "SELECT name, value FROM duckdb_settings()" });
  const settingsBlob = JSON.stringify(settingsQ.body.rows ?? []);
  check("duckdb_settings() does not expose the lake TOKEN", !settingsBlob.includes(LAKE_TOKEN));
  // Belt-and-suspenders: the literal token must not surface in ANY introspection
  // the agent can reach. (databases list shows the attach name 'lake', not creds.)
  const dbsQ = await post("/query", { sql: "SELECT * FROM duckdb_databases()" });
  check("duckdb_databases() does not expose the lake TOKEN", !JSON.stringify(dbsQ.body.rows ?? []).includes(LAKE_TOKEN));

  // ── Probe #3f (NEW): the sidecar's spawned process env carries no secrets ────
  // Read the child's /proc/<pid>/environ and confirm neither the lake token nor
  // the parent canary marker is present. Only SIDECAR_PORT/DB_FILE/PATH should be.
  let childEnv = "";
  try { childEnv = readFileSync(`/proc/${sidecar.pid}/environ`, "utf8"); } catch (e) { childEnv = `__unreadable__:${e.message}`; }
  const envVars = childEnv.split("\0").filter(Boolean);
  const hasToken = childEnv.includes(LAKE_TOKEN);
  const hasCanary = childEnv.includes("LAKE_SECRET_CANARY") || childEnv.includes("do-not-leak");
  check("sidecar /proc env does NOT contain the lake token", !hasToken && childEnv !== "" && !childEnv.startsWith("__unreadable__"), childEnv.startsWith("__unreadable__") ? childEnv : `${envVars.length} vars`);
  check("sidecar /proc env does NOT inherit the parent secret canary", !hasCanary && !childEnv.startsWith("__unreadable__"));

  // ── scratch lands in the encrypted workspace; commit it ─────────────────────
  const scratch = await post("/run", { sql: "CREATE TABLE my_scratch AS SELECT * FROM lake.query('FROM memory.main.orders')" });
  check("CREATE scratch from lake read", scratch.status === 200);
  const readScratch = await post("/query", { sql: "SELECT count(*) AS n FROM my_scratch" });
  check("scratch is queryable", readScratch.body.rows?.[0]?.[0] === 3, JSON.stringify(readScratch.body.rows));

  // ── FIFO: fire many concurrently, all return correctly ──────────────────────
  const N = 12;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => post("/query", { sql: `SELECT ${i} AS i, count(*) AS n FROM my_scratch` })),
  );
  const allOk = results.every((r, i) => r.status === 200 && r.body.rows?.[0]?.[0] === i && r.body.rows?.[0]?.[1] === 3);
  check(`FIFO: ${N} concurrent queries all return correctly`, allOk);

  // ── Probe #4a: snapshot (flush) then prove the on-disk file is ciphertext ────
  const snap = await post("/snapshot");
  check("snapshot (checkpoint) ok", snap.status === 200);
  const magic = readFileSync(DB_FILE).subarray(0, 4).toString("latin1");
  check("on-disk header is ciphertext (not 'DUCK')", magic !== "DUCK", `first4=${JSON.stringify(magic)}`);

  // ── Probe #4b: shutdown → clean checkpoint; restart in-place; scratch persists
  await post("/shutdown");
  await new Promise((r) => setTimeout(r, 500));
  check("workspace file persisted on disk", existsSync(DB_FILE));

  sidecar = spawnSidecar(DB_FILE);
  await waitHealthy();
  await post("/init", { key: KEY, lakeProxy: `localhost:${LAKE_PORT}`, lakeToken: LAKE_TOKEN, disableSsl: true });
  const afterRestart = await post("/query", { sql: "SELECT count(*) AS n FROM my_scratch" });
  check("scratch survived an in-place restart (durable workspace)", afterRestart.body.rows?.[0]?.[0] === 3, JSON.stringify(afterRestart.body.rows));

  // ── Probe #4c: in-process wrong-key reopen fails (sanity before cross-container)
  await post("/shutdown");
  await new Promise((r) => setTimeout(r, 500));
  {
    const inst = await DuckDBInstance.create(":memory:");
    const c = await inst.connect();
    await c.run("INSTALL httpfs; LOAD httpfs;");
    let wrongFailed = false;
    try { await c.run(`ATTACH '${DB_FILE}' AS w (ENCRYPTION_KEY '${WRONG_KEY}')`); await c.runAndReadAll("SELECT 1 FROM w.my_scratch"); }
    catch { wrongFailed = true; }
    check("wrong key fails to open the encrypted workspace", wrongFailed);
  }

  // Leave OUT_DB cleanly checkpointed on disk for the cross-container reopen step.
  check("OUT_DB left on disk for cross-container reopen", existsSync(DB_FILE), DB_FILE);

  console.log(`\n  ${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
  exitCode = fail === 0 ? 0 : 1;
} catch (e) {
  console.error("probe error:", e);
  exitCode = 1;
} finally {
  try { sidecar.kill("SIGKILL"); } catch {}
  try { await lakeConn.run(`CALL quack_stop('quack:localhost:${LAKE_PORT}')`); } catch {}
  process.exit(exitCode);
}
