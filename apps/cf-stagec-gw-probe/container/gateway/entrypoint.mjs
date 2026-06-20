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
import { resolve } from "node:path";

import { DuckDBInstance } from "@duckdb/node-api";
import {
  bootDuckRuntime,
  applySnapshot,
  birdshotRevoke,
  birdshotStatus,
  normalize,
  restoreLakeViews,
} from "./gateway-src/duck.ts";

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
const FWD_PORT = Number(process.env.FORWARDER_PORT ?? 8080);
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

async function main() {
  const dataDir = resolve(STATE_DIR, "data");
  mkdirSync(dataDir, { recursive: true });

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
  const seedDemo =
    !quackboard &&
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
    s3: {
      endpoint: process.env.S3_ENDPOINT ?? "",
      keyId: process.env.S3_KEY_ID ?? "",
      secret: process.env.S3_SECRET ?? "",
      sessionToken: process.env.S3_SESSION_TOKEN ?? "",
      region: process.env.S3_REGION || "auto",
      useSsl: /^(1|true|yes|on)$/i.test(process.env.S3_USE_SSL ?? ""),
      urlStyle: process.env.S3_URL_STYLE === "vhost" ? "vhost" : "path",
    },
    // Quackboard mode: open this durable file as the DEFAULT catalog so quack serves its
    // tables and birdshot resolves bare refs against it (no lake ATTACH). Empty ⇒ lake mode.
    quackboard,
    databasePath: process.env.DUCKDB_DATABASE_PATH || ":memory:",
  };

  const catalogDesc = config.ducklakeCatalogFile
    ? `file:${config.ducklakeCatalogFile}`
    : `postgres(schema=${config.metadataSchema || "main"})`;
  log(`booting gateway: quack:${QUACK_PORT}, mode=${quackboard ? `quackboard(db=${config.databasePath})` : seedDemo ? "selftest-demo" : "real-lake"}, catalog=${catalogDesc}, dataPath=${config.ducklakeDataPath}`);
  const rt = await bootDuckRuntime(config);
  log("gateway booted — quack_serve up, birdshot hooks installed pre-serve");

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

  // ── In-container quack CLIENT ────────────────────────────────────────────────
  // workerd has no DuckDB, so the agent's quack client CANNOT live in the Worker.
  // It lives here: a SECOND DuckDBInstance that ATTACHes to the loopback quack
  // listener presenting the session JWT as the TOKEN, exactly as a real agent's
  // DuckDB would (mirrors birdshot.e2e.ts Bucket 2a). The gated traffic is loopback
  // INSIDE the container; the DO drives it over containerFetch → /query (JSON in,
  // JSON rows out). This proves the gateway DO serves GATED quack — it does NOT
  // claim raw quack wire survives the containerFetch hop (out of scope, Stage D+).
  const clientInst = await DuckDBInstance.create(":memory:");
  const client = await clientInst.connect();
  await client.run("INSTALL quack; LOAD quack");
  // One ATTACH per session token; cache so repeated /query calls reuse the session.
  const attachedTokens = new Set();

  // FTS recall (quackboard): the BM25 index is rebuilt lazily — only when the observations
  // table has grown since the last build — so recall never pays an O(N) rebuild per write
  // (plan req 3) and reads stay fresh within one observe→recall hop. -1 forces a rebuild on
  // the first recall after a (cold) boot, folding in any observes since bootstrap.
  let lastFtsCount = -1;
  async function attach(token) {
    if (attachedTokens.has(token)) return;
    // birdshot_authenticate verifies the JWT (RS256) against server_token + JWKS at
    // ATTACH; a bad token throws here. DISABLE_SSL: loopback plaintext quack.
    await client.run(
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

    // Liveness — the DO polls this until quack is reachable.
    if (method === "GET" && path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, quackPort: QUACK_PORT }));
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
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, grants: body.snapshot.roleGrants.length }));
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
    // so the DO can upload a crash-consistent file to R2. Quackboard durability (the served
    // database IS the store); a no-op CHECKPOINT on a lake gateway (:memory:) is harmless.
    if (path === "/ctrl/checkpoint" && method === "POST") {
      await rt.run("CHECKPOINT");
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
    log(`forwarder listening on 0.0.0.0:${FWD_PORT} (→ quack:${QUACK_PORT})`);
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
