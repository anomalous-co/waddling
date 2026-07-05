// PoC: the waddling gateway as a Rivet actor (fork A).
//
// WHY THIS WORKS WHERE WORKERS/DO DID NOT:
//   A Rivet actor is a real, long-lived Node process (Runner mode), not a
//   workerd V8 isolate. So native @duckdb/node-api loads, the native
//   birdshot.duckdb_extension LOADs, and quack_serve opens its listener —
//   the ENTIRE existing gateway runs unchanged. workerd can do none of that.
//
// MAPPING ONTO waddling:
//   - One actor instance per endpoint  → key = [orgId, endpointId]
//     (mirrors "one long-lived gateway container per endpoint").
//   - The non-serializable DuckRuntime lives in c.vars (ephemeral, rebuilt on
//     wake) — exactly what vars are for. Source of truth stays in DuckLake/R2.
//   - Each actor gets its OWN quack port (quack_serve hardcodes 9500 in the
//     gateway env; many actors in one runner would collide, so we allocate a
//     free port per actor here).
//
// This file reuses the REAL gateway code (no fork): bootDuckRuntime() already
// LOADs birdshot, creates the R2 secret (skipped in local-data mode), ATTACHes
// the lake, runs quack_serve, and wires birdshot's auth/authz hooks.

import { actor, setup } from "rivetkit";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { persistFile, restoreFile } from "./db-persist.ts";

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import {
  bootDuckRuntime,
  applySnapshot,
  birdshotStatus,
  normalize,
  type DuckRuntime,
} from "../../packages/gateway/src/duck.ts";
import type { GatewayConfig } from "../../packages/gateway/src/config.ts";
import type { BirdshotSnapshot } from "@waddling/control-schema";

// ── Paths (repo-relative) ─────────────────────────────────────────────────────
const POC_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const REPO_ROOT = resolve(POC_ROOT, "..");
const LOCAL_DIR = resolve(POC_ROOT, ".local");
const BIRDSHOT_EXT =
  process.env.BIRDSHOT_EXTENSION_PATH ??
  resolve(
    REPO_ROOT,
    "birdshot/build/release/extension/birdshot/birdshot.duckdb_extension",
  );

/** OS-assigned free TCP port on loopback (per-actor quack port). */
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

interface GatewayVars {
  rt: DuckRuntime | null;
  quackPort: number | null;
}

type AuthConfig = {
  issuer: string;
  audience: string;
  jwks?: { kid: string; n: string; e: string }[];
};

// Structural ctx — works for both action and onRequest contexts (both carry
// vars + key), so ensure() can be shared between the actions and the proxy.
type GwCtx = { vars: GatewayVars; key: ReadonlyArray<unknown> };

// Hop-by-hop / length headers that must NOT be forwarded across a proxy hop;
// Node's fetch sets its own. Everything else (Content-Type, auth/TOKEN, quack's
// own headers) passes through, since quack's exact wire headers are opaque.
const HOP_BY_HOP = new Set([
  "host", "connection", "content-length", "transfer-encoding",
  "keep-alive", "upgrade", "proxy-connection", "te", "trailer",
]);

/** Lazily boot the native DuckDB+birdshot+quack runtime and cache it in vars. */
async function ensure(c: GwCtx): Promise<DuckRuntime> {
  if (c.vars.rt) return c.vars.rt;

  // key = [orgId, endpointId]; the endpoint scopes the lake + quack listener.
  const endpointId = String(c.key[1] ?? c.key[0] ?? "default");
  const port = await freePort();

  const dataDir = resolve(LOCAL_DIR, endpointId, "data");
  mkdirSync(dataDir, { recursive: true });

  // Local-data, local-file-catalog mode — the no-Postgres/no-R2 host path
  // (mirrors scripts/waddling-demo seed). Swap ducklakeDataPath to 's3://...'
  // + fill s3{} to put the lake on R2 instead; bootDuckRuntime handles both.
  const config: GatewayConfig = {
    birdshotExtensionPath: BIRDSHOT_EXT,
    quackPort: port,
    serverToken: process.env.GW_SERVER_TOKEN ?? "poc-server-token",
    ctrlPort: 0, // unused here; the actor IS the control surface
    ducklakeCatalogDsn: "",
    ducklakeCatalogFile: resolve(LOCAL_DIR, endpointId, "lake.ducklake"),
    ducklakeDataPath: dataDir.endsWith("/") ? dataDir : `${dataDir}/`,
    localData: true,
    lakeAlias: "lake",
    encrypted: false,
    s3: { endpoint: "", keyId: "", secret: "", region: "auto", useSsl: false, urlStyle: "path" },
  };

  const rt = await bootDuckRuntime(config);
  c.vars.rt = rt;
  c.vars.quackPort = port;
  return rt;
}

