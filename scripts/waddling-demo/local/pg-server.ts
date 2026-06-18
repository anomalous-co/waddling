/**
 * pg-server.ts — Host-native control-plane Postgres for the no-Docker demo.
 *
 * Runs an embedded PGlite (real Postgres compiled to WASM) and exposes it on a
 * TCP port speaking the Postgres wire protocol, so the Next.js app, the
 * gateway-client, and seed.ts can all connect via a normal `postgres://` DSN
 * with no Docker/Postgres install. The DuckLake catalog does NOT go through
 * here — the lake uses its own local DuckDB catalog file (see run-local.sh).
 *
 * maxConnections is set high because the app uses a `pg` Pool (many conns).
 *
 * Env:
 *   PGDATA_DIR  persistent PGlite data dir (default: <demo>/.local/pgdata)
 *   PG_PORT     TCP port to listen on     (default: 5470)
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.PGDATA_DIR ?? join(__dirname, "..", ".local", "pgdata");
const PORT = Number(process.env.PG_PORT ?? "5470");

async function main(): Promise<void> {
  console.log(`[pg-server] starting PGlite at ${DATA_DIR}`);
  mkdirSync(dirname(DATA_DIR), { recursive: true });
  const db = await PGlite.create({ dataDir: DATA_DIR });
  await db.waitReady;

  const server = new PGLiteSocketServer({
    db,
    port: PORT,
    host: "127.0.0.1",
    maxConnections: 20,
  });
  await server.start();
  console.log(`[pg-server] Postgres wire protocol on 127.0.0.1:${PORT} (ready)`);

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`[pg-server] ${sig} — shutting down`);
    try {
      await server.stop();
      await db.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[pg-server] fatal:", err);
  process.exit(1);
});
