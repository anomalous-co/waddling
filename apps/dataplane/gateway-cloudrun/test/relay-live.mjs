// Live end-to-end relay verification for ws-bringup workspace gateway (WF-2c).
// Proves three properties LIVE against real GCP services:
//   1. Form A: single-table lake read succeeds through rt.connection's lake ATTACH.
//   2. Form B: JOIN across two lake tables falls back to Form B (quack_query server-side).
//   3. Denial: reading an EXISTING lake table that has no read grant is denied.
//
// The test spawns gcloud run services proxy ws-bringup internally.
//
// Usage:
//   node test/relay-live.mjs
//   (requires: gcloud auth, node >= 22, jose installed in node_modules)

import { spawn } from "node:child_process";
import net from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const ROUTER_BASE = "https://waddling-router-788805446348.us-west1.run.app";
const LAKE_QUACK  = "waddling-router-788805446348.us-west1.run.app:443";
const WS_PORT     = 9998;
const WS_BASE     = `http://127.0.0.1:${WS_PORT}`;
const PROJECT     = "project-bd87157a-f6fd-4d44-830";
const REGION      = "us-west1";

const ISSUER    = "relay-live-issuer";
const AUDIENCE  = "gw:bringup";
const KID       = "relay-live-key";
const PRINCIPAL = "agent:relay-live";

