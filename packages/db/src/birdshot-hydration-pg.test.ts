/**
 * Phase 3.5 integration harness (spec §12h): prove birdshot's lazy grant-store
 * hydration works against a REAL Postgres backend.
 *
 *   PGlite (authoritative __birdshot_grants store)
 *     -> PGLiteSocketServer (Postgres wire on 127.0.0.1:PORT)
 *       -> DuckDB (ATTACH ... AS __birdshot (TYPE postgres))
 *         -> birdshot_authenticate -> HydrateSubject lazily pulls a subject's raw
 *            GRANT SQL FROM the ATTACHed protected catalog (catalog-qualified query)
 *
 * What this proves that the local-backend sqllogictest cannot:
 *  1. Networked lazy hydration: alice (direct), bob (transitive role r1), carol
 *     (PUBLIC) are ALLOWED purely from grant rows pulled over the Postgres wire.
 *  2. Fail-closed across the wire: a subject with no rows is default-denied; a
 *     malformed store row poisons its subject (`hydration_failed`) so it is denied
 *     even on a resource PUBLIC would otherwise grant.
 *  3. The CRITICAL protection invariant (§10): now that `__birdshot` is a genuinely
 *     ATTACHed catalog, NO wire token can read it — via its own alias (catalog-name
 *     guard), via a second benign alias (table-name-prefix guard), or bare.
 *
 * Run:  pnpm run --filter @pglite-sandbox/db hydration:pg
 *   (or from packages/db:  pnpm run hydration:pg)
 */
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

// Absolute path to the locally-built (unsigned) birdshot extension.
const EXT =
  "/Users/orchid/mirrir/waddling/birdshot/build/release/extension/birdshot/birdshot.duckdb_extension";

// High, unlikely-contended ports for the PGlite Postgres wires. PGLiteSocketServer
// services ONE client connection per server, and DuckDB's postgres scanner holds a
// persistent connection per ATTACH — so the second (`sneaky`) alias needs its own
// server/port rather than a concurrent connection to the same one.
const PG_PORT = 55432;
const PG_PORT2 = 55433;

let passed = 0;
let failed = 0;
const DEBUG = process.env.HARNESS_DEBUG === "1";
function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
    if (!DEBUG) assert.equal(cond, true, `ASSERTION FAILED: ${name}`);
  }
}

