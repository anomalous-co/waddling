import { WaddlingDuck } from "../scripts/duckdb-client";

async function main() {
  // ── Test 1: analyst — aggregate query ──────────────────────────────
  console.log("=== Test 1: analyst aggregate ===");
  const duck = await WaddlingDuck.create({ apiKey: "sk_agent_analyst_demo" });
  console.log(`  session: ${duck.session.sessionId.slice(0, 8)}…  ttl: ${duck.sessionTtl}s`);
  const r1 = await duck.query(
    "SELECT status, COUNT(*) as cnt FROM lake.sales.orders GROUP BY status ORDER BY cnt DESC"
  );
  for (const row of r1.rows) console.log(`  ${(row as string[])[0]}: ${(row as number[])[1]}`);
  duck.close();

  // ── Test 2: analyst — denied (ssn) ─────────────────────────────────
  console.log("\n=== Test 2: analyst denied (ssn) ===");
  const duck2 = await WaddlingDuck.create({ apiKey: "sk_agent_analyst_demo" });
  try {
    await duck2.query("SELECT ssn FROM lake.sales.customers LIMIT 1");
    console.log("  UNEXPECTED: should have been denied");
  } catch (err) {
    console.log(`  Denied: ${(err as Error).message.slice(0, 80)}`);
  }
  duck2.close();

  // ── Test 3: etl-bot — write ────────────────────────────────────────
  console.log("\n=== Test 3: etl-bot write to events ===");
  const duck3 = await WaddlingDuck.create({ apiKey: "sk_agent_etlbot_demo" });
  console.log(`  granted: ${JSON.stringify(duck3.granted).slice(0, 80)}`);
  const r3 = await duck3.query(
    "INSERT INTO lake.sales.events (event_id, customer_id, event_type, payload, ts) VALUES (99997, 1, 'test_from_client', '{\"source\":\"WaddlingDuck\"}', NOW())"
  );
  console.log(`  Result: ${JSON.stringify(r3)}`);
  duck3.close();

  // ── Test 4: etl-bot — denied (SELECT on events, write-only) ────────
  console.log("\n=== Test 4: etl-bot denied (SELECT on events) ===");
  const duck4 = await WaddlingDuck.create({ apiKey: "sk_agent_etlbot_demo" });
  try {
    await duck4.query("SELECT * FROM lake.sales.events LIMIT 1");
    console.log("  UNEXPECTED: should have been denied");
  } catch (err) {
    console.log(`  Denied: ${(err as Error).message.slice(0, 80)}`);
  }
  duck4.close();

  console.log("\n=== All tests passed ===");
}

main().catch(err => console.error("FATAL:", err.message));