const j = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? Number(x) : x), 2);
let failed = false;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra != null ? "  " + String(extra).slice(0, 300) : ""}`);
  if (!cond) failed = true;
};

async function post(base, path, body) {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: r.status, json };
}

function waitForPort(port, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function attempt() {
      const sock = net.connect(port, "127.0.0.1", () => { sock.destroy(); resolve(); });
      sock.on("error", () => {
        if (Date.now() - start > timeout) return reject(new Error(`port ${port} not ready after ${timeout}ms`));
        setTimeout(attempt, 500);
      });
    }
    attempt();
  });
}

// ── Spawn the gcloud proxy to ws-bringup ──────────────────────────────────────
console.log(`\n[relay-live] spawning gcloud run services proxy ws-bringup --port=${WS_PORT}`);
const proxy = spawn("gcloud", [
  "run", "services", "proxy", "ws-bringup",
  "--project", PROJECT, "--region", REGION,
  "--port", String(WS_PORT),
], { stdio: ["ignore", "pipe", "pipe"] });
proxy.stdout.on("data", (d) => process.stdout.write(`[gcloud-proxy] ${d}`));
proxy.stderr.on("data", (d) => process.stderr.write(`[gcloud-proxy] ${d}`));
proxy.on("exit", (code) => { if (code !== null && code !== 0) console.log(`[gcloud-proxy] exited code=${code}`); });

let proxyOk = false;
try {
  await waitForPort(WS_PORT, 60000);
  proxyOk = true;
  console.log(`[gcloud-proxy] port ${WS_PORT} ready`);
} catch (e) {
  console.error(`[gcloud-proxy] port not ready: ${e.message}`);
}
if (!proxyOk) { proxy.kill(); process.exit(1); }

try {
  // ── Mint RS256 keypair + JWT ──────────────────────────────────────────────────
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const pub = await exportJWK(publicKey);
  const mintJwt = () =>
    new SignJWT({ id: PRINCIPAL, mode: "service", cap: "connect" })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setSubject(PRINCIPAL).setIssuer(ISSUER).setAudience(AUDIENCE)
      .setIssuedAt().setJti(crypto.randomUUID()).setExpirationTime("10m")
      .sign(privateKey);
  const jwt = await mintJwt();

  const auth = { issuer: ISSUER, audience: AUDIENCE, jwks: [{ kid: KID, n: pub.n, e: pub.e }] };
  const pushSnap = (grants) => post(ROUTER_BASE, "/ctrl/snapshot", {
    snapshot: {
      userRoles: [{ userId: PRINCIPAL, role: "r1" }],
      roleGrants: grants.map((g) => ({ role: "r1", tableRef: g.ref, action: g.action })),
    },
    auth,
    lakeCatalog: "lake",
  });
  const gl = (sql) => post(ROUTER_BASE, "/governed-load", { token: jwt, sql });

  // ── Step 1: push WIDE setup snapshot (DDL grants on r1, r2, AND secret_unwanted) ──
  // secret_unwanted must EXIST in the lake so the denial is a real ACL denial, not
  // a "table does not exist" error that would trigger the Form-B fallback.
  const ddl = (ref) => [
    { ref, action: "create" }, { ref, action: "drop" }, { ref, action: "write" },
  ];
  let r = await pushSnap([...ddl("main.r1"), ...ddl("main.r2"), ...ddl("main.secret_unwanted")]);
  console.log("\n[setup-snapshot]", j(r.json));
  check("setup snapshot (wide DDL grants) ok", r.status === 200 && r.json.ok === true);

  // ── Step 2: create all three tables in the lake ───────────────────────────────
  r = await gl("CREATE OR REPLACE TABLE main.r1 AS SELECT * FROM (VALUES (1,'a'),(2,'b'),(3,'c')) AS t(id,label)");
  console.log("[create r1]", j(r.json));
  check("create r1 ok", r.status === 200 && r.json.ok === true);

  r = await gl("CREATE OR REPLACE TABLE main.r2 AS SELECT * FROM (VALUES (1,100),(2,200),(3,300)) AS t(id,amount)");
  console.log("[create r2]", j(r.json));
  check("create r2 ok", r.status === 200 && r.json.ok === true);

  r = await gl("CREATE OR REPLACE TABLE main.secret_unwanted AS SELECT * FROM (VALUES (99,'private'),(100,'data')) AS t(id,info)");
  console.log("[create secret_unwanted]", j(r.json));
  check("create secret_unwanted ok (exists but will be ungranted for relay)", r.status === 200 && r.json.ok === true);

  // ── Step 3: push NARROW relay snapshot (read-only on r1 + r2, NOT secret_unwanted) ──
  r = await pushSnap([
    { ref: "main.r1", action: "read" },
    { ref: "main.r2", action: "read" },
  ]);
  console.log("[relay-snapshot]", j(r.json));
  check("relay snapshot (read r1+r2, no access to secret_unwanted) ok", r.status === 200 && r.json.ok === true);

  // ── Step 4: configure the workspace relay → ATTACH lake via router ────────────
  r = await post(WS_BASE, "/ctrl/configure-lake", {
    lakeProxy: LAKE_QUACK,
    lakeToken: jwt,
    // disableSsl omitted → real TLS (router uses HTTPS:443)
  });
  console.log("\n[configure-lake]", j(r.json));
  check("configure-lake ok", r.status === 200 && r.json.ok === true, `lakeProxy=${r.json.lakeProxy}`);

  // ── Test 1: Form A — single-table lake read ───────────────────────────────────
  r = await post(WS_BASE, "/relay-query", { sql: "SELECT count(*) AS n FROM lake.main.r1" });
  console.log("\n[relay-query Test 1 — Form A single-table]", j(r.json));
  check("Test 1: Form A single-table ok=true", r.status === 200 && r.json.ok === true,
    `form=${r.json.form} error=${r.json.error}`);
  check("Test 1: used Form A (not B)", r.json.form === "A", `got form=${r.json.form}`);
  check("Test 1: count(*) = 3", r.json.rows?.[0]?.[0] === 3, `got ${r.json.rows?.[0]?.[0]}`);

  // ── Test 2: Form B — JOIN across two lake tables ──────────────────────────────
  // Form A hits DuckDB's "Multiple streaming scans not currently supported" limit;
  // relay falls back to Form B (quack_query pushes the whole JOIN to the lake server-side).
  r = await post(WS_BASE, "/relay-query", {
    sql: "SELECT r1.id, r1.label, r2.amount FROM lake.main.r1 JOIN lake.main.r2 USING (id) ORDER BY r1.id",
  });
  console.log("\n[relay-query Test 2 — Form B JOIN]", j(r.json));
  check("Test 2: Form B JOIN ok=true", r.status === 200 && r.json.ok === true,
    `form=${r.json.form} error=${r.json.error}`);
  check("Test 2: fell back to Form B", r.json.form === "B", `got form=${r.json.form}`);
  check("Test 2: returns 3 joined rows", r.json.rowCount === 3, `got rowCount=${r.json.rowCount}`);
  if (r.json.rows) {
    // Verify the JOIN result is correct (sorted by r1.id)
    const rows = r.json.rows;
    check("Test 2: row[0] = [1,'a',100]",
      rows[0]?.[0] === 1 && rows[0]?.[1] === "a" && rows[0]?.[2] === 100,
      `got ${j(rows[0])}`);
    check("Test 2: row[2] = [3,'c',300]",
      rows[2]?.[0] === 3 && rows[2]?.[1] === "c" && rows[2]?.[2] === 300,
      `got ${j(rows[2])}`);
  }

  // ── Test 3: Denial — secret_unwanted exists but has no read grant ─────────────
  // Proves birdshot ACL enforcement end-to-end: the lake has the table, but the
  // relay JWT has no read grant for it → denied at the lake gateway.
  r = await post(WS_BASE, "/relay-query", { sql: "SELECT * FROM lake.main.secret_unwanted" });
  console.log("\n[relay-query Test 3 — ACL denial]", j(r.json));
  check("Test 3: denied table ok=false", r.status === 200 && r.json.ok === false,
    `form=${r.json.form} error=${r.json.error}`);
  check("Test 3: error is non-empty (birdshot ACL denial)", r.json.error != null && r.json.error.length > 0,
    `error=${r.json.error}`);

  // ── Test 4: re-attach path — second configure-lake re-DETACHes and re-ATTACHes lake ──
  // Verifies the wsLakeAttached → USE; DETACH lake → re-ATTACH branch when the JWT is
  // rotated (the lake is already attached from Test 1-3 above).
  // Mint a fresh JWT (simulates token rotation) with the same key and push a fresh snapshot.
  const jwt2 = await mintJwt();
  let r2snap = await pushSnap([{ ref: "main.r1", action: "read" }, { ref: "main.r2", action: "read" }]);
  console.log("\n[re-configure-snapshot]", j(r2snap.json));
  check("re-configure snapshot ok", r2snap.status === 200 && r2snap.json.ok === true);
  // Re-call configure-lake with new JWT while lake is already attached.
  let rc = await post(WS_BASE, "/ctrl/configure-lake", { lakeProxy: LAKE_QUACK, lakeToken: jwt2 });
  console.log("[re-configure-lake]", j(rc.json));
  check("re-configure-lake (DETACH+re-ATTACH) ok", rc.status === 200 && rc.json.ok === true);
  // Verify the new attachment works.
  let rq = await post(WS_BASE, "/relay-query", { sql: "SELECT count(*) AS n FROM lake.main.r2" });
  console.log("[re-query after re-attach]", j(rq.json));
  check("re-attach: relay-query r2 ok=true", rq.status === 200 && rq.json.ok === true,
    `form=${rq.json.form} error=${rq.json.error}`);
  check("re-attach: Form A used", rq.json.form === "A", `got form=${rq.json.form}`);
  check("re-attach: r2 count=3", rq.json.rows?.[0]?.[0] === 3, `got ${rq.json.rows?.[0]?.[0]}`);

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log(`\n=== RELAY LIVE ${failed ? "FAIL" : "PASS"} ===`);
  if (!failed) {
    console.log("Form A single-table: PASS");
    console.log("Form B JOIN fallback: PASS (form=B confirmed)");
    console.log("ACL denial (existing ungranted table): PASS");
  }

} finally {
  proxy.kill();
  console.log("[gcloud-proxy] killed");
}

process.exit(failed ? 1 : 0);
