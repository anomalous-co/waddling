// Verifies the crux of the workspace→lake relay design (advisor risk #1), LIVE through the public
// router against the real lake gateway: does a JOIN across two lake tables fail under Form A
// (ATTACH+scan → multiple-streaming-scans limit), and does Form B (quack_query pushing the whole
// JOIN to the lake, server-side) succeed? If Form B works here, the relay can mitigate the JOIN
// limit by rewriting Form-A→Form-B; if not, the relay design needs rethinking.
//
//   GW_BASE=https://<router> QUACK_TARGET=<router-host>:443 node test/relay-join-probe.mjs
import { DuckDBInstance } from "@duckdb/node-api";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const BASE = process.env.GW_BASE;            // router (forwards to the lake gateway)
const QUACK_TARGET = process.env.QUACK_TARGET;
const ISSUER = "joinprobe-issuer", AUDIENCE = "gw:bringup", KID = "joinprobe-key", PRINCIPAL = "agent:joinprobe";
const j = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? Number(x) : x));
const post = async (p, b) => { const r = await fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };

const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const pub = await exportJWK(publicKey);
const jwt = await new SignJWT({ id: PRINCIPAL, mode: "service", cap: "connect" })
  .setProtectedHeader({ alg: "RS256", kid: KID }).setSubject(PRINCIPAL)
  .setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setJti(crypto.randomUUID()).setExpirationTime("10m").sign(privateKey);
const auth = { issuer: ISSUER, audience: AUDIENCE, jwks: [{ kid: KID, n: pub.n, e: pub.e }] };
const snap = (grants) => post("/ctrl/snapshot", { snapshot: { userRoles: [{ userId: PRINCIPAL, role: "r1" }], roleGrants: grants.map((g) => ({ role: "r1", tableRef: g.ref, action: g.action })) }, auth, lakeCatalog: "lake" });

// 1. create two joinable lake tables (DDL grants), then grant read on both.
const ddl = (ref) => [{ ref, action: "create" }, { ref, action: "drop" }, { ref, action: "write" }];
console.log("ddl snapshot:", j(await snap([...ddl("main.j1"), ...ddl("main.j2")])));
console.log("create j1:", j(await post("/governed-load", { token: jwt, sql: "CREATE OR REPLACE TABLE main.j1 AS SELECT * FROM (VALUES (1,'a'),(2,'b'),(3,'c')) AS t(id,label)" })));
console.log("create j2:", j(await post("/governed-load", { token: jwt, sql: "CREATE OR REPLACE TABLE main.j2 AS SELECT * FROM (VALUES (1,100),(2,200),(3,300)) AS t(id,amount)" })));
console.log("read snapshot:", j(await snap([{ ref: "main.j1", action: "read" }, { ref: "main.j2", action: "read" }])));

// 2. external client ATTACHes the lake THROUGH the router (real TLS :443).
const inst = await DuckDBInstance.create(":memory:");
const c = await inst.connect();
await c.run("INSTALL quack; LOAD quack");
await c.run(`ATTACH 'quack:${QUACK_TARGET}' AS lake (TOKEN '${jwt.replace(/'/g, "''")}')`);
console.log("ATTACHed lake via router");

// 3. Form A JOIN (ATTACH+scan of two lake tables) — expected to hit the streaming-scan limit.
let formA = "OK", formArows = null;
try { formArows = (await c.runAndReadAll("SELECT j1.id, j1.label, j2.amount FROM lake.main.j1 JOIN lake.main.j2 USING (id) ORDER BY j1.id")).getRowObjects(); }
catch (e) { formA = String(e.message || e).split("\n")[0]; }
console.log(`\nForm A JOIN → ${formA === "OK" ? "OK rows=" + j(formArows) : "FAILED: " + formA}`);

// 4. Form B JOIN (push the whole JOIN to the lake server-side via quack_query).
let formB = "OK", formBrows = null;
const sql = "SELECT j1.id, j1.label, j2.amount FROM main.j1 JOIN main.j2 USING (id) ORDER BY j1.id";
try { formBrows = (await c.runAndReadAll(`FROM quack_query('quack:${QUACK_TARGET}', '${sql.replace(/'/g, "''")}', token => '${jwt.replace(/'/g, "''")}')`)).getRowObjects(); }
catch (e) { formB = String(e.message || e).split("\n")[0]; }
console.log(`Form B JOIN → ${formB === "OK" ? "OK rows=" + j(formBrows) : "FAILED: " + formB}`);

console.log("\n=== VERDICT ===");
console.log(`Form A (client-side ATTACH+scan JOIN): ${formA === "OK" ? "works" : "FAILS (" + formA + ")"}`);
console.log(`Form B (server-side quack_query JOIN): ${formB === "OK" ? "WORKS — relay can mitigate via Form B" : "FAILS (" + formB + ") — relay design needs rethink"}`);
const ok = formB === "OK" && Array.isArray(formBrows) && formBrows.length === 3;
console.log(ok ? "\nRELAY JOIN MITIGATION VIABLE ✅" : "\nNEEDS ATTENTION ❌");
process.exit(ok ? 0 : 1);
