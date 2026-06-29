// WF-1 closing gate: concurrency + cross-agent ACL isolation on the SINGLE authoritative
// quack-serving instance (the primitive WF-2's router sits on). Discharges three things the
// single-agent dial-in test did NOT:
//   1. concurrency ceiling — N agents dial in and read simultaneously; measure p50/p99/max +
//      throughput, and whether it cliffs (the "10s–100s agents/s" requirement);
//   2. the unattributed warm-read HANG — if it wedges, concurrency is where it shows; a per-query
//      timeout turns a wedge into a visible failure instead of a hang;
//   3. cross-agent ACL isolation — agents with DISJOINT grants run concurrently; each must read
//      ONLY its own table and be DENIED the other (per-request birdshot sid on the serving path).
import { DuckDBInstance } from "@duckdb/node-api";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const BASE = process.env.GW_BASE || "http://127.0.0.1:9999";
const QUACK = process.env.QUACK_TARGET || "127.0.0.1:9999";
const ISSUER = "bringup-issuer", AUDIENCE = "gw:bringup", KID = "bringup-key-1";
const K = Number(process.env.K || 24);          // concurrent agents
const ROUNDS = Number(process.env.ROUNDS || 4); // read rounds per agent (fan-out volume)
const Q_TIMEOUT_MS = 30000;
let failed = false;
const check = (n, c, x) => { console.log(`${c ? "✅" : "❌"} ${n}${x ? "  " + x : ""}`); if (!c) failed = true; };
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT(${label}) after ${ms}ms`)), ms))]);

const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const pub = await exportJWK(publicKey);
const mint = (sub) => new SignJWT({ id: sub, mode: "service", cap: "connect" })
  .setProtectedHeader({ alg: "RS256", kid: KID }).setSubject(sub)
  .setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setJti(crypto.randomUUID())
  .setExpirationTime("20m").sign(privateKey);

// Two principals with DISJOINT single-table grants (the isolation matrix).
const A = "agent:A", B = "agent:B";
const jwtA = await mint(A), jwtB = await mint(B);
const auth = { issuer: ISSUER, audience: AUDIENCE, jwks: [{ kid: KID, n: pub.n, e: pub.e }] };
const snapshot = {
  userRoles: [{ userId: A, role: "rA" }, { userId: B, role: "rB" }],
  roleGrants: [
    { role: "rA", tableRef: "main.bringup_t", action: "read" },
    { role: "rB", tableRef: "main.secret_t", action: "read" },
  ],
};
const snapRes = await fetch(`${BASE}/ctrl/snapshot`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ snapshot, auth, lakeCatalog: "lake" }) });
check("snapshot (A→bringup_t, B→secret_t) pushed", snapRes.status === 200);

// Build K external clients (alternating A/B) — setup is sequential; the READ phase is concurrent.
console.log(`building ${K} dial-in clients…`);
const clients = [];
for (let i = 0; i < K; i++) {
  const isA = i % 2 === 0;
  const inst = await DuckDBInstance.create(":memory:");
  const c = await inst.connect();
  await c.run("INSTALL quack; LOAD quack");
  await c.run(`ATTACH 'quack:${QUACK}' AS lake (TOKEN '${(isA ? jwtA : jwtB).replace(/'/g, "''")}', DISABLE_SSL true)`);
  clients.push({ c, isA, idx: i });
}
check(`all ${K} agents dialed in (quack ATTACH authenticated)`, clients.length === K);

// Concurrent read fan-out: every agent, every round, reads its OWN table and probes the OTHER.
const lat = [];
let ownFail = 0, isoFail = 0, hang = 0;
const t0 = Date.now();
const tasks = [];
for (let r = 0; r < ROUNDS; r++) {
  for (const { c, isA, idx } of clients) {
    tasks.push((async () => {
      const own = isA ? "lake.main.bringup_t" : "lake.main.secret_t";
      const other = isA ? "lake.main.secret_t" : "lake.main.bringup_t";
      const s = Date.now();
      try {
        const rr = await withTimeout(c.runAndReadAll(`SELECT count(*) AS n FROM ${own}`), Q_TIMEOUT_MS, `own a${idx}`);
        if (Number(rr.getRowObjects()[0]?.n) < 1) ownFail++;
      } catch (e) { (String(e.message).startsWith("TIMEOUT") ? hang++ : ownFail++); }
      lat.push(Date.now() - s);
      // isolation: the OTHER agent's table must be denied (client throws)
      let denied = false;
      try { await withTimeout(c.runAndReadAll(`SELECT count(*) FROM ${other}`), Q_TIMEOUT_MS, `iso a${idx}`); }
      catch (e) { if (String(e.message).startsWith("TIMEOUT")) hang++; else denied = true; }
      if (!denied) isoFail++;
    })());
  }
}
await Promise.all(tasks);
const total = Date.now() - t0;
const n = lat.length;
lat.sort((a, b) => a - b);
const pct = (p) => lat[Math.min(n - 1, Math.floor(p / 100 * n))];

console.log(`\n— ${n} granted reads + ${n} isolation probes across ${K} concurrent agents × ${ROUNDS} rounds in ${total}ms`);
console.log(`  latency ms: p50=${pct(50)} p90=${pct(90)} p99=${pct(99)} max=${lat[n - 1]}`);
console.log(`  throughput: ${(2 * n / (total / 1000)).toFixed(1)} queries/s`);
check("no warm-read HANG (zero query timeouts)", hang === 0, `hangs=${hang}`);
check("all granted reads returned rows", ownFail === 0, `failures=${ownFail}`);
check("cross-agent ACL isolation held (every other-table read DENIED)", isoFail === 0, `leaks=${isoFail}`);

console.log(failed ? "\n=== CONCURRENCY PROBE: FAIL ===" : "\n=== CONCURRENCY PROBE: PASS — concurrent dial-in, no hang, per-agent isolation holds ===");
process.exit(failed ? 1 : 0);
