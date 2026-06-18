// Probe-local copy of the workspace sidecar.
//
// This is a verbatim behavioural copy of gateway-rivet-poc/src/workspace-sidecar.ts
// with two probe-only deltas:
//   1. `normalize` is inlined (the real sidecar imports it from packages/gateway
//      src/duck.ts, which pulls in @waddling/control-schema types — a workspace
//      dependency chain we deliberately do NOT drag into a standalone container
//      image). The inlined copy is byte-for-byte the same logic.
//   2. plain .mjs so the container runs it with bare `node` (no tsx/TS toolchain
//      needed inside the image).
// The production migration (Stage C) keeps workspace-sidecar.ts UNCHANGED as the
// container entrypoint; this divergence exists only to make the probe image
// self-contained. The isolation/encryption/FIFO contract below is identical.
//
// SECURITY (isolation): the workspace is a new execution surface birdshot cannot
// see. It MUST NOT be able to read the lake's object store directly. So it:
//   • holds NO lake S3 secret,
//   • SET autoload/autoinstall_known_extensions=false,
//   • SET disabled_filesystems='HTTPFileSystem,S3FileSystem' AFTER loading httpfs
//     (registered class names, not extension names) — blocks s3:// and http://
//     reads while leaving quack's transport intact; the agent CANNOT undo it
//     (DuckDB makes the list append-only),
//   • reaches the lake ONLY via the quack ATTACH (birdshot-gated).
// httpfs is loaded solely for its OpenSSL crypto provider (encrypted-DB writes).
//
// env: SIDECAR_PORT, DB_FILE

import { createServer } from "node:http";
import { DuckDBInstance } from "@duckdb/node-api";

const PORT = Number(process.env.SIDECAR_PORT);
const DB_FILE = process.env.DB_FILE;
if (!PORT || !DB_FILE) {
  console.error("[ws-sidecar] need SIDECAR_PORT + DB_FILE");
  process.exit(1);
}

/** Single-quote escape for inlining into a DuckDB SQL literal. */
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

/** Normalize a DuckDB row tree to JSON-safe values (BigInt → Number, value
 *  wrappers → readable toString()). Verbatim from packages/gateway/src/duck.ts. */
function normalize(value) {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto && proto !== Object.prototype) return String(value);
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalize(v)]),
    );
  }
  return value;
}

let conn = null;
let booted = false;
let lakeAttached = false;

// ── FIFO queue: serialize all SQL onto the single workspace connection ─────────
let chain = Promise.resolve();
let queueDepth = 0;
function enqueue(task) {
  queueDepth++;
  const result = chain.then(task, task);
  chain = result.then(() => { queueDepth--; }, () => { queueDepth--; });
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

async function init(body) {
  if (!body.key) throw new Error("init: missing workspace key");

  if (!booted) {
    // allow_unsigned_extensions deliberately NOT set: quack + httpfs are signed,
    // so the default (false) blocks the agent from LOADing a malicious unsigned
    // .so it wrote to local disk. With autoinstall/autoload off there is no path
    // to bring in new code.
    const inst = await DuckDBInstance.create(":memory:");
    const c = await inst.connect();

    await c.run("INSTALL quack; LOAD quack;");
    await c.run("INSTALL httpfs; LOAD httpfs;"); // OpenSSL crypto provider

    // Isolation lever. MUST come after httpfs load; agent cannot undo it (DuckDB
    // makes disabled_filesystems append-only). REGISTERED class names — NOT the
    // extension names; 'HTTPFS'/'S3' silently no-op and leave exfil open.
    await c.run("SET autoinstall_known_extensions=false; SET autoload_known_extensions=false;");
    await c.run("SET disabled_filesystems='HTTPFileSystem,S3FileSystem';");

    // The encrypted, durable workspace. Scratch lands here by default (USE w).
    await c.run(`ATTACH ${q(DB_FILE)} AS w (ENCRYPTION_KEY ${q(body.key)})`);
    await c.run("USE w");

    conn = c;
    booted = true;
  }

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

  if (body.lockConfiguration !== false) {
    await conn.run("SET lock_configuration=true;");
  }
}

async function checkpoint() {
  await conn.run("CHECKPOINT w");
}

const server = createServer((req, res) => {
  void (async () => {
    const url = (req.url ?? "/").split("?")[0];
    try {
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
        return sendJson(res, 200, { ...out, queueDepth });
      }
      if (url === "/snapshot") {
        await enqueue(checkpoint);
        return sendJson(res, 200, { ok: true });
      }
      if (url === "/shutdown") {
        await enqueue(async () => {
          try { await conn.run("DETACH lake"); } catch { /* not attached */ }
          lakeAttached = false;
          await conn.run("CHECKPOINT w");
        });
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

process.on("SIGTERM", () => {
  void (async () => {
    try {
      if (booted) {
        await Promise.race([
          enqueue(() => conn.run("CHECKPOINT w")),
          new Promise((_, rej) => setTimeout(() => rej(new Error("checkpoint timeout")), 2500)),
        ]);
      }
    } catch { /* best effort */ }
    process.exit(0);
  })();
});

server.listen(PORT, "127.0.0.1", () => console.error(`[ws-sidecar] up :${PORT} db=${DB_FILE}`));
