// Workspace mode live verification for ws-bringup Cloud Run service.
//
// Drives the full persistence + ACL proof:
//   1. Mint RS256 keypair + session JWT
//   2. Push birdshot snapshot granting create/drop/write+read on main.ws_t
//   3. Create main.ws_t via /governed-load (trusted ETL path — agent DDL)
//   4. POST /ctrl/checkpoint → GCS upload
//   5. [MANUAL STEP] force a cold revision (run externally, then restart proxy)
//   6. When READ_ONLY=1: push a read snapshot, dial in via quack, read ws_t → rows must persist
//   7. Verify an ungranted table is DENIED (birdshot workspace ACL live)
//
// Usage (two-phase):
//   # Phase 1 — write + checkpoint (ws-bringup MUST be running):
//   GW_BASE=http://127.0.0.1:9998 QUACK_TARGET=127.0.0.1:9998 node test/ws-bringup-test.mjs
//
//   # Force a cold revision externally:
//   gcloud run services update ws-bringup --update-env-vars=BUMP=1 --project=... --region=us-west1
//   # Then restart the proxy: gcloud run services proxy ws-bringup --port=9998 --project=... --region=us-west1
//
//   # Phase 2 — read-only (proves persistence across cold restart):
//   READ_ONLY=1 GW_BASE=http://127.0.0.1:9998 QUACK_TARGET=127.0.0.1:9998 node test/ws-bringup-test.mjs

import { DuckDBInstance } from "@duckdb/node-api";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const BASE = process.env.GW_BASE || "http://127.0.0.1:9998";
const QUACK_TARGET = process.env.QUACK_TARGET || "127.0.0.1:9998";
const ISSUER = "ws-bringup-issuer", AUDIENCE = "gw:ws-bringup", KID = "ws-key-1", PRINCIPAL = "agent:ws-bringup";
const j = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? Number(x) : x));
let failed = false;
const check = (name, cond, extra) => {
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failed = true;
};

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: r.status, json };
}

// 1. Mint RS256 keypair + dial-in JWT
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

// In workspace mode the catalog is the DB basename (workspace.duckdb → "workspace").
// Grants reference tables as schema.table inside that catalog.
const WS_CATALOG = process.env.WS_CATALOG || "workspace";

const snapshot = (grants) => ({
  userRoles: [{ userId: PRINCIPAL, role: "r1" }],
  roleGrants: grants.map((g) => ({ role: "r1", tableRef: g.ref, action: g.action })),
});
const pushSnapshot = (grants) =>
  post("/ctrl/snapshot", { snapshot: snapshot(grants), auth, lakeCatalog: WS_CATALOG });

const READ_ONLY = /^(1|true|yes)$/i.test(process.env.READ_ONLY ?? "");
let r;

