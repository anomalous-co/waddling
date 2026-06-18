import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { loadConfig, type StackConfig } from "./config.ts";
import { bootstrapAuthSchema, loadBirdshotExtension, pushSnapshot } from "./birdshot.ts";
import { seedInstanceData } from "./seed.ts";

/**
 * A fully-initialized quack stack for one instance:
 *   PGlite (authoritative store)
 *     -> PGLiteSocketServer (Postgres wire on 127.0.0.1:pgPort)
 *       -> DuckDB (ATTACH local_db READ_ONLY, VIEW todos)
 *         -> quack_serve (federation endpoint)
 *         -> ensurePeer() (lazy ATTACH of the peer's quack endpoint)
 */
export interface Stack {
  config: StackConfig;
  db: PGlite;
  /**
   * Private PGlite store for notebooks + saved views. NOT attached to DuckDB,
   * so it is unreachable by quack peers (physical isolation).
   */
  privateDb: PGlite;
  /**
   * Auth PGlite store for Better Auth (user/account/session/jwks) + the
   * `birdshot.*` schema (roles/grants/revocations). Like {@link privateDb} it is
   * NEVER attached to DuckDB, so peers cannot read the auth schema; the host
   * reads it and pushes snapshots into the birdshot extension.
   */
  authDb: PGlite;
  /** Whether the birdshot extension is loaded and owns the quack auth/authz hooks. */
  birdshotActive: boolean;
  duck: DuckDBConnection;
  /**
   * Lazily ATTACH the peer's quack endpoint. The peer may not be up when this
   * instance boots, so this retries on each call until it succeeds. Returns
   * whether the peer is currently attached.
   */
  ensurePeer(): Promise<boolean>;
  /** Reset the peer-attached flag so the next ensurePeer() retries the ATTACH. */
  resetPeer(): void;
}

// The init promise is cached on globalThis so it survives Next.js dev
// hot-reloads, is shared across Next's separate module registries (route
// handlers vs. instrumentation), and doubles as the EADDRINUSE rebind guard:
// the PG-wire + quack servers bind their ports exactly once per process.
declare global {
  // eslint-disable-next-line no-var
  var __quackStack: Promise<Stack> | undefined;
}

