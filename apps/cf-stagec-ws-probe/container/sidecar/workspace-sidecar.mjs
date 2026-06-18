// Workspace sidecar (Model B) — a PLAIN Node process (NOT the SDK process-server,
// and NOT rivetkit, where native quack/httpfs break). The WorkspaceSandbox DO
// launches one per (workspace, agent) via startProcess and drives it over a tiny
// HTTP control API reached by containerFetch. This is the agent's durable,
// encrypted, private DuckDB workspace AND its only client into the lake.
//
// MODEL B (the DO is pure c2). The DO holds NO file bytes and the container holds
// NO R2 credentials. The DO mints SHORT-LIVED, SINGLE-OBJECT presigned R2 GET/PUT
// URLs and hands them to THIS process over /init. This process does its OWN R2
// transfer with plain Node `fetch` (NOT DuckDB, NOT S3FileSystem): on init it
// fetch(presignedGet) → writes DB_FILE → ATTACHes it encrypted; on snapshot/shutdown
// it CHECKPOINTs then fetch(presignedPut, {body:<DB_FILE bytes>}). No S3 secret ever
// enters this process, so the workspace DuckDB cannot reach the object store even
// though the node process can fetch its own file.
//
// SECURITY (S1 isolation): the workspace is a new execution surface birdshot cannot
// see. It MUST NOT read the lake's object store directly (that would bypass every
// ACL). So the DuckDB instance:
//   • holds NO lake S3 secret (its secret store stays empty),
//   • SET autoload/autoinstall_known_extensions=false,
//   • SET disabled_filesystems='HTTPFileSystem,S3FileSystem' AFTER loading httpfs —
//     blocks s3:// and http:// reads while leaving quack's transport intact; the
//     agent CANNOT undo it (DuckDB makes the list append-only),
//   • reaches the lake ONLY via the (optional) quack ATTACH (birdshot-gated).
// httpfs is loaded solely for its OpenSSL crypto provider (encrypted-DB writes need
// it), never paired with an S3 secret. NOTE: the node-process R2 transfer above is a
// SEPARATE client (undici fetch) from DuckDB's filesystem layer — disabling
// S3FileSystem/HTTPFileSystem does not (and must not) block the node fetch that
// restores/persists the encrypted file; it blocks the DuckDB-visible exfil paths.
//
// Persistence: an ATTACHed, natively-encrypted DuckDB file (ENCRYPTION_KEY,
// AES-GCM-256). Scratch lands there by default (USE w). The bytes on R2 are already
// ciphertext, so they are encrypted at rest with no extra step.
//
// Concurrency: a single connection with a FIFO queue — queries execute serially and
// return per-query as each completes, keeping the encrypted file consistent.
//
// env (baked in the Dockerfile, one sidecar per container): SIDECAR_PORT, DB_FILE.

