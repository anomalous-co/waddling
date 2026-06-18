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
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { DuckDBInstance } from "@duckdb/node-api";
import {
  bootDuckRuntime,
  applySnapshot,
  birdshotRevoke,
  birdshotStatus,
  normalize,
} from "./gateway-src/duck.ts";

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
  const seedDemo =
    process.env.GW_SELFTEST_SEED === "1" ||
    (!process.env.DUCKLAKE_CATALOG_DSN && !/^s3:\/\//i.test(process.env.DUCKLAKE_DATA_PATH ?? ""));

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
      region: process.env.S3_REGION || "auto",
      useSsl: /^(1|true|yes|on)$/i.test(process.env.S3_USE_SSL ?? ""),
      urlStyle: process.env.S3_URL_STYLE === "vhost" ? "vhost" : "path",
    },
  };

  const catalogDesc = config.ducklakeCatalogFile
    ? `file:${config.ducklakeCatalogFile}`
    : `postgres(schema=${config.metadataSchema || "main"})`;
  log(`booting gateway: quack:${QUACK_PORT}, mode=${seedDemo ? "selftest-demo" : "real-lake"}, catalog=${catalogDesc}, dataPath=${config.ducklakeDataPath}`);
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
