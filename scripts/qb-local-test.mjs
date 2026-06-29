import { DuckDBInstance } from "@duckdb/node-api";
import { rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXT = "birdshot/build/release/extension/birdshot/birdshot.duckdb_extension";
const tmpDir = join(tmpdir(), "qb-local-" + Date.now());
mkdirSync(tmpDir, { recursive: true });
const dbPath = join(tmpDir, "quackboard.duckdb");

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const qid = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const b64url = (s) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function main() {
  const inst = await DuckDBInstance.create(dbPath, { allow_unsigned_extensions: "true" });
  const conn = await inst.connect();
  await conn.run("INSTALL httpfs;");

  // Discover database name
  const dbReader = await conn.runAndReadAll("SELECT database_name FROM duckdb_databases() WHERE internal = false ORDER BY database_name");
  const dbName = String(dbReader.getRowObjects()[0]?.database_name ?? "???");
  console.log("database_name:", dbName);

  // Create quackboard schema (matching container bootstrap)
  await conn.run("CREATE SEQUENCE IF NOT EXISTS obs_seq START 1");
  await conn.run(`CREATE TABLE IF NOT EXISTS observations(id INTEGER PRIMARY KEY DEFAULT nextval('obs_seq'), agent_role TEXT, content TEXT, refs JSON, topic TEXT, ts TIMESTAMP DEFAULT current_timestamp)`);
  await conn.run(`INSERT INTO observations(agent_role, content, refs, topic) SELECT 'system', 'init', '[]', 'meta' WHERE NOT EXISTS (SELECT 1 FROM observations)`);

  // Verify table is queryable
  const verify = await conn.runAndReadAll("SELECT count(*) AS n FROM observations");
  console.log("table verify:", verify.getRowObjects()[0]?.n, "rows");

  // ── Load birdshot ────────────────────────────────────
  await conn.run(`INSTALL quack; LOAD quack;`);
  await conn.run(`LOAD ${q(EXT)}`);

  for (const s of [
    "SELECT birdshot_reset_config()",
    `SELECT birdshot_set_lake_catalog(${q(dbName)})`,
    "SELECT birdshot_set_auth('', '', 'dev')",
    "SELECT birdshot_add_role_grant('reader', 'main.observations', 'read')",
    "SELECT birdshot_add_role_grant('reader', 'main.observations', 'write')",
    "SELECT birdshot_add_user_role('alice', 'reader')",
    "SELECT birdshot_commit_config()",
  ]) await conn.run(s);

  // ── Start quack server ───────────────────────────────
  const port = 19500 + Math.floor(Math.random() * 1000);
  await conn.run(`CALL quack_serve('quack:localhost:${port}', token := 'srv-token')`);
  await conn.run("SET GLOBAL quack_authentication_function = 'birdshot_authenticate'");
  await conn.run("SET GLOBAL quack_authorization_function  = 'birdshot_authorize'");
  console.log(`quack_serve up on :${port}`);

  // ── Client ──────────────────────────────────────────
  const clinst = await DuckDBInstance.create(":memory:");
  const cli = await clinst.connect();
  await cli.run("INSTALL quack; LOAD quack");
  const alice = `${b64url('{"alg":"none","typ":"JWT"}')}.${b64url(JSON.stringify({sub:"alice"}))}.x`;

  async function tryQuery(label, sql) {
    try {
      await cli.runAndReadAll(
        `FROM quack_query('quack:localhost:${port}', ${q(sql)}, token := '${alice}', disable_ssl := true)`
      );
      console.log(`✅ ${label}`);
    } catch (e) { console.log(`❌ ${label}:`, e.message.split("\n")[0]); }
  }

  await tryQuery("INSERT (unqualified)", "INSERT INTO observations(agent_role, content) VALUES ('alice', 'hello')");
  await tryQuery("INSERT (schema-qualified)", "INSERT INTO main.observations(agent_role, content) VALUES ('alice', 'hello2')");
  await tryQuery("INSERT (fully-qualified)", `INSERT INTO ${dbName}.main.observations(agent_role, content) VALUES ('alice', 'hello3')`);
  await tryQuery("SELECT (unqualified)", "SELECT count(*) FROM observations");
  await tryQuery("SELECT (schema-qualified)", "SELECT count(*) FROM main.observations");

  // Drain audit
  const audit = (await conn.runAndReadAll("SELECT birdshot_log_drain(100) AS blob")).getRowObjects()[0]?.blob ?? "";
  console.log("\naudit:");
  for (const line of String(audit).split("\n")) {
    if (!line) continue;
    const [, event, , , decision, reasonB64] = line.split("\t");
    const reason = reasonB64 ? Buffer.from(reasonB64, "base64").toString() : "";
    console.log(`  ${event}: ${decision} ${reason}`);
  }

  await conn.run(`CALL quack_stop('quack:localhost:${port}')`);
  rmSync(tmpDir, { recursive: true, force: true });
}
main().catch(console.error);