import { createServer } from "node:http";
import { writeFileSync, readFileSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";

const PORT = Number(process.env.SIDECAR_PORT);
const DB_FILE = process.env.DB_FILE;
if (!PORT || !DB_FILE) {
  console.error("[ws-sidecar] need SIDECAR_PORT + DB_FILE");
  process.exit(1);
}

// Single-quote escape for inlining into a DuckDB SQL literal.
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// Inlined from packages/gateway/src/duck.ts (the cross-monorepo import is not in the
// container build context). Coerce DuckDB row values to JSON-safe primitives:
// BigInt → number (or string when it would lose precision), everything else as-is.
function normalize(v) {
  if (typeof v === "bigint") {
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(v)
      : v.toString();
  }
  return v;
}

let conn = null;
let booted = false;
let lakeAttached = false;

// Presigned R2 PUT for THIS session's object, vended by the DO on /init. Held so
// /snapshot and /shutdown can persist without another round-trip to mint one. The
// DO refreshes it on each /init (presigned URLs are short-lived).
let presignedPut = null;

// ── FIFO queue: serialize all SQL onto the single workspace connection ─────────
let chain = Promise.resolve();
let queueDepth = 0;
// Monotonic high-water mark of queueDepth. We report THIS (not the live queueDepth)
// to prove two tasks were ever queued at once: the per-task decrement is registered
// on `result` BEFORE the caller's await continuation, so by the time a /query handler
// reads queueDepth its own task has already decremented — a live read can never show
// the overlap. peakDepth is decrement-proof, so peakDepth>=2 is the sound FIFO signal.
let peakDepth = 0;
function enqueue(task) {
  queueDepth++;
  if (queueDepth > peakDepth) peakDepth = queueDepth;
  const result = chain.then(task, task);
  chain = result.then(
    () => { queueDepth--; },
    () => { queueDepth--; },
  );
  return result;
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

/**
 * /init contract (Model B):
 *   {
 *     key:           "<64-hex>",      // 32-byte workspace ENCRYPTION_KEY (vended by DO)
 *     presignedGet:  "<url>",         // short-lived single-object R2 GET for the .duckdb
 *     presignedPut:  "<url>",         // short-lived single-object R2 PUT for the .duckdb
 *     getStatus404Ok: true,           // a 404 on GET = first-ever session (fresh DB)
 *     lakeProxy?:    "host:port",     // OPTIONAL quack ingress (gateway) — DEFERRED
 *     lakeToken?:    "<jwt>",         // OPTIONAL session JWT as quack TOKEN — DEFERRED
 *     disableSsl?:   false,
 *     lockConfiguration?: true,
 *   }
 * The lake fields are accepted but NOT exercised by the probe (gateway is infra-blocked).
 */
async function init(body) {
  if (!body.key) throw new Error("init: missing workspace key");
  if (body.presignedPut) presignedPut = body.presignedPut;

  if (!booted) {
    // Restore the encrypted file from R2 over plain Node fetch BEFORE ATTACH. The DO
    // never touches these bytes. A 404 means first-ever session — leave DB_FILE
    // absent so ATTACH creates a fresh encrypted DB.
    if (body.presignedGet) {
      const getRes = await fetch(body.presignedGet, { method: "GET" });
      if (getRes.ok) {
        const buf = Buffer.from(await getRes.arrayBuffer());
        writeFileSync(DB_FILE, buf);
      } else if (getRes.status === 404 || getRes.status === 403) {
        // 404 (and R2's 403-for-missing on some token scopes) → first-ever session.
        if (!body.getStatus404Ok) {
          throw new Error(`init: presigned GET ${getRes.status} (and getStatus404Ok not set)`);
        }
      } else {
        throw new Error(`init: presigned GET failed ${getRes.status}`);
      }
    }

    // allow_unsigned_extensions deliberately NOT set: quack + httpfs are signed (load
    // without it), so the default (false) means the agent cannot LOAD a malicious
    // UNSIGNED extension. With autoinstall/autoload off there is no path to new code.
    const inst = await DuckDBInstance.create(":memory:");
    const c = await inst.connect();

    // Load BEFORE locking down: explicit installs use the on-disk cache (the image
    // pre-bakes quack + httpfs); idempotent.
    await c.run("INSTALL quack; LOAD quack;");
    await c.run("INSTALL httpfs; LOAD httpfs;"); // OpenSSL crypto provider for encrypted DB writes

    // Isolation lever (S1). MUST come after httpfs load; agent cannot undo it
    // (disabled_filesystems is append-only). The names are the REGISTERED class
    // names — 'HTTPFileSystem' + 'S3FileSystem' — NOT extension names; 'HTTPFS'/'S3'
    // silently no-op and leave exfil open. These block read_csv/read_parquet over
    // http:// and s3:// with a hard "disabled by configuration" error, while quack's
    // own HTTP transport (a separate client) keeps working.
    await c.run("SET autoinstall_known_extensions=false; SET autoload_known_extensions=false;");
    await c.run("SET disabled_filesystems='HTTPFileSystem,S3FileSystem';");

    // The encrypted, durable workspace. Scratch lands here by default (USE w). A WRONG
    // key throws right here — which is how the encrypted-at-rest reopen test fails.
    await c.run(`ATTACH ${q(DB_FILE)} AS w (ENCRYPTION_KEY ${q(body.key)})`);
    await c.run("USE w");

    conn = c;
    booted = true;
  }

  // (Re)attach the lake — DEFERRED in this probe (gateway infra-blocked). The code
  // path exists so the contract is complete; the probe never sends lakeProxy/lakeToken.
  if (body.lakeProxy && body.lakeToken) {
    if (lakeAttached) {
      try { await conn.run("DETACH lake"); } catch { /* not attached */ }
      lakeAttached = false;
    }
    await conn.run(
      `ATTACH 'quack:${body.lakeProxy}' AS lake (TOKEN ${q(body.lakeToken)}, DISABLE_SSL ${body.disableSsl ? "true" : "false"})`,
    );
    lakeAttached = true;
  }

  // Defense-in-depth: prevent the agent toggling any further config. Done last so all
  // SETs above are applied. disabled_filesystems is already irreversible on its own;
  // this also pins autoload/unsigned/etc.
  if (body.lockConfiguration !== false) {
    await conn.run("SET lock_configuration=true;");
  }
}

/** Flush the encrypted workspace catalog so a snapshot of the file is consistent. */
async function checkpoint() {
  await conn.run("CHECKPOINT w");
}

/** Plain-Node fetch of the local DB_FILE bytes to the presigned R2 PUT. The DO never
 *  sees the bytes; this process owns the transfer. */
async function persist() {
  if (!presignedPut) throw new Error("persist: no presigned PUT url (init not run?)");
  const bytes = readFileSync(DB_FILE);
  const putRes = await fetch(presignedPut, {
    method: "PUT",
    body: bytes,
    headers: { "content-type": "application/octet-stream" },
  });
  if (!putRes.ok) {
    const txt = (await putRes.text()).slice(0, 400);
    throw new Error(`persist: presigned PUT failed ${putRes.status}: ${txt}`);
  }
}

const server = createServer((req, res) => {
  void (async () => {
    const url = (req.url ?? "/").split("?")[0];
    try {
      // The server only listens once the process can accept commands, so
      // reachability == ready-for-/init. `booted` (post-/init) is reported for
      // observability but does not gate health.
      if (url === "/health") { res.statusCode = 200; res.end(booted ? "ready" : "awaiting-init"); return; }

      const body = await readJson(req);

      if (url === "/init") {
        await enqueue(() => init(body));
        return sendJson(res, 200, { ok: true, lakeAttached });
      }
      if (!booted) return sendJson(res, 409, { error: "not_initialized" });

      if (url === "/run") {
        await enqueue(() => conn.run(String(body.sql)));
        return sendJson(res, 200, { ok: true, queueDepth });
      }
      if (url === "/query") {
        const out = await enqueue(async () => {
          const reader = await conn.runAndReadAll(String(body.sql));
          const columns = reader.columnNames();
          const objs = reader.getRowObjects();
          const rows = objs.map((o) => columns.map((cn) => normalize(o[cn])));
          return { columns, rows, rowCount: rows.length };
        });
        return sendJson(res, 200, { ...out, queueDepth, peakDepth });
      }
      if (url === "/snapshot") {
        // Periodic/explicit checkpoint: flush + persist to R2, keep serving.
        await enqueue(checkpoint);
        await persist();
        return sendJson(res, 200, { ok: true });
      }
      if (url === "/shutdown") {
        // Final clean checkpoint before the DO tears the container down. Drop the lake
        // attach so the file is self-contained, flush, persist, then exit. Persist
        // ONLY on a clean checkpoint so a torn file never overwrites the last good
        // snapshot — the DO additionally guards on this reply being {ok:true}.
        await enqueue(async () => {
          try { await conn.run("DETACH lake"); } catch { /* not attached */ }
          lakeAttached = false;
          await conn.run("CHECKPOINT w");
        });
        await persist();
        sendJson(res, 200, { ok: true });
        setTimeout(() => process.exit(0), 50);
        return;
      }
      return sendJson(res, 404, { error: "not_found" });
    } catch (e) {
      return sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  })();
});

// Bind 0.0.0.0 (NOT loopback): containerFetch reaches this through the SDK
// process-server, which cannot hit a 127.0.0.1-only bind. Isolation is enforced by
// the container network boundary, not the bind address. (gw-probe forwarder does the same.)
server.listen(PORT, "0.0.0.0", () => console.error(`[ws-sidecar] up :${PORT} db=${DB_FILE}`));