/** Run a scalar boolean birdshot_authorize and return the native JS boolean. */
async function authz(duck: DuckDBConnection, sid: string, sql: string): Promise<boolean> {
  const escaped = sql.replace(/'/g, "''");
  const r = await duck.runAndReadAll(`SELECT birdshot_authorize('${sid}', '${escaped}')`);
  return r.getRowsJS()[0][0] as boolean;
}

async function main() {
  // ---- 1. PGlite authoritative store, exposed over the Postgres wire -------
  const db = new PGlite(); // in-memory pglite
  await db.exec(`
    CREATE TABLE __birdshot_grants (
      grantee_kind TEXT,
      grantee      TEXT,
      stmt         TEXT,
      version      BIGINT DEFAULT 0
    );
  `);
  // alice: a direct subject grant.
  await db.exec(
    `INSERT INTO __birdshot_grants (grantee_kind, grantee, stmt)
     VALUES ('subject', 'alice', 'GRANT SELECT ON main.hyd TO alice');`,
  );
  // bob: role membership + the role's own grant -> transitive hydration. The
  // role-keyed row targets the role explicitly (`TO ROLE r1`): its grant must land
  // under the bare role name that bob's membership (`GRANT r1 TO bob`) joins. A bare
  // `TO r1` would instead land under the SUBJECT self-role of "r1" (§11 namespacing),
  // which bob — a member of the *role* r1 — never holds, so the transitive path would
  // silently not enforce. (The local sqllogictest uses a bare `TO r1` but masks this
  // by granting PUBLIC on the SAME table bob reads; this harness isolates the role
  // path by putting PUBLIC on a different table, main.pub.)
  await db.exec(
    `INSERT INTO __birdshot_grants (grantee_kind, grantee, stmt)
     VALUES ('subject', 'bob', 'GRANT r1 TO bob'),
            ('role',    'r1',  'GRANT SELECT ON main.hyd TO ROLE r1');`,
  );
  // PUBLIC: grantee='' (NOT NULL) per §12a; reaches every identity (incl. carol,
  // who has no subject/role rows of her own).
  await db.exec(
    `INSERT INTO __birdshot_grants (grantee_kind, grantee, stmt)
     VALUES ('public', '', 'GRANT SELECT ON main.pub TO PUBLIC');`,
  );
  // mallory: a GRANT-shaped but MALFORMED row -> parse failure -> fail-closed poison.
  await db.exec(
    `INSERT INTO __birdshot_grants (grantee_kind, grantee, stmt)
     VALUES ('subject', 'mallory', 'GRANT bogus_priv ON main.pub TO mallory');`,
  );
  // (dave: intentionally NO rows -> clean empty hydration -> default-deny.)

  const pgWire = new PGLiteSocketServer({ db, port: PG_PORT, host: "127.0.0.1" });
  await pgWire.start();
  console.log(`PGlite Postgres wire on 127.0.0.1:${PG_PORT}`);

  // ---- 2. DuckDB + postgres scanner + birdshot -----------------------------
  const instance = await DuckDBInstance.create(":memory:", {
    allow_unsigned_extensions: "true",
  });
  const duck = await instance.connect();
  await duck.run("INSTALL postgres; LOAD postgres");
  await duck.run(`LOAD '${EXT}'`);

  const dsn = `host=127.0.0.1 port=${PG_PORT} dbname=postgres user=postgres sslmode=disable`;
  // ATTACH the pglite store as the protected `__birdshot` catalog. READ_ONLY:
  // hydration only reads; the store is the authority, mutated out-of-band.
  await duck.run(`ATTACH '${dsn}' AS __birdshot (TYPE postgres, READ_ONLY)`);

  // Diagnostic: confirm the scanner exposes the table under `public` (§12h choice).
  const schemaRow = await duck.runAndReadAll(
    `SELECT table_schema FROM __birdshot.information_schema.tables WHERE table_name='__birdshot_grants'`,
  );
  console.log(`store table schema via postgres scanner: ${schemaRow.getRowsJS()[0]?.[0]}`);

  // Base tables so the pulled grants' binds resolve.
  await duck.run("CREATE TABLE main.hyd (id INT, title VARCHAR)");
  await duck.run("CREATE TABLE main.pub (id INT, note VARCHAR)");

  // ---- 3. birdshot config (mirror the local test ordering) -----------------
  // service tokens -> commit_config -> set_grant_store('table') -> authenticate.
  // NO commit_config after any authenticate (it would clobber direct-to-live hydration).
  await duck.run("SELECT birdshot_reset_config()");
  await duck.run("SELECT birdshot_set_auth('', '', 'dev')");
  for (const [tok, sub] of [
    ["hy-alice", "alice"],
    ["hy-bob", "bob"],
    ["hy-carol", "carol"],
    ["hy-dave", "dave"],
    ["hy-mallory", "mallory"],
  ]) {
    await duck.run(`SELECT birdshot_add_service_token('${tok}', '${sub}')`);
  }
  await duck.run("SELECT birdshot_commit_config()");

  // Point the store at the ATTACHed postgres catalog. The `target` DSN is recorded
  // for operators; HydrateSubject resolves the pull via the (now attached) __birdshot
  // catalog. This is set AFTER commit (SetGrantStore lives outside the snapshot).
  const storeRes = await duck.runAndReadAll(
    `SELECT birdshot_set_grant_store('table', '${dsn}')`,
  );
  check("set_grant_store('table') -> 'table'", storeRes.getRowsJS()[0][0] === "table");

  // ---- 4. authenticate -> triggers the lazy pull FROM PGLITE ---------------
  for (const [sid, tok] of [
    ["s-alice", "hy-alice"],
    ["s-bob", "hy-bob"],
    ["s-carol", "hy-carol"],
    ["s-dave", "hy-dave"],
    ["s-mallory", "hy-mallory"],
  ]) {
    const r = await duck.runAndReadAll(
      `SELECT birdshot_authenticate('${sid}', '${tok}', '')`,
    );
    // authenticate succeeds even for mallory; fail-closed is enforced at authorize.
    assert.equal(r.getRowsJS()[0][0], true, `authenticate ${sid}`);
  }

  // ---- 5. ASSERT hydration outcomes (all pulled over the Postgres wire) -----
  console.log("\n[networked lazy hydration]");
  check("alice ALLOWED on main.hyd (direct subject grant)", await authz(duck, "s-alice", "SELECT id FROM main.hyd"));
  check("bob ALLOWED on main.hyd (transitive role r1)", await authz(duck, "s-bob", "SELECT id FROM main.hyd"));
  check("carol ALLOWED on main.pub (PUBLIC)", await authz(duck, "s-carol", "SELECT id FROM main.pub"));

  console.log("\n[fail-closed across the wire]");
  // dave: no rows -> clean empty hydration -> default-deny on main.hyd. (PUBLIC still
  // grants him main.pub — that's the contrast that shows this is default-deny, not poison.)
  check("dave DENIED on main.hyd (no rows -> default-deny)", (await authz(duck, "s-dave", "SELECT id FROM main.hyd")) === false);
  check("dave ALLOWED on main.pub (PUBLIC still reaches him)", await authz(duck, "s-dave", "SELECT id FROM main.pub"));
  // mallory: malformed row poisons her -> denied EVEN on main.pub, which PUBLIC grants.
  // carol-allowed vs mallory-denied on the SAME main.pub proves hydration_failed poison,
  // not mere default-deny.
  check("mallory DENIED on main.pub (malformed row -> hydration_failed poison)", (await authz(duck, "s-mallory", "SELECT id FROM main.pub")) === false);

  // ---- 6. CRITICAL protection invariant (§10) ------------------------------
  // The store table was just read SUCCESSFULLY on birdshot's internal connection
  // (alice/bob/carol got grants) — so it exists and resolves. The SAME table must be
  // unreadable by every wire token. Three routes, three guards:
  console.log("\n[CRITICAL: store unaddressable by any wire token]");
  //  (a) its own alias -> IsProtectedRef catalog-name guard (c.rfind('__birdshot')==0)
  check(
    "wire DENIED: SELECT * FROM __birdshot.public.__birdshot_grants (catalog-name guard)",
    (await authz(duck, "s-alice", "SELECT * FROM __birdshot.public.__birdshot_grants")) === false,
  );
  //  (b) ATTACH a store table under a second, benign alias `sneaky`. Here
  //      IsProtectedCatalog('sneaky') is FALSE, so the ONLY thing blocking the read is
  //      the table-name-prefix guard (t.rfind('__birdshot')==0) — precisely the §10
  //      defense against evading protection by re-attaching the store under another
  //      name. (A separate pglite/socket server backs `sneaky` because the primary
  //      server already holds a persistent connection for the `__birdshot` catalog.)
  const db2 = new PGlite();
  await db2.exec(
    `CREATE TABLE __birdshot_grants (grantee_kind TEXT, grantee TEXT, stmt TEXT, version BIGINT DEFAULT 0);
     INSERT INTO __birdshot_grants (grantee_kind, grantee, stmt) VALUES ('subject','eve','GRANT SELECT ON main.hyd TO eve');`,
  );
  const pgWire2 = new PGLiteSocketServer({ db: db2, port: PG_PORT2, host: "127.0.0.1" });
  await pgWire2.start();
  await duck.run(
    `ATTACH 'host=127.0.0.1 port=${PG_PORT2} dbname=postgres user=postgres sslmode=disable' AS sneaky (TYPE postgres, READ_ONLY)`,
  );
  check(
    "wire DENIED: SELECT * FROM sneaky.public.__birdshot_grants (table-name-prefix guard)",
    (await authz(duck, "s-alice", "SELECT * FROM sneaky.public.__birdshot_grants")) === false,
  );
  //  (c) bare/unqualified -> does not resolve outside the store catalog -> denied.
  check(
    "wire DENIED: SELECT * FROM __birdshot_grants (bare, non-resolution)",
    (await authz(duck, "s-alice", "SELECT * FROM __birdshot_grants")) === false,
  );

  // ---- teardown ------------------------------------------------------------
  await pgWire2.stop();
  await db2.close();
  await pgWire.stop();
  await db.close();

  if (failed > 0) throw new Error(`${failed} assertion(s) failed`);
  console.log(`\nAll ${passed} assertions passed.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("\nHARNESS FAILED:", err);
    process.exit(1);
  },
);
