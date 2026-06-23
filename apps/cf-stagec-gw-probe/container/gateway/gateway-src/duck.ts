// DuckDB bootstrap + birdshot control for the gateway (W3).
//
// Boots an in-memory DuckDB, LOADs the (unsigned) birdshot extension, creates
// the S3/R2/MinIO secret, ATTACHes the org's DuckLake, starts quack_serve, and
// exposes thin wrappers over the birdshot_* control functions used by the ctrl
// server (snapshot / constraints / revoke / status). See repo.md for the
// birdshot fn signatures and ducklake.md for ATTACH syntax.

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import type { GatewayConfig } from "./config";
import type { BirdshotSnapshot } from "@waddling/control-schema";

/** Single-quote escape for inlining a string into a DuckDB SQL literal. */
function q(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/** Quote a SQL identifier (double-quote, escaping embedded quotes). */
function qid(s: string): string {
  return '"' + s.replace(/"/g, '""') + '"';
}

/**
 * Expose the lake's `main` tables as read-through VIEWs in `memory.main` so quack (which
 * serves only the server's default `memory` catalog) can serve them. The view body reads
 * straight from the lake, so the data stays durable in the lake/object store. Idempotent
 * (CREATE OR REPLACE); a fresh local-file demo lake has no tables and this is a no-op.
 */
export async function restoreLakeViews(connection: DuckDBConnection, alias: string): Promise<void> {
  try {
    const reader = await connection.runAndReadAll(
      `SELECT table_name FROM duckdb_tables() WHERE database_name = ${q(alias)} AND schema_name = 'main'`,
    );
    for (const row of reader.getRowObjects() as Record<string, unknown>[]) {
      const t = String(row.table_name);
      await connection.run(`CREATE OR REPLACE VIEW memory.main.${qid(t)} AS SELECT * FROM ${alias}.main.${qid(t)}`);
    }
  } catch (e) {
    console.log(`[gateway] restoreLakeViews failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Defensively create the Postgres schema that a postgres-catalog DuckLake will use as
 * its METADATA_SCHEMA, before the ducklake ATTACH. DuckLake auto-creates its metadata
 * *tables* (CREATE_IF_NOT_EXISTS) but not the enclosing PG *schema*, so a fresh endpoint
 * whose schema doesn't exist yet would otherwise fail to attach. We do this by ATTACHing
 * the catalog Postgres directly (DuckDB postgres extension) and running CREATE SCHEMA IF
 * NOT EXISTS — pushed through to PG — then detaching. Idempotent and cheap. Retries to
 * tolerate the catalog still warming up (mirrors the ATTACH retry below).
 */
async function ensureCatalogSchema(
  connection: DuckDBConnection,
  catalogDsn: string,
  schema: string,
): Promise<void> {
  const bootstrapAlias = "_catalog_bootstrap";
  const maxAttempts = 15;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await connection.run(`ATTACH ${q(catalogDsn)} AS ${bootstrapAlias} (TYPE postgres)`);
      try {
        await connection.run(`CREATE SCHEMA IF NOT EXISTS ${bootstrapAlias}.${qid(schema)}`);
      } finally {
        await connection.run(`DETACH ${bootstrapAlias}`);
      }
      return;
    } catch (err) {
      lastErr = err;
      // A leftover attach from a failed prior attempt blocks re-ATTACH — try to clear it.
      try { await connection.run(`DETACH ${bootstrapAlias}`); } catch { /* not attached */ }
      console.log(
        `[gateway] ensure catalog schema attempt ${attempt}/${maxAttempts} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}

/**
 * Normalize a DuckDB row tree to JSON-safe values (BigInt → Number, value
 * wrappers → their readable toString()). Mirrors packages/db/src/analytics.ts.
 */
export function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto && proto !== Object.prototype) return String(value);
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalize(v)]),
    );
  }
  return value;
}

