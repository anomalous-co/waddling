// DuckDB sidecar — a PLAIN process (not the rivetkit actor runtime), so native
// httpfs/quack work here (proven by verify-b; the actor runtime broke them).
// The supervising agent actor spawns one of these per agent, points it at a
// persistent DB file, and drives it over a tiny loopback HTTP API.
//
// env: SIDECAR_PORT, DB_FILE

import { createServer, type IncomingMessage } from "node:http";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { normalize } from "../../packages/gateway/src/duck.ts";

const PORT = Number(process.env.SIDECAR_PORT);
const DB_FILE = process.env.DB_FILE;
if (!PORT || !DB_FILE) {
  console.error("[sidecar] need SIDECAR_PORT + DB_FILE");
  process.exit(1);
}

let conn: DuckDBConnection;

async function readJson(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function checkpointAndExit(code = 0): Promise<never> {
  try { await conn.run("CHECKPOINT"); } catch { /* best effort */ }
  process.exit(code);
}
process.on("SIGTERM", () => { void checkpointAndExit(0); });

const server = createServer(async (req, res) => {
  try {
    const url = req.url ?? "/";
    if (url === "/health") { res.end("ok"); return; }
    const body = await readJson(req);
    res.setHeader("content-type", "application/json");

    if (url === "/run") {
      await conn.run(body.sql);
      res.end(JSON.stringify({ ok: true }));
    } else if (url === "/query") {
      const rows = (await conn.runAndReadAll(body.sql)).getRowObjects();
      res.end(JSON.stringify({ rows: normalize(rows) }));
    } else if (url === "/attach") {
      await conn.run(
        `ATTACH 'quack:${body.proxy}' AS lake (TOKEN '${String(body.token).replace(/'/g, "''")}', DISABLE_SSL true)`,
      );
      res.end(JSON.stringify({ attached: true }));
    } else if (url === "/shutdown") {
      // Drop the (transient) gateway attach so the snapshot file is self-contained
      // — the gateway session is re-established from the actor's state on wake.
      try { await conn.run("DETACH lake"); } catch { /* not attached */ }
      // Flush WAL into the main file so a snapshot of it is consistent, then exit.
      await conn.run("CHECKPOINT");
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => process.exit(0), 50);
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
});

(async () => {
  const inst = await DuckDBInstance.create(DB_FILE);
  conn = await inst.connect();
  await conn.run("INSTALL quack; LOAD quack");
  server.listen(PORT, "127.0.0.1", () => console.error(`[sidecar] up :${PORT} db=${DB_FILE}`));
})().catch((e) => { console.error("[sidecar] init failed", e); process.exit(1); });
