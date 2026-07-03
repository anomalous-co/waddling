/**
 * Scoped-store proof (control-DB shape): the PRODUCTION path acl.ts + the gateway run,
 * which the unscoped grant-store:e2e / hydration:pg do NOT cover. Proves two facts the
 * whole cutover rests on:
 *
 *   1. Datalake SCOPING: one shared store serves many datalakes; a `datalake` column +
 *      per-datalake `__birdshot_meta` epoch + `birdshot_set_grant_scope('<datalakeId>')`
 *      isolate tenants. Another datalake's grant to the SAME subject must NOT leak.
 *   2. A COLON subject (`agent:<uuid>` — the JWT `sub`) surviving store -> pull -> enforce,
 *      via the grant-store.ts builders (bare grantee, unquoted). The interactive colon
 *      proof was in-process only; this drives it through the stored/scoped path.
 *
 * Run:  pnpm run grant-store:scoped   (from packages/db)
 */
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { applyStatement, grant, revoke, grantsForKey, type StoreScope } from "./grant-store.ts";

const EXT =
  "/Users/orchid/mirrir/waddling/birdshot/build/release/extension/birdshot/birdshot.duckdb_extension";
const PG_PORT = 55445;

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

const DL_A = "dl_aaaa1111";
const DL_B = "dl_bbbb2222";
const AGENT = "agent:8f3c-uuid-1234"; // colon-bearing JWT sub
const scopeA: StoreScope = { datalake: DL_A };
const scopeB: StoreScope = { datalake: DL_B };

async function main() {
  // ---- control-DB-shaped store (migration 022): datalake column + per-dl meta ----
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE __birdshot_grants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      datalake TEXT NOT NULL, grantee_kind TEXT NOT NULL, grantee TEXT NOT NULL DEFAULT '',
      stmt TEXT NOT NULL, version BIGINT NOT NULL, created_at timestamptz DEFAULT now());
    CREATE TABLE __birdshot_meta (datalake TEXT PRIMARY KEY, epoch BIGINT NOT NULL DEFAULT 0);
  `);
  const pgWire = new PGLiteSocketServer({ db, port: PG_PORT, host: "127.0.0.1" });
  await pgWire.start();

  const instance = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
  const duck = await instance.connect();
  await duck.run("INSTALL postgres; LOAD postgres");
  await duck.run(`LOAD '${EXT}'`);
  const dsn = `host=127.0.0.1 port=${PG_PORT} dbname=postgres user=postgres sslmode=disable`;
  await duck.run(`ATTACH '${dsn}' AS __birdshot (TYPE postgres, READ_ONLY)`);
  await duck.run("CREATE SCHEMA sales");
  await duck.run("CREATE TABLE sales.orders (id INT, total INT)");

  // The gateway for datalake A: scope it to DL_A only.
  await duck.run("SELECT birdshot_reset_config()");
  await duck.run("SELECT birdshot_set_auth('', '', 'dev')");
  await duck.run(`SELECT birdshot_add_service_token('tok', '${AGENT}')`);
  await duck.run("SELECT birdshot_commit_config()");
  await duck.run(`SELECT birdshot_set_grant_store('table', '${dsn}')`);
  await duck.run(`SELECT birdshot_set_grant_scope('${DL_A}')`);
  await duck.run(`SELECT birdshot_authenticate('s1', 'tok', '')`);

  console.log("\n[scoped store: colon subject through store -> pull -> enforce]");
  check("colon agent DENIED before any grant", !(await authz(duck, "s1", "SELECT id FROM sales.orders")));

  // Grant to the colon subject in datalake B (WRONG tenant) — must NOT leak into A.
  await applyStatement(db, grant({ privileges: ["SELECT"], on: "sales.orders", to: { subject: AGENT } }), scopeB);
  check("cross-tenant isolation: DL_B grant does NOT authorize on DL_A gateway",
    !(await authz(duck, "s1", "SELECT id FROM sales.orders")));

  // Grant to the colon subject in datalake A — now enforce.
  await applyStatement(db, grant({ privileges: ["SELECT"], on: "sales.orders", to: { subject: AGENT } }), scopeA);
  check("colon agent ALLOWED after scoped GRANT (bare grantee)",
    await authz(duck, "s1", "SELECT id FROM sales.orders"));

  // REVOKE in A -> epoch bump -> denied on next query (freshness).
  await applyStatement(db, revoke({ privileges: ["SELECT"], on: "sales.orders", to: { subject: AGENT } }), scopeA);
  check("colon agent DENIED after scoped REVOKE (freshness gate)",
    !(await authz(duck, "s1", "SELECT id FROM sales.orders")));

  // UI read is datalake-scoped: A sees its GRANT+REVOKE, B sees only its own GRANT.
  const aStmts = await grantsForKey(db, AGENT, scopeA);
  const bStmts = await grantsForKey(db, AGENT, scopeB);
  console.log("\n[scoped UI read]");
  check("grantsForKey(A) has the GRANT + REVOKE", aStmts.length === 2 && aStmts[0].startsWith("GRANT"));
  check("grantsForKey(B) has ONLY the B grant (no cross-tenant bleed)",
    bStmts.length === 1 && bStmts[0] === `GRANT SELECT ON sales.orders TO ${AGENT}`);

  // Per-datalake epoch: A bumped 3x (grant,revoke) ... B bumped 1x.
  const epochA = (await db.query("SELECT epoch FROM __birdshot_meta WHERE datalake=$1", [DL_A])).rows[0] as { epoch: bigint };
  const epochB = (await db.query("SELECT epoch FROM __birdshot_meta WHERE datalake=$1", [DL_B])).rows[0] as { epoch: bigint };
  check("per-datalake epoch A = 2 (grant+revoke)", Number(epochA.epoch) === 2);
  check("per-datalake epoch B = 1 (one grant)", Number(epochB.epoch) === 1);

  await pgWire.stop();
  await db.close();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
