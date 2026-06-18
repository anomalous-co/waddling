// PoC verification (fork A): prove birdshot ENFORCES inside the Rivet actor.
//
// Loading the extension proves nothing about enforcement: rt.query() in the
// gateway runs on its OWN ungated connection. birdshot's authz hook only fires
// on a quack CLIENT connection carrying a session JWT. So this script does
// exactly what an external agent's DuckDB does — just over loopback:
//
//   1. boot the actor + seed a demo lake
//   2. generate an RSA keypair; push its public JWK + a one-grant snapshot
//   3. mint an RS256 session JWT (same claims/issuer/aud as the real gateway)
//   4. open a SEPARATE DuckDB, ATTACH 'quack:localhost:<port>' (TOKEN <jwt>)
//   5. granted query  → succeeds
//   6. ungranted query → DENIED
//
// The allowed/denied pair through a TOKEN'd quack connection is the proof.
//
// Run: `pnpm dev` (or npm) in one terminal, then `pnpm verify` in another.

import { createClient } from "rivetkit/client";
import type { registry } from "./registry.ts";
import { DuckDBInstance } from "@duckdb/node-api";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const RIVET_ENDPOINT = process.env.RIVET_ENDPOINT ?? "http://localhost:6420";
const ORG = "poc-org";
const ENDPOINT = "poc-endpoint";
const ISSUER = "poc-issuer";
const AUDIENCE = `gw:${ENDPOINT}`;
const KID = "poc-key-1";
const PRINCIPAL = "agent:demo"; // birdshot principal == JWT sub/id

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

  // 1. Boot the native runtime inside the actor + seed the demo lake.
  const booted = await gw.boot();
  console.log("[1] actor booted:", booted);
  await gw.seedDemo();
  console.log("[2] demo tables seeded (allowed, secret)");

  const st = (await gw.status()) as { ext_loaded?: boolean } | Record<string, unknown>;
  console.log("[3] birdshot_status() in-actor:", st);

  // 2. RSA keypair; trust its public JWK at the gateway via the snapshot's auth.
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const pub = await exportJWK(publicKey);
  const auth = { issuer: ISSUER, audience: AUDIENCE, jwks: [{ kid: KID, n: pub.n!, e: pub.e! }] };

  // Snapshot: PRINCIPAL → role r1 → read main.allowed (NOT main.secret).
  const snapshot = {
    userRoles: [{ userId: PRINCIPAL, role: "r1" }],
    roleGrants: [{ role: "r1", tableRef: "main.allowed", action: "read" as const }],
  };
  await gw.applyPolicy(snapshot, auth);
  console.log("[4] policy applied: r1 → read main.allowed only");

  // 3. Mint the session JWT (mirrors apps/waddling .../sessions/route.ts claims).
  const jwt = await new SignJWT({ id: PRINCIPAL, mode: "service", cap: "connect" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setSubject(PRINCIPAL)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime("5m")
    .sign(privateKey);
  console.log("[5] session JWT minted for", PRINCIPAL);

  // 4. ATTACH as the agent over quack, exactly like a real client would.
  const port = await gw.quackPort();
  const inst = await DuckDBInstance.create(":memory:");
  const conn = await inst.connect();
  await conn.run("INSTALL quack; LOAD quack");
  await conn.run(
    // Local quack listener has no TLS → DISABLE_SSL true (plain HTTP loopback).
    // In prod the gateway terminates TLS, so a real agent uses DISABLE_SSL false.
    `ATTACH 'quack:localhost:${port}' AS lake (TOKEN '${jwt.replace(/'/g, "''")}', DISABLE_SSL true)`,
  );
  console.log(`[6] agent ATTACHed to quack:localhost:${port}`);

  // 5. Granted query — must succeed.
  const allowed = (await conn.runAndReadAll("SELECT * FROM lake.allowed")).getRowObjects();
  console.log("[7] SELECT allowed →", allowed);
  if (allowed.length === 0) fail("granted query returned no rows (expected 2)");

  // 6. Ungranted query — must be denied.
  try {
    (await conn.runAndReadAll("SELECT * FROM lake.secret")).getRowObjects();
  } catch (e) {
    console.log("[8] SELECT secret → DENIED:", (e as Error).message);
    pass("birdshot enforced ACLs inside the Rivet actor (allowed ✓, denied ✓)");
  }
  fail("secret was NOT denied — birdshot did not enforce");
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