if (!READ_ONLY) {
  console.log("=== PHASE 1: write + checkpoint ===");

  // 2. Push write snapshot: create/drop/write + read on ws_t (DDL + insert + read back)
  r = await pushSnapshot([
    { ref: "main.ws_t", action: "create" },
    { ref: "main.ws_t", action: "drop" },
    { ref: "main.ws_t", action: "write" },
    { ref: "main.ws_t", action: "read" },
  ]);
  console.log("[snapshot:write]", j(r));
  check("snapshot push (create/drop/write/read) ok", r.status === 200 && r.json.ok === true);

  // 3. Create main.ws_t via /governed-load
  const gl = (sql) => post("/governed-load", { token: jwt, sql });
  r = await gl(
    "CREATE OR REPLACE TABLE main.ws_t AS SELECT * FROM (VALUES (1,100),(2,250),(3,9000)) AS t(id,total)",
  );
  console.log("[governed-load ws_t]", j(r));
  check("governed-load created ws_t", r.status === 200 && r.json.ok === true,
    `phase=${r.json.phase} decision=${r.json.authorizeDecision}`);

  // Verify the table is readable while the connection is open
  const inst = await DuckDBInstance.create(":memory:");
  const c = await inst.connect();
  await c.run("INSTALL quack; LOAD quack");
  let attachErr = null;
  try {
    await c.run(`ATTACH 'quack:${QUACK_TARGET}' AS ws (TOKEN '${jwt.replace(/'/g, "''")}', DISABLE_SSL true)`);
  } catch (e) { attachErr = e instanceof Error ? e.message : String(e); }
  check("pre-checkpoint quack ATTACH ok", attachErr === null, attachErr || "");
  if (!attachErr) {
    let rows = null, readErr = null;
    try { rows = (await c.runAndReadAll(`SELECT count(*) AS n FROM ws.main.ws_t`)).getRowObjects(); }
    catch (e) { readErr = e instanceof Error ? e.message : String(e); }
    console.log("   pre-checkpoint read ws_t →", j(rows), readErr ? `err=${readErr}` : "");
    check("pre-checkpoint read ws_t returns rows (n=3)", !readErr && Number(rows?.[0]?.n) === 3);
  }

  // 4. CHECKPOINT + GCS upload
  r = await post("/ctrl/checkpoint", {});
  console.log("[checkpoint]", j(r));
  check("checkpoint + GCS upload ok", r.status === 200 && r.json.ok === true);

  console.log("\n=== PHASE 1 DONE — now force a cold revision, restart the proxy, then run with READ_ONLY=1 ===");
  console.log("  gcloud run services update ws-bringup --update-env-vars=BUMP=1 --project=project-bd87157a-f6fd-4d44-830 --region=us-west1");
  console.log("  gcloud run services proxy ws-bringup --project=project-bd87157a-f6fd-4d44-830 --region=us-west1 --port=9998 &");
  console.log("  (wait ~30s for the new revision to boot, then:)");
  console.log("  READ_ONLY=1 GW_BASE=http://127.0.0.1:9998 QUACK_TARGET=127.0.0.1:9998 node test/ws-bringup-test.mjs");

} else {
  console.log("=== PHASE 2: cold-restart persistence + ACL proof ===");

  // 6. Push read snapshot (post-restart; new container loaded ws.duckdb from GCS)
  r = await pushSnapshot([
    { ref: "main.ws_t", action: "read" },
  ]);
  console.log("[snapshot:read]", j(r));
  check("snapshot push (read grant) ok", r.status === 200 && r.json.ok === true);

  // Dial in and read ws_t — must survive the cold restart
  const inst = await DuckDBInstance.create(":memory:");
  const c = await inst.connect();
  await c.run("INSTALL quack; LOAD quack");
  let attachErr = null;
  try {
    await c.run(`ATTACH 'quack:${QUACK_TARGET}' AS ws (TOKEN '${jwt.replace(/'/g, "''")}', DISABLE_SSL true)`);
  } catch (e) { attachErr = e instanceof Error ? e.message : String(e); }
  check("post-restart quack ATTACH authenticated", attachErr === null, attachErr || "");

  if (!attachErr) {
    // Granted read → rows must persist from before the cold restart
    let rows = null, readErr = null;
    try { rows = (await c.runAndReadAll(`SELECT count(*) AS n FROM ws.main.ws_t`)).getRowObjects(); }
    catch (e) { readErr = e instanceof Error ? e.message : String(e); }
    console.log("   post-restart read ws_t →", j(rows), readErr ? `err=${readErr}` : "");
    check(
      "PERSISTENCE: ws_t rows survive cold restart (n=3, from GCS)",
      !readErr && Number(rows?.[0]?.n) === 3,
    );

    // 7. ACL: ungranted table DENIED (try reading a table that doesn't have a grant)
    let denied = false;
    try { await c.runAndReadAll("SELECT * FROM ws.main.ws_secret"); }
    catch { denied = true; }
    console.log("   ungranted table read →", denied ? "DENIED (threw)" : "ALLOWED (unexpected)");
    check("ACL: ungranted table read is DENIED by birdshot", denied);
  }

  console.log(failed
    ? "\n=== WORKSPACE VERIFY: FAIL ==="
    : "\n=== WORKSPACE VERIFY: PASS — GCS persistence + birdshot ACL enforcement live on ws-bringup ===");
}

process.exit(failed ? 1 : 0);
