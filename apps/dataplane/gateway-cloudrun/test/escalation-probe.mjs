// SECURITY: can an authenticated agent escalate over the legitimate /quack path by CALLING
// birdshot's own config functions on the serving connection? birdshot_add_role_grant / reset_config
// / commit_config / add_jwk are ordinary SQL functions on the DuckDB instance; quack's per-request
// connections run on that same instance. If birdshot_authorize doesn't forbid these calls, a guest
// with a single read grant could grant itself anything (or install its own JWKS = full auth bypass).
//
// Setup uses the AUTHENTICATED control path (proxy → /ctrl); the ATTACK uses the guest's quack
// session. Run against ws-b via its gcloud proxy:
//   GW_BASE=http://127.0.0.1:9997 QUACK_TARGET=127.0.0.1:9997 node test/escalation-probe.mjs
import { DuckDBInstance } from "@duckdb/node-api";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const BASE = process.env.GW_BASE || "http://127.0.0.1:9997";
const QUACK_TARGET = process.env.QUACK_TARGET || "127.0.0.1:9997";
const ISSUER = "esc-issuer", AUDIENCE = "gw:ws-b", KID = "esc-key";
const OWNER = "agent:esc-owner", GUEST = "agent:esc-guest";
const j = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? Number(x) : x));
const post = async (p, b) => { const r = await fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };

const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const pub = await exportJWK(publicKey);
const mint = (sub) => new SignJWT({ id: sub, mode: "service", cap: "connect" })
  .setProtectedHeader({ alg: "RS256", kid: KID }).setSubject(sub)
  .setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setJti(crypto.randomUUID()).setExpirationTime("10m").sign(privateKey);
const jwtOwner = await mint(OWNER), jwtGuest = await mint(GUEST);
const auth = { issuer: ISSUER, audience: AUDIENCE, jwks: [{ kid: KID, n: pub.n, e: pub.e }] };
const snap = (roleGrants, userRoles) => post("/ctrl/snapshot", { snapshot: { userRoles, roleGrants }, auth, lakeCatalog: "workspace" });

// Setup (authenticated control path): seed two tables; grant guest read on e_public only.
const ddl = ["e_public", "e_private"].flatMap((t) => ["create", "drop", "write"].map((action) => ({ role: "owner", tableRef: `main.${t}`, action })));
await snap(ddl, [{ userId: OWNER, role: "owner" }]);
await post("/governed-load", { token: jwtOwner, sql: "CREATE OR REPLACE TABLE main.e_public AS SELECT 1 AS id" });
await post("/governed-load", { token: jwtOwner, sql: "CREATE OR REPLACE TABLE main.e_private AS SELECT 42 AS secret" });
await snap([{ role: "owner", tableRef: "main.e_private", action: "read" }, { role: "guest", tableRef: "main.e_public", action: "read" }], [{ userId: OWNER, role: "owner" }, { userId: GUEST, role: "guest" }]);
console.log("setup done: guest has read on e_public ONLY");

// Attack: guest dials in, attempts to call birdshot config functions to self-grant e_private.
const inst = await DuckDBInstance.create(":memory:");
const c = await inst.connect();
await c.run("INSTALL quack; LOAD quack");
await c.run(`ATTACH 'quack:${QUACK_TARGET}' AS wsb (TOKEN '${jwtGuest.replace(/'/g, "''")}', DISABLE_SSL true)`);

async function tryStmt(label, sql) {
  try { const r = await c.runAndReadAll(sql); console.log(`  [${label}] ALLOWED → ${j(r.getRowObjects()).slice(0, 120)}`); return true; }
  catch (e) { console.log(`  [${label}] blocked: ${String(e.message || e).split("\n")[0].slice(0, 120)}`); return false; }
}

console.log("\nguest attempts birdshot config-function calls over its quack session:");
await tryStmt("reset_config", "SELECT birdshot_reset_config()");
await tryStmt("add_role_grant", "SELECT birdshot_add_role_grant('guest', 'main.e_private', 'read')");
await tryStmt("add_jwk(own key)", `SELECT birdshot_add_jwk('evil', ${"'" + pub.n + "'"}, ${"'" + pub.e + "'"})`);
await tryStmt("commit_config", "SELECT birdshot_commit_config()");

// The REAL vector: Form B (quack_query) pushes the WHOLE statement to the gateway, where birdshot's
// config functions DO exist. If birdshot_authorize lets a function-call statement through, this runs
// server-side on the gateway's instance and mutates the process-global birdshot State.
const gq = (sql) => `FROM quack_query('quack:${QUACK_TARGET}', '${sql.replace(/'/g, "''")}', token => '${jwtGuest.replace(/'/g, "''")}', disable_ssl => true)`;
console.log("\nguest attempts the SAME calls via Form B (quack_query → server-side on the gateway):");
await tryStmt("B:reset_config", gq("SELECT birdshot_reset_config()"));
await tryStmt("B:add_role_grant", gq("SELECT birdshot_add_role_grant('guest','main.e_private','read')"));
await tryStmt("B:add_jwk", gq(`SELECT birdshot_add_jwk('evil','${pub.n}','${pub.e}')`));
await tryStmt("B:commit_config", gq("SELECT birdshot_commit_config()"));

console.log("\nguest now attempts the read it should NOT have (Form A and Form B):");
let leaked = false;
try { const r = await c.runAndReadAll("SELECT secret FROM wsb.main.e_private"); leaked = true; console.log("  e_private (Form A) →", j(r.getRowObjects())); }
catch (e) { console.log("  e_private (Form A) → DENIED:", String(e.message || e).split("\n")[0].slice(0, 100)); }
try { const r = await c.runAndReadAll(gq("SELECT secret FROM main.e_private")); leaked = true; console.log("  e_private (Form B) →", j(r.getRowObjects())); }
catch (e) { console.log("  e_private (Form B) → DENIED:", String(e.message || e).split("\n")[0].slice(0, 100)); }

console.log(leaked ? "\n❌❌ CRITICAL ESCALATION: guest self-granted and read e_private" : "\n✅ SAFE: birdshot config-function self-grant did NOT escalate via Form A OR Form B (e_private still denied)");
process.exit(leaked ? 1 : 0);
