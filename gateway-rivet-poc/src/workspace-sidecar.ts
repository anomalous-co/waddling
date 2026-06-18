// Workspace sidecar — a PLAIN Node process (not the rivetkit actor runtime, where
// native quack/httpfs break). The session actor spawns one per (workspace, agent)
// and drives it over a tiny loopback HTTP API. This is the agent's durable,
// encrypted, private DuckDB workspace AND its only client into the lake.
//
// SECURITY (S1 isolation): the workspace is a new execution surface birdshot cannot
// see. It MUST NOT be able to read the lake's object store directly (that would
// bypass every ACL). So it:
//   • holds NO lake S3 secret (this instance's secret store stays empty),
//   • SET autoload/autoinstall_known_extensions=false,
//   • SET disabled_filesystems='S3,HTTPFS' AFTER loading httpfs — blocks s3:// and
//     http:// reads while leaving quack's transport intact; the agent CANNOT undo it
//     (DuckDB makes the list append-only),
//   • reaches the lake ONLY via the quack ATTACH (birdshot-gated).
// httpfs is loaded solely for its OpenSSL crypto provider (encrypted-DB writes need
// it), never paired with an S3 secret.
//
// Persistence: the workspace is an ATTACHed, natively-encrypted DuckDB file
// (ENCRYPTION_KEY, AES-GCM-256). Scratch lands there by default (USE w). The actor
// restores the file from S3 before /init and uploads it after /snapshot|/shutdown.
//
// Concurrency: a single connection with a FIFO queue — the agent may fire many
// queries; they execute serially and return per-query as each completes. Keeps the
// encrypted file consistent and gives a well-defined checkpoint point.
//
// env: SIDECAR_PORT, DB_FILE (the restored-or-fresh encrypted workspace file path)

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { normalize } from "../../packages/gateway/src/duck.ts";

const PORT = Number(process.env.SIDECAR_PORT);
const DB_FILE = process.env.DB_FILE;
if (!PORT || !DB_FILE) {
  console.error("[ws-sidecar] need SIDECAR_PORT + DB_FILE");
  process.exit(1);
}

