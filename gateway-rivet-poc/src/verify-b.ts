// FORK B verification — prove an EXTERNAL DuckDB can ATTACH to the gateway
// THROUGH Rivet (not direct loopback) and get birdshot-enforced results.
//
// Topology under test:
//   this process's DuckDB ──quack:127.0.0.1:7800──▶ proxy ──RivetKit──▶
//     gatewayActor.onRequest ──▶ loopback quack ──▶ birdshot
//
// Same allowed/denied proof as fork A, but every byte now crosses the Rivet
// boundary. Green here = quack tunnels through Rivet.
//
// Run order: rivet-engine → `npm run dev` → `npm run proxy` → `npm run verify:b`

import { createClient } from "rivetkit/client";
import type { registry } from "./registry.ts";
import { DuckDBInstance } from "@duckdb/node-api";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const RIVET_ENDPOINT = process.env.RIVET_ENDPOINT ?? "http://localhost:6420";
const PROXY = process.env.QUACK_PROXY ?? "127.0.0.1:7800";
const ORG = "poc-org";
const ENDPOINT = "poc-endpoint";
const ISSUER = "poc-issuer";
const AUDIENCE = `gw:${ENDPOINT}`;
const KID = "poc-key-1";
const PRINCIPAL = "agent:demo";

function pass(msg: string): never {
  console.log(`\n✅ PASS — ${msg}`);
  process.exit(0);
}
function fail(msg: string): never {
  console.error(`\n❌ FAIL — ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const client = createClient<typeof registry>(RIVET_ENDPOINT);
  const gw = client.gateway.getOrCreate([ORG, ENDPOINT]);

  await gw.boot();
  await gw.seedDemo();
  console.log("[1] gateway actor booted + seeded");

  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const pub = await exportJWK(publicKey);
  const auth = { issuer: ISSUER, audience: AUDIENCE, jwks: [{ kid: KID, n: pub.n!, e: pub.e! }] };
  const snapshot = {
    userRoles: [{ userId: PRINCIPAL, role: "r1" }],
    roleGrants: [{ role: "r1", tableRef: "main.allowed", action: "read" as const }],
  };
  await gw.applyPolicy(snapshot, auth);
  console.log("[2] policy applied: r1 → read main.allowed only");

  const jwt = await new SignJWT({ id: PRINCIPAL, mode: "service", cap: "connect" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setSubject(PRINCIPAL)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime("5m")
    .sign(privateKey);
  console.log("[3] session JWT minted for", PRINCIPAL);

  // The agent's OWN, independent DuckDB. It ATTACHes to the PROXY, not to the
  // actor's loopback port — so the whole conversation goes through Rivet.
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  await conn.run("INSTALL quack; LOAD quack");
  await conn.run(
    `ATTACH 'quack:${PROXY}' AS lake (TOKEN '${jwt.replace(/'/g, "''")}', DISABLE_SSL true)`,
  );
  console.log(`[4] external DuckDB ATTACHed via proxy quack:${PROXY} (through Rivet)`);

  const allowed = (await conn.runAndReadAll("SELECT * FROM lake.allowed")).getRowObjects();
  console.log("[5] SELECT allowed →", allowed);
  if (allowed.length === 0) fail("granted query returned no rows through the tunnel");

  try {
    (await conn.runAndReadAll("SELECT * FROM lake.secret")).getRowObjects();
  } catch (e) {
    console.log("[6] SELECT secret → DENIED:", (e as Error).message);
    pass("quack tunnelled through Rivet; birdshot enforced end-to-end (allowed ✓, denied ✓)");
  }
  fail("secret was NOT denied through the tunnel");
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
