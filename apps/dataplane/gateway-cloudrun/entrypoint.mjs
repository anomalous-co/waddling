// Stage D probe — gateway container entrypoint (boot + forwarder + control channel).
//
// Runs INSIDE the CF Container (started by GatewayDO via sandbox.startProcess).
// It does three things, in this order:
//   1. seed a minimal local ducklake (file catalog + local data dir) with two
//      tables — public.orders (ALLOWED) + public.secrets (FORBIDDEN);
//   2. boot the REAL gateway runtime (bootDuckRuntime from packages/gateway):
//      INSTALL/LOAD quack, LOAD birdshot, ATTACH ducklake, install
//      birdshot_authenticate/birdshot_authorize as quack's auth/authz hooks
//      BEFORE quack_serve (boot-order is security-critical), CALL quack_serve on
//      loopback :9500;
//   3. start an HTTP forwarder on :8080 that the Durable Object reaches via
//      containerFetch. Two surfaces:
//        • POST /ctrl/*  → in-process birdshot control (snapshot push, status) on
//          the gateway's trusted control connection — NOT an agent data path;
//        • everything else → proxied byte-for-byte to loopback quack:9500 (the
//          Fork-B quack-over-HTTP translation; agent SQL rides this, gated by
//          birdshot_authorize).
//
// WHY a forwarder rather than containerFetch straight to :9500 — the gateway's
// birdshot control functions (applySnapshot / birdshot_status) must run on the
// SAME in-process DuckDB connection that quack_serve was started from; only a
// process living next to that connection can call them. The forwarder co-locates
// the control channel with the quack proxy so the DO drives both over one port.
// (containerFetch directly to :9500 also reaches quack — see README — but it
// cannot reach the in-process control functions, so the forwarder is required
// for the snapshot push regardless.)

import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

import { DuckDBInstance } from "@duckdb/node-api";
import {
  bootDuckRuntime,
  applySnapshot,
  birdshotRevoke,
  birdshotStatus,
  normalize,
  restoreLakeViews,
} from "./gateway-src/duck.ts";
import { gcsDownload, gcsUpload } from "./gateway-src/gcs.ts";

// Monotonic counter for private authz session ids on the trusted connection
// (governed-load). Each call gets a fresh sid so concurrent loads never share a
// birdshot session/principal.
let etlSeq = 0;

// Reject anything beyond a single SQL statement BEFORE authz, so the string we
// authorize is byte-identical to the string we execute (no TOCTOU surface). A
// `;` inside a single-quoted literal does not count. birdshot ALSO denies
// multi-statement at authorize — this is the belt to that suspenders.
function isSingleStatement(sql) {
  let inStr = false;
  const s = String(sql);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") {
      if (inStr && s[i + 1] === "'") { i++; continue; } // escaped '' inside a literal
      inStr = !inStr;
    } else if (ch === ";" && !inStr) {
      // a trailing `;` (only whitespace after it) is a benign terminator, not a second statement.
      if (s.slice(i + 1).trim() === "") return true;
      return false;
    }
  }
  return true;
}

const QUACK_PORT = Number(process.env.QUACK_PORT ?? 9500);
// Cloud Run injects $PORT as the single ingress port (TLS terminated at the edge, plaintext
// HTTP forwarded here). External agents dial in with `ATTACH 'quack:<service-host>:443'`; the
// edge routes to this forwarder, which proxies the quack wire protocol byte-for-byte to the
// loopback quack_serve listener. Honor $PORT first; FORWARDER_PORT/8080 stay as local defaults.
const FWD_PORT = Number(process.env.PORT ?? process.env.FORWARDER_PORT ?? 8080);
const STATE_DIR = process.env.GW_STATE_DIR ?? "/var/lib/waddling";
const BIRDSHOT_EXT =
  process.env.BIRDSHOT_EXTENSION_PATH ?? "/opt/birdshot/birdshot.duckdb_extension";

// Hop-by-hop headers Node sets itself; never forward across the proxy hop.
const HOP_BY_HOP = new Set([
  "host", "connection", "content-length", "transfer-encoding",
  "keep-alive", "upgrade", "proxy-connection", "te", "trailer",
]);

const log = (...a) => console.log("[gw-entry]", ...a);

/** Single-quote escape for inlining a bound value into a DuckDB SQL literal (typed
 *  memory ops only — see /ctrl/qb-remember). */
const qlit = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// Strip the lake ATTACH-alias catalog qualifier from 3-part refs so Form-B relay SQL
// runs against the remote gateway's served tables without the workspace client-side alias
// prefix. Rewrites `lake.<schema>.<table>` → `<schema>.<table>` (global, all occurrences);
// leaves 2-part refs and the word "lake" elsewhere untouched.
const stripLakeCatalog = (sql) =>
  sql.replace(/\blake\s*\.\s*(?=("?[A-Za-z_]\w*"?)\s*\.\s*("?[A-Za-z_]\w*"?))/gi, "");

