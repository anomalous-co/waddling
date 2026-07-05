/**
 * End-to-end proof (spec §13): a literal GRANT/DENY/REVOKE statement flows
 *   control-plane WRITE (grant-store.ts) -> Postgres store (pglite) -> birdshot
 *   lazy hydrate + epoch freshness -> ENFORCE -> UI READ (grantsForKey, verbatim).
 *
 * No compiler anywhere: the writer builds canonical granular SQL, applyStatement
 * appends the row + bumps the epoch transactionally, and every authorize below picks
 * up the change via the freshness gate (no re-authenticate). Proves the loop the
 * control-api + grant UI will be built on.
 *
 * Run:  pnpm run grant-store:e2e   (from packages/db)
 */
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { applyStatement, grant, deny, revoke, grantRole, grantsForKey } from "./grant-store.ts";

const EXT =
  "/Users/orchid/mirrir/waddling/birdshot/build/release/extension/birdshot/birdshot.duckdb_extension";
const PG_PORT = 55442;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
    assert.equal(cond, true, `ASSERTION FAILED: ${name}`);
  }
}
async function authz(duck: DuckDBConnection, sid: string, sql: string): Promise<boolean> {
  const escaped = sql.replace(/'/g, "''");
  const r = await duck.runAndReadAll(`SELECT birdshot_authorize('${sid}', '${escaped}')`);
  return r.getRowsJS()[0][0] as boolean;
}

async function main() {
  // ---- store: empty grants + epoch=0 -------------------------------------
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE __birdshot_grants (grantee_kind TEXT, grantee TEXT, stmt TEXT, version BIGINT DEFAULT 0);
    CREATE TABLE __birdshot_meta (epoch BIGINT); INSERT INTO __birdshot_meta VALUES (0);
  `);
  const pgWire = new PGLiteSocketServer({ db, port: PG_PORT, host: "127.0.0.1" });
  await pgWire.start();

  // ---- DuckDB + postgres scanner + birdshot ------------------------------
  const instance = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
  const duck = await instance.connect();
  await duck.run("INSTALL postgres; LOAD postgres");
  await duck.run(`LOAD '${EXT}'`);
  const dsn = `host=127.0.0.1 port=${PG_PORT} dbname=postgres user=postgres sslmode=disable`;
  await duck.run(`ATTACH '${dsn}' AS __birdshot (TYPE postgres, READ_ONLY)`);
  await duck.run("CREATE SCHEMA sales");
  await duck.run("CREATE TABLE sales.orders (id INT, total INT)");
  await duck.run("CREATE TABLE sales.pii (id INT, ssn VARCHAR)");

  await duck.run("SELECT birdshot_reset_config()");
  await duck.run("SELECT birdshot_set_auth('', '', 'dev')");
  await duck.run("SELECT birdshot_add_service_token('tok-agent1', 'agent1')");
  await duck.run("SELECT birdshot_commit_config()");
  await duck.run(`SELECT birdshot_set_grant_store('table', '${dsn}')`);
  await duck.run("SELECT birdshot_authenticate('s1', 'tok-agent1', '')");

  // ---- 1. no grants -> default-deny --------------------------------------
  console.log("\n[write -> store -> hydrate -> enforce]");
  check("agent1 DENIED sales.orders (no grants yet)", !(await authz(duck, "s1", "SELECT id FROM sales.orders")));

  // ---- 2. GRANT (to a role) + membership -> ALLOW ------------------------
  await applyStatement(db, grant({ privileges: ["SELECT"], on: "sales.orders", to: { role: "analyst" } }));
  await applyStatement(db, grantRole("analyst", "agent1"));
  check("agent1 ALLOWED sales.orders after GRANT+membership", await authz(duck, "s1", "SELECT id FROM sales.orders"));

  // ---- 3. REVOKE -> DENY (freshness, no re-auth) -------------------------
  await applyStatement(db, revoke({ privileges: ["SELECT"], on: "sales.orders", to: { role: "analyst" } }));
  check("agent1 DENIED sales.orders after REVOKE", !(await authz(duck, "s1", "SELECT id FROM sales.orders")));

  // ---- 4. wildcard GRANT -> ALLOW across the schema ----------------------
  await applyStatement(db, grant({ privileges: ["SELECT"], on: "ALL TABLES IN SCHEMA sales", to: { role: "analyst" } }));
  console.log("\n[deny-wins carve-out flows end-to-end]");
  check("agent1 ALLOWED sales.orders (wildcard)", await authz(duck, "s1", "SELECT id FROM sales.orders"));
  check("agent1 ALLOWED sales.pii (wildcard, before DENY)", await authz(duck, "s1", "SELECT id FROM sales.pii"));

  // ---- 5. DENY sales.pii -> carve-out (deny-wins), sales.orders unaffected
  await applyStatement(db, deny({ privileges: ["SELECT"], on: "sales.pii", to: { role: "analyst" } }));
  check("agent1 STILL ALLOWED sales.orders", await authz(duck, "s1", "SELECT id FROM sales.orders"));
  check("agent1 DENIED sales.pii (deny-wins carve-out)", !(await authz(duck, "s1", "SELECT id FROM sales.pii")));

  // ---- 6. UI READ: the key's literal statements, verbatim ----------------
  console.log("\n[UI read: literal statements for agent1's key]");
  const stmts = await grantsForKey(db, "agent1");
  for (const s of stmts) console.log(`    ${s}`);
  check(
    "grantsForKey returns the membership",
    stmts.includes("GRANT analyst TO agent1"),
  );
  check(
    "grantsForKey returns the wildcard grant (literal)",
    stmts.includes("GRANT SELECT ON ALL TABLES IN SCHEMA sales TO ROLE analyst"),
  );
  check(
    "grantsForKey returns the DENY carve-out (literal)",
    stmts.includes("DENY SELECT ON sales.pii TO ROLE analyst"),
  );

  await pgWire.stop();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
