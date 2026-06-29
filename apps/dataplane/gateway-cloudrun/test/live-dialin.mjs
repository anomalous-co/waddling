// Live external dial-in gate for the Cloud Run gateway (WF-1's one gate that matters).
//
// Runs OUTSIDE the gateway (this laptop = an external DuckDB). Reaches the PRIVATE gw-bringup
// Cloud Run service through `gcloud run services proxy` (an authenticated localhost tunnel that
// stands in for the WF-2 per-user router). The ONLY dial-in credential is the birdshot RS256
// session JWT — the same token birdshot validates for ACLs. The full product loop:
//   1. mint an RS256 keypair + a session JWT (the agent's dial-in token);
//   2. push a birdshot snapshot (auth JWKS + grants) via /ctrl/snapshot;
//   3. seed lake tables via /governed-load with the JWT (governed write that persists to DuckLake);
//   4. re-push a READ snapshot (grant read on ONE table only);
//   5. as an EXTERNAL DuckDB: ATTACH 'quack:<proxy>' (TOKEN jwt) and SELECT through quack —
//      granted table returns rows (the dial-in read), ungranted table is DENIED.
import { DuckDBInstance } from "@duckdb/node-api";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const BASE = process.env.GW_BASE || "http://127.0.0.1:9999";        // gcloud run services proxy
const QUACK_TARGET = process.env.QUACK_TARGET || "127.0.0.1:9999";  // quack: dial target (proxy)
const ISSUER = "bringup-issuer", AUDIENCE = "gw:bringup", KID = "bringup-key-1", PRINCIPAL = "agent:bringup";
const j = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? Number(x) : x));
let failed = false;
const check = (name, cond, extra) => { console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`); if (!cond) failed = true; };

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: r.status, json };
}

// ── 1. keypair + dial-in JWT ──────────────────────────────────────────────────
const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const pub = await exportJWK(publicKey);
const mintJwt = () => new SignJWT({ id: PRINCIPAL, mode: "service", cap: "connect" })
  .setProtectedHeader({ alg: "RS256", kid: KID })
  .setSubject(PRINCIPAL).setIssuer(ISSUER).setAudience(AUDIENCE)
  .setIssuedAt().setJti(crypto.randomUUID()).setExpirationTime("10m").sign(privateKey);
const jwt = await mintJwt();

const auth = { issuer: ISSUER, audience: AUDIENCE, jwks: [{ kid: KID, n: pub.n, e: pub.e }] };
const snapshot = (grants) => ({
  userRoles: [{ userId: PRINCIPAL, role: "r1" }],
  roleGrants: grants.map((g) => ({ role: "r1", tableRef: g.ref, action: g.action })),
});
const pushSnapshot = (grants) => post("/ctrl/snapshot", { snapshot: snapshot(grants), auth, lakeCatalog: "lake" });

// READ_ONLY=1 skips the writes — used to prove durability across a COLD container restart
// (the table must still be readable from the shared Postgres DuckLake catalog).
const READ_ONLY = /^(1|true|yes)$/i.test(process.env.READ_ONLY ?? "");
let r;
if (!READ_ONLY) {
  // ── 2. write-phase snapshot: create/drop/write on both tables so a CREATE OR REPLACE … AS
  //      SELECT is authorized (create+drop are parse-layer DDL capabilities; write materializes rows). ──
  const ddl = (ref) => [
    { ref, action: "create" }, { ref, action: "drop" }, { ref, action: "write" },
  ];
  r = await pushSnapshot([...ddl("main.bringup_t"), ...ddl("main.secret_t")]);
  console.log("[snapshot:write]", j(r));
  check("snapshot push (ddl grants) ok", r.status === 200 && r.json.ok === true);

  // ── 3. governed writes (CTAS from literal VALUES — no external read_source, no source policy) ──
  const gl = (sql) => post("/governed-load", { token: jwt, sql });
  r = await gl("CREATE OR REPLACE TABLE main.bringup_t AS SELECT * FROM (VALUES (1,100),(2,250),(3,9000)) AS t(id,total)");
  console.log("[governed-load bringup_t]", j(r));
  check("governed-load created bringup_t", r.status === 200 && r.json.ok === true, `phase=${r.json.phase} decision=${r.json.authorizeDecision}`);
  r = await gl("CREATE OR REPLACE TABLE main.secret_t AS SELECT * FROM (VALUES (1,'111-22-3333')) AS t(id,ssn)");
  console.log("[governed-load secret_t]", j(r));
  check("governed-load created secret_t", r.status === 200 && r.json.ok === true, `phase=${r.json.phase} decision=${r.json.authorizeDecision}`);
} else {
  console.log("[READ_ONLY] skipping writes — proving durability of a prior governed write across a cold container");
}

// ── 4. read-phase snapshot: grant read on bringup_t ONLY (secret_t stays ungranted) ──
r = await pushSnapshot([{ ref: "main.bringup_t", action: "read" }]);
console.log("[snapshot:read]", j(r));
check("snapshot push (read grant) ok", r.status === 200 && r.json.ok === true);

// ── 5. EXTERNAL DuckDB dials in via quack with the JWT as the sole credential ──
const inst = await DuckDBInstance.create(":memory:");
const c = await inst.connect();
await c.run("INSTALL quack; LOAD quack");
let attachErr = null;
try {
  // DISABLE_SSL=false (env) → real HTTPS at :443 (e.g. dialing through the public router); default
  // true for the loopback gcloud-proxy path. quack auto-selects HTTPS for non-local URIs anyway.
  const noSsl = /^(0|false|no)$/i.test(process.env.DISABLE_SSL ?? "true");
  const sslOpt = noSsl ? "" : ", DISABLE_SSL true";
  await c.run(`ATTACH 'quack:${QUACK_TARGET}' AS lake (TOKEN '${jwt.replace(/'/g, "''")}'${sslOpt})`);
} catch (e) { attachErr = e instanceof Error ? e.message : String(e); }
check("external quack ATTACH authenticated (birdshot JWT)", attachErr === null, attachErr ? `err=${attachErr}` : "");

if (!attachErr) {
  // granted read → rows
  let rows = null, readErr = null;
  try { rows = (await c.runAndReadAll("SELECT count(*) AS n FROM lake.main.bringup_t")).getRowObjects(); }
  catch (e) { readErr = e instanceof Error ? e.message : String(e); }
  console.log("   dial-in read bringup_t →", j(rows), readErr ? `err=${readErr}` : "");
  check("DIAL-IN READ granted table returns rows (n=3)", !readErr && Number(rows?.[0]?.n) === 3);

  // ungranted read → DENY (the client throws)
  let denied = false, secretRows = null;
  try { secretRows = (await c.runAndReadAll("SELECT * FROM lake.main.secret_t")).getRowObjects(); }
  catch { denied = true; }
  console.log("   dial-in read secret_t →", denied ? "DENIED (threw)" : j(secretRows));
  check("DIAL-IN READ ungranted table DENIED", denied);
}

console.log(failed ? "\n=== LIVE DIAL-IN: FAIL ===" : "\n=== LIVE DIAL-IN: PASS — external quack dial-in + birdshot ACL enforcement live on Cloud Run ===");
process.exit(failed ? 1 : 0);