/** Get (initializing on first call) the process-wide quack stack singleton. */
export function getStack(): Promise<Stack> {
  if (!globalThis.__quackStack) {
    // If init fails — e.g. a stale process from a previous run still holds this
    // instance's PG_PORT, quack port, or PGlite data dir — clear the cache so a
    // later call can retry once the conflict clears, rather than caching (and
    // forever returning) a rejected promise.
    globalThis.__quackStack = initStack().catch((err: unknown) => {
      globalThis.__quackStack = undefined;
      throw err;
    });
  }
  return globalThis.__quackStack;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function initStack(): Promise<Stack> {
  const config = loadConfig();
  // Fail fast instead of hanging a request forever if a resource can't be
  // acquired (most commonly a stale process still holding a port / the data dir).
  return withTimeout(
    buildStack(config),
    15_000,
    `Stack init timed out for instance ${config.instance}. Is another process ` +
      `already using PG_PORT ${config.pgPort}, quack port ${config.quackPort}, ` +
      `or DATA_DIR ${config.dataDir}?`,
  );
}

async function buildStack(config: StackConfig): Promise<Stack> {

  // 1. PGlite is the authoritative store; CRUD writes go directly to it.
  const db = new PGlite(config.dataDir);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id         SERIAL PRIMARY KEY,
      title      TEXT NOT NULL,
      done       BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT now()
    )
  `);

  // Per-instance PII + memories (distinct fake data for A vs B). These live in
  // the federated store and are exposed to DuckDB below, but birdshot's ACL gates
  // them: quack peers get `todos` only, not contacts/addresses/memories.
  await seedInstanceData(db, config.instance);

  // 1b. Private store for notebooks + saved views. A SEPARATE PGlite database
  // that is NEVER attached to DuckDB, so quack peers physically cannot reach it.
  const privateDb = new PGlite(config.privateDataDir);
  await privateDb.exec(`
    CREATE TABLE IF NOT EXISTS notebooks (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      cells      JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMP DEFAULT now(),
      updated_at TIMESTAMP DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS saved_views (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      sql        TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  // 1c. Auth store: Better Auth tables + the birdshot.* schema (roles, grants,
  // revocations). A THIRD, SEPARATE PGlite database that — like privateDb — is
  // NEVER attached to DuckDB, so no quack peer can read the auth schema out of
  // the catalog. The host reads it and pushes snapshots into birdshot.
  const authDb = new PGlite(config.authDataDir);
  await bootstrapAuthSchema(authDb, config.instance);

  // 2. Expose PGlite over the Postgres wire so DuckDB can attach it locally.
  const pgWire = new PGLiteSocketServer({
    db,
    port: config.pgPort,
    host: "127.0.0.1",
  });
  await pgWire.start();
  console.log(`[${config.instance}] PGlite wire server on 127.0.0.1:${config.pgPort}`);

  // 2b. Expose authDb over its own wire port for Better Auth's `pg` Pool. This
  // is reachable only by the host (Better Auth), never ATTACHed into DuckDB.
  const authWire = new PGLiteSocketServer({
    db: authDb,
    port: config.authPgPort,
    host: "127.0.0.1",
  });
  await authWire.start();
  console.log(`[${config.instance}] auth PGlite wire server on 127.0.0.1:${config.authPgPort}`);

  // 3. In-memory DuckDB for analytics. allow_unsigned_extensions lets us LOAD
  // the locally-built (unsigned) birdshot extension.
  const instance = await DuckDBInstance.create(":memory:", {
    allow_unsigned_extensions: "true",
  });
  const duck = await instance.connect();

  // 4. Load quack (DuckDB's HTTP catalog federation, v1.5.3+).
  await duck.run("INSTALL quack; LOAD quack");

  // 5. Attach own PGlite read-only (analytics never writes through DuckDB).
  await duck.run(
    `ATTACH 'host=127.0.0.1 port=${config.pgPort} dbname=postgres sslmode=disable'
     AS local_db (TYPE postgres, READ_ONLY)`,
  );

  // 6. Surface the tables in DuckDB's main schema. `todos` is the shared/federated
  // table; contacts/addresses/memories are PII surfaced into the catalog so the
  // ACL is meaningful — they exist for peers to *reference*, and birdshot denies
  // the read (peer role lacks the grant). Local authenticated users (member/owner)
  // are granted and can read them.
  await duck.run("CREATE OR REPLACE VIEW todos AS SELECT * FROM local_db.public.todos");
  await duck.run("CREATE OR REPLACE VIEW contacts AS SELECT * FROM local_db.public.contacts");
  await duck.run("CREATE OR REPLACE VIEW addresses AS SELECT * FROM local_db.public.addresses");
  await duck.run("CREATE OR REPLACE VIEW memories AS SELECT * FROM local_db.public.memories");

  // 7. Start this instance's quack endpoint (a DuckDB background thread).
  await duck.run(
    `CALL quack_serve('quack:localhost:${config.quackPort}', token := '${config.quackToken}')`,
  );
  console.log(`[${config.instance}] DuckDB quack server on quack:localhost:${config.quackPort}`);

  // 7b. Auth/authz for quack peers. Preferred path: the birdshot extension —
  // per-role table ACLs, query/violation logging, instant revocation, and OAuth
  // identities (via Better Auth) — owns both the authentication and authorization
  // hooks. If the extension isn't built/loadable, fall back to the legacy
  // peer_read_only macro so federation keeps working.
  let birdshotActive = false;
  if (await loadBirdshotExtension(duck, config)) {
    await pushSnapshot(duck, authDb, config);
    birdshotActive = true;
    console.log(`[${config.instance}] birdshot active — quack hooks enforced by extension`);
  } else {
    // Legacy fallback. Deny-list rather than allow-list: quack issues its own
    // catalog-introspection queries during a peer ATTACH, and an allow-list keyed
    // on SELECT/WITH/... rejects them and breaks federation. We allow everything
    // EXCEPT statements beginning with a data/DDL-mutating keyword.
    await duck.run(`
      CREATE OR REPLACE MACRO peer_read_only(sid, query) AS (
        NOT regexp_matches(
          upper(ltrim(query)),
          '^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE|TRUNCATE|COPY|ATTACH|DETACH|INSTALL|LOAD|CALL|MERGE|GRANT|REVOKE|VACUUM|EXPORT|IMPORT|PIVOT)\\b'
        )
      );
      SET GLOBAL quack_authorization_function = 'peer_read_only';
    `);
    console.log(`[${config.instance}] birdshot inactive — using legacy peer_read_only macro`);
  }

  // 8. Lazy peer attachment — the peer may not be up yet.
  let peerAttached = false;
  async function ensurePeer(): Promise<boolean> {
    if (peerAttached) return true;
    try {
      // Clear any stale handle first. After a failed peer query we mark the peer
      // detached (resetPeer) but the `peer_db` catalog entry may still exist, so a
      // bare ATTACH would fail with "database peer_db already attached" and the
      // peer would stay stuck offline. DETACH (ignoring "not attached") makes the
      // re-ATTACH below idempotent and self-healing.
      try {
        await duck.run("DETACH peer_db");
      } catch {
        // wasn't attached — fine
      }
      await duck.run(
        `ATTACH 'quack:localhost:${config.peerQuackPort}'
         AS peer_db (TOKEN '${config.peerQuackToken}', DISABLE_SSL true)`,
      );
      peerAttached = true;
    } catch {
      // peer not yet up — will retry on the next call
    }
    return peerAttached;
  }

  return {
    config,
    db,
    privateDb,
    authDb,
    birdshotActive,
    duck,
    ensurePeer,
    resetPeer() {
      peerAttached = false;
    },
  };
}