/** Single-quote escape for inlining into a DuckDB SQL literal. */
const q = (s: string): string => "'" + String(s).replace(/'/g, "''") + "'";

let conn: DuckDBConnection | null = null;
let booted = false;
let lakeAttached = false;

// ── FIFO queue: serialize all SQL onto the single workspace connection ─────────
let chain: Promise<unknown> = Promise.resolve();
let queueDepth = 0;
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  queueDepth++;
  const result = chain.then(task, task);
  // keep the chain alive regardless of this task's outcome
  chain = result.then(
    () => { queueDepth--; },
    () => { queueDepth--; },
  );
  return result as Promise<T>;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

interface InitBody {
  /** 32-byte (hex/base64/raw) workspace encryption key. */
  key: string;
  /** host:port of the gateway quack ingress (Fork-B proxy or direct loopback). */
  lakeProxy?: string;
  /** session JWT presented as the quack TOKEN; birdshot verifies it. */
  lakeToken?: string;
  /** plain-HTTP quack transport (local/dev). */
  disableSsl?: boolean;
  /** belt-and-suspenders: lock all config after boot. Default true. */
  lockConfiguration?: boolean;
}

/**
 * Boot the workspace instance: isolation posture → load exts → attach the encrypted
 * workspace → (optionally) attach the lake. Idempotent: a second /init only refreshes
 * the lake attach (e.g. on a re-issued session JWT).
 */
async function init(body: InitBody): Promise<void> {
  if (!body.key) throw new Error("init: missing workspace key");

  if (!booted) {
    // NOTE: allow_unsigned_extensions is deliberately NOT set. quack + httpfs are
    // both signed (they load without it), so leaving the default (false) means the
    // agent cannot LOAD a malicious UNSIGNED extension it wrote to local disk —
    // closing the native-code-execution vector. Combined with autoinstall/autoload
    // off, there is no path to bring in new code.
    const inst = await DuckDBInstance.create(":memory:");
    const c = await inst.connect();

    // Load BEFORE locking down: explicit installs use the on-disk cache (the image
    // pre-bakes quack + httpfs); these are idempotent.
    await c.run("INSTALL quack; LOAD quack;");
    await c.run("INSTALL httpfs; LOAD httpfs;"); // OpenSSL crypto provider for encrypted DB writes

    // Isolation lever (S1). MUST come after httpfs load; agent cannot undo it
    // (DuckDB makes disabled_filesystems append-only). The filesystem names are
    // the REGISTERED class names — 'HTTPFileSystem' + 'S3FileSystem' — NOT the
    // extension names; 'HTTPFS'/'S3' silently no-op and leave exfil open. These
    // block read_csv/read_parquet over http:// and s3:// (incl. R2/GCS via S3)
    // with a hard "disabled by configuration" error, while quack's own HTTP
    // transport (a separate client) keeps working.
    await c.run("SET autoinstall_known_extensions=false; SET autoload_known_extensions=false;");
    await c.run("SET disabled_filesystems='HTTPFileSystem,S3FileSystem';");

    // The encrypted, durable workspace. Scratch lands here by default (USE w).
    await c.run(`ATTACH ${q(DB_FILE!)} AS w (ENCRYPTION_KEY ${q(body.key)})`);
    await c.run("USE w");

    conn = c;
    booted = true;
  }

  // (Re)attach the lake — the ONLY path to lake data, birdshot-gated.
  if (body.lakeProxy && body.lakeToken) {
    if (lakeAttached) {
      try { await conn!.run("DETACH lake"); } catch { /* not attached */ }
      lakeAttached = false;
    }
    await conn!.run(
      `ATTACH 'quack:${body.lakeProxy}' AS lake (TOKEN ${q(body.lakeToken)}, DISABLE_SSL ${body.disableSsl ? "true" : "false"})`,
    );
    lakeAttached = true;
  }

  // Defense-in-depth: prevent the agent from toggling any further config. Done
  // last so all sidecar SETs above are already applied. disabled_filesystems is
  // already irreversible on its own; this also pins autoload/unsigned/etc.
  if (body.lockConfiguration !== false) {
    await conn!.run("SET lock_configuration=true;");
  }
}

/** Flush the encrypted workspace file so a snapshot of it is consistent. */
async function checkpoint(): Promise<void> {
  // CHECKPOINT the workspace catalog specifically; the lake catalog is independent
  // (a remote quack attach) and needs no flush. We do NOT detach the lake here so
  // the session keeps querying after a periodic checkpoint.
  await conn!.run("CHECKPOINT w");
}

const server = createServer((req, res) => {
  void (async () => {
    const url = (req.url ?? "/").split("?")[0];
    try {
      // The server only starts listening once the process is ready to accept
      // commands, so reachability == ready-for-/init. `booted` (post-/init) is
      // reported in the body for observability but does not gate health.
      if (url === "/health") { res.statusCode = 200; res.end(booted ? "ready" : "awaiting-init"); return; }

      const body = await readJson(req);

      if (url === "/init") {
        await enqueue(() => init(body as unknown as InitBody));
        return sendJson(res, 200, { ok: true, lakeAttached });
      }
      if (!booted) return sendJson(res, 409, { error: "not_initialized" });

      if (url === "/run") {
        await enqueue(() => conn!.run(String(body.sql)));
        return sendJson(res, 200, { ok: true, queueDepth });
      }
      if (url === "/query") {
        const out = await enqueue(async () => {
          const reader = await conn!.runAndReadAll(String(body.sql));
          const columns = reader.columnNames();
          const objs = reader.getRowObjects() as Record<string, unknown>[];
          const rows = objs.map((o) => columns.map((cn) => normalize(o[cn])));
          return { columns, rows, rowCount: rows.length };
        });
        return sendJson(res, 200, { ...out, queueDepth });
      }
      if (url === "/snapshot") {
        // Periodic/keepalive checkpoint: flush the file, keep serving.
        await enqueue(checkpoint);
        return sendJson(res, 200, { ok: true });
      }
      if (url === "/shutdown") {
        // Final snapshot before the actor uploads + the process exits. Drop the
        // lake attach so the file is fully self-contained, flush, then exit.
        await enqueue(async () => {
          try { await conn!.run("DETACH lake"); } catch { /* not attached */ }
          lakeAttached = false;
          await conn!.run("CHECKPOINT w");
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
  // Best-effort flush so a forced reschedule doesn't lose committed scratch. Route
  // the CHECKPOINT through the SAME FIFO as queries (bounded) so it never runs
  // concurrently with an in-flight statement on the single connection.
  void (async () => {
    try {
      if (booted) {
        await Promise.race([
          enqueue(() => conn!.run("CHECKPOINT w")),
          new Promise((_, rej) => setTimeout(() => rej(new Error("checkpoint timeout")), 2500)),
        ]);
      }
    } catch { /* best effort */ }
    process.exit(0);
  })();
});

server.listen(PORT, "127.0.0.1", () => console.error(`[ws-sidecar] up :${PORT} db=${DB_FILE}`));
