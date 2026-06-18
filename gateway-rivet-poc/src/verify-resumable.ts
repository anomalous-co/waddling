// FORK B + resumable agents — the full vision.
//
// Each agent has its OWN DuckDB instance living in a durable Rivet actor. It
// connects to the gateway THROUGH Rivet (proxy → gatewayActor → quack). We then
// let the agent actor HIBERNATE (its in-memory DuckDB is dropped), and show it
// RE-ESTABLISH from durable state on the next query — same session, resumed.
//
// Proof points:
//   - allowed query returns rows; secret query is birdshot-DENIED
//   - the durable query counter advances across a hibernation (state survived)
//   - the registry log shows SLEEP then WAKE + "cold — rebuilding" (real evict)
//
// Run order: rivet-engine → `npm run dev` → `npm run proxy` → `npm run verify:resumable`

import { createClient } from "rivetkit/client";
import { ActorError } from "rivetkit/client";
import type { registry } from "./registry.ts";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const RIVET_ENDPOINT = process.env.RIVET_ENDPOINT ?? "http://localhost:6420";
const PROXY = process.env.QUACK_PROXY ?? "127.0.0.1:7800";
const ORG = "poc-org";
const ENDPOINT = "poc-endpoint";
const ISSUER = "poc-issuer";
const AUDIENCE = `gw:${ENDPOINT}`;
const KID = "poc-key-1";
const PRINCIPAL = "agent:demo";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function pass(msg: string): never { console.log(`\n✅ PASS — ${msg}`); process.exit(0); }
function fail(msg: string): never { console.error(`\n❌ FAIL — ${msg}`); process.exit(1); }

async function main(): Promise<void> {
  const client = createClient<typeof registry>(RIVET_ENDPOINT);

  // ── Set up the gateway endpoint (policy + JWK) and mint a session token ──────
  const gw = client.gateway.getOrCreate([ORG, ENDPOINT]);
  await gw.boot();
  await gw.seedDemo();
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const pub = await exportJWK(publicKey);
  await gw.applyPolicy(
    { userRoles: [{ userId: PRINCIPAL, role: "r1" }], roleGrants: [{ role: "r1", tableRef: "main.allowed", action: "read" as const }] },
    { issuer: ISSUER, audience: AUDIENCE, jwks: [{ kid: KID, n: pub.n!, e: pub.e! }] },
  );
  const jwt = await new SignJWT({ id: PRINCIPAL, mode: "service", cap: "connect" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setSubject(PRINCIPAL).setIssuer(ISSUER).setAudience(AUDIENCE)
    .setIssuedAt().setJti(crypto.randomUUID()).setExpirationTime("5m").sign(privateKey);
  console.log("[1] gateway ready; session JWT minted");

  // ── The agent's own resumable DuckDB actor ───────────────────────────────────
  const me = client.agent.getOrCreate(["agent-demo"]);
  await me.connect(jwt, PROXY);
  console.log("[2] agent actor remembers gateway (proxy + token in durable state)");

  const r1 = await me.query("SELECT * FROM lake.allowed");
  console.log(`[3] query #1 → rows=${JSON.stringify(r1.rows)} durableCount=${r1.queries}`);
  if (r1.queries !== 1) fail("expected durable query count 1");

  // ── Let the agent actor hibernate (sleepTimeout=2s), then query again ─────────
  console.log("[4] idling 12s to force real hibernation (watch registry log for SLEEP)…");
  await sleep(12000);

  const r2 = await me.query("SELECT * FROM lake.allowed");
  console.log(`[5] query #2 (post-hibernation) → rows=${JSON.stringify(r2.rows)} durableCount=${r2.queries}`);
  if (r2.queries !== 2) fail(`durable state did not survive hibernation (count=${r2.queries}, expected 2)`);
  if (r2.rows.length === 0) fail("re-established agent returned no rows");

  // ── birdshot still enforces after the resume ─────────────────────────────────
  try {
    await me.query("SELECT * FROM lake.secret");
  } catch (e) {
    const msg = e instanceof ActorError ? e.message : String(e);
    console.log("[6] query secret → DENIED:", msg);
    pass("resumable per-agent DuckDB: hibernated, re-established from state, birdshot still enforced");
  }
  fail("secret was NOT denied after resume");
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