async function main() {
  // Wall-clock from process start (this module's first line runs at import; main() is called
  // immediately after) to the forwarder accepting connections — the in-container boot cost,
  // surfaced in healthz as `bootMs` so a benchmark can decompose total cold boot into
  // container/node provisioning (DO-observed waited − bootMs) vs DuckDB boot (bootMs).
  const bootStartedAt = Date.now();
  let bootMs = 0; // frozen when the forwarder starts listening (see server.listen below)
  const dataDir = resolve(STATE_DIR, "data");
  mkdirSync(dataDir, { recursive: true });

  // Materialize the shared Cloud SQL mTLS material (client cert/key + server CA) from the
  // injected PEM secrets to files, so DuckDB's postgres extension can present them on the
  // catalog ATTACH (Cloud SQL requires a client cert and a non-system-trusted server CA →
  // sslmode=verify-ca + explicit sslrootcert). One shared cert per deployment. No-op when the
  // *_PEM env vars are absent (local-file / demo / selftest / quackboard paths).
  let catalogSslCert = process.env.DUCKLAKE_CATALOG_SSLCERT ?? "";
  let catalogSslKey = process.env.DUCKLAKE_CATALOG_SSLKEY ?? "";
  let catalogSslRootCert = process.env.DUCKLAKE_CATALOG_SSLROOTCERT ?? "";
  // PEMs arrive base64-encoded (GW_PG_SSL*_PEM_B64): the startProcess env channel indents
  // continuation lines of a multi-line value, which corrupts a raw PEM ("bad end line").
  // A single-line base64 value is immune; decode it here. Fall back to the raw *_PEM names
  // for any caller that still injects them directly (local/file paths).
  const pemFromEnv = (name) => {
    const b64 = process.env[`${name}_B64`];
    if (b64) return Buffer.from(b64, "base64").toString("utf8");
    return process.env[name] || "";
  };
  const certPem = pemFromEnv("GW_PG_SSLCERT_PEM");
  const keyPem = pemFromEnv("GW_PG_SSLKEY_PEM");
  const rootPem = pemFromEnv("GW_PG_SSLROOTCERT_PEM");
  if (certPem || keyPem || rootPem) {
    const sslDir = resolve(STATE_DIR, "cloudsql");
    mkdirSync(sslDir, { recursive: true });
    const writePem = (pem, name, mode) => {
      const p = resolve(sslDir, name);
      writeFileSync(p, pem, { mode });
      return p;
    };
    if (certPem) catalogSslCert = writePem(certPem, "client-cert.pem", 0o600);
    if (keyPem) catalogSslKey = writePem(keyPem, "client-key.pem", 0o600);
    if (rootPem) catalogSslRootCert = writePem(rootPem, "server-ca.pem", 0o644);
  }

  // Boot config is injected as per-process env by the GatewayDO at startProcess. Two modes:
  //   • REAL lake — the per-org Postgres catalog (DUCKLAKE_CATALOG_DSN) scoped to this
  //     endpoint's own METADATA_SCHEMA, with s3:// data (DUCKLAKE_DATA_PATH + S3_* creds).
  //     This is the production path: agent SQL hits real lake tables, gated by birdshot.
  //   • SELFTEST/demo — no real catalog configured (or GW_SELFTEST_SEED=1): a local-file
  //     DuckLake + local data dir, plus a seeded memory.main demo lake. Deterministic and
  //     OFFLINE so the data plane /selftest stays a regression guard, not a live-infra test.
  // Quackboard: serve a durable .duckdb file directly (no lake, no demo seed). birdshot still
  // boots + enforces; bootDuckRuntime bootstraps the schema on the control connection. Must
  // NOT seed the demo lake (that would create memory.main.orders and leave the default catalog
  // as :memory: with no observations table → birdshot bind_error).
  const quackboard = /^(1|true|yes|on)$/i.test(process.env.QUACKBOARD ?? "");
  // Workspace mode: open a durable .duckdb at DUCKDB_DATABASE_PATH, serve via quack+birdshot,
  // but bootstrap EMPTY schema (agent DDL creates its own tables). GCS provides persistence.
  // Mutually exclusive with quackboard; quackboard takes precedence if both are set.
  const workspaceMode = !quackboard && /^(1|true|yes|on)$/i.test(process.env.WORKSPACE_MODE ?? "");
  const seedDemo =
    !quackboard && !workspaceMode &&
    (process.env.GW_SELFTEST_SEED === "1" ||
      (!process.env.DUCKLAKE_CATALOG_DSN && !/^s3:\/\//i.test(process.env.DUCKLAKE_DATA_PATH ?? "")));

  const localDataDir = dataDir.endsWith("/") ? dataDir : `${dataDir}/`;
  const ducklakeDataPath = process.env.DUCKLAKE_DATA_PATH || localDataDir;

  const config = {
    birdshotExtensionPath: BIRDSHOT_EXT,
    quackPort: QUACK_PORT,
    serverToken: process.env.GW_SERVER_TOKEN ?? "gw-probe-server-token",
    ctrlPort: 0, // unused; the forwarder below IS the control surface
    // postgres catalog (real) vs local-file catalog (demo). seedDemo ⇒ a local file.
    ducklakeCatalogDsn: process.env.DUCKLAKE_CATALOG_DSN ?? "",
    ducklakeCatalogFile: seedDemo
      ? process.env.DUCKLAKE_CATALOG_FILE || resolve(STATE_DIR, "lake.ducklake")
      : process.env.DUCKLAKE_CATALOG_FILE ?? "",
    ducklakeDataPath,
    localData: !/^s3:\/\//i.test(ducklakeDataPath),
    lakeAlias: process.env.DUCKLAKE_ALIAS || "lake",
    // Per-endpoint isolation inside a shared org catalog (ignored for a local-file catalog).
    metadataSchema: process.env.DUCKLAKE_METADATA_SCHEMA ?? "",
    encrypted: /^(1|true|yes|on)$/i.test(process.env.DUCKLAKE_ENCRYPTED ?? ""),
    // mTLS material for the postgres catalog (Cloud SQL); empty for local-file/demo catalogs.
    catalogSslCert,
    catalogSslKey,
    catalogSslRootCert,
    s3: {
      endpoint: process.env.S3_ENDPOINT ?? "",
      keyId: process.env.S3_KEY_ID ?? "",
      secret: process.env.S3_SECRET ?? "",
      sessionToken: process.env.S3_SESSION_TOKEN ?? "",
      region: process.env.S3_REGION || "auto",
      useSsl: /^(1|true|yes|on)$/i.test(process.env.S3_USE_SSL ?? ""),
      urlStyle: process.env.S3_URL_STYLE === "vhost" ? "vhost" : "path",
    },
    // No-lake modes: open the durable .duckdb file directly (quackboard or workspace).
    // quackboard bootstraps coordination schema; workspace boots with empty schema.
    quackboard,
    workspaceMode,
    databasePath: process.env.DUCKDB_DATABASE_PATH || ":memory:",
  };

  const catalogDesc = config.ducklakeCatalogFile
    ? `file:${config.ducklakeCatalogFile}`
    : `postgres(schema=${config.metadataSchema || "main"})`;
  log(`booting gateway: quack:${QUACK_PORT}, mode=${quackboard ? `quackboard(db=${config.databasePath})` : workspaceMode ? `workspace(db=${config.databasePath})` : seedDemo ? "selftest-demo" : "real-lake"}, catalog=${catalogDesc}, dataPath=${config.ducklakeDataPath}`);
  // ── Workspace GCS restore (workspace mode only, before DuckDB opens the file) ──────────
  // Download the durable .duckdb from GCS so DuckDB opens an already-populated file.
  // On first boot (404) we skip the download and let DuckDB create a fresh empty database.
  // Any other GCS error surfaces loudly here (mis-config/IAM) rather than silently starting
  // with an empty database and losing the workspace. The SA (gateway-run@...) must have
  // storage.objectAdmin on the workspace bucket — provisioned in provision.sh.
  const wsBucket = process.env.WORKSPACE_GCS_BUCKET ?? "";
  const wsObject = process.env.WORKSPACE_GCS_OBJECT ?? "";
  if (workspaceMode && wsBucket && wsObject && config.databasePath !== ":memory:") {
    mkdirSync(dirname(resolve(config.databasePath)), { recursive: true });
    const found = await gcsDownload(wsBucket, wsObject, config.databasePath);
    log(found
      ? `workspace restored from gs://${wsBucket}/${wsObject}`
      : `workspace not found in GCS (${wsObject}) — starting fresh`);
  }

  const rt = await bootDuckRuntime(config);
  log("gateway booted — quack_serve up, birdshot hooks installed pre-serve");

  // ── Cold-boot snapshot arming (folds the /ctrl/snapshot round-trip into boot) ──────
  // The director (GatewayPoolDO.doArm) normally pushes the birdshot ACL snapshot over a
  // SEPARATE /ctrl/snapshot call AFTER healthz goes green — one extra container round-trip
  // on every cold boot. When it instead hands us the cached snapshot via GW_BOOT_SNAPSHOT
  // (base64 JSON {snapshot, auth, lakeCatalog}), we apply it HERE, before the forwarder
  // accepts traffic, so the replica is already armed when healthz first answers. healthz
  // reports the applied version so the director can skip its redundant push. Fail-safe is
  // preserved (armed before serving); if this fails we fall back to the director's push.
  // lastSnapshot is declared here (not in the forwarder block) so /ctrl/reapply can recover
  // a hot replica from the boot-applied policy too.
  let lastSnapshot = null;
  let bootSnapshotVersion = 0;

  // ── Workspace lake relay state (workspace mode only) ─────────────────────────
  // Cached from /ctrl/configure-lake so /relay-query Form-B can ship the whole
  // statement to the lake server-side via quack_query.
  let wsLakeProxy = null;
  let wsLakeToken = null;
  let wsLakeDisableSsl = false;
  let wsLakeAttached = false;
  if (process.env.GW_BOOT_SNAPSHOT) {
    try {
      const parsed = JSON.parse(Buffer.from(process.env.GW_BOOT_SNAPSHOT, "base64").toString("utf8"));
      const prevAlias = rt.config.lakeAlias;
      if (parsed.lakeCatalog) rt.config.lakeAlias = parsed.lakeCatalog;
      try {
        await applySnapshot(rt, parsed.snapshot, parsed.auth);
      } finally {
        rt.config.lakeAlias = prevAlias;
      }
      lastSnapshot = { snapshot: parsed.snapshot, auth: parsed.auth, lakeCatalog: parsed.lakeCatalog };
      bootSnapshotVersion = Number(process.env.GW_BOOT_SNAPSHOT_VERSION || 0);
      log(`boot-armed birdshot snapshot v${bootSnapshotVersion} (${parsed.snapshot?.roleGrants?.length ?? 0} grants) — no /ctrl/snapshot round-trip needed`);
    } catch (e) {
      log(`boot snapshot apply failed (director will push via /ctrl/snapshot): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (seedDemo) {
    // ── Seed the minimal demo lake AFTER boot (trusted control connection) ────────
    // Seed in memory.main — the PROVEN federation placement (birdshot.e2e.ts:147-164
    // + the Rivet PoC seedDemo). quack serves a federated scan on a connection that
    // defaults to memory.main, so the bare table ref quack pushes down MUST be
    // resolvable unqualified there. (Seeding in the ducklake fails: birdshot allows
    // the scan but quack's serving connection can't resolve bare `orders` against the
    // lake catalog → "Table orders does not exist".) The matching birdshot lake
    // catalog is therefore 'memory' (set on the snapshot push below), and the grant
    // is `main.orders`. orders -> ALLOWED; secrets -> FORBIDDEN (no grant).
    await rt.run("CREATE TABLE IF NOT EXISTS memory.main.orders  (id INTEGER, total INTEGER)");
    await rt.run("CREATE TABLE IF NOT EXISTS memory.main.secrets (id INTEGER, ssn VARCHAR)");
    await rt.run("DELETE FROM memory.main.orders");
    await rt.run("DELETE FROM memory.main.secrets");
    await rt.run("INSERT INTO memory.main.orders  VALUES (1,100),(2,250),(3,9000)");
    await rt.run("INSERT INTO memory.main.secrets VALUES (1,'111-22-3333'),(2,'444-55-6666')");
    log("seeded memory.main.orders (allowed) + memory.main.secrets (forbidden)");
  }

  // ── In-container quack CLIENT (lazy — cold-boot optimization) ────────────────
  // workerd has no DuckDB, so the agent's quack client CANNOT live in the Worker.
  // It lives here: a SECOND DuckDBInstance that ATTACHes to the loopback quack
  // listener presenting the session JWT as the TOKEN, exactly as a real agent's
  // DuckDB would (mirrors birdshot.e2e.ts Bucket 2a). The gated traffic is loopback
  // INSIDE the container; the DO drives it over containerFetch → /query (JSON in,
  // JSON rows out). This proves the gateway DO serves GATED quack — it does NOT
  // claim raw quack wire survives the containerFetch hop (out of scope, Stage D+).
  //
  // Created LAZILY on first /query: real agent traffic rides the catch-all quack proxy
  // below, not /query, so most boots never touch this. Building it eagerly cost every
  // cold boot a second DuckDBInstance + INSTALL/LOAD quack for nothing.
  let client = null;
  // One ATTACH per session token; cache so repeated /query calls reuse the session.
  const attachedTokens = new Set();
  async function ensureClient() {
    if (client) return client;
    const clientInst = await DuckDBInstance.create(":memory:");
    client = await clientInst.connect();
    await client.run("INSTALL quack; LOAD quack");
    return client;
  }

  // FTS recall (quackboard): the BM25 index is rebuilt lazily — only when the observations
  // table has grown since the last build — so recall never pays an O(N) rebuild per write
  // (plan req 3) and reads stay fresh within one observe→recall hop. -1 forces a rebuild on
  // the first recall after a (cold) boot, folding in any observes since bootstrap.
  let lastFtsCount = -1;
  async function attach(token) {
    const c = await ensureClient();
    if (attachedTokens.has(token)) return;
    // birdshot_authenticate verifies the JWT (RS256) against server_token + JWKS at
    // ATTACH; a bad token throws here. DISABLE_SSL: loopback plaintext quack.
    await c.run(
      `ATTACH 'quack:localhost:${QUACK_PORT}' AS lake (TOKEN '${token.replace(/'/g, "''")}', DISABLE_SSL true)`,
    );
    attachedTokens.add(token);
  }

  /** Drain birdshot's audit log and return the LAST authorize decision (allow/deny). */
  async function lastAuthorizeDecision() {
    const reader = await rt.connection.runAndReadAll("SELECT birdshot_log_drain(10000) AS blob");
    const blob = reader.getRowObjects()[0]?.blob ?? "";
    let last = null;
    for (const line of String(blob).split("\n")) {
      if (!line) continue;
      const cols = line.split("\t");
      // ts \t event \t sid \t user \t decision \t reasonB64 \t queryB64
      const event = cols[1];
      const decision = cols[4];
      if (event === "authorize") last = decision;
    }
    return last;
  }

  // ── Forwarder + control channel on :8080 ─────────────────────────────────────
  // `lastSnapshot` (declared above, before the boot-snapshot arming) caches the last
  // successfully-applied snapshot (+ auth + lakeCatalog) so /ctrl/reapply can re-run
  // applySnapshot WITHOUT a control-plane round trip. It is seeded by the boot-snapshot
  // arming when GW_BOOT_SNAPSHOT is present, and refreshed by every /ctrl/snapshot push.
  // Used to recover a hot replica whose in-memory birdshot policy got corrupted.
  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      const reason = err instanceof Error ? err.message : String(err);
      log(`forwarder ${req.method} ${req.url} → 500: ${reason}`);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "forwarder_error", reason }));
    });
  });

  async function handle(req, res) {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    const path = url.split("?")[0];

    // Liveness — the DO polls this until quack is reachable. `snapshotVersion` reports the
    // birdshot policy version this replica armed itself with at boot (0 if none): the director
    // reads it to skip a redundant /ctrl/snapshot push when the boot already applied the
    // current snapshot (see GatewayPoolDO.doArm).
    if (method === "GET" && path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, quackPort: QUACK_PORT, snapshotVersion: bootSnapshotVersion, bootMs }));
      return;
    }

    // ── Control channel (in-process birdshot, trusted connection) ──────────────
    if (path === "/ctrl/snapshot" && method === "POST") {
      const body = await readJson(req);
      if (!body.snapshot) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing snapshot" }));
        return;
      }
      // applySnapshot wires birdshot_set_auth(...,'rs256') + birdshot_add_jwk for
      // each JWK when `auth` is present → birdshot runs in PRODUCTION RS256 mode.
      // applySnapshot calls birdshot_set_lake_catalog(rt.config.lakeAlias) so the
      // authz bind-walk resolves agent refs against the right catalog. Here the
      // seeded tables live in `memory` (not the ducklake alias), so the caller
      // passes lakeCatalog:'memory'; temporarily override config.lakeAlias for the
      // push so applySnapshot stages the correct catalog, then restore it.
      const prevAlias = rt.config.lakeAlias;
      if (body.lakeCatalog) rt.config.lakeAlias = body.lakeCatalog;
      try {
        await applySnapshot(rt, body.snapshot, body.auth);
      } finally {
        rt.config.lakeAlias = prevAlias;
      }
      // Cache for /ctrl/reapply (restore the alias override the re-apply needs).
      lastSnapshot = { snapshot: body.snapshot, auth: body.auth, lakeCatalog: body.lakeCatalog };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, grants: body.snapshot.roleGrants.length }));
      return;
    }

    // Re-apply the last successfully-applied snapshot verbatim (no control-plane
    // round trip). Recovers a hot replica whose in-memory birdshot policy got
    // corrupted (applySnapshot is a full reset→set→commit, so this is idempotent).
    // 409 when the container has never received a snapshot (cold boot) — push one
    // via /ctrl/snapshot first. `force` (default true) re-applies even if
    // birdshot_status reports a loaded policy; set false to skip when loaded.
    if (path === "/ctrl/reapply" && method === "POST") {
      if (!lastSnapshot) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no_cached_snapshot", reason: "this container has never received a snapshot — push one via /ctrl/snapshot first" }));
        return;
      }
      const body = await readJson(req).catch(() => ({}));
      const force = body.force !== false;
      if (!force) {
        const st = await birdshotStatus(rt);
        const policySize = Number(st?.policySize ?? 0);
        if (policySize > 0) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, reapplied: false, reason: "policy already loaded (force=false)" }));
          return;
        }
      }
      const prevAlias = rt.config.lakeAlias;
      if (lastSnapshot.lakeCatalog) rt.config.lakeAlias = lastSnapshot.lakeCatalog;
      try {
        await applySnapshot(rt, lastSnapshot.snapshot, lastSnapshot.auth);
      } finally {
        rt.config.lakeAlias = prevAlias;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, reapplied: true, grants: lastSnapshot.snapshot.roleGrants.length }));
      return;
    }

    // birdshot_revoke → in-memory, forward-only denylist (kind ∈ user|jti|session).
    // The next query for that subject is denied. Runs on the trusted control
    // connection. expiresUs (µs-from-now) optional; 0/undefined ⇒ forever. The
    // denylist is in-memory, so a cold gateway has nothing to revoke (the dataplane
    // side no-ops in that case).
    if (path === "/ctrl/revoke" && method === "POST") {
      const body = await readJson(req);
      const { kind, id, reason, expiresUs } = body;
      if (!kind || !id) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing kind/id" }));
        return;
      }
      await birdshotRevoke(rt, kind, id, reason ?? "", expiresUs);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, kind, id }));
      return;
    }

    // Fold the WAL into the main .duckdb file on the trusted control connection (un-gated),
    // then in workspace mode upload the flushed file to GCS for cross-restart durability.
    // A no-op CHECKPOINT on a lake gateway (:memory:) is harmless.
    if (path === "/ctrl/checkpoint" && method === "POST") {
      await rt.run("CHECKPOINT");
      if (workspaceMode && wsBucket && wsObject && config.databasePath !== ":memory:") {
        try {
          await gcsUpload(wsBucket, wsObject, config.databasePath);
        } catch (uploadErr) {
          const reason = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
          log(`GCS upload failed after CHECKPOINT: ${reason}`);
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "gcs_upload_failed", reason }));
          return;
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── Private per-agent memory (TRUSTED, narrow-typed — NOT a SQL passthrough) ──
    // agent_memory carries NO birdshot grant, so the gated quack path (raw qb_query)
    // can never reach it. These two endpoints are the ONLY way in, and they run FIXED
    // SQL on the trusted control connection with the parameters bound — `agentRole` is
    // always supplied by the control plane from the authenticated caller, never by the
    // agent. This is the proxy-layer row-scoping the ACL model calls for, kept as two
    // typed verbs rather than an arbitrary-SQL endpoint (which would re-create the
    // retired /gw/query trusted-connection bypass).
    if (path === "/ctrl/qb-remember" && method === "POST") {
      const { agentRole, key, content } = await readJson(req);
      if (!agentRole || content === undefined || content === null) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing agentRole/content" }));
        return;
      }
      await rt.run(
        `INSERT INTO agent_memory(agent_role, key, content) VALUES (${qlit(agentRole)}, ${key ? qlit(key) : "NULL"}, ${qlit(content)})`,
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (path === "/ctrl/qb-mine" && method === "POST") {
      const { agentRole, key, limit } = await readJson(req);
      if (!agentRole) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing agentRole" }));
        return;
      }
      const cap = Math.min(Math.max(Number(limit) || 50, 1), 500);
      const where = `agent_role = ${qlit(agentRole)}` + (key ? ` AND key = ${qlit(key)}` : "");
      const reader = await rt.connection.runAndReadAll(
        `SELECT key, content, ts FROM agent_memory WHERE ${where} ORDER BY ts DESC LIMIT ${cap}`,
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, rows: normalize(reader.getRowObjects()) }));
      return;
    }

    // Shared-corpus BM25 recall (TRUSTED — observations is RW to every org agent, so ranked
    // recall over it adds no per-agent governance; running it on the control connection avoids
    // birdshot's bind-walk choking on the fts_main_observations.* internal tables the match_bm25
    // macro expands to). Rebuilds the index only when the corpus changed since the last recall.
    if (path === "/ctrl/qb-recall" && method === "POST") {
      const { term, limit } = await readJson(req);
      if (!term) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing term" }));
        return;
      }
      const cap = Math.min(Math.max(Number(limit) || 20, 1), 100);
      const cntReader = await rt.connection.runAndReadAll("SELECT count(*) AS n FROM observations");
      const cnt = Number(cntReader.getRowObjects()[0]?.n ?? 0);
      if (cnt !== lastFtsCount) {
        await rt.run("PRAGMA create_fts_index('observations', 'id', 'content', stemmer = 'porter', overwrite = 1)");
        lastFtsCount = cnt;
      }
      const reader = await rt.connection.runAndReadAll(
        `SELECT agent_role, content, topic, ts, score FROM (
           SELECT *, fts_main_observations.match_bm25(id, ${qlit(term)}) AS score FROM observations
         ) sq WHERE score IS NOT NULL ORDER BY score DESC LIMIT ${cap}`,
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, rows: normalize(reader.getRowObjects()) }));
      return;
    }

    if (path === "/ctrl/status" && method === "GET") {
      // birdshot_status() returns a SPACE-delimited "key=value ..." string (NOT
      // JSON — see StatusSummary in birdshot_extension.cpp), so duck.ts's
      // birdshotStatus falls back to { raw }. Parse `mode=` out of the raw line so
      // the DO can assert production RS256 mode without re-implementing the parse.
      const status = await birdshotStatus(rt);
      const raw = typeof status?.raw === "string" ? status.raw : "";
      const fields = {};
      for (const tok of raw.split(/\s+/)) {
        const eq = tok.indexOf("=");
        if (eq > 0) fields[tok.slice(0, eq)] = tok.slice(eq + 1);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ birdshot: { ...fields, raw } }));
      return;
    }

    // ── Full lake catalog (trusted connection, UNFILTERED by grants) ───────────
    // Admin-facing: powers the control-plane ACL authoring picker (real schemas/
    // tables/columns the owner may grant). Distinct from the agent-facing
    // grant-scoped `describe`. Scoped to the lake catalog (database_name = the
    // ATTACH alias) so the demo `memory.main` tables and system schemas never leak
    // in as if they were the datalake's catalog. Names + types ONLY — never rows.
    if (path === "/ctrl/catalog" && method === "GET") {
      // Return the lake's real DATA tables only. Three exclusions:
      //  - demo/system catalogs (memory/system/temp) — keeps the demo `memory.main`
      //    orders/secrets + read-through views out of the admin picker. We exclude by
      //    catalog name rather than filter to `= lakeAlias` because a DuckLake ATTACH
      //    may report its catalog under its own name, not the alias (describeTables in
      //    duck.ts carries the same warning) — so `= alias` could drop the real lake.
      //  - information_schema/pg_catalog — engine internals.
      //  - `ducklake_*` tables — DuckLake's own catalog bookkeeping (column/snapshot/
      //    data_file/…), which live in the metadata schema (`dl_<slug>`) and are NOT
      //    user data. DuckLake reserves the `ducklake_` prefix, so this is safe; the
      //    metadata schema then has zero rows and never appears in the picker.
      const reader = await rt.connection.runAndReadAll(
        `SELECT schema_name, table_name, column_name, data_type, is_nullable
           FROM duckdb_columns()
          WHERE database_name NOT IN ('memory', 'system', 'temp')
            AND schema_name NOT IN ('information_schema', 'pg_catalog')
            AND table_name NOT LIKE 'ducklake_%'
          ORDER BY schema_name, table_name, column_index`,
      );
      const rows = normalize(reader.getRowObjects());
      // group rows → { schemas: [{ name, tables: [{ name, columns: [{name,type,nullable}] }] }] }
      const schemaMap = new Map();
      for (const r of rows) {
        const sName = String(r.schema_name);
        const tName = String(r.table_name);
        let sch = schemaMap.get(sName);
        if (!sch) { sch = { name: sName, tables: new Map() }; schemaMap.set(sName, sch); }
        let tbl = sch.tables.get(tName);
        if (!tbl) { tbl = { name: tName, columns: [] }; sch.tables.set(tName, tbl); }
        const nul = r.is_nullable;
        tbl.columns.push({
          name: String(r.column_name),
          type: String(r.data_type),
          nullable: nul === true || String(nul).toLowerCase() === "true" || String(nul).toUpperCase() === "YES",
        });
      }
      const schemas = [...schemaMap.values()].map((s) => ({ name: s.name, tables: [...s.tables.values()] }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ schemas }));
      return;
    }

    // ── Audit drain (trusted connection) ───────────────────────────────────────
    // birdshot's audit log is process-GLOBAL (State::Get() is a singleton; the
    // Authorize hook on the quack serving connection appends to the same deque this
    // trusted connection drains). So this returns the authorize/authenticate records
    // for queries that came in over the quack/workspace path — the ones the dashboard
    // needs. DESTRUCTIVE: each record is returned exactly once. Free-text fields are
    // base64url in the blob (sid/user/reason/query); decode to clean JSON here.
    if (path === "/ctrl/audit-drain" && method === "POST") {
      const dec = (s) => {
        try { return Buffer.from(String(s), "base64url").toString("utf8"); } catch { return ""; }
      };
      const CAP = 10000;
      const reader = await rt.connection.runAndReadAll(`SELECT birdshot_log_drain(${CAP}) AS blob`);
      const blob = String(reader.getRowObjects()[0]?.blob ?? "");
      const records = [];
      for (const line of blob.split("\n")) {
        if (!line) continue;
        // ts_us \t event \t sidB64 \t userB64 \t decision \t reasonB64 \t queryB64
        const c = line.split("\t");
        records.push({
          tsUs: Number(c[0]) || 0,
          event: c[1] ?? "",
          sid: dec(c[2]),
          user: dec(c[3]),
          decision: c[4] ?? "",
          reason: dec(c[5]),
          query: dec(c[6]),
        });
      }
      // The drain is capped; a full batch means more may be pending (next drain gets
      // them) OR the buffer overflowed and oldest records were dropped — flag it.
      if (records.length >= CAP) log(`audit-drain hit cap ${CAP} — possible buffer overflow / backlog`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ records, count: records.length }));
      return;
    }

    // ── Workspace lake relay: configure lake ATTACH (workspace mode only) ──────
    // Runs ATTACH 'quack:<lakeProxy>' AS lake on the trusted control connection so the
    // relay can address lake.main.* tables from rt.connection. Caches lakeProxy + lakeToken
    // in module state for Form-B fallback in /relay-query. Re-attaching: DETACH lake first.
    if (workspaceMode && path === "/ctrl/configure-lake" && method === "POST") {
      const body = await readJson(req);
      const { lakeProxy, lakeToken, disableSsl } = body;
      if (!lakeProxy || !lakeToken) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing lakeProxy or lakeToken" }));
        return;
      }
      if (wsLakeAttached) {
        try {
          await rt.run(`USE "${String(config.lakeAlias).replace(/"/g, '""')}"; DETACH lake`);
        } catch { /* not attached — safe to ignore */ }
        wsLakeAttached = false;
      }
      await rt.run(
        `ATTACH 'quack:${lakeProxy}' AS lake (TOKEN ${qlit(lakeToken)}${disableSsl ? ", DISABLE_SSL true" : ""})`,
      );
      wsLakeProxy = lakeProxy;
      wsLakeToken = lakeToken;
      wsLakeDisableSsl = !!disableSsl;
      wsLakeAttached = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, lakeProxy }));
      return;
    }

    // ── Data load (trusted connection): index HN stories into the real lake ─────
    // Runs on rt.connection (which ATTACHed the lake with the S3 secret), so the parquet
    // lands in the lake's DATA_PATH (R2). NOT an agent path — this is the trusted loader
    // that seeds lake content; agents only READ it through the birdshot-gated quack path.
    if (path === "/ctrl/load-hn" && method === "POST") {
      const body = await readJson(req);
      const days = Number(body.days ?? 30);
      const limit = Math.min(Number(body.limit ?? 1000), 1000);
      const sinceTs = Math.floor(Date.now() / 1000) - days * 86400;
      // HN Algolia /search ranks by popularity (points) — "top" stories. One page, ≤1000.
      const url = `https://hn.algolia.com/api/v1/search?tags=story&numericFilters=created_at_i>${sinceTs}&hitsPerPage=${limit}`;
      const hnRes = await fetch(url);
      if (!hnRes.ok) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "hn_fetch_failed", status: hnRes.status }));
        return;
      }
      const hn = await hnRes.json();
      const hits = Array.isArray(hn.hits) ? hn.hits : [];
      writeFileSync("/tmp/hn.json", JSON.stringify(hits));
      const alias = config.lakeAlias;
      // CREATE OR REPLACE in the lake's `main` schema → parquet written to DATA_PATH (R2).
      await rt.run(
        `CREATE OR REPLACE TABLE ${alias}.main.hn_posts AS
           SELECT CAST(objectID AS BIGINT) AS id, title, url, author,
                  CAST(points AS INTEGER) AS points, CAST(num_comments AS INTEGER) AS num_comments,
                  to_timestamp(created_at_i) AS created_at
             FROM read_json('/tmp/hn.json', maximum_object_size=104857600)
            WHERE title IS NOT NULL`,
      );
      // Expose it for quack serving: a read-through view in memory.main (quack serves only
      // the server's default catalog). The data stays in the lake (R2).
      await rt.run(`CREATE OR REPLACE VIEW memory.main.hn_posts AS SELECT * FROM ${alias}.main.hn_posts`);
      const countReader = await rt.connection.runAndReadAll(`SELECT count(*) AS n FROM ${alias}.main.hn_posts`);
      const count = Number(countReader.getRowObjects()[0]?.n ?? 0);
      log(`loaded ${count} HN posts into ${alias}.main.hn_posts (last ${days}d)`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, count, fetched: hits.length, days }));
      return;
    }

    // ── Gated agent query path: ATTACH(token) → run SQL → drain decision ────────
    // The DO POSTs {token, sql}; the in-container quack client runs it against the
    // birdshot-gated loopback listener. A DENY surfaces as the client THROWING
    // (birdshot.e2e.ts:250-253) — there is no "denied" string on the wire — so we
    // additionally drain birdshot's audit log and return the authorize decision so
    // the caller can tell an authz deny apart from a parse/typo error.
    if (path === "/query" && method === "POST") {
      const body = await readJson(req);
      const { token, sql } = body;
      if (!token || !sql) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing token/sql" }));
        return;
      }
      let attachError = null;
      try {
        await attach(token);
      } catch (e) {
        attachError = e instanceof Error ? e.message : String(e);
      }
      if (attachError) {
        // Authentication failure (bad/garbage token) — never reaches authz.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, phase: "authenticate", error: attachError }));
        return;
      }
      let rows = null;
      let queryError = null;
      try {
        const reader = await client.runAndReadAll(sql);
        rows = normalize(reader.getRowObjects());
      } catch (e) {
        queryError = e instanceof Error ? e.message : String(e);
      }
      const decision = await lastAuthorizeDecision();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: queryError === null,
        rows,
        rowCount: Array.isArray(rows) ? rows.length : null,
        error: queryError,
        // birdshot's own verdict for the LAST authorize event — the authoritative
        // signal. "deny" + a thrown query = a genuine authorization denial.
        authorizeDecision: decision,
      }));
      return;
    }

    // ── Governed ETL: authorize on the same hook quack uses, then execute on the
    //    TRUSTED connection that owns the lake (so the write PERSISTS to DuckLake).
    //
    // The gated quack path serves only the `memory` catalog (read-through views), so a
    // CTAS through it cannot persist a LAKE write. But authorization and durable
    // execution are separable: `birdshot_authorize` is the literal production authz
    // function (duck.ts SET quack_authorization_function), and the trusted control
    // connection already persists to the lake (proven by /ctrl/load-hn). So:
    //   1. authenticate the agent JWT into a PRIVATE session on rt.connection,
    //   2. authorize the EXACT sql with birdshot_authorize(sid, sql) — denies happen
    //      from the PARSE LITERAL, before any read_source fetch (no SSRF window),
    //   3. only on allow, run the byte-identical string on rt.connection. Same
    //      connection ⇒ authz catalog context ≡ execution catalog context (USE lake +
    //      birdshot_set_lake_catalog both resolve bare `main.x` into the lake).
    // Single-statement is enforced pre-authz AND by birdshot, so the authorized string
    // is exactly the executed string.
    if (path === "/governed-load" && method === "POST") {
      const body = await readJson(req);
      const { token, sql } = body;
      if (!token || !sql) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing token/sql" }));
        return;
      }
      const reply = (status, obj) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (!isSingleStatement(sql)) {
        reply(200, { ok: false, phase: "reject", error: "only a single SQL statement is allowed" });
        return;
      }
      const sid = `etl-${++etlSeq}`;
      const lit = (s) => String(s).replace(/'/g, "''");
      // 1. Authenticate the JWT (RS256 vs the snapshot's JWKS) into session `sid`.
      let authed = false;
      try {
        const r = await rt.connection.runAndReadAll(`SELECT birdshot_authenticate('${sid}', '${lit(token)}', '') AS ok`);
        authed = r.getRowObjects()[0]?.ok === true;
      } catch (e) {
        reply(200, { ok: false, phase: "authenticate", error: e instanceof Error ? e.message : String(e) });
        return;
      }
      if (!authed) {
        reply(200, { ok: false, phase: "authenticate", error: "token rejected" });
        return;
      }
      // 2. Authorize the exact statement. DENY ⇒ stop here — nothing executes, no fetch.
      let allowed = false;
      try {
        const r = await rt.connection.runAndReadAll(`SELECT birdshot_authorize('${sid}', '${lit(sql)}') AS ok`);
        allowed = r.getRowObjects()[0]?.ok === true;
      } catch (e) {
        reply(200, { ok: false, phase: "authorize", error: e instanceof Error ? e.message : String(e) });
        return;
      }
      if (!allowed) {
        reply(200, { ok: false, phase: "authorize", authorizeDecision: "deny", error: "not authorized for this statement" });
        return;
      }
      // 3. Execute the byte-identical string on the trusted connection (owns the lake
      //    attach + S3 secret + egress). Bare `main.x` → lake via `USE lake`.
      let execError = null;
      try {
        await rt.run(sql);
      } catch (e) {
        execError = e instanceof Error ? e.message : String(e);
      }
      if (execError) {
        reply(200, { ok: false, phase: "execute", authorizeDecision: "allow", error: execError });
        return;
      }
      // 4. Refresh read-through views so any newly-created lake table is queryable
      //    through the gated quack path immediately.
      try { await restoreLakeViews(rt.connection, rt.config.lakeAlias); } catch { /* best-effort */ }
      reply(200, { ok: true, phase: "done", authorizeDecision: "allow" });
      return;
    }

    // ── Workspace lake relay query (workspace mode only) ─────────────────────
    // Form A: run the SQL on rt.connection (which has `lake` attached from configure-lake)
    // so the workspace can scan lake.main.* tables directly. Falls back to Form B
    // (quack_query pushing the whole statement to the lake server-side) when:
    //   - "Multiple streaming scans" → JOIN across two lake tables that Form A cannot carry.
    //   - Catalog "does not exist" + `lake` in the SQL → stale client catalog for a table
    //     created after the current ATTACH.
    // /relay-query MUST run on rt.connection (trusted) — quack_serve serves only the workspace
    // catalog and cannot address the attached `lake` catalog.
    if (workspaceMode && path === "/relay-query" && method === "POST") {
      const body = await readJson(req);
      const sql = String(body.sql ?? "");
      if (!sql) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing sql" }));
        return;
      }
      if (!wsLakeProxy || !wsLakeToken) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "lake not configured — POST /ctrl/configure-lake first" }));
        return;
      }
      const runRelayReader = async (s) => {
        const reader = await rt.connection.runAndReadAll(s);
        const columns = reader.columnNames();
        const objs = reader.getRowObjects();
        const rows = objs.map((o) => columns.map((cn) => normalize(o[cn])));
        return { columns, rows, rowCount: rows.length };
      };
      const makeFormB = () =>
        `FROM quack_query('quack:${wsLakeProxy}', ${qlit(stripLakeCatalog(sql))}, ` +
        `token => ${qlit(wsLakeToken)}, disable_ssl => ${wsLakeDisableSsl ? "true" : "false"})`;
      let relayResult = null;
      let relayForm = null;
      let relayError = null;
      try {
        relayResult = await runRelayReader(sql);
        relayForm = "A";
      } catch (eA) {
        const msg = String(eA?.message ?? eA);
        const needsServerSide =
          /streaming scan/i.test(msg) ||
          (/does not exist|catalog error/i.test(msg) && /\blake\b/i.test(sql));
        if (needsServerSide) {
          try {
            relayResult = await runRelayReader(makeFormB());
            relayForm = "B";
          } catch (eB) {
            relayError = String(eB?.message ?? eB);
          }
        } else {
          relayError = msg;
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: relayResult != null,
        rows: relayResult?.rows ?? null,
        rowCount: relayResult?.rowCount ?? null,
        form: relayForm,
        error: relayError,
      }));
      return;
    }

    // ── Everything else → quack (Fork-B quack-over-HTTP) ───────────────────────
    // quack_serve binds 'localhost'; target localhost so an IPv6-only listener is
    // matched too (macOS/Linux dual-stack quirk seen in the Rivet PoC).
    const target = `http://localhost:${QUACK_PORT}${url}`;
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null || HOP_BY_HOP.has(k.toLowerCase())) continue;
      headers[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const body = Buffer.concat(chunks);

    const upstream = await fetch(target, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" || body.length === 0 ? undefined : new Uint8Array(body),
    });
    const outHeaders = {};
    upstream.headers.forEach((v, k) => {
      if (!HOP_BY_HOP.has(k.toLowerCase())) outHeaders[k] = v;
    });
    res.writeHead(upstream.status, outHeaders);
    res.end(Buffer.from(await upstream.arrayBuffer()));
  }

  server.listen(FWD_PORT, "0.0.0.0", () => {
    bootMs = Date.now() - bootStartedAt;
    log(`forwarder listening on 0.0.0.0:${FWD_PORT} (→ quack:${QUACK_PORT}) — in-container boot ${bootMs}ms`);
  });
}

async function readJson(req) {
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

main().catch((err) => {
  console.error("[gw-entry] FATAL:", err);
  process.exit(1);
});
