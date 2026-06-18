// WorkspaceRunner — the plain-Node orchestration for one (workspace, agent) session,
// independent of Rivet so it is unit-testable end to end. The Rivet actor
// (workspace-actor.ts) is a thin wrapper that holds one of these in its vars and
// forwards lifecycle hooks. Composes the two validated pieces:
//   • workspace-sidecar.ts — isolated, encrypted, FIFO DuckDB child (the only lake
//     client, birdshot-gated; cannot read the object store directly).
//   • workspace-store.ts    — S3 GET/PUT of the encrypted file (R2 prod / MinIO local).
//
// SECRET CUSTODY: the workspace key + session JWT + S3 creds are passed into
// configure() each session start (control-plane-managed) and held only in memory —
// never persisted. After a cold start the file is restored from S3 and the sidecar
// re-initialized from the re-vended secrets.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceStore, workspaceKey, type S3StoreConfig } from "./workspace-store.ts";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const SIDECAR_SCRIPT = resolve(HERE, "workspace-sidecar.ts");
const TSX_BIN = resolve(HERE, "..", "node_modules", ".bin", "tsx");
const DEFAULT_TMP_ROOT = resolve(HERE, "..", ".local", "workspaces");

/** Secrets + coords vended by the control plane at session start (held in memory only). */
export interface WorkspaceConfig {
  /** 32-byte workspace encryption key (control-plane-managed). */
  workspaceKey: string;
  /** Gateway quack ingress (Fork-B proxy host:port) for the lake ATTACH. */
  lakeProxy: string;
  /** Session JWT presented as the quack TOKEN; birdshot verifies + gates it. */
  lakeToken: string;
  /** Plain-HTTP quack transport (local/dev). */
  disableSsl?: boolean;
  /** Object-store coords for persisting the encrypted file. */
  s3: S3StoreConfig;
}

export interface QueryResult { columns: string[]; rows: unknown[][]; rowCount: number; queueDepth?: number }

// Reap orphaned sidecars if the host process dies.
const liveSidecars = new Set<ChildProcess>();
const reap = () => { for (const p of liveSidecars) { try { p.kill("SIGKILL"); } catch { /* gone */ } } };
process.once("exit", reap);

async function freePort(): Promise<number> {
  return await new Promise<number>((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

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

export class WorkspaceRunner {
  private proc: ChildProcess | null = null;
  private port: number | null = null;
  private exited: Promise<void> | null = null;
  private store: WorkspaceStore | null = null;
  private cfg: WorkspaceConfig | null = null;
  private readonly file: string;
  private readonly key: string;

  constructor(
    readonly workspaceId: string,
    readonly agentId: string,
    tmpRoot: string = DEFAULT_TMP_ROOT,
  ) {
    this.file = resolve(tmpRoot, workspaceId, `${agentId}.duckdb`);
    this.key = workspaceKey(workspaceId, agentId);
  }

  /** Session start: vend secrets, restore the encrypted file from S3, bring up the sidecar. */
  async configure(cfg: WorkspaceConfig): Promise<void> {
    this.cfg = cfg;
    this.store = new WorkspaceStore(cfg.s3);
    await this.ensure();
  }

  async query(sql: string): Promise<QueryResult> {
    await this.ensure();
    return (await sidecarFetch(this.port!, "/query", { sql })) as unknown as QueryResult;
  }

  async run(sql: string): Promise<void> {
    await this.ensure();
    await sidecarFetch(this.port!, "/run", { sql });
  }

  /** Checkpoint + upload, keeping the session live (periodic/explicit snapshot). */
  async snapshot(): Promise<void> {
    if (!this.proc || this.port == null || !this.store) return;
    await sidecarFetch(this.port, "/snapshot");
    await this.store.upload(this.key, new Uint8Array(readFileSync(this.file)));
  }

  /** End/ hibernate: shutdown sidecar (DETACH lake + CHECKPOINT + exit), upload, drop local copy. */
  async end(): Promise<void> {
    if (!this.proc || this.port == null) return;
    // /shutdown returns {ok:true} only AFTER a successful DETACH lake + CHECKPOINT,
    // so a clean reply means the file is self-contained and safe to upload.
    let cleanShutdown = false;
    try { const r = await sidecarFetch(this.port, "/shutdown"); cleanShutdown = r?.ok === true; } catch { /* may exit before replying */ }
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, 3000))]);
    const killed = this.proc.exitCode === null;
    if (killed) { try { this.proc.kill("SIGKILL"); } catch { /* gone */ } }
    // Only upload a CLEANLY checkpointed file. If we had to SIGKILL (or shutdown
    // failed), the on-disk file may be mid-write/torn — keep the last good S3
    // snapshot rather than overwrite it with a corrupt one.
    if (cleanShutdown && !killed && this.store && existsSync(this.file)) {
      await this.store.upload(this.key, new Uint8Array(readFileSync(this.file)));
    }
    rmSync(this.file, { force: true });
    this.proc = null; this.port = null; this.exited = null;
  }

  get queuePort(): number | null { return this.port; }

  /** Restore-from-S3 (if cold) → spawn sidecar → /init. Idempotent + reentrancy-safe. */
  private ensuring: Promise<void> | null = null;
  private async ensure(): Promise<void> {
    if (this.proc) return;
    // Single-flight: a concurrent configure()/query() must not double-spawn.
    if (this.ensuring) return this.ensuring;
    this.ensuring = this.doEnsure().finally(() => { this.ensuring = null; });
    return this.ensuring;
  }

  private async doEnsure(): Promise<void> {
    if (this.proc) return;
    if (!this.cfg || !this.store) throw new Error("workspace not configured — call configure() first");

    mkdirSync(resolve(this.file, ".."), { recursive: true });
    if (!existsSync(this.file)) {
      const bytes = await this.store.download(this.key);
      if (bytes) writeFileSync(this.file, bytes);
      // absent → first-ever session: the sidecar creates a fresh encrypted DB on ATTACH.
    }

    const port = await freePort();
    // MINIMAL env: do NOT inherit the parent process.env — the agent can read the
    // sidecar's own environment (e.g. read_blob('/proc/self/environ')) since
    // LocalFileSystem can't be disabled while quack needs it. Pass only what the
    // child needs: PATH (tsx/node), HOME (~/.duckdb extension cache), and the two
    // sidecar vars. Workspace key + lake token arrive over the loopback /init POST,
    // never via env; S3 creds never enter this process at all.
    const proc = spawn(TSX_BIN, [SIDECAR_SCRIPT], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        SIDECAR_PORT: String(port),
        DB_FILE: this.file,
      },
      stdio: "ignore",
    });
    liveSidecars.add(proc);
    this.proc = proc;
    this.port = port;
    this.exited = new Promise<void>((res) => proc.once("exit", () => { liveSidecars.delete(proc); res(); }));

    try {
      let healthy = false;
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) { healthy = true; break; } } catch { /* not up */ }
      }
      if (!healthy) throw new Error("workspace sidecar did not become healthy");

      await sidecarFetch(port, "/init", {
        key: this.cfg.workspaceKey,
        lakeProxy: this.cfg.lakeProxy,
        lakeToken: this.cfg.lakeToken,
        disableSsl: this.cfg.disableSsl ?? false,
      });
    } catch (err) {
      // Failed to come up / init: tear the orphan down + reset so a retry re-spawns.
      try { proc.kill("SIGKILL"); } catch { /* gone */ }
      liveSidecars.delete(proc);
      this.proc = null; this.port = null; this.exited = null;
      throw err;
    }
  }
}