export interface DuckRuntime {
  connection: DuckDBConnection;
  config: GatewayConfig;
  /** Run a query and return JSON-safe columns + row tuples. */
  query(sql: string, cap?: number): Promise<{ columns: string[]; rows: unknown[][]; rowCount: number; truncated: boolean }>;
  /** Run a statement with no result. */
  run(sql: string): Promise<void>;
}

// Idempotent quackboard schema: the shared agent-coordination tables + a seeded FTS index.
// Run on the un-gated CONTROL connection at boot (before quack_serve), so it is not subject
// to birdshot authorization. CREATE … IF NOT EXISTS makes it a no-op on a restored db.
const QUACKBOARD_SCHEMA: string[] = [
  "CREATE SEQUENCE IF NOT EXISTS obs_seq   START 1",
  "CREATE SEQUENCE IF NOT EXISTS amem_seq  START 1",
  "CREATE SEQUENCE IF NOT EXISTS sub_seq   START 1",
  "CREATE SEQUENCE IF NOT EXISTS notif_seq START 1",
  "CREATE SEQUENCE IF NOT EXISTS bnd_seq   START 1",
  "CREATE SEQUENCE IF NOT EXISTS msg_seq   START 1",
  `CREATE TABLE IF NOT EXISTS objectives(id INTEGER PRIMARY KEY, owner TEXT,
     status TEXT DEFAULT 'open', body TEXT, ts TIMESTAMP DEFAULT current_timestamp)`,
  `CREATE TABLE IF NOT EXISTS observations(id INTEGER PRIMARY KEY DEFAULT nextval('obs_seq'),
     agent_role TEXT, content TEXT, refs JSON, topic TEXT, ts TIMESTAMP DEFAULT current_timestamp)`,
  `CREATE TABLE IF NOT EXISTS agent_memory(id INTEGER PRIMARY KEY DEFAULT nextval('amem_seq'),
     agent_role TEXT, key TEXT, content TEXT, ts TIMESTAMP DEFAULT current_timestamp)`,
  `CREATE TABLE IF NOT EXISTS claims(area TEXT PRIMARY KEY, agent_role TEXT,
     status TEXT DEFAULT 'claimed', ts TIMESTAMP DEFAULT current_timestamp)`,
  `CREATE TABLE IF NOT EXISTS subscriptions(id INTEGER PRIMARY KEY DEFAULT nextval('sub_seq'),
     agent_role TEXT, pattern TEXT, match_type TEXT DEFAULT 'fts', topic TEXT,
     created TIMESTAMP DEFAULT current_timestamp)`,
  `CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY DEFAULT nextval('notif_seq'),
     to_role TEXT, source_id INTEGER, sub_id INTEGER, snippet TEXT,
     ts TIMESTAMP DEFAULT current_timestamp, is_read BOOLEAN DEFAULT false)`,
  `CREATE TABLE IF NOT EXISTS boundaries(id INTEGER PRIMARY KEY DEFAULT nextval('bnd_seq'),
     name TEXT, scope TEXT, paths JSON, status TEXT DEFAULT 'open', owner TEXT,
     ts TIMESTAMP DEFAULT current_timestamp)`,
  `CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY DEFAULT nextval('msg_seq'),
     from_agent TEXT, to_agent TEXT, body TEXT, ts TIMESTAMP DEFAULT current_timestamp)`,
  // Seed one sentinel so the FTS index always has a document, then build it.
  `INSERT INTO observations(agent_role, content, refs, topic)
     SELECT 'system', 'quackboard initialized', '[]', 'meta'
     WHERE NOT EXISTS (SELECT 1 FROM observations)`,
  "PRAGMA create_fts_index('observations', 'id', 'content', stemmer = 'porter', overwrite = 1)",
];

async function bootstrapQuackboardSchema(connection: DuckDBConnection): Promise<void> {
  for (const stmt of QUACKBOARD_SCHEMA) await connection.run(stmt);
}