export const gateway = actor({
  options: { name: "DuckDB Gateway", icon: "database" },

  // No persisted state in this PoC: the lake catalog lives on disk/R2, and the
  // birdshot policy is re-pushed on each (re)boot by the control plane.
  state: {},

  // Native, non-serializable runtime — ephemeral, rebuilt on wake.
  createVars: (): GatewayVars => ({ rt: null, quackPort: null }),

  // ── FORK B: quack-over-Rivet ────────────────────────────────────────────────
  // quack is HTTP request/response (the client POSTs to `/quack`). So an
  // EXTERNAL agent's DuckDB can reach this in-actor quack server by tunnelling
  // its HTTP through Rivet: agent → public proxy → Rivet gateway → this
  // onRequest → loopback `http://127.0.0.1:<quackPort>`. No socket exposure,
  // no quack changes. Bodies are binary (Arrow/CBOR) → forwarded as raw bytes.
  onRequest: async (c, request) => {
    await ensure(c);
    const url = new URL(request.url);
    // quack_serve binds 'localhost' — match it (macOS resolves localhost to ::1
    // first, so a hardcoded 127.0.0.1 can miss an IPv6-only listener).
    const target = `http://localhost:${c.vars.quackPort}${url.pathname}${url.search}`;

    const headers = new Headers();
    request.headers.forEach((v, k) => {
      if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v);
    });

    const method = request.method;
    const body =
      method === "GET" || method === "HEAD"
        ? undefined
        : new Uint8Array(await request.arrayBuffer());

    const resp = await fetch(target, {
      method,
      headers,
      body,
      // @ts-expect-error Node's undici requires duplex when streaming a body.
      duplex: "half",
    });

    const out = new Headers();
    resp.headers.forEach((v, k) => {
      if (!HOP_BY_HOP.has(k.toLowerCase())) out.set(k, v);
    });
    return new Response(new Uint8Array(await resp.arrayBuffer()), {
      status: resp.status,
      headers: out,
    });
  },

  actions: {
    /** Boot DuckDB + LOAD birdshot + quack_serve. Returns the per-actor port. */
    boot: async (c) => {
      await ensure(c);
      return { booted: true, quackPort: c.vars.quackPort };
    },

    /** birdshot_status() — proves the native extension is loaded in-process. */
    status: async (c) => birdshotStatus(await ensure(c)),

    /** Diagnostic: serving-connection defaults + where the demo tables live. */
    debug: async (c) => {
      const rt = await ensure(c);
      const defaults = await rt.query("SELECT current_database() AS db, current_schema() AS sch");
      const tables = await rt.query(
        "SELECT database_name, schema_name, table_name FROM duckdb_tables() WHERE table_name IN ('allowed','secret')",
      );
      return { defaults: defaults.rows, tables: tables.rows };
    },

    /** The agent-facing quack port to ATTACH to (loopback in local dev). */
    quackPort: async (c) => {
      await ensure(c);
      return c.vars.quackPort;
    },

    /**
     * Seed a tiny demo lake (ungated, trusted control path) so there is
     * something for ACLs to gate: demo.allowed (granted) + demo.secret (not).
     */
    seedDemo: async (c) => {
      const rt = await ensure(c);
      // quack serves federated scans on a connection that defaults to
      // memory.main (NOT lake.main, which is only this rt connection's default).
      // A federated scan arrives as a bare table name, so the tables must be
      // resolvable unqualified on the serving connection → put them in
      // memory.main. birdshot gates by schema.table name, independent of catalog.
      await rt.run("CREATE TABLE IF NOT EXISTS memory.main.allowed (id INTEGER, val VARCHAR)");
      await rt.run("CREATE TABLE IF NOT EXISTS memory.main.secret  (id INTEGER, ssn VARCHAR)");
      await rt.run("DELETE FROM memory.main.allowed");
      await rt.run("DELETE FROM memory.main.secret");
      await rt.run("INSERT INTO memory.main.allowed VALUES (1,'ok'),(2,'fine')");
      await rt.run("INSERT INTO memory.main.secret  VALUES (1,'111-22-3333')");
      return { seeded: true };
    },

    /**
     * Push a birdshot policy snapshot + auth config (control-plane action).
     * Reuses the exact gateway wrapper used by the real ctrl server.
     */
    applyPolicy: async (c, snapshot: BirdshotSnapshot, auth: AuthConfig) => {
      // Pull-model (spec §13): applySnapshot is CONFIG-only now — birdshot pulls grants from the
      // store. The legacy `snapshot` arg is ignored (kept for the PoC action's signature).
      void snapshot;
      await applySnapshot(await ensure(c), { auth });
      return { applied: true };
    },
  },
});

