// Local smoke test for the Cloud Run gateway's core design — real birdshot + a real Postgres
// DuckLake catalog (the production model; a local-FILE catalog can't be shared by two
// instances and gives false staleness). Run via `pnpm run smoke` (orchestrates a throwaway
// Postgres + linux/amd64 containers). Two DuckDB instances share ONE Postgres catalog + data
// dir, modelling a separate WRITER service and READER service. Asserts the milestone gates,
// using the EXACT reader path server.mjs uses — a fresh connection per read, NO reATTACH:
//   1. a reader instance sees a table the writer created before the reader attached;
//   2. a data-only INSERT by the writer is visible to a subsequent reader read (the case the
//      CF catalog-hash dispatch missed) — proven fresh with a PG catalog, no re-resolution;
//   3. an ungranted table is DENIED (birdshot parity on the direct lake.<schema>.<table> ref);
//   4. a brand-new table created AFTER the reader attached is visible to the reader.
import { DuckDBInstance } from "@duckdb/node-api";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { mkdirSync } from "node:fs";

const BIRDSHOT = process.env.BIRDSHOT_EXTENSION_PATH || "/p/birdshot.duckdb_extension";
const PG_DSN = process.env.SMOKE_PG_DSN; // "host=... port=5432 dbname=... user=... password=..."
const DATA = process.env.SMOKE_DATA || "/tmp/smoke-data/";
const ISSUER = "smoke-issuer", AUDIENCE = "gw:smoke", KID = "smoke-key-1", PRINCIPAL = "agent:smoke";
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const j = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? Number(x) : x));
let failed = false;
const check = (name, cond) => { console.log(`${cond ? "✅" : "❌"} ${name}`); if (!cond) failed = true; };

if (!PG_DSN) { console.error("SMOKE_PG_DSN required (Postgres catalog)"); process.exit(2); }
mkdirSync(DATA, { recursive: true });

async function attachLake(role) {
  const inst = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
  const c = await inst.connect();
  await c.run("INSTALL ducklake; INSTALL postgres; INSTALL httpfs; LOAD ducklake; LOAD postgres; LOAD httpfs;");
  await c.run(`LOAD ${q(BIRDSHOT)}`);
  await c.run(`ATTACH 'ducklake:postgres:${PG_DSN}' AS lake (DATA_PATH ${q(DATA)})`);
  await c.run("USE lake");
  console.log(`[${role}] instance up, lake attached (postgres catalog)`);
  return { inst, c };
}

let sidSeq = 0;
async function authedSid(conn, jwt) {
  const sid = `smoke-${++sidSeq}`;
  const r = await conn.runAndReadAll(`SELECT birdshot_authenticate(${q(sid)}, ${q(jwt)}, '') AS ok`);
  return { sid, ok: r.getRowObjects()[0]?.ok === true };
}
async function authorize(conn, sid, sql) {
  try {
    const r = await conn.runAndReadAll(`SELECT birdshot_authorize(${q(sid)}, ${q(sql)}) AS ok`);
    return r.getRowObjects()[0]?.ok === true ? "allow" : "deny";
  } catch (e) { return "throw:" + String(e.message || e).split("\n")[0]; }
}

// ── WRITER instance ─────────────────────────────────────────────────────────
const W = await attachLake("writer");
for (const t of ["allowed", "secret", "fresh"]) { try { await W.c.run(`DROP TABLE lake.main.${t}`); } catch { /* */ } }
await W.c.run("CREATE TABLE lake.main.allowed(id INTEGER, total INTEGER)");
await W.c.run("INSERT INTO lake.main.allowed VALUES (1,100),(2,250)");
await W.c.run("CREATE TABLE lake.main.secret(id INTEGER, ssn VARCHAR)");
await W.c.run("INSERT INTO lake.main.secret VALUES (1,'111-22-3333')");
console.log("[writer] created allowed(2) + secret(1)");

// ── READER instance (separate instance; reads on FRESH connections, NO reATTACH) ─────
const R = await attachLake("reader");
const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const pub = await exportJWK(publicKey);
const jwt = await new SignJWT({ id: PRINCIPAL, mode: "service", cap: "connect" })
  .setProtectedHeader({ alg: "RS256", kid: KID })
  .setSubject(PRINCIPAL).setIssuer(ISSUER).setAudience(AUDIENCE)
  .setIssuedAt().setJti(crypto.randomUUID()).setExpirationTime("5m").sign(privateKey);
async function applyGrants(tables) {
  await R.c.run([
    "SELECT birdshot_reset_config()",
    `SELECT birdshot_set_lake_catalog('lake')`,
    `SELECT birdshot_set_auth(${q(ISSUER)}, ${q(AUDIENCE)}, 'rs256')`,
    `SELECT birdshot_add_jwk(${q(KID)}, ${q(pub.n)}, ${q(pub.e)})`,
    `SELECT birdshot_add_user_role(${q(PRINCIPAL)}, 'r1')`,
    ...tables.map((t) => `SELECT birdshot_add_role_grant('r1', 'main.${t}', 'read')`),
    "SELECT birdshot_commit_config()",
  ].join(";\n"));
}
await applyGrants(["allowed"]);
console.log("[reader] policy applied: r1 → read main.allowed");

// server.mjs's exact /query path: a FRESH connection per read (no reATTACH).
async function readerQuery(sql) {
  const conn = await R.inst.connect();
  try {
    const { sid, ok } = await authedSid(conn, jwt);
    if (!ok) return { decision: "authn_fail" };
    const decision = await authorize(conn, sid, sql);
    if (decision !== "allow") return { decision };
    const rows = (await conn.runAndReadAll(sql)).getRowObjects();
    return { decision, rows };
  } finally { try { conn.closeSync(); } catch { /* */ } }
}

const r1 = await readerQuery("SELECT count(*) AS n FROM lake.main.allowed");
console.log("   reader SELECT count(*) →", j(r1));
check("GATE1 reader sees writer's CREATE+rows (n=2)", r1.decision === "allow" && Number(r1.rows?.[0]?.n) === 2);

await W.c.run("INSERT INTO lake.main.allowed VALUES (3,9000)");
console.log("[writer] INSERT a 3rd row (data-only, no DDL)");
const r2 = await readerQuery("SELECT count(*) AS n FROM lake.main.allowed");
console.log("   reader SELECT count(*) after insert →", j(r2));
check("GATE2 data-only INSERT visible to reader, NO reATTACH (n=3)", Number(r2.rows?.[0]?.n) === 3);

const r3 = await readerQuery("SELECT * FROM lake.main.secret");
console.log("   reader SELECT secret →", j(r3));
check("GATE3 ungranted lake read DENIED", r3.decision !== "allow");

await W.c.run("CREATE TABLE lake.main.fresh AS SELECT 7 AS v");
await applyGrants(["allowed", "fresh"]); // re-push snapshot after the create (as the control plane would)
const r4 = await readerQuery("SELECT v FROM lake.main.fresh");
console.log("   reader SELECT fresh (table created after reader attached) →", j(r4));
check("GATE4 table created AFTER reader attached is visible, NO reATTACH (v=7)", r4.decision === "allow" && Number(r4.rows?.[0]?.v) === 7);

console.log(failed ? "\n=== SMOKE: FAIL ===" : "\n=== SMOKE: PASS — reader coherence (PG catalog, no reATTACH) + birdshot parity hold ===");
process.exit(failed ? 1 : 0);