/** Boot DuckDB, load birdshot, create the S3 secret, ATTACH the lake, serve quack. */
export async function bootDuckRuntime(config: GatewayConfig): Promise<DuckRuntime> {
  // Per-phase cold-boot instrumentation (Track 0): the two phases that dominate cold start are
  // the lake ATTACH (a cold Postgres catalog can stall the retry loop for seconds) and quack_serve.
  // Emit one line per phase so a single real boot trace tells us where the time actually goes —
  // grep `[gateway:boot]` in the logs. Cheap (Date.now diffs); leave it on in production.
  const tBoot = Date.now();
  let tPhase = tBoot;
  const mark = (phase: string): void => {
    const now = Date.now();
    console.log(`[gateway:boot] ${phase} +${now - tPhase}ms (total ${now - tBoot}ms)`);
    tPhase = now;
  };

  // A lake gateway opens ':memory:' (durable data lives in the ATTACHed lake); a quackboard
  // opens its durable .duckdb file directly, so quack serves the agent-coordination tables.
  // Open with the build-time extension cache (prebake-extensions.mjs bakes quack/httpfs/
  // ducklake/postgres/fts here), so the INSTALLs below are local cache hits, not network
  // downloads — the single biggest cold-boot win. Same dir + same node-api version as the
  // build ⇒ the <dir>/v<ver>/<platform>/ path matches.
  const instance = await DuckDBInstance.create(config.databasePath, {
    allow_unsigned_extensions: "true",
    extension_directory: process.env.DUCKDB_EXTENSION_DIR || "/opt/duckdb-extensions",
  });
  const connection = await instance.connect();
  mark("duckdb-create");

  // quack (HTTP catalog federation) + birdshot (ACL enforcement).
  await connection.run("INSTALL quack; LOAD quack");
  await connection.run(`LOAD ${q(config.birdshotExtensionPath)}`);
  mark("load-quack-birdshot");

  // httpfs underlies quack's wire transport — needed for both lake and quackboard.
  await connection.run("INSTALL httpfs;");
  if (config.quackboard) {
    // Discover and USE the actual database name so quack's per-request connections +
    // birdshot's bind-walk resolve unqualified table refs against the same catalog.
    // Opening a file path makes that file (not `memory`) the default catalog, and
    // birdshot_set_lake_catalog must match it — so override config.lakeAlias with the
    // discovered name. MUST come BEFORE table creation so tables land in the right DB.
    const dbReader = await connection.runAndReadAll(
      "SELECT database_name FROM duckdb_databases() WHERE internal = false ORDER BY database_name",
    );
    const dbName = String(
      (dbReader.getRowObjects()[0] as Record<string, unknown>)?.database_name ?? "memory",
    );
    console.log(
      `[gateway] quackboard database name: ${dbName}, lakeAlias=${config.lakeAlias || "(empty)"}`,
    );
    await connection.run(`USE ${qid(dbName)}`);
    config.lakeAlias = dbName;
    // FTS powers quackboard recall (BM25) + pub/sub matching; no lake catalog/object store.
    await connection.run("INSTALL fts; LOAD fts;");
    // Create the shared coordination tables on the un-gated control connection, before the
    // birdshot hooks + quack_serve below. Idempotent — a no-op on a restored db.
    await bootstrapQuackboardSchema(connection);
    mark("quackboard-schema");
  } else {
    // ducklake + postgres for the lake catalog/object store.
    await connection.run("INSTALL ducklake; INSTALL postgres;");
    mark("install-ducklake-postgres");
  }

  // quack's wire transport rides HTTPFS, so cache + reuse the underlying HTTP(S)
  // connections instead of paying a fresh handshake per request — the lever for
  // high-throughput gateway serving (defaults to false). GLOBAL so the transient
  // per-request connections quack's auth callbacks run on inherit it.
  await connection.run("LOAD httpfs; SET GLOBAL httpfs_connection_caching = true;");

  // A quackboard has no lake: skip the S3 secret, the ducklake ATTACH, and the read-through
  // views entirely. quack serves the opened database's own tables (restored from R2). The
  // birdshot hooks + quack_serve below still run, so ACLs are enforced.
  // (Quackboard config — USE + lakeAlias override — was already handled above, before schema creation.)
  if (!config.quackboard) {
  // S3 / R2 / MinIO secret. PROVIDER config = explicit static creds.
  // MinIO: USE_SSL false + URL_STYLE path; R2: USE_SSL true + vhost.
  // Skipped entirely in local-data mode (DATA_PATH is a local dir, no object store).
  if (!config.localData) {
    // SESSION_TOKEN present ⇒ STS-style temp creds (the R2 faucet's scoped, short-lived
    // key). DuckDB's httpfs S3 secret carries it alongside KEY_ID/SECRET.
    const sessionTokenLine = config.s3.sessionToken
      ? `,\n        SESSION_TOKEN ${q(config.s3.sessionToken)}`
      : "";
    await connection.run(`
      CREATE OR REPLACE SECRET lake_s3 (
        TYPE s3,
        PROVIDER config,
        KEY_ID ${q(config.s3.keyId)},
        SECRET ${q(config.s3.secret)},
        ENDPOINT ${q(config.s3.endpoint)},
        REGION ${q(config.s3.region)},
        USE_SSL ${config.s3.useSsl ? "true" : "false"},
        URL_STYLE ${q(config.s3.urlStyle)}${sessionTokenLine}
      )
    `);
  }

  // ATTACH the DuckLake. Two catalog modes:
  //   * postgres-catalog (Docker/prod): 'ducklake:postgres:<dsn>' + s3:// data
  //   * local-file (host-native demo):  'ducklake:<file>' + local-dir data
  // CREATE_IF_NOT_EXISTS defaults true, so the gateway can boot before the seed
  // populates the lake. Retry to tolerate the catalog/store still warming up.
  const isPgCatalog = !config.ducklakeCatalogFile;
  const catalogTarget = isPgCatalog
    ? `ducklake:postgres:${config.ducklakeCatalogDsn}`
    : `ducklake:${config.ducklakeCatalogFile}`;

  // Per-endpoint isolation: when many endpoints share ONE org Postgres catalog DB,
  // METADATA_SCHEMA scopes this endpoint's DuckLake metadata to its own PG schema so
  // it can't see another endpoint's tables. DuckLake's CREATE_IF_NOT_EXISTS creates the
  // DuckLake *metadata tables*, but does NOT promise to create the PG *schema* namespace
  // they live in — so create it defensively first (the minted role inherits `postgres`,
  // hence has CREATE). This MUST run in the gateway container: it's the only tier with
  // raw :5432 egress to the catalog (control-api's Worker reaches Postgres only via its
  // Hyperdrive binding, pinned to the control DB). Idempotent; a no-op once it exists.
  const useMetadataSchema = isPgCatalog && config.metadataSchema;
  if (useMetadataSchema) {
    await ensureCatalogSchema(connection, config.ducklakeCatalogDsn, config.metadataSchema);
    mark("ensure-catalog-schema");
  }

  const opts: string[] = [`DATA_PATH ${q(config.ducklakeDataPath)}`];
  if (useMetadataSchema) opts.push(`METADATA_SCHEMA ${q(config.metadataSchema)}`);
  if (config.encrypted) opts.push("ENCRYPTED");
  const attachSql = `ATTACH '${catalogTarget}' AS ${config.lakeAlias} (${opts.join(", ")})`;
  {
    // Backoff grows from 250ms (was a flat 2s): a responsive catalog that needs ONE retry
    // costs 250ms, not 2s, while a genuinely cold catalog still gets ~20s of total patience.
    const maxAttempts = 15;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await connection.run(attachSql);
        lastErr = undefined;
        if (attempt > 1) console.log(`[gateway:boot] ATTACH ducklake succeeded on attempt ${attempt}`);
        break;
      } catch (err) {
        lastErr = err;
        console.log(
          `[gateway] ATTACH ducklake attempt ${attempt}/${maxAttempts} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        await new Promise((r) => setTimeout(r, Math.min(250 * 2 ** (attempt - 1), 3000)));
      }
    }
    if (lastErr) throw lastErr;
  }
  // The single biggest cold-boot variable: a cold Postgres catalog can hold this across retries.
  // The attempt count above pinpoints catalog-warmth cost in a boot trace.
  mark("attach-ducklake");

  // Make the lake the default catalog on the control connection so this process's
  // own control/introspection ops (e.g. ducklakeSnapshot, ad-hoc admin queries)
  // resolve bare `schema.table` to the lake. Agent SQL never runs on this
  // connection; the authz-hook path resolves the catalog independently via
  // birdshot_set_lake_catalog (applySnapshot), since `USE` does NOT carry to the
  // transient per-request connections quack's auth callbacks run on.
  await connection.run(`USE ${config.lakeAlias}`);

  // quack serves ONLY the server's `memory` catalog (verified: USE does not change what it
  // serves, and a client cannot address an attached server catalog). So expose the lake's
  // tables as read-through VIEWs in memory.main — the data stays in the lake (R2), but
  // `FROM memory.main.<t>` reads through. birdshot's bind-walk sees the view's expanded
  // `<lakeAlias>.main.<t>`, which matches the grants pushed with lakeCatalog=<lakeAlias>.
  // memory.main is shared across the instance's connections, so quack's per-request
  // serving connections see these views. Restores on every (re)boot from the durable lake.
  await restoreLakeViews(connection, config.lakeAlias);
  mark("restore-lake-views");
  } // end if (!config.quackboard) — quackboard skips the entire lake-mount section

  // Hand quack's auth/authz hooks to birdshot BEFORE the server starts listening.
  // The auth callbacks are evaluated on a fresh server-side connection per request
  // and read the GLOBAL slot (quack reference §Settings), so they must be installed
  // before quack_serve — otherwise there is a window where the endpoint accepts
  // connections with the default allow-all callbacks (quack_check_token /
  // quack_nop_authorization) and an agent could reach the lake un-gated.
  await connection.run("SET GLOBAL quack_authentication_function = 'birdshot_authenticate'");
  await connection.run("SET GLOBAL quack_authorization_function  = 'birdshot_authorize'");

  // Start the quack endpoint (background thread). The session JWT is the TOKEN;
  // birdshot_authenticate verifies it against server_token + JWKS.
  await connection.run(
    `CALL quack_serve('quack:localhost:${config.quackPort}', token := ${q(config.serverToken)})`,
  );
  mark("quack-serve");
  console.log(`[gateway:boot] bootDuckRuntime ready in ${Date.now() - tBoot}ms`);

  const runtime: DuckRuntime = {
    connection,
    config,
    async run(sql: string): Promise<void> {
      await connection.run(sql);
    },
    async query(sql, cap) {
      const reader = await connection.runAndReadAll(sql);
      const columns = reader.columnNames();
      const objs = reader.getRowObjects() as Record<string, unknown>[];
      const capped = cap !== undefined && objs.length > cap;
      const used = capped ? objs.slice(0, cap) : objs;
      const rows = used.map((o) => columns.map((c) => normalize(o[c])));
      return { columns, rows, rowCount: rows.length, truncated: capped };
    },
  };
  return runtime;
}

// ── Schema introspection (for the control plane's describe endpoint) ──────────

export interface DescribedColumn {
  name: string;
  type: string;
  nullable?: boolean;
}
export interface DescribedTable {
  schema: string;
  table: string;
  columns: DescribedColumn[];
}

/**
 * Introspect the attached lake's columns + types via `duckdb_columns()` (the same
 * function packages/db/src/schema.ts uses for the web editor's autocomplete).
 * Runs on the gateway's own (ungated) connection — the CONTROL PLANE filters the
 * result down to the requesting agent's grants before any of it reaches a client
 * (the describe route intersects against `granted.tables`, which is the non-leak
 * boundary). We therefore deliberately do NOT filter by catalog here: that filter
 * can only ever *exclude* the real lake tables (a DuckLake attach may not report
 * its catalog as the alias) and adds no safety the grant intersection doesn't
 * already provide. Only internal schemas are dropped. Optionally restricted to a
 * set of "schema.table" refs to avoid shipping the whole catalog.
 */
export async function describeTables(
  rt: DuckRuntime,
  only?: { schema: string; table: string }[],
): Promise<DescribedTable[]> {
  const reader = await rt.connection.runAndReadAll(
    `SELECT schema_name, table_name, column_name, data_type, is_nullable
       FROM duckdb_columns()
      WHERE schema_name NOT IN ('information_schema', 'pg_catalog')
      ORDER BY schema_name, table_name, column_index`,
  );
  const rows = reader.getRowObjects() as Record<string, unknown>[];

  const wanted = only
    ? new Set(only.map((t) => `${t.schema}.${t.table}`.toLowerCase()))
    : null;

  const byTable = new Map<string, DescribedTable>();
  for (const r of rows) {
    const schema = String(r.schema_name);
    const table = String(r.table_name);
    const key = `${schema}.${table}`;
    if (wanted && !wanted.has(key.toLowerCase())) continue;
    let t = byTable.get(key);
    if (!t) {
      t = { schema, table, columns: [] };
      byTable.set(key, t);
    }
    // duckdb_columns().is_nullable is a BOOLEAN (unlike information_schema's
    // 'YES'/'NO'); accept either form defensively.
    const nul = r.is_nullable;
    t.columns.push({
      name: String(r.column_name),
      type: String(r.data_type),
      nullable: nul === true || String(nul).toLowerCase() === 'true' || String(nul).toUpperCase() === 'YES',
    });
  }
  return [...byTable.values()];
}

// ── birdshot control-plane wrappers (applied by the ctrl server) ───────────────

/**
 * Apply a full birdshot policy snapshot atomically (reset → set → commit).
 * Mirrors the compiler output in ARCHITECTURE.md §3e. Auth config (issuer,
 * audience, JWKS) is pulled from the gateway config / JWKS endpoint.
 */
export async function applySnapshot(
  rt: DuckRuntime,
  snapshot: BirdshotSnapshot,
  auth?: { issuer: string; audience: string; jwks?: { kid: string; n: string; e: string }[] },
): Promise<void> {
  const c = rt.connection;
  await c.run("SELECT birdshot_reset_config()");
  // The lake catalog ALIAS (gateway-local config). birdshot installs it as the
  // default catalog search path when binding agent SQL on the transient authz-hook
  // connection — where `USE <alias>` does NOT carry — so bare/unqualified table refs
  // (form-A push-down) still resolve to the lake. Part of the staged config, so it
  // is re-set on every snapshot (reset_config above cleared it).
  if (rt.config.lakeAlias) {
    await c.run(`SELECT birdshot_set_lake_catalog(${q(rt.config.lakeAlias)})`);
  }
  if (auth) {
    await c.run(`SELECT birdshot_set_auth(${q(auth.issuer)}, ${q(auth.audience)}, 'rs256')`);
    for (const k of auth.jwks ?? []) {
      await c.run(`SELECT birdshot_add_jwk(${q(k.kid)}, ${q(k.n)}, ${q(k.e)})`);
    }
  }
  for (const ur of snapshot.userRoles) {
    await c.run(`SELECT birdshot_add_user_role(${q(ur.userId)}, ${q(ur.role)})`);
  }
  for (const g of snapshot.roleGrants) {
    await c.run(`SELECT birdshot_add_role_grant(${q(g.role)}, ${q(g.tableRef)}, ${q(g.action)})`);
  }
  // Column allow-lists + time-of-day windows (Phase 2). birdshot enforces these at
  // the quack authz hook via bind-and-walk; without this push it holds table grants
  // ONLY and a granted table leaks every column. columns → CSV; absent window → ''.
  for (const rc of snapshot.roleConstraints ?? []) {
    const cols = (rc.columns ?? []).join(",");
    const ws = rc.window?.start ?? "";
    const we = rc.window?.end ?? "";
    await c.run(
      `SELECT birdshot_add_grant_constraint(${q(rc.role)}, ${q(rc.tableRef)}, ${q(cols)}, ${q(ws)}, ${q(we)})`,
    );
  }
  // Per-role allowlists for NON-catalog resources (Phase 3). Each `kind` maps to a
  // distinct birdshot policy function; the role can then run an already-CONSTANT
  // read_source/copy/attach/install whose literal matches the pattern. Without
  // these, every such capability default-denies (an empty allowlist grants nothing).
  for (const p of snapshot.policies ?? []) {
    const fn =
      p.kind === "source"
        ? "birdshot_add_source_policy"
        : p.kind === "dest"
          ? "birdshot_add_dest_policy"
          : p.kind === "extension"
            ? "birdshot_add_ext_policy"
            : "birdshot_add_attach_policy";
    await c.run(`SELECT ${fn}(${q(p.role)}, ${q(p.pattern)})`);
  }
  await c.run("SELECT birdshot_commit_config()");

  // Re-expose lake tables as read-through views. The per-replica `memory.main` views
  // quack serves are created at boot (restoreLakeViews in bootDuckRuntime), so a table
  // loaded AFTER this replica booted — e.g. a governed ETL that ran on a PEER replica and
  // persisted to the shared DuckLake — is invisible here until the views are refreshed.
  // applySnapshot runs on every snapshot re-arm, so refreshing here makes a freshly-loaded
  // table queryable on whichever replica serves the next read. No-op for a quackboard.
  //
  // CRITICAL: this is BEST-EFFORT and must NEVER block the apply. The birdshot config is
  // already committed above (the connect-critical part); a view refresh that resolves the
  // lake schema from the Postgres DuckLake catalog can be slow, and applySnapshot gates
  // connect (control-api aborts /gw/snapshot if it runs long → every connect times out).
  // So time-bound it and move on; a missed refresh is recovered on the next boot/re-arm.
  if (!rt.config.quackboard) {
    await Promise.race([
      restoreLakeViews(c, rt.config.lakeAlias).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }
}

/** Instant revocation → in-memory denylist; next query for the subject denied. */
export async function birdshotRevoke(
  rt: DuckRuntime,
  kind: "user" | "jti" | "session",
  id: string,
  reason: string,
  expiresUs?: number,
): Promise<void> {
  const exp = expiresUs === undefined ? "NULL" : `${Math.trunc(expiresUs)}::bigint`;
  await rt.connection.run(`SELECT birdshot_revoke(${q(kind)}, ${q(id)}, ${q(reason)}, ${exp})`);
}

/** birdshot_status() → parsed object (auth mode, policy size, session/audit). */
export async function birdshotStatus(rt: DuckRuntime): Promise<unknown> {
  const reader = await rt.connection.runAndReadAll("SELECT birdshot_status() AS s");
  const raw = (reader.getRowObjects()[0]?.s as string) ?? "";
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

/** Current DuckLake snapshot info for status reporting. */
export async function ducklakeSnapshot(rt: DuckRuntime): Promise<unknown> {
  try {
    const reader = await rt.connection.runAndReadAll(
      `SELECT * FROM ${rt.config.lakeAlias}.current_snapshot()`,
    );
    return normalize(reader.getRowObjects()[0] ?? null);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