// ── The agent's OWN resumable, independent DuckDB instance ────────────────────
// One actor per agent (key = [agentId]). It holds the agent's private DuckDB in
// vars and ATTACHes to the gateway THROUGH Rivet (via the public quack proxy).
//
// "Resumable" precisely: the native DuckDB in vars is EPHEMERAL — Rivet drops it
// on hibernation. What survives is c.state (the proxy address, session token,
// query count). On wake the actor durably RE-ESTABLISHES: re-creates the DuckDB
// and re-ATTACHes from c.state. The in-memory working set is NOT preserved
// (temp tables/loaded data would need the DB file persisted to actor storage —
// a separate spike). The lake itself is the source of truth, so re-ATTACH is
// enough to resume querying.

interface AgentState {
  proxy: string; // host:port of the public quack ingress
  token: string; // session JWT (birdshot principal)
  queries: number; // durable counter — proves state survives hibernation
}
interface AgentVars {
  inst: DuckDBInstance | null;
  conn: DuckDBConnection | null;
  attached: boolean;
}

export const agent = actor({
  // Hibernate after 8s idle (ms). Must exceed the first-query cost (cold DuckDB
  // + INSTALL quack download) or the actor is torn down mid-creation; the PoC
  // idles longer than this to force a real hibernation.
  options: { name: "Agent DuckDB", icon: "user", sleepTimeout: 8000 },

  state: { proxy: "", token: "", queries: 0 } as AgentState,
  createVars: (): AgentVars => ({ inst: null, conn: null, attached: false }),

  onWake: (c) =>
    console.log(`[agent ${String(c.key[0])}] WAKE — durable queries so far: ${c.state.queries}`),
  onSleep: (c) =>
    console.log(`[agent ${String(c.key[0])}] SLEEP — dropping in-memory DuckDB, keeping state`),

  actions: {
    /** Remember how to reach the gateway so we can resume after hibernation. */
    connect: (c, token: string, proxy: string) => {
      c.state.token = token;
      c.state.proxy = proxy;
      return { connected: true };
    },

    /** Run SQL on the agent's own DuckDB, (re)establishing it from state if cold. */
    query: async (c, sql: string) => {
      if (!c.vars.conn) {
        // Cold start (first call OR woke from hibernation with vars dropped).
        console.log(`[agent ${String(c.key[0])}] cold — rebuilding DuckDB + re-ATTACH from state`);
        const inst = await DuckDBInstance.create(":memory:");
        const conn = await inst.connect();
        await conn.run("INSTALL quack; LOAD quack");
        c.vars.inst = inst;
        c.vars.conn = conn;
        c.vars.attached = false;
      }
      if (!c.vars.attached) {
        await c.vars.conn.run(
          `ATTACH 'quack:${c.state.proxy}' AS lake (TOKEN '${c.state.token.replace(/'/g, "''")}', DISABLE_SSL true)`,
        );
        c.vars.attached = true;
      }
      const rows = (await c.vars.conn.runAndReadAll(sql)).getRowObjects();
      c.state.queries += 1;
      return { rows: normalize(rows), queries: c.state.queries };
    },
  },
});

// ── The WORKING per-agent managed DuckDB: actor supervises a DuckDB SIDECAR ───
// The previous `agent` actor fails because DuckDB's quack client can't run in the
// rivetkit runtime. Here the actor instead SUPERVISES a DuckDB sidecar (a plain
// child process, where native httpfs works) and owns durability: it restores the
// agent's DB file from actor KV on cold start and persists it back on hibernate.
// → a managed, resumable, per-agent DuckDB whose private working set survives a
// reschedule, without the agent running anything locally.

const SIDECAR_SCRIPT = resolve(POC_ROOT, "src/sidecar.ts");
const TSX_BIN = resolve(POC_ROOT, "node_modules/.bin/tsx");

// Track live sidecars so orphans get reaped if the registry process exits.
const liveSidecars = new Set<ChildProcess>();
function reapSidecars(): void {
  for (const p of liveSidecars) { try { p.kill("SIGKILL"); } catch { /* gone */ } }
}
process.once("exit", reapSidecars);
process.once("SIGINT", () => { reapSidecars(); process.exit(0); });
process.once("SIGTERM", () => { reapSidecars(); process.exit(0); });

interface SidecarState { token: string; proxy: string }
interface SidecarVars { proc: ChildProcess | null; port: number | null; exited: Promise<void> | null }
type SidecarCtx = {
  vars: SidecarVars;
  state: SidecarState;
  key: ReadonlyArray<unknown>;
  kv: import("./db-persist.ts").KvLike;
};

const agentDir = (id: string) => resolve(LOCAL_DIR, "agents", id);
const dbPath = (id: string) => resolve(agentDir(id), "db.duckdb");

