// Cross-workspace governed dial-in (the second ACL domain). Proves LIVE on ws-b that a workspace
// OWNER can grant a DIFFERENT agent scoped access to its tables: agent A (not the owner) dials into
// workspace B and reads ONLY the tables B granted A, and is denied the rest. The "compiler" here is
// trivial (grant grantee→tables) — it's the template for the control-plane buildWorkspaceSnapshot;
// the point is the data-plane enforcement of a per-grantee workspace snapshot.
//
//   GW_BASE=http://127.0.0.1:9997 QUACK_TARGET=127.0.0.1:9997 node test/cross-workspace.mjs
import { DuckDBInstance } from "@duckdb/node-api";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const BASE = process.env.GW_BASE || "http://127.0.0.1:9997";
const QUACK_TARGET = process.env.QUACK_TARGET || "127.0.0.1:9997";
const ISSUER = "xws-issuer", AUDIENCE = "gw:ws-b", KID = "xws-key";
const OWNER = "agent:owner-b", A = "agent:a-guest";
const j = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? Number(x) : x));
let failed = false;
const check = (n, c, x) => { console.log(`${c ? "✅" : "❌"} ${n}${x ? "  " + x : ""}`); if (!c) failed = true; };
const post = async (p, b) => { const r = await fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };

// One JWKS/key; two principals (owner + guest) distinguished by sub.
const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const pub = await exportJWK(publicKey);
const mint = (sub) => new SignJWT({ id: sub, mode: "service", cap: "connect" })
  .setProtectedHeader({ alg: "RS256", kid: KID }).setSubject(sub)
  .setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setJti(crypto.randomUUID()).setExpirationTime("10m").sign(privateKey);
const jwtOwner = await mint(OWNER), jwtA = await mint(A);
const auth = { issuer: ISSUER, audience: AUDIENCE, jwks: [{ kid: KID, n: pub.n, e: pub.e }] };
const snap = (roleGrants, userRoles) => post("/ctrl/snapshot", { snapshot: { userRoles, roleGrants }, auth, lakeCatalog: "workspace" });

// 1. Owner seeds two tables in workspace B (owner has create/drop/write on both).
const ownerDdl = ["b_public", "b_private"].flatMap((t) => ["create", "drop", "write"].map((action) => ({ role: "owner", tableRef: `main.${t}`, action })));
console.log("owner ddl snapshot:", j(await snap(ownerDdl, [{ userId: OWNER, role: "owner" }])));
console.log("seed b_public:", j(await post("/governed-load", { token: jwtOwner, sql: "CREATE OR REPLACE TABLE main.b_public AS SELECT * FROM (VALUES (1,'shared'),(2,'ok')) AS t(id,note)" })));
console.log("seed b_private:", j(await post("/governed-load", { token: jwtOwner, sql: "CREATE OR REPLACE TABLE main.b_private AS SELECT * FROM (VALUES (1,'secret')) AS t(id,note)" })));

// 2. The cross-workspace GRANT: owner B grants guest A read on b_public ONLY (b_private stays private).
//    Owner keeps full access too. This is what a control-plane buildWorkspaceSnapshot would emit.
const shared = [
  ...["b_public", "b_private"].map((t) => ({ role: "owner", tableRef: `main.${t}`, action: "read" })),
  { role: "guest", tableRef: "main.b_public", action: "read" },
];
console.log("shared snapshot:", j(await snap(shared, [{ userId: OWNER, role: "owner" }, { userId: A, role: "guest" }])));

// 3. Guest A dials into workspace B and exercises its grants.
const inst = await DuckDBInstance.create(":memory:");
const c = await inst.connect();
await c.run("INSTALL quack; LOAD quack");
await c.run(`ATTACH 'quack:${QUACK_TARGET}' AS wsb (TOKEN '${jwtA.replace(/'/g, "''")}', DISABLE_SSL true)`);
check("guest A dialed into workspace B (birdshot authenticated)", true);

let pubRows = null, pubErr = null;
try { pubRows = (await c.runAndReadAll("SELECT count(*) AS n FROM wsb.main.b_public")).getRowObjects(); } catch (e) { pubErr = String(e.message || e); }
console.log("   A reads b_public →", j(pubRows), pubErr ? `err=${pubErr}` : "");
check("guest A reads GRANTED table b_public (n=2)", !pubErr && Number(pubRows?.[0]?.n) === 2);

let denied = false;
try { await c.runAndReadAll("SELECT * FROM wsb.main.b_private"); } catch { denied = true; }
console.log("   A reads b_private →", denied ? "DENIED" : "ALLOWED (LEAK!)");
check("guest A DENIED ungranted table b_private (owner kept it private)", denied);

console.log(failed ? "\n=== CROSS-WORKSPACE: FAIL ===" : "\n=== CROSS-WORKSPACE: PASS — a workspace governs a DIFFERENT agent's scoped access live ===");
process.exit(failed ? 1 : 0);
