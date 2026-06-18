// FULL demo, one agent, one run:
//   • the agent's managed DuckDB has a PRIVATE table that survives hibernation
//     (persisted to Rivet KV, local file wiped, restored on wake)
//   • the SAME sidecar ATTACHes the governed gateway THROUGH Rivet and runs
//     birdshot-enforced queries (allowed ✓ / denied ✓)
//   • after hibernation the gateway SESSION auto-resumes from durable state
//
// Run order: rivet-engine → `npm run dev` → `npm run proxy` → `npm run verify:full`

import { createClient } from "rivetkit/client";
import type { registry } from "./registry.ts";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const RIVET = process.env.RIVET_ENDPOINT ?? "http://localhost:6420";
const PROXY = process.env.QUACK_PROXY ?? "127.0.0.1:7800";
const ORG = "poc-org", ENDPOINT = "poc-endpoint", ISSUER = "poc-issuer";
const AUD = `gw:${ENDPOINT}`, KID = "poc-key-1", PRINCIPAL = "agent:demo";

function pass(m: string): never { console.log(`\n✅ PASS — ${m}`); process.exit(0); }
function fail(m: string): never { console.error(`\n❌ FAIL — ${m}`); process.exit(1); }

type Q = { rows: unknown[] };
const j = (x: unknown) => JSON.stringify(x);

async function main(): Promise<void> {
  const c = createClient<typeof registry>(RIVET);

  // ── Gateway endpoint: policy + JWK, mint the agent's session token ──────────
  const gw = c.gateway.getOrCreate([ORG, ENDPOINT]);
  await gw.boot();
  await gw.seedDemo();
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const pub = await exportJWK(publicKey);
  await gw.applyPolicy(
    { userRoles: [{ userId: PRINCIPAL, role: "r1" }], roleGrants: [{ role: "r1", tableRef: "main.allowed", action: "read" as const }] },
    { issuer: ISSUER, audience: AUD, jwks: [{ kid: KID, n: pub.n!, e: pub.e! }] },
  );
  const jwt = await new SignJWT({ id: PRINCIPAL, mode: "service", cap: "connect" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setSubject(PRINCIPAL).setIssuer(ISSUER).setAudience(AUD)
    .setIssuedAt().setJti(crypto.randomUUID()).setExpirationTime("10m").sign(privateKey);
  console.log("[1] gateway endpoint ready; agent session JWT minted");

  // ── The agent's managed DuckDB (a supervised sidecar; nothing runs locally) ──
  const me = c.agentSidecar.getOrCreate(["agent-full"]);
  await me.start();
  await me.run("CREATE TABLE IF NOT EXISTS notes(id INTEGER, body VARCHAR)");
  await me.run("DELETE FROM notes");
  await me.run("INSERT INTO notes VALUES (1,'private note')");
  const priv1 = (await me.query("SELECT * FROM notes ORDER BY id")) as Q;
  console.log("[2] PRIVATE table written →", priv1.rows);

  // ── Same sidecar ATTACHes the governed gateway THROUGH Rivet ────────────────
  await me.attachGateway(jwt, PROXY);
  const lake1 = (await me.query("SELECT * FROM lake.allowed")) as Q;
  console.log("[3] GOVERNED lake query (through Rivet) →", lake1.rows);
  if (lake1.rows.length === 0) fail("granted lake query returned no rows");
  let denied1 = false;
  try { await me.query("SELECT * FROM lake.secret"); } catch { denied1 = true; }
  console.log(`[4] ungranted lake.secret denied by birdshot: ${denied1}`);
  if (!denied1) fail("birdshot did not deny lake.secret");

  // ── Hibernate: persist private DB to Rivet KV + wipe local file ─────────────
  const h = await me.hibernate();
  console.log("[5] hibernated:", h);

  // ── After wake: private table survived AND gateway session auto-resumed ─────
  const priv2 = (await me.query("SELECT * FROM notes ORDER BY id")) as Q;
  console.log("[6] PRIVATE table after wake (from KV) →", priv2.rows);
  const lake2 = (await me.query("SELECT * FROM lake.allowed")) as Q;
  console.log("[7] GOVERNED lake after wake (session auto-resumed) →", lake2.rows);
  let denied2 = false;
  try { await me.query("SELECT * FROM lake.secret"); } catch { denied2 = true; }
  console.log(`[8] ungranted still denied after wake: ${denied2}`);

  if (j(priv2.rows) !== j(priv1.rows)) fail(`private table did not survive: ${j(priv1.rows)} → ${j(priv2.rows)}`);
  if (lake2.rows.length === 0) fail("gateway session did not resume after wake");
  if (!denied2) fail("birdshot enforcement lost after wake");

  pass("one managed agent: private DuckDB survived hibernation + governed gateway session resumed, birdshot enforced throughout");
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