async function sidecarFetch(port: number, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await resp.text();
  if (!resp.ok) throw new Error(`sidecar ${path} ${resp.status}: ${txt}`);
  return txt ? JSON.parse(txt) : {};
}

/** Restore-from-KV (if cold) and spawn the agent's DuckDB sidecar. */
async function ensureSidecar(c: SidecarCtx): Promise<void> {
  if (c.vars.proc) return;
  const id = String(c.key[0] ?? "agent");
  mkdirSync(agentDir(id), { recursive: true });
  const file = dbPath(id);

  if (!existsSync(file)) {
    const bytes = await restoreFile(c.kv);
    if (bytes) { writeFileSync(file, bytes); console.log(`[agentSidecar ${id}] restored ${bytes.length}B DB from KV`); }
    else console.log(`[agentSidecar ${id}] fresh DB (no KV snapshot yet)`);
  }

  const port = await freePort();
  const proc = spawn(TSX_BIN, [SIDECAR_SCRIPT], {
    env: { ...process.env, SIDECAR_PORT: String(port), DB_FILE: file },
    stdio: "ignore",
  });
  liveSidecars.add(proc);
  c.vars.proc = proc;
  c.vars.port = port;
  c.vars.exited = new Promise<void>((res) => proc.once("exit", () => { liveSidecars.delete(proc); res(); }));

  let healthy = false;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { healthy = true; break; } } catch { /* not up */ }
  }
  if (!healthy) throw new Error("sidecar did not become healthy");

  // Resume the gateway session if the agent had one. Best-effort: a gateway
  // outage must not block access to the agent's own private DuckDB.
  if (c.state.token && c.state.proxy) {
    try { await sidecarFetch(port, "/attach", { token: c.state.token, proxy: c.state.proxy }); }
    catch (e) { console.log(`[agentSidecar ${String(c.key[0])}] gateway re-attach failed (private DB still usable): ${e instanceof Error ? e.message : e}`); }
  }
}

/** Cleanly stop the sidecar (CHECKPOINT+exit) and persist its DB file to KV. */
async function snapshotToKv(c: SidecarCtx): Promise<number> {
  const v = c.vars;
  if (!v.proc || v.port == null) return 0;
  try { await sidecarFetch(v.port, "/shutdown"); } catch { /* may exit before replying */ }
  await Promise.race([v.exited, new Promise((r) => setTimeout(r, 3000))]);
  if (v.proc.exitCode === null) { try { v.proc.kill("SIGKILL"); } catch { /* gone */ } }
  const bytes = new Uint8Array(readFileSync(dbPath(String(c.key[0] ?? "agent"))));
  const chunks = await persistFile(c.kv, bytes);
  v.proc = null; v.port = null; v.exited = null;
  return chunks;
}

export const agentSidecar = actor({
  options: { name: "Agent DuckDB (sidecar)", icon: "database", sleepTimeout: 8000 },
  state: { token: "", proxy: "" } as SidecarState,
  createVars: (): SidecarVars => ({ proc: null, port: null, exited: null }),

  // Automatic durability: on hibernation, persist the DB file to KV.
  onSleep: async (c) => {
    const n = await snapshotToKv(c as unknown as SidecarCtx);
    console.log(`[agentSidecar ${String(c.key[0])}] SLEEP — persisted DB to KV (${n} chunks)`);
  },

  actions: {
    start: async (c) => { await ensureSidecar(c as unknown as SidecarCtx); return { started: true }; },
    run: async (c, sql: string) => { await ensureSidecar(c as unknown as SidecarCtx); return sidecarFetch(c.vars.port!, "/run", { sql }); },
    query: async (c, sql: string) => { await ensureSidecar(c as unknown as SidecarCtx); return sidecarFetch(c.vars.port!, "/query", { sql }); },
    attachGateway: async (c, token: string, proxy: string) => {
      c.state.token = token; c.state.proxy = proxy;
      await ensureSidecar(c as unknown as SidecarCtx);
      return sidecarFetch(c.vars.port!, "/attach", { token, proxy });
    },

    // Deterministic stand-in for a reschedule: persist to KV, kill the sidecar,
    // and WIPE the local DB file so the next query MUST restore from KV.
    hibernate: async (c) => {
      const chunks = await snapshotToKv(c as unknown as SidecarCtx);
      rmSync(dbPath(String(c.key[0] ?? "agent")), { force: true });
      return { persisted: true, chunks, localWiped: true };
    },
  },
});

export const registry = setup({ use: { gateway, agent, agentSidecar } });

// Type-only importers (e.g. verify.ts via `import type { registry }`) never run
// this; only `tsx src/registry.ts` does, which starts the local dev server.
registry.start();
