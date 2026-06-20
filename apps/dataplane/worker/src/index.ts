// waddling DATA PLANE — one worker, two private Container DOs, exposed to control-api
// + mcp-external over a SERVICE BINDING. Productionizes the proven cf-stagec-loop-probe
// topology IN PLACE (keeping both DOs same-worker, because the outbound handler reaching
// a CROSS-worker DO binding is unproven and this is the security chokepoint).
//
// THE INVARIANT (unchanged): agent SQL reaches the lake through exactly one path — the
// WorkspaceSandbox's locked DuckDB ATTACHes quack:443 to a PRIVATE GatewayDO, gated by
// birdshot_authorize. This worker is the single service-binding front for BOTH:
//   • the workspace lifecycle  — /configure /query /run /snapshot /end  (mcp-external
//     drives queries; control-api drives configure with the vended key + session JWT);
//   • the gateway control plane — /gw/snapshot /gw/status /gw/revoke  (control-api's
//     gateway-client pushes the birdshot ACL snapshot + RS256 JWKS here).
//
// MERGE of proven code:
//   • WorkspaceSandbox = ws-probe Model-B (DO mints presigned R2 URLs from Secrets-Store
//     creds; the sidecar does its OWN encrypted-file I/O — no creds in the container) +
//     loop-probe outbound routing (the one quack:443 egress → GatewayDO via binding).
//   • GatewayDO = the real packages/gateway in a container (quack_serve + birdshot),
//     keyed PER ENDPOINT.
//   • Both container images reused unchanged by Dockerfile path.
//
// PER-ENDPOINT GATEWAY ROUTING (new vs the loop-probe's single GW_ID): the workspace's
// outbound handler gets only (request, env) — no DO state — so the target endpoint must
// travel through the allowlisted HOST. configure sets lakeProxy = gw-<endpointId>.internal
// :443, allowlists that host, and maps it to the handler; the handler parses <endpointId>
// back out of the host and routes to GatewayDO `gw:<endpointId>`.

import { getSandbox, Sandbox, ContainerProxy } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import { AwsClient } from "aws4fetch";
import { importJWK, SignJWT, type JWK } from "jose";
import { createHash } from "node:crypto";

export { ContainerProxy };

interface Env {
  GATEWAY: DurableObjectNamespace<GatewayDO>;
  // The per-datalake autoscaling director (plain DO). One instance per datalake id; owns the
  // gateway replica pool, the load-based scale decision, and the fail-safe snapshot-arming
  // invariant. It is on the CONTROL path (cheap decisions), never the data path (bytes).
  GATEWAY_POOL: DurableObjectNamespace<GatewayPoolDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceSandbox>;
  // Per-org quackboard: a single-writer governed DuckDB (no lake), one container per org.
  QUACKBOARD: DurableObjectNamespace<QuackboardDO>;
  R2_ACCESS_KEY_ID: { get(): Promise<string> };
  R2_SECRET_ACCESS_KEY: { get(): Promise<string> };
  R2_ENDPOINT: string;
  R2_BUCKET: string;
  R2_REGION: string;
  R2_HOST: string;
  WADDLING_ENV: string;
}

// ── ports / ids ────────────────────────────────────────────────────────────────
const GW_FWD_PORT = 8080;       // gateway forwarder (proxies non-/ctrl → quack:9500)
const WS_SIDECAR_PORT = 8080;   // workspace sidecar control port (its own container)
const GW_DIR = "/opt/gateway";
// Quackboard: one DO/container per org (single writer); its durable DuckDB lives at a fixed
// container path, restored from / persisted to R2 at the control-plane-assigned r2Key.
const quackboardDoId = (orgId: string): string => `qb:${orgId}`.toLowerCase();
const QB_DB_PATH = "/var/lib/waddling/quackboard.duckdb";
const QB_LOCAL_QUACK = "quack:localhost:9500"; // the in-container quack server (QUACK_PORT)
const BOOT_CMD = `node --import tsx ${GW_DIR}/entrypoint.mjs`;
const WS_SIDECAR_CMD = "node --use-system-ca /opt/workspace/workspace-sidecar.mjs";
const PRESIGN_TTL_SEC = 3600;   // covers a full session (≤1h); R2 max is 7d. Sessions
                                 // longer than this need a periodic re-/init refresh (a
                                 // production follow-up; the DO holds the creds to do it).

// PER-DATALAKE gateway addressing. The host is symbolic (never DNS-resolved — the
// outbound handler short-circuits it into a gateway replica DO).
const gatewayHost = (datalakeId: string): string => `gw-${datalakeId}.internal`;
function endpointFromGatewayHost(host: string): string | null {
  const m = /^gw-(.+)\.internal$/.exec(host);
  return m ? m[1] : null;
}

// LEGACY static gateway key (one DO per datalake, ran forever). Replaced by the replica
// pool below; retained only so /gw/teardown-legacy can destroy the abandoned DOs on cutover.
const legacyGatewayDoId = (datalakeId: string): string => `gw:${datalakeId}`;

// ── gateway pool (autoscaling) ──────────────────────────────────────────────────
// A datalake's gateway compute is an ephemeral POOL of replica containers, created on
// demand by load and slept (scaled to zero) when idle. Each replica is a GatewayDO keyed
// `gwpool:<datalakeId>:<n>`; the per-datalake GatewayPoolDO director owns which n's are live.
const MAX_REPLICAS = 4;          // hard cap on concurrent replicas per datalake
const TARGET_CONCURRENCY = 8;    // in-flight queries per replica before spilling to a new one
const replicaDoId = (datalakeId: string, n: number): string => `gwpool:${datalakeId}:${n}`.toLowerCase();
const getPool = (env: Env, datalakeId: string): DurableObjectStub<GatewayPoolDO> =>
  env.GATEWAY_POOL.get(env.GATEWAY_POOL.idFromName(datalakeId));

// DO id + R2 object key for a (workspace, agent). Lowercased (the SDK warns uppercase
// breaks case-insensitive preview hostnames). Object key is CONSTANT across sessions so
// a cold restore on a different DO instance hits the same R2 object.
// Deterministic ≤63-char Sandbox DO id for a (workspace, agent). The raw
// `${workspaceId}:${agentId}` (two UUIDs) is 73 chars — over the SDK's 63-char limit — so
// hash it. The R2 object key (workspaceObjectKey) still uses the ids separately, so a cold
// restore on a different DO instance hits the same object regardless of this id.
const wsDoId = (workspaceId: string, agentId: string): string =>
  createHash("sha256").update(`${workspaceId}:${agentId}`).digest("hex").slice(0, 48);
const workspaceObjectKey = (workspaceId: string, agentId: string): string => `workspace/${workspaceId}/db/${agentId}.duckdb`;

// ── DO classes ─────────────────────────────────────────────────────────────────
// GatewayDO: the TRUSTED gateway. enableInternet=true so ALL egress ports leave the
// container — the production catalog is ducklake:postgres on :5432 (raw PG wire) plus
// R2 on :443. The gateway holds the lake creds and is the trusted side; only the
// WORKSPACE is locked down (enableInternet=false + deny-by-default allowlist + the one
// quack:443 tunnel). The SDK default would pass only 80/443/DNS, blocking the catalog.
export class GatewayDO extends Sandbox<Env> {
  enableInternet = true;
  // Scale-to-zero: an idle gateway replica container sleeps after this window, freeing its
  // slot. Waking is cold (the /tmp marker + quack_serve process are gone) — ensureGateway
  // re-boots and the director re-applies the birdshot snapshot before the replica serves.
  sleepAfter = "5m";
}

export class WorkspaceSandbox extends Sandbox<Env> {
  enableInternet = false;
  interceptHttps = true;
  allowedHosts: string[] = [];
}

// The one allowlisted quack:443 egress from a workspace is intercepted and handed here;
// forward it into the PER-ENDPOINT private gateway container's :8080 forwarder (which
// proxies non-/ctrl paths to quack_serve:9500) via the same-worker GATEWAY binding.
// `env` is the live ContainerProxy env (2nd arg) so the binding is callable.
(WorkspaceSandbox as unknown as {
  outboundHandlers: Record<string, (request: Request, env: Env) => Promise<Response>>;
}).outboundHandlers = {
  toGateway: async (request: Request, env: Env): Promise<Response> => {
    const u = new URL(request.url);
    const datalakeId = endpointFromGatewayHost(u.hostname);
    if (!datalakeId) return new Response(`bad gateway host: ${u.hostname}`, { status: 502 });
    // Ask the director for a replica. It scales under load and GUARANTEES the chosen replica is
    // armed with the current birdshot snapshot before returning — so a woken/cold gateway can
    // never serve this query with a stale/empty ACL set (the fail-safe).
    const pool = getPool(env, datalakeId);
    const picked = await pool.pickReplica(datalakeId);
    if (!picked.replicaKey) return new Response(picked.error ?? "no gateway replica", { status: 503 });
    const gw = getSandbox(env.GATEWAY, picked.replicaKey, { sleepAfter: GATEWAY_SLEEP_AFTER }) as unknown as {
      containerFetch(url: string, init: RequestInit, port?: number): Promise<Response>;
    };
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => { headers[k] = v; });
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const body = hasBody ? new Uint8Array(await request.arrayBuffer()) : undefined;
    try {
      return await gw.containerFetch(`http://gw${u.pathname}${u.search}`, { method: request.method, headers, body }, GW_FWD_PORT);
    } finally {
      // Release the in-flight slot. The outbound handler has no ctx for waitUntil; the release
      // RPC is cheap and does not consume the (already-returned) response body stream.
      try { await pool.release(picked.replicaKey); } catch { /* best-effort load bookkeeping */ }
    }
  },
};

// ── cold-boot retry (proven in ws-probe) ───────────────────────────────────────
const BOOT_RACE = /invalidated by a container stop|container (is )?(stop|not running|starting)|no (running )?instance|default session/i;
async function withBootRetry<T>(fn: () => Promise<T>, label: string, tries = 15, delayMs = 2500): Promise<T> {
  let lastErr = "";
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!BOOT_RACE.test(msg)) throw e;
      lastErr = msg;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`${label}: still racing container boot after ${tries} tries: ${lastErr}`);
}

// ── SDK handle shapes ──────────────────────────────────────────────────────────
interface GatewayHandle {
  exec(cmd: string): Promise<{ stdout: string }>;
  startProcess(cmd: string, opts?: { cwd?: string; env?: Record<string, string> }): Promise<unknown>;
  containerFetch(url: string, init: RequestInit, port?: number): Promise<Response>;
}

// Per-endpoint gateway boot config (the trusted side — it holds the lake creds). Sent by
// control-api on /gw/snapshot, translated to per-process env injected at startProcess so
// the entrypoint's loadGatewayConfig-shaped reader boots the REAL lake instead of the
// offline demo. Absent ⇒ the entrypoint falls back to the deterministic selftest seed.
interface GatewayBoot {
  serverToken?: string;
  catalogDsn?: string;        // postgres catalog DSN (real lake)
  catalogFile?: string;       // local-file catalog (demo/selftest)
  dataPath?: string;          // 's3://bucket/prefix/' (real) or a local dir
  metadataSchema?: string;    // per-endpoint isolation inside a shared org catalog
  alias?: string;             // lake ATTACH alias (default 'lake')
  encrypted?: boolean;
  s3?: {
    endpoint?: string; keyId?: string; secret?: string; sessionToken?: string;
    region?: string; useSsl?: boolean; urlStyle?: 'path' | 'vhost';
  };
  // Quackboard: serve the opened database directly (no lake ATTACH). r2Key is informational
  // here (the DO restores/persists the file); QUACKBOARD + DUCKDB_DATABASE_PATH drive the boot.
  quackboard?: boolean;
  r2Key?: string;
}

/** Translate a GatewayBoot descriptor into the entrypoint's per-process env. Only set keys
 *  that are present — the entrypoint supplies sane defaults and the selftest fallback. */
function bootEnvFromConfig(boot?: GatewayBoot): Record<string, string> | undefined {
  if (!boot) return undefined;
  const env: Record<string, string> = {};
  const set = (k: string, v: unknown) => { if (v !== undefined && v !== null && v !== '') env[k] = String(v); };
  set('GW_SERVER_TOKEN', boot.serverToken);
  if (boot.quackboard) {
    // No lake: boot birdshot + serve quack against the restored .duckdb file.
    // No DUCKLAKE_ALIAS — birdshot resolves unqualified table refs against the
    // DuckDB default catalog, not a lake alias.
    env.QUACKBOARD = 'true';
    env.DUCKDB_DATABASE_PATH = QB_DB_PATH;
    return env;
  }
  set('DUCKLAKE_CATALOG_DSN', boot.catalogDsn);
  set('DUCKLAKE_CATALOG_FILE', boot.catalogFile);
  set('DUCKLAKE_DATA_PATH', boot.dataPath);
  set('DUCKLAKE_METADATA_SCHEMA', boot.metadataSchema);
  set('DUCKLAKE_ALIAS', boot.alias);
  if (boot.encrypted) env.DUCKLAKE_ENCRYPTED = 'true';
  if (boot.s3) {
    set('S3_ENDPOINT', boot.s3.endpoint);
    set('S3_KEY_ID', boot.s3.keyId);
    set('S3_SECRET', boot.s3.secret);
    set('S3_SESSION_TOKEN', boot.s3.sessionToken);
    set('S3_REGION', boot.s3.region);
    if (boot.s3.useSsl !== undefined) env.S3_USE_SSL = boot.s3.useSsl ? 'true' : 'false';
    set('S3_URL_STYLE', boot.s3.urlStyle);
  }
  return env;
}
interface WsHandle {
  exec(cmd: string): Promise<{ stdout: string; stderr?: string }>;
  startProcess(cmd: string, opts?: { cwd?: string }): Promise<unknown>;
  containerFetch(url: string, init: RequestInit, port?: number): Promise<Response>;
  setAllowedHosts(hosts: string[]): Promise<void>;
  setOutboundByHost(host: string, handlerName: string): Promise<void>;
  destroy(): Promise<void>;
}

// ── gateway helpers ────────────────────────────────────────────────────────────
async function ensureGateway(gw: GatewayHandle, bootEnv?: Record<string, string>): Promise<{ waitedMs: number; coldBooted: boolean }> {
  const marker = await withBootRetry(() => gw.exec("test -f /tmp/gw-started && echo yes || echo no"), "gw warmup");
  // A slept/woken container loses its /tmp marker AND its loaded birdshot config (the process
  // is gone), so an absent marker means COLD: the caller MUST re-apply the snapshot before the
  // replica serves any agent query (fail-safe — never serve with a stale/empty ACL set).
  const coldBooted = marker.stdout.trim() !== "yes";
  if (coldBooted) {
    await gw.exec("touch /tmp/gw-started");
    // bootEnv carries the per-datalake lake config (catalog DSN, metadata schema, s3 creds).
    // A HOT gateway is NOT re-bootstrapped — its config is fixed at first boot.
    await gw.startProcess(BOOT_CMD, { cwd: GW_DIR, env: bootEnv });
  }
  const start = Date.now();
  let lastErr = "";
  while (Date.now() - start < 90_000) {
    try {
      const r = await gw.containerFetch("http://gw/healthz", { method: "GET" }, GW_FWD_PORT);
      if (r.ok) return { waitedMs: Date.now() - start, coldBooted };
      lastErr = `healthz ${r.status}`;
    } catch (e) { lastErr = e instanceof Error ? e.message : String(e); }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`gateway not healthy in 90s: ${lastErr}`);
}

async function gwFwd(gw: GatewayHandle, path: string, init: RequestInit): Promise<{ status: number; json: any }> {
  const r = await gw.containerFetch(`http://gw${path}`, init, GW_FWD_PORT);
  const txt = await r.text();
  let json: any = txt;
  try { json = txt ? JSON.parse(txt) : {}; } catch { /* keep raw */ }
  return { status: r.status, json };
}

// ── Quackboard: per-org governed DuckDB (no lake), single writer, R2-durable ─────
// Same container image + entrypoint as the gateway, but booted with QUACKBOARD=1 so it serves
// its restored .duckdb file directly (birdshot still loaded + enforcing). enableInternet=true
// so the container can reach R2:443 to restore/persist the durable file.
export class QuackboardDO extends Sandbox<Env> {
  enableInternet = true;
  sleepAfter = "10m";
}

interface QbHandle {
  exec(cmd: string): Promise<{ stdout: string; stderr?: string }>;
  startProcess(cmd: string, opts?: { cwd?: string; env?: Record<string, string> }): Promise<unknown>;
  containerFetch(url: string, init: RequestInit, port?: number): Promise<Response>;
  destroy(): Promise<void>;
}

const qbSandbox = (env: Env, orgId: string): QbHandle =>
  getSandbox(env.QUACKBOARD, quackboardDoId(orgId), { sleepAfter: "10m" }) as unknown as QbHandle;

// base64 (utf-8 safe) so arbitrary SQL crosses `exec` with no shell escaping; single-quote
// for the shell (presigned URLs carry & = ?). base64 output is itself shell-safe.
const b64 = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

// In-container quack client (the image has @duckdb/node-api, NOT the duckdb CLI). Runs the
// agent SQL through quack_query against the local server with the JWT as the token, so
// birdshot authenticates + authorizes. SQL/TOKEN arrive base64 in env (no shell/SQL-literal
// escaping in the command); the client decodes and doubles quotes for the quack_query literal.
// Run from /opt/gateway via `node --input-type=module` over stdin (cwd resolves the package).
const QB_CLIENT_JS = `
import { DuckDBInstance } from '@duckdb/node-api';
const dec = (b) => Buffer.from(b || '', 'base64').toString('utf8');
const sql = dec(process.env.SQL_B64), token = dec(process.env.TOKEN_B64);
const lit = (s) => s.replace(/'/g, "''");
const inst = await DuckDBInstance.create(':memory:', { allow_unsigned_extensions: 'true' });
const con = await inst.connect();
await con.run('INSTALL quack; LOAD quack;');
const reader = await con.runAndReadAll("FROM quack_query('${QB_LOCAL_QUACK}', '" + lit(sql) + "', token => '" + lit(token) + "')");
const objs = reader.getRowObjects();
const columns = objs.length ? Object.keys(objs[0]) : [];
const rows = objs.map((o) => columns.map((c) => o[c]));
process.stdout.write(JSON.stringify({ columns, rows }, (k, v) => typeof v === 'bigint' ? Number(v) : v));
`;

/** Boot the quackboard container: restore the durable file from R2 (404 ⇒ fresh), start the
 *  gateway entrypoint with QUACKBOARD=1 (birdshot loaded, no lake, schema bootstrapped on the
 *  control connection by duck.ts), wait for health. Cold-only startProcess; a hot container is
 *  reused. The single-writer model means exactly one container per org is correct. */
async function ensureQuackboard(env: Env, orgId: string, boot: GatewayBoot): Promise<{ coldBooted: boolean }> {
  const qb = qbSandbox(env, orgId);
  await withBootRetry(() => qb.exec("echo ready"), `qb warmup ${orgId}`);
  const marker = await qb.exec("test -f /tmp/qb-started && echo yes || echo no");
  const coldBooted = marker.stdout.trim() !== "yes";
  if (coldBooted) {
    await qb.exec("touch /tmp/qb-started");
    await qb.exec(`mkdir -p ${QB_DB_PATH.replace(/\/[^/]+$/, "")}`);
    // Restore the durable file. -f ⇒ curl fails on 404; on any failure clear the path so the
    // entrypoint opens a fresh DuckDB and bootstraps the schema from scratch.
    if (boot.r2Key) {
      const get = await mintPresigned(env, "GET", boot.r2Key);
      await qb.exec(`curl -fsS -o ${QB_DB_PATH} ${shq(get)} || rm -f ${QB_DB_PATH}`);
    }
    await qb.startProcess(BOOT_CMD, { cwd: GW_DIR, env: bootEnvFromConfig(boot) });
  }
  const start = Date.now();
  let lastErr = "";
  while (Date.now() - start < 90_000) {
    try {
      const r = await qb.containerFetch("http://gw/healthz", { method: "GET" }, GW_FWD_PORT);
      if (r.ok) return { coldBooted };
      lastErr = `healthz ${r.status}`;
    } catch (e) { lastErr = e instanceof Error ? e.message : String(e); }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`quackboard not healthy in 90s: ${lastErr}`);
}

/** Forward a /ctrl/* control-channel call (e.g. the birdshot snapshot push) to the quackboard
 *  container's forwarder — same mechanism as gwFwd, addressed by orgId. */
async function qbFwd(env: Env, orgId: string, path: string, init: RequestInit): Promise<{ status: number; json: any }> {
  const r = await qbSandbox(env, orgId).containerFetch(`http://gw${path}`, init, GW_FWD_PORT);
  const txt = await r.text();
  let json: any = txt;
  try { json = txt ? JSON.parse(txt) : {}; } catch { /* keep raw */ }
  return { status: r.status, json };
}

/** Run governed SQL against the in-container quack server AS the agent: the session JWT is the
 *  quack TOKEN, so birdshot authenticates + authorizes. Uses an in-container duckdb quack_query
 *  client (the stateless path the prototype proved). Returns {columns, rows, rowCount}. */
async function qbQuery(env: Env, orgId: string, sql: string, token: string): Promise<{ status: number; json: any }> {
  const cmd =
    `cd /opt/gateway && SQL_B64=${b64(sql)} TOKEN_B64=${b64(token)} ` +
    `sh -c 'echo ${b64(QB_CLIENT_JS)} | base64 -d | node --input-type=module'`;
  const r = await qbSandbox(env, orgId).exec(cmd);
  const out = (r.stdout ?? "").trim();
  try {
    const j = JSON.parse(out);
    return { status: 200, json: { columns: j.columns ?? [], rows: j.rows ?? [], rowCount: (j.rows ?? []).length } };
  } catch {
    // birdshot denial / SQL error surfaces on stderr (not valid JSON) → structured envelope.
    return { status: 500, json: { error: "query_failed", reason: (r.stderr ?? out ?? "").trim() } };
  }
}

/** Private per-agent memory — TRUSTED, narrow-typed ops forwarded to the container's
 *  /ctrl/qb-remember | /ctrl/qb-mine (fixed SQL, agentRole bound by the control plane).
 *  agent_memory has NO birdshot grant, so it is unreachable from the gated quack path;
 *  these are the only way in. boot is ensured first so a cold/slept org still serves. */
async function qbRemember(
  env: Env, orgId: string, boot: GatewayBoot, agentRole: string, key: string | undefined, content: string,
): Promise<{ status: number; json: any }> {
  await ensureQuackboard(env, orgId, boot);
  return qbFwd(env, orgId, "/ctrl/qb-remember", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentRole, key, content }),
  });
}
async function qbMine(
  env: Env, orgId: string, boot: GatewayBoot, agentRole: string, key: string | undefined, limit: number | undefined,
): Promise<{ status: number; json: any }> {
  await ensureQuackboard(env, orgId, boot);
  return qbFwd(env, orgId, "/ctrl/qb-mine", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentRole, key, limit }),
  });
}

/** Shared-corpus BM25 recall — TRUSTED typed op (observations is shared; ranked recall over it
 *  adds no per-agent governance and dodges birdshot's fts-internal-table bind-walk). */
async function qbRecall(
  env: Env, orgId: string, boot: GatewayBoot, term: string, limit: number | undefined,
): Promise<{ status: number; json: any }> {
  await ensureQuackboard(env, orgId, boot);
  return qbFwd(env, orgId, "/ctrl/qb-recall", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ term, limit }),
  });
}

/** Drain birdshot's process-global audit log from the org's quackboard container (destructive,
 *  exactly-once per record). The control plane persists each record as an audit_event. */
async function qbAuditDrain(env: Env, orgId: string): Promise<{ status: number; json: any }> {
  return qbFwd(env, orgId, "/ctrl/audit-drain", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
}

/** Fold the WAL into the file (best-effort CHECKPOINT via the un-gated /ctrl channel) then
 *  upload it to R2. Bounded-staleness durability: call on a schedule and on disconnect. The
 *  /ctrl/checkpoint endpoint is a container-side follow-up; if absent, the upload still runs. */
async function qbPersist(env: Env, orgId: string, r2Key: string): Promise<{ ok: boolean }> {
  const qb = qbSandbox(env, orgId);
  try { await qb.containerFetch("http://gw/ctrl/checkpoint", { method: "POST" }, GW_FWD_PORT); }
  catch { /* ctrl/checkpoint optional until the container exposes it */ }
  const put = await mintPresigned(env, "PUT", r2Key);
  const r = await qb.exec(`curl -fsS -X PUT --data-binary @${QB_DB_PATH} ${shq(put)} && echo OK || echo FAIL`);
  return { ok: /OK\s*$/.test(r.stdout ?? "") };
}

// End-to-end remote proof of the quackboard data plane: boot → birdshot snapshot → observe
// (gated write) → recall (gated read) → persist to R2 → force cold boot → restore → recall.
// Proves container orchestration, the birdshot-gated write+read path, AND the R2 durability
// round-trip in one verdict. Self-contained (mints its own JWT/JWKS); touches no real org.
async function qbSelftest(env: Env): Promise<Response> {
  // Fresh org id per run → a never-seen DO that ALWAYS cold-boots on the latest image with a
  // clean R2 key (404 → fresh bootstrap). Avoids destroying a hot container (which would
  // restore a stale/bad file and fail healthz) and avoids serving stale code from a warm one.
  const orgId = `qb-selftest-${crypto.randomUUID().slice(0, 8)}`;
  const r2Key = `quackboard/${orgId}/quackboard.duckdb`;
  const boot: GatewayBoot = { serverToken: "srv_qbselftest", alias: "quackboard", quackboard: true, r2Key };
  const marker = `mk-${crypto.randomUUID()}`;
  const { auth, jwt } = await mintSelftestAuthAndJwt();
  const snapshot = {
    userRoles: [{ userId: `agent:${ST_AGENT}`, role: `agent_${ST_AGENT}` }],
    roleGrants: [
      { role: `agent_${ST_AGENT}`, tableRef: "main.observations", action: "read" },
      { role: `agent_${ST_AGENT}`, tableRef: "main.observations", action: "write" },
    ],
  };
  const pushSnapshot = () => qbFwd(env, orgId, "/ctrl/snapshot", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshot, auth }),
  });
  const steps: Record<string, unknown> = {};
  try {
    steps.boot1 = await ensureQuackboard(env, orgId, boot);
    steps.snapshot1 = (await pushSnapshot()).json;
    // Verify birdshot has the right mode + catalog before querying.
    const st1 = await qbFwd(env, orgId, "/ctrl/status", { method: "GET" });
    steps.birdshotStatus = st1.json;
    // Probes (through the gated quack path): what catalog does the serving connection use,
    // and where does `observations` actually live? Pinpoints catalog/resolution vs authz.
    steps.probeCatalog = (await qbQuery(env, orgId, "SELECT current_database() AS db, current_schema() AS sch", jwt)).json;
    steps.probeTableLoc = (await qbQuery(env, orgId, "SELECT database_name, schema_name FROM duckdb_tables() WHERE table_name='observations'", jwt)).json;
    // Drain any warm-start audit noise before the real steps.
    try { await qbFwd(env, orgId, "/ctrl/audit-drain", { method: "POST" }); } catch {}
    steps.observe = (await qbQuery(env, orgId, `INSERT INTO observations(agent_role, content) VALUES ('${ST_AGENT}', '${marker}')`, jwt)).json;
    steps.audit1 = (await qbFwd(env, orgId, "/ctrl/audit-drain", { method: "POST" })).json;
    steps.recallBefore = (await qbQuery(env, orgId, `SELECT content FROM observations WHERE content = '${marker}'`, jwt)).json;
    steps.persist = await qbPersist(env, orgId, r2Key);
    // force a true cold boot: destroy the container so the next ensure restores from R2.
    try { await qbSandbox(env, orgId).destroy(); } catch { /* already gone */ }
    steps.boot2 = await ensureQuackboard(env, orgId, boot);
    steps.snapshot2 = (await pushSnapshot()).json; // a cold gateway lost its in-memory policy
    const after = (await qbQuery(env, orgId, `SELECT content FROM observations WHERE content = '${marker}'`, jwt)).json;
    steps.recallAfter = after;
    const durable = Array.isArray(after?.rows) && after.rows.some((r: unknown[]) => String(r?.[0]) === marker);
    return Response.json({
      marker, durable,
      verdict: durable
        ? "QUACKBOARD-REMOTE-PASS — gated write+read survived the R2 cold-boot round-trip"
        : "FAIL — see steps",
      steps,
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e), steps }, { status: 500 });
  }
}

// ── GatewayPoolDO: the per-datalake autoscaling director ─────────────────────────
// One instance per datalake (keyed by datalake id). Owns the gateway replica pool: it makes
// the load-based scale decision, guarantees the fail-safe snapshot invariant (a replica NEVER
// serves an agent query before the CURRENT birdshot snapshot is applied), and reports the
// runtime status (asleep/running). It stays on the CONTROL path — it decides + arms; the
// worker forwards the query bytes directly to the chosen replica. The cached snapshot + lake
// bootEnv are persisted (DO storage, encrypted at rest) so a woken director can re-arm a cold
// replica without a control-api round-trip.

interface PoolCache {
  snapshot: unknown;
  auth: unknown;
  lakeCatalog?: string;
  bootEnv?: Record<string, string>;
}
interface ReplicaRec { appliedVersion: number; lastActiveAt: number; }
type ReplicaMap = Record<number, ReplicaRec>;

const POOL_WARM_WINDOW_MS = 4 * 60_000;   // < sleepAfter(5m): touched within this ⇒ certainly awake
const POOL_IDLE_WINDOW_MS = 6 * 60_000;   // > sleepAfter(5m): no activity within this ⇒ asleep
const GATEWAY_SLEEP_AFTER = "5m";

function replicaIndexFromKey(replicaKey: string): number {
  const n = Number(replicaKey.slice(replicaKey.lastIndexOf(":") + 1));
  return Number.isFinite(n) ? n : 0;
}

export class GatewayPoolDO extends DurableObject<Env> {
  // In-memory only (lost on director hibernation — correctly, since a slept director had no
  // in-flight work): live load + boot dedup per replica index.
  private inFlight = new Map<number, number>();
  private booting = new Map<number, Promise<void>>();
  private datalakeId = "";

  private async meta(): Promise<{ currentVersion: number }> {
    return (await this.ctx.storage.get<{ currentVersion: number }>("meta")) ?? { currentVersion: 0 };
  }
  private async replicas(): Promise<ReplicaMap> {
    return (await this.ctx.storage.get<ReplicaMap>("replicas")) ?? {};
  }

  /** Cache the newest snapshot, bump the version, and eagerly (re)arm live replicas so an ACL
   *  change takes effect immediately on warm replicas (cold ones re-arm lazily on next pick).
   *  Pre-warms replica 0 — this is the connect-time push, mirroring the old boot-on-snapshot. */
  async applySnapshot(datalakeId: string, payload: PoolCache): Promise<{ version: number; status: number }> {
    this.datalakeId = datalakeId;
    const { currentVersion } = await this.meta();
    const version = currentVersion + 1;
    await this.ctx.storage.put("cache", payload);
    await this.ctx.storage.put("meta", { currentVersion: version });

    const reps = await this.replicas();
    if (!(0 in reps)) reps[0] = { appliedVersion: 0, lastActiveAt: 0 };
    await this.ctx.storage.put("replicas", reps);

    // Eager fan-out: replica 0 always (pre-warm); any other recently-live replica too. Failures
    // are tolerated — a replica that slept resets to appliedVersion 0 and re-arms on next pick.
    let status = 200;
    const now = Date.now();
    for (const k of Object.keys(reps)) {
      const n = Number(k);
      const stale = now - reps[n].lastActiveAt > POOL_IDLE_WINDOW_MS;
      if (n !== 0 && stale) continue; // don't wake idle replicas just to fan out — lazy is correct
      try { await this.armReplica(n, /*force*/ true); } catch { status = 207; }
    }
    return { version, status };
  }

  /** Pick (or spawn) a replica under load and GUARANTEE it is armed with the current snapshot
   *  before returning. Increments in-flight; the worker releases after the query. Fail-closed:
   *  with no cached snapshot there are no ACLs, so we refuse to route (never serve open). */
  async pickReplica(datalakeId: string): Promise<{ replicaKey?: string; error?: string }> {
    this.datalakeId = datalakeId;
    const { currentVersion } = await this.meta();
    if (currentVersion === 0) return { error: "datalake gateway not configured (no snapshot)" };

    const reps = await this.replicas();
    const indices = Object.keys(reps).map(Number);
    const now = Date.now();
    const loadOf = (i: number) => this.inFlight.get(i) ?? 0;
    // Selection order keeps warm replicas busy before paying a cold boot:
    //   1. a WARM replica under target (no cold boot)         ← cheapest
    //   2. any existing replica under target (wakes a cold slot, reuses its DO)
    //   3. spawn the next index (scale up) if under the cap
    //   4. all saturated + capped → least-loaded overall (pile on)
    let n: number | null = null;
    let best = Infinity;
    for (const i of indices) {
      const load = loadOf(i);
      const warm = now - reps[i].lastActiveAt < POOL_IDLE_WINDOW_MS;
      if (warm && load < TARGET_CONCURRENCY && load < best) { best = load; n = i; }
    }
    if (n === null) {
      best = Infinity;
      for (const i of indices) {
        const load = loadOf(i);
        if (load < TARGET_CONCURRENCY && load < best) { best = load; n = i; }
      }
    }
    if (n === null && indices.length < MAX_REPLICAS) {
      n = indices.length ? Math.max(...indices) + 1 : 0;
      reps[n] = { appliedVersion: 0, lastActiveAt: 0 };
      await this.ctx.storage.put("replicas", reps);
    }
    if (n === null) {
      best = Infinity;
      for (const i of indices) { const load = loadOf(i); if (load < best) { best = load; n = i; } }
      n = n ?? 0;
    }

    // Reserve the slot (in-memory load only). Do NOT touch lastActiveAt here — doArm/release own
    // it, so a slept replica keeps its STALE timestamp and doArm's ensureGateway correctly detects
    // the cold container and re-applies the snapshot before this query is served (the fail-safe).
    this.inFlight.set(n, loadOf(n) + 1);
    try {
      await this.armReplica(n, /*force*/ false);
    } catch (e) {
      this.inFlight.set(n, Math.max(0, loadOf(n) - 1));
      return { error: `replica ${n} arm failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { replicaKey: replicaDoId(this.datalakeId, n) };
  }

  /** Decrement in-flight after the worker finishes forwarding a query to this replica. */
  async release(replicaKey: string): Promise<void> {
    const n = replicaIndexFromKey(replicaKey);
    this.inFlight.set(n, Math.max(0, (this.inFlight.get(n) ?? 1) - 1));
    const reps = await this.replicas();
    if (reps[n]) { reps[n].lastActiveAt = Date.now(); await this.ctx.storage.put("replicas", reps); }
  }

  /** Runtime status WITHOUT waking any replica: asleep when nothing has been active within the
   *  idle window (so a sleeping pool reports asleep), running otherwise. */
  async status(): Promise<{ state: "asleep" | "running" | "unconfigured"; replicas: number; inFlightTotal: number; version: number }> {
    const { currentVersion } = await this.meta();
    const reps = await this.replicas();
    const indices = Object.keys(reps).map(Number);
    const now = Date.now();
    let inFlightTotal = 0; for (const v of this.inFlight.values()) inFlightTotal += v;
    const anyWarm = inFlightTotal > 0 || indices.some((i) => now - reps[i].lastActiveAt < POOL_IDLE_WINDOW_MS);
    const state = currentVersion === 0 ? "unconfigured" : anyWarm ? "running" : "asleep";
    return { state, replicas: indices.length, inFlightTotal, version: currentVersion };
  }

  /** Forward-only birdshot revoke (jti/user/session denylist) to currently-warm replicas. Cold
   *  replicas have an empty denylist on their next boot, so they are skipped (nothing to revoke). */
  async revoke(datalakeId: string, args: { kind: string; id: string; reason?: string; expiresUs?: number }): Promise<{ ok: boolean; fanned: number }> {
    this.datalakeId = datalakeId;
    return this.fanOut("/ctrl/revoke", JSON.stringify(args));
  }
  async drainAudit(datalakeId: string): Promise<{ records: unknown[]; count: number }> {
    this.datalakeId = datalakeId;
    const reps = await this.replicas();
    const now = Date.now();
    const records: unknown[] = [];
    for (const k of Object.keys(reps)) {
      const n = Number(k);
      if (now - reps[n].lastActiveAt > POOL_IDLE_WINDOW_MS) continue; // cold ⇒ nothing ran ⇒ skip
      try {
        const gw = getSandbox(this.env.GATEWAY, replicaDoId(this.datalakeId, n), { sleepAfter: GATEWAY_SLEEP_AFTER }) as unknown as GatewayHandle;
        const r = await gwFwd(gw, "/ctrl/audit-drain", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        if (r.json?.records) records.push(...r.json.records);
      } catch { /* cold/raced — skip */ }
    }
    return { records, count: records.length };
  }

  /** Destroy every replica container for this datalake (hard reset / decommission). */
  async destroyAll(datalakeId: string): Promise<{ destroyed: number }> {
    this.datalakeId = datalakeId;
    const reps = await this.replicas();
    let destroyed = 0;
    for (const k of Object.keys(reps)) {
      try {
        const gw = getSandbox(this.env.GATEWAY, replicaDoId(this.datalakeId, Number(k))) as unknown as { destroy(): Promise<void> };
        await gw.destroy(); destroyed++;
      } catch { /* already gone */ }
    }
    await this.ctx.storage.deleteAll();
    this.inFlight.clear(); this.booting.clear();
    return { destroyed };
  }

  // ── pool-director reset (Step 4 of the gateway-lifecycle plan) ──────────────────
  // Two recovery ops for a corrupt/stale director state, distinct from destroyAll
  // (which tears down compute). Neither runs agent SQL; both are explicit admin actions.

  /** Clear the cached snapshot + reset currentVersion to 0. The director returns to
   *  'unconfigured': pickReplica refuses to route (fail-closed — no cached policy ⇒
   *  no ACLs ⇒ serve nothing) until the next /gw/snapshot re-establishes it. Warm
   *  replica CONTAINERS are left running but their in-memory birdshot policy is now
   *  untracked by the director; the next snapshot re-arms them. Use when the cached
   *  snapshot itself is suspected corrupt (a bad compile got pushed) — it forces a
   *  clean re-push from the control plane's source of truth. */
  async resetPool(datalakeId: string): Promise<{ ok: boolean; clearedReplicas: number }> {
    this.datalakeId = datalakeId;
    const reps = await this.replicas();
    const clearedReplicas = Object.keys(reps).length;
    await this.ctx.storage.delete("cache");
    await this.ctx.storage.put("meta", { currentVersion: 0 });
    // Mark every replica stale so doArm re-applies the (next) snapshot rather than
    // trusting a warm container's in-memory policy the director can no longer vouch for.
    for (const k of Object.keys(reps)) {
      reps[Number(k)] = { appliedVersion: 0, lastActiveAt: reps[Number(k)].lastActiveAt };
    }
    await this.ctx.storage.put("replicas", reps);
    return { ok: true, clearedReplicas };
  }

  /** Keep the cached snapshot + currentVersion but mark every replica as stale
   *  (appliedVersion=0). Warm containers stay up; the NEXT pick (or an explicit rearm)
   *  re-applies the SAME cached snapshot. Lighter than resetPool: the policy is fine,
   *  we just don't trust that the replicas actually have it loaded (e.g. after a suspected
   *  in-memory corruption on one replica, or to force a clean re-commit everywhere). */
  async clearSnapshot(datalakeId: string): Promise<{ ok: boolean; markedStale: number; version: number }> {
    this.datalakeId = datalakeId;
    const { currentVersion } = await this.meta();
    const reps = await this.replicas();
    const markedStale = Object.keys(reps).length;
    for (const k of Object.keys(reps)) {
      reps[Number(k)] = { appliedVersion: 0, lastActiveAt: reps[Number(k)].lastActiveAt };
    }
    await this.ctx.storage.put("replicas", reps);
    return { ok: true, markedStale, version: currentVersion };
  }

  private async fanOut(path: string, body: string): Promise<{ ok: boolean; fanned: number }> {
    const reps = await this.replicas();
    const now = Date.now();
    let fanned = 0;
    for (const k of Object.keys(reps)) {
      const n = Number(k);
      if (now - reps[n].lastActiveAt > POOL_IDLE_WINDOW_MS) continue;
      try {
        const gw = getSandbox(this.env.GATEWAY, replicaDoId(this.datalakeId, n), { sleepAfter: GATEWAY_SLEEP_AFTER }) as unknown as GatewayHandle;
        await gwFwd(gw, path, { method: "POST", headers: { "content-type": "application/json" }, body });
        fanned++;
      } catch { /* cold/raced — skip */ }
    }
    return { ok: true, fanned };
  }

  /** Guarantee replica n is booted AND carrying the current snapshot. Boot is deduped per index
   *  (concurrent picks await one boot). Hot path: a replica touched within the warm window whose
   *  applied version is current is trusted awake — no container round-trip. */
  private armReplica(n: number, force: boolean): Promise<void> {
    const existing = this.booting.get(n);
    if (existing) return existing;
    const p = this.doArm(n, force).finally(() => this.booting.delete(n));
    this.booting.set(n, p);
    return p;
  }

  private async doArm(n: number, force: boolean): Promise<void> {
    const { currentVersion } = await this.meta();
    const reps = await this.replicas();
    const rec = reps[n] ?? { appliedVersion: 0, lastActiveAt: 0 };
    const now = Date.now();
    const certainlyAwake = now - rec.lastActiveAt < POOL_WARM_WINDOW_MS;
    if (!force && rec.appliedVersion >= currentVersion && certainlyAwake) return; // hot path

    const cache = await this.ctx.storage.get<PoolCache>("cache");
    if (!cache) throw new Error("no cached snapshot");
    const gw = getSandbox(this.env.GATEWAY, replicaDoId(this.datalakeId, n), { sleepAfter: GATEWAY_SLEEP_AFTER }) as unknown as GatewayHandle;
    const { coldBooted } = await ensureGateway(gw, cache.bootEnv);
    const applied = coldBooted ? 0 : rec.appliedVersion; // a cold container lost its loaded config
    if (applied < currentVersion) {
      const r = await gwFwd(gw, "/ctrl/snapshot", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ snapshot: cache.snapshot, auth: cache.auth, lakeCatalog: cache.lakeCatalog ?? "memory" }),
      });
      if (r.status >= 300) throw new Error(`/ctrl/snapshot ${r.status}: ${JSON.stringify(r.json)}`);
    }
    reps[n] = { appliedVersion: currentVersion, lastActiveAt: now };
    await this.ctx.storage.put("replicas", reps);
  }

  // ── per-replica lifecycle RPCs (Step 3 of the gateway-lifecycle plan) ──────────
  // These are the ops-recovery levers for a single replica, exposed over the
  // service-binding /gw/replica/:n/{wake,sleep,destroy,rearm} routes. They DO NOT
  // run agent SQL and do NOT take in-flight load into account — they are explicit
  // admin actions. The director's load-based autoscaler (pickReplica) is unaffected.

  /** Force-boot replica n and arm it with the current snapshot. Creates the replica
   *  slot if missing (wake can bring up a specific index up to MAX_REPLICAS). This is
   *  the inverse of sleep: it guarantees a cold container is up + serving the current
   *  policy before returning. Used by the wake lifecycle route + the dashboard's
   *  "start replica" button. */
  async wakeReplica(datalakeId: string, n: number): Promise<{ replicaKey: string; appliedVersion: number }> {
    this.datalakeId = datalakeId;
    const { currentVersion } = await this.meta();
    if (currentVersion === 0) throw new Error("datalake gateway not configured (no snapshot)");
    if (n < 0 || n >= MAX_REPLICAS) throw new Error(`replica index ${n} out of range (0..${MAX_REPLICAS - 1})`);
    const reps = await this.replicas();
    if (!(n in reps)) {
      reps[n] = { appliedVersion: 0, lastActiveAt: 0 };
      await this.ctx.storage.put("replicas", reps);
    }
    await this.armReplica(n, /*force*/ true);
    const after = await this.replicas();
    return { replicaKey: replicaDoId(this.datalakeId, n), appliedVersion: after[n]?.appliedVersion ?? 0 };
  }

  /** Force a replica's container to stop (free its slot) while KEEPING the replica
   *  slot. The container is ephemeral, so "sleep" = destroy() it; the next pick/wake
   *  cold-boots a fresh one and re-applies the snapshot (appliedVersion reset to 0 so
   *  doArm knows to re-arm). Lighter than destroy: the slot + its index survive. */
  async sleepReplica(datalakeId: string, n: number): Promise<{ ok: boolean }> {
    this.datalakeId = datalakeId;
    const reps = await this.replicas();
    if (!(n in reps)) return { ok: false };
    try {
      const gw = getSandbox(this.env.GATEWAY, replicaDoId(this.datalakeId, n), { sleepAfter: GATEWAY_SLEEP_AFTER }) as unknown as { destroy(): Promise<void> };
      await gw.destroy();
    } catch { /* already gone / hibernated */ }
    // Reset to stale so the next access re-arms (cold-boot re-applies the snapshot —
    // the fail-safe). Keep the slot so the index is stable for ops.
    reps[n] = { appliedVersion: 0, lastActiveAt: 0 };
    await this.ctx.storage.put("replicas", reps);
    this.inFlight.delete(n);
    return { ok: true };
  }

  /** Destroy a replica's container AND remove its slot from the pool (scale down by
   *  one). Harder than sleep: the index is gone, so the next pick may re-spawn a
   *  different index. Use when a replica is wedged and sleep didn't recover it. */
  async destroyReplica(datalakeId: string, n: number): Promise<{ ok: boolean }> {
    this.datalakeId = datalakeId;
    const reps = await this.replicas();
    if (!(n in reps)) return { ok: false };
    try {
      const gw = getSandbox(this.env.GATEWAY, replicaDoId(this.datalakeId, n)) as unknown as { destroy(): Promise<void> };
      await gw.destroy();
    } catch { /* already gone */ }
    delete reps[n];
    await this.ctx.storage.put("replicas", reps);
    this.inFlight.delete(n);
    this.booting.delete(n);
    return { ok: true };
  }

  /** Force re-apply the director's CACHED snapshot to replica n (whether warm or
   *  cold). This is the director-level "re-arm": it does NOT re-fetch from the
   *  control plane, it re-pushes what the director already holds. Recovers a replica
   *  whose in-memory birdshot policy got corrupted but whose container is still hot,
   *  or forces a cold replica to re-arm without a pick. For a control-plane-sourced
   *  fresh policy, use /gw/snapshot (which updates the cache) instead. */
  async rearmReplica(datalakeId: string, n: number): Promise<{ ok: boolean; appliedVersion: number }> {
    this.datalakeId = datalakeId;
    const { currentVersion } = await this.meta();
    if (currentVersion === 0) throw new Error("datalake gateway not configured (no snapshot)");
    const reps = await this.replicas();
    if (!(n in reps)) throw new Error(`replica ${n} does not exist — wake it first`);
    await this.armReplica(n, /*force*/ true);
    const after = await this.replicas();
    return { ok: true, appliedVersion: after[n]?.appliedVersion ?? 0 };
  }

  /** Per-replica detail for the dashboard (Step 8): index, appliedVersion (vs the
   *  current), lastActiveAt, in-flight load, and a warm flag. Does NOT wake any
   *  container — derived from director state like status(). */
  async replicaStatus(): Promise<{
    version: number;
    replicas: Array<{ index: number; appliedVersion: number; current: boolean; lastActiveAt: number; inFlight: number; warm: boolean }>;
  }> {
    const { currentVersion } = await this.meta();
    const reps = await this.replicas();
    const now = Date.now();
    const out = Object.keys(reps).map(Number).sort((a, b) => a - b).map((n) => ({
      index: n,
      appliedVersion: reps[n].appliedVersion,
      current: reps[n].appliedVersion >= currentVersion,
      lastActiveAt: reps[n].lastActiveAt,
      inFlight: this.inFlight.get(n) ?? 0,
      warm: now - reps[n].lastActiveAt < POOL_WARM_WINDOW_MS,
    }));
    return { version: currentVersion, replicas: out };
  }
}

// ── presigned R2 (Model B; aws4fetch — from ws-probe) ──────────────────────────
async function mintPresigned(env: Env, method: "GET" | "PUT", key: string, expiresSec = PRESIGN_TTL_SEC): Promise<string> {
  const accessKeyId = await env.R2_ACCESS_KEY_ID.get();
  const secretAccessKey = await env.R2_SECRET_ACCESS_KEY.get();
  const client = new AwsClient({ accessKeyId, secretAccessKey, region: env.R2_REGION, service: "s3" });
  const url = new URL(`${env.R2_ENDPOINT}/${env.R2_BUCKET}/${key}`);
  url.searchParams.set("X-Amz-Expires", String(expiresSec));
  const signed = await client.sign(url.toString(), { method, aws: { signQuery: true } });
  return signed.url;
}

// ── workspace helpers ──────────────────────────────────────────────────────────
async function wsSidecar(ws: WsHandle, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await ws.containerFetch(`http://ws${path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }, WS_SIDECAR_PORT);
  const txt = await r.text();
  let json: any = txt;
  try { json = txt ? JSON.parse(txt) : {}; } catch { /* keep raw */ }
  return { status: r.status, json };
}

interface ConfigureArgs {
  workspaceId: string;
  agentId: string;
  endpointId: string;
  workspaceKey: string;   // 32-byte hex, control-plane-vended (NEVER persisted in the DO)
  lakeToken: string;      // session JWT, presented as the quack TOKEN
  disableSsl?: boolean;
  /** Lock the DuckDB configuration after /init (default true). Set false by the
   *  reconfigure lifecycle route so a workspace whose container survived can be
   *  re-ATTACHed without the "lock_configuration has been locked" 500. */
  lockConfiguration?: boolean;
}

/** Boot the workspace sidecar, wire per-endpoint egress, restore-from-R2 + ATTACH the
 *  lake. The DO mints the presigned URLs from Secrets-Store creds; the sidecar does its
 *  own file I/O. Returns whether the lake ATTACH succeeded. */
async function configureWorkspace(env: Env, args: ConfigureArgs): Promise<{ lakeAttached: boolean; initStatus: number }> {
  const id = wsDoId(args.workspaceId, args.agentId);
  const ws = getSandbox(env.WORKSPACE, id) as unknown as WsHandle;
  const gwHost = gatewayHost(args.endpointId);

  await withBootRetry(() => ws.exec("echo ready"), `ws warmup ${id}`);
  // Deny-by-default egress: ONLY the per-endpoint gateway host + the R2 host may leave.
  // The gateway host routes to the toGateway handler (→ private gateway DO); the R2 host
  // has NO per-host handler → SDK allowlist fallback → real R2 (the sidecar's file I/O).
  await withBootRetry(() => ws.setAllowedHosts([gwHost, env.R2_HOST]), `setAllowedHosts ${id}`);
  await withBootRetry(() => ws.setOutboundByHost(gwHost, "toGateway"), `setOutboundByHost ${id}`);

  const marker = await ws.exec("test -f /tmp/ws-started && echo yes || echo no");
  if (marker.stdout.trim() !== "yes") {
    await ws.exec("touch /tmp/ws-started");
    await ws.startProcess(WS_SIDECAR_CMD);
  }

  const deadline = Date.now() + 90_000;
  let healthy = false, lastErr = "";
  while (Date.now() < deadline) {
    try {
      const r = await ws.containerFetch("http://ws/health", { method: "GET" }, WS_SIDECAR_PORT);
      if (r.ok) { healthy = true; break; }
      lastErr = `health ${r.status}`;
    } catch (e) { lastErr = e instanceof Error ? e.message : String(e); }
    await new Promise((res) => setTimeout(res, 1000));
  }
  if (!healthy) throw new Error(`workspace sidecar not healthy in 90s: ${lastErr}`);

  const objectKey = workspaceObjectKey(args.workspaceId, args.agentId);
  const presignedGet = await mintPresigned(env, "GET", objectKey);
  const presignedPut = await mintPresigned(env, "PUT", objectKey);
  const init = await wsSidecar(ws, "/init", {
    key: args.workspaceKey,
    presignedGet,
    presignedPut,
    getStatus404Ok: true,                 // a missing object = first-ever session (fresh DB)
    lakeProxy: `${gwHost}:443`,
    lakeToken: args.lakeToken,
    disableSsl: args.disableSsl ?? false,  // false → quack speaks HTTPS:443 (intercepted)
    lockConfiguration: args.lockConfiguration ?? true,
  });
  if (init.status !== 200) throw new Error(`sidecar /init ${init.status}: ${JSON.stringify(init.json)}`);
  return { lakeAttached: init.json?.lakeAttached === true, initStatus: init.status };
}

/** Map a sidecar response into the service contract. A 409 not_initialized means the DO
 *  hibernated (the container — hence the session — is gone): the caller must re-run
 *  connect→configure. The session state lives in the sidecar, never DO storage. */
function asServiceResponse(r: { status: number; json: any }): Response {
  if (r.status === 409 && r.json?.error === "not_initialized") {
    return Response.json({ error: "needs_configure", reason: "workspace not initialized (cold/hibernated) — reconnect" }, { status: 409 });
  }
  return Response.json(r.json, { status: r.status });
}

// ── service-binding fetch router ─────────────────────────────────────────────────
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const body: any = request.method === "POST" ? await request.json().catch(() => ({})) : {};

  // ── gateway control plane (control-api gateway-client) → the per-datalake pool ──
  if (path === "/gw/snapshot" && request.method === "POST") {
    const { endpointId, snapshot, auth, lakeCatalog, gatewayBoot } = body;
    if (!endpointId || !snapshot) return Response.json({ error: "missing endpointId/snapshot" }, { status: 400 });
    const r = await getPool(env, endpointId).applySnapshot(endpointId, {
      snapshot, auth, lakeCatalog, bootEnv: bootEnvFromConfig(gatewayBoot as GatewayBoot | undefined),
    });
    return Response.json({ ok: true, version: r.version }, { status: r.status });
  }
  if (path === "/gw/status") {
    const endpointId = url.searchParams.get("endpointId");
    if (!endpointId) return Response.json({ error: "missing endpointId" }, { status: 400 });
    // Derived from director state — does NOT wake a sleeping pool (scale-to-zero stays at zero).
    const r = await getPool(env, endpointId).status();
    return Response.json(r, { status: 200 });
  }
  if (path === "/gw/audit-drain" && request.method === "POST") {
    // Drain birdshot audit records from the datalake's WARM replicas (cold ones ran nothing).
    const { endpointId } = body;
    if (!endpointId) return Response.json({ error: "missing endpointId" }, { status: 400 });
    const r = await getPool(env, endpointId).drainAudit(endpointId);
    return Response.json(r, { status: 200 });
  }
  if (path === "/gw/revoke" && request.method === "POST") {
    // Forward-only jti/user/session denylist, fanned to the datalake's WARM replicas. The
    // denylist is in-memory per replica; a cold replica has an empty denylist on its next boot,
    // so it is skipped (nothing to revoke there). We do NOT wake sleeping replicas to revoke.
    const { endpointId, kind, id, reason, expiresUs } = body;
    if (!endpointId || !kind || !id) {
      return Response.json({ error: "missing endpointId/kind/id" }, { status: 400 });
    }
    const r = await getPool(env, endpointId).revoke(endpointId, { kind, id, reason, expiresUs });
    return Response.json(r, { status: 200 });
  }
  // Cutover teardown — destroy a datalake's replica pool (and the abandoned LEGACY static
  // gw:<id> DO from before pooling). Used once to "kill the current gateways".
  if (path === "/gw/teardown-legacy" && request.method === "POST") {
    const { endpointId } = body;
    if (!endpointId) return Response.json({ error: "missing endpointId" }, { status: 400 });
    let legacy = false;
    try {
      await (getSandbox(env.GATEWAY, legacyGatewayDoId(endpointId)) as unknown as { destroy(): Promise<void> }).destroy();
      legacy = true;
    } catch { /* already gone / never booted */ }
    const r = await getPool(env, endpointId).destroyAll(endpointId);
    return Response.json({ ok: true, legacyDestroyed: legacy, ...r }, { status: 200 });
  }

  // ── per-replica gateway lifecycle (Step 3) ─────────────────────────────────────
  // Service-binding-only (the DATAPLANE binding is the trust boundary, same as the
  // other /gw/* routes — no bearer token; control-api is the sole caller). These are
  // explicit admin ops on a single replica index; they bypass the load-based
  // autoscaler. Path: /gw/replica/:n/{wake,sleep,destroy,rearm,reapply}. Body: { endpointId }.
  // reapply is gateway-side: it asks the replica's CONTAINER to re-run its cached
  // snapshot (no director/control-plane round trip), so it is forwarded straight to
  // the container's /ctrl/reapply rather than going through a director RPC.
  const replicaOp = /^\/gw\/replica\/(\d+)\/(wake|sleep|destroy|rearm|reapply)$/.exec(path);
  if (replicaOp && request.method === "POST") {
    const n = Number(replicaOp[1]);
    const op = replicaOp[2];
    const { endpointId } = body;
    if (!endpointId) return Response.json({ error: "missing endpointId" }, { status: 400 });
    if (!Number.isInteger(n) || n < 0) return Response.json({ error: "bad replica index" }, { status: 400 });
    // reapply: forward to the container's /ctrl/reapply (its own cached snapshot).
    if (op === "reapply") {
      try {
        const gw = getSandbox(env.GATEWAY, replicaDoId(endpointId, n), { sleepAfter: GATEWAY_SLEEP_AFTER }) as unknown as GatewayHandle;
        // Ensure the container is up (a cold container lost its cached snapshot → 409 below).
        await ensureGateway(gw, undefined);
        const force = body.force !== false;
        const r = await gwFwd(gw, "/ctrl/reapply", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ force }),
        });
        return Response.json(r.json, { status: r.status });
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
      }
    }
    const pool = getPool(env, endpointId);
    try {
      let r: unknown;
      if (op === "wake") r = await pool.wakeReplica(endpointId, n);
      else if (op === "sleep") r = await pool.sleepReplica(endpointId, n);
      else if (op === "destroy") r = await pool.destroyReplica(endpointId, n);
      else r = await pool.rearmReplica(endpointId, n);
      return Response.json(r, { status: 200 });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
  }
  // Per-replica detail for the dashboard (no container wake — derived from director state).
  if (path === "/gw/replicas" && request.method === "GET") {
    const endpointId = url.searchParams.get("endpointId");
    if (!endpointId) return Response.json({ error: "missing endpointId" }, { status: 400 });
    const r = await getPool(env, endpointId).replicaStatus();
    return Response.json(r, { status: 200 });
  }

  // ── pool-director reset (Step 4) ───────────────────────────────────────────────
  // resetPool: drop the cached snapshot + zero currentVersion (fail-closed until the
  //   next /gw/snapshot). clearSnapshot: keep the cache, mark every replica stale so
  //   the next pick re-applies the same snapshot. Both service-binding-only.
  if (path === "/gw/pool/reset" && request.method === "POST") {
    const { endpointId } = body;
    if (!endpointId) return Response.json({ error: "missing endpointId" }, { status: 400 });
    const r = await getPool(env, endpointId).resetPool(endpointId);
    return Response.json(r, { status: 200 });
  }
  if (path === "/gw/pool/clear-snapshot" && request.method === "POST") {
    const { endpointId } = body;
    if (!endpointId) return Response.json({ error: "missing endpointId" }, { status: 400 });
    const r = await getPool(env, endpointId).clearSnapshot(endpointId);
    return Response.json(r, { status: 200 });
  }

  // ── governed ETL: authorize-then-execute a lake WRITE on the trusted gateway ────
  // A lake write (CTAS / read_source ingest) can't go through the workspace (sealed,
  // no egress) or the gated quack serving path (serves the memory catalog only — a
  // CTAS there wouldn't persist to DuckLake). It runs on the gateway replica's TRUSTED
  // connection, gated by birdshot_authorize first (same hook quack uses), then executed
  // — so the write persists to the lake. The director GUARANTEES the chosen replica is
  // armed with the current snapshot before serving, same fail-safe as a read query.
  if (path === "/gw/load" && request.method === "POST") {
    const { sql, lakeToken } = body;
    const endpointId = body.endpointId ?? body.datalakeId;
    if (!endpointId || !sql || !lakeToken) {
      return Response.json({ error: "missing datalakeId/sql/lakeToken" }, { status: 400 });
    }
    const pool = getPool(env, endpointId);
    const picked = await pool.pickReplica(endpointId);
    if (!picked.replicaKey) return Response.json({ error: picked.error ?? "no gateway replica" }, { status: 503 });
    const gw = getSandbox(env.GATEWAY, picked.replicaKey, { sleepAfter: GATEWAY_SLEEP_AFTER }) as unknown as GatewayHandle;
    try {
      const r = await gwFwd(gw, "/governed-load", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: lakeToken, sql }),
      });
      return Response.json(r.json, { status: r.status });
    } finally {
      try { await pool.release(picked.replicaKey); } catch { /* best-effort load bookkeeping */ }
    }
  }

  // ── workspace lifecycle (control-api configure; mcp-external query/run) ─────────
  if (path === "/configure" && request.method === "POST") {
    // control-api migrated endpointId → datalakeId (the gateway DO is keyed gw:<datalakeId>,
    // and gw-<id>.internal uses the same value); accept either name for the routing id.
    const { workspaceId, agentId, workspaceKey, lakeToken, disableSsl, lockConfiguration } = body;
    const endpointId = body.endpointId ?? body.datalakeId;
    if (!workspaceId || !agentId || !endpointId || !workspaceKey || !lakeToken) {
      return Response.json({ error: "missing workspaceId/agentId/datalakeId/workspaceKey/lakeToken" }, { status: 400 });
    }
    const out = await configureWorkspace(env, { workspaceId, agentId, endpointId, workspaceKey, lakeToken, disableSsl, lockConfiguration });
    return Response.json({ ok: true, ...out });
  }
  if ((path === "/query" || path === "/run") && request.method === "POST") {
    const { workspaceId, agentId, sql } = body;
    if (!workspaceId || !agentId || !sql) return Response.json({ error: "missing workspaceId/agentId/sql" }, { status: 400 });
    const ws = getSandbox(env.WORKSPACE, wsDoId(workspaceId, agentId)) as unknown as WsHandle;
    return asServiceResponse(await wsSidecar(ws, path, { sql }));
  }
  if (path === "/snapshot" && request.method === "POST") {
    const { workspaceId, agentId } = body;
    if (!workspaceId || !agentId) return Response.json({ error: "missing workspaceId/agentId" }, { status: 400 });
    const ws = getSandbox(env.WORKSPACE, wsDoId(workspaceId, agentId)) as unknown as WsHandle;
    return asServiceResponse(await wsSidecar(ws, "/snapshot"));
  }
  if (path === "/end" && request.method === "POST") {
    const { workspaceId, agentId } = body;
    if (!workspaceId || !agentId) return Response.json({ error: "missing workspaceId/agentId" }, { status: 400 });
    const id = wsDoId(workspaceId, agentId);
    const ws = getSandbox(env.WORKSPACE, id) as unknown as WsHandle;
    let shutdown: any = null;
    try { shutdown = (await wsSidecar(ws, "/shutdown")).json; } catch { /* may already be gone */ }
    try { await ws.destroy(); } catch { /* free the container slot */ }
    return Response.json({ ok: true, shutdown });
  }

  // ── quackboard lifecycle (control-api) ──────────────────────────────────────────
  if (path === "/qb/selftest") return qbSelftest(env);
  if (path === "/qb/configure" && request.method === "POST") {
    const { orgId, gatewayBoot, snapshot } = body;
    if (!orgId || !gatewayBoot) return Response.json({ error: "missing orgId/gatewayBoot" }, { status: 400 });
    const out = await ensureQuackboard(env, orgId, gatewayBoot as GatewayBoot);
    // Push the birdshot snapshot (per-agent grants over the quackboard tables) so queries are
    // authorized. Without it birdshot denies — same fail-safe as the lake gateway.
    let snap: any = null;
    if (snapshot) {
      snap = (await qbFwd(env, orgId, "/ctrl/snapshot", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(snapshot),
      })).json;
    }
    return Response.json({ ok: true, ...out, snapshot: snap });
  }
  if (path === "/qb/query" && request.method === "POST") {
    const { orgId, sql, lakeToken, gatewayBoot } = body;
    if (!orgId || !sql || !lakeToken) return Response.json({ error: "missing orgId/sql/lakeToken" }, { status: 400 });
    // Ensure the container is booted + quack serving before the gated query (a cold/slept org
    // otherwise refuses the connection). birdshot authz still depends on the snapshot the
    // control plane pushes via /qb/configure — control-api re-pushes on cold-detect + retries.
    if (gatewayBoot) await ensureQuackboard(env, orgId, gatewayBoot as GatewayBoot);
    const r = await qbQuery(env, orgId, sql, lakeToken);
    return Response.json(r.json, { status: r.status });
  }
  if (path === "/qb/remember" && request.method === "POST") {
    const { orgId, gatewayBoot, agentRole, key, content } = body;
    if (!orgId || !gatewayBoot || !agentRole || content === undefined || content === null) {
      return Response.json({ error: "missing orgId/gatewayBoot/agentRole/content" }, { status: 400 });
    }
    const r = await qbRemember(env, orgId, gatewayBoot as GatewayBoot, agentRole, key, content);
    return Response.json(r.json, { status: r.status });
  }
  if (path === "/qb/mine" && request.method === "POST") {
    const { orgId, gatewayBoot, agentRole, key, limit } = body;
    if (!orgId || !gatewayBoot || !agentRole) {
      return Response.json({ error: "missing orgId/gatewayBoot/agentRole" }, { status: 400 });
    }
    const r = await qbMine(env, orgId, gatewayBoot as GatewayBoot, agentRole, key, limit);
    return Response.json(r.json, { status: r.status });
  }
  if (path === "/qb/recall" && request.method === "POST") {
    const { orgId, gatewayBoot, term, limit } = body;
    if (!orgId || !gatewayBoot || !term) {
      return Response.json({ error: "missing orgId/gatewayBoot/term" }, { status: 400 });
    }
    const r = await qbRecall(env, orgId, gatewayBoot as GatewayBoot, term, limit);
    return Response.json(r.json, { status: r.status });
  }
  if (path === "/qb/audit-drain" && request.method === "POST") {
    const { orgId } = body;
    if (!orgId) return Response.json({ error: "missing orgId" }, { status: 400 });
    const r = await qbAuditDrain(env, orgId);
    return Response.json(r.json, { status: r.status });
  }
  if (path === "/qb/persist" && request.method === "POST") {
    const { orgId, r2Key } = body;
    if (!orgId || !r2Key) return Response.json({ error: "missing orgId/r2Key" }, { status: 400 });
    return Response.json(await qbPersist(env, orgId, r2Key));
  }

  if (path === "/r2probe") {
    // Does the dataplane's R2 S3 cred reach an arbitrary (per-org) bucket, or only
    // R2_BUCKET? Presigned PUT + GET a tiny object against ?bucket=. Determines whether
    // per-org lake buckets work with the existing account creds.
    const bucket = url.searchParams.get("bucket") ?? env.R2_BUCKET;
    const key = "r2probe/ping.txt";
    try {
      const accessKeyId = await env.R2_ACCESS_KEY_ID.get();
      const secretAccessKey = await env.R2_SECRET_ACCESS_KEY.get();
      const client = new AwsClient({ accessKeyId, secretAccessKey, region: env.R2_REGION, service: "s3" });
      const base = `${env.R2_ENDPOINT}/${bucket}/${key}`;
      const put = await client.fetch(base, { method: "PUT", body: "pong" });
      const get = await client.fetch(base, { method: "GET" });
      const body = get.ok ? await get.text() : "";
      return Response.json({ bucket, put: put.status, get: get.status, body, ok: put.ok && get.ok && body === "pong" });
    } catch (e) {
      return Response.json({ bucket, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }

  // Trusted data load: boot the datalake's gateway (replica 0) with its REAL lake config, then
  // have it index HN stories into the lake (trusted connection → parquet to R2). Agents only
  // READ the result through the birdshot-gated quack path. This is a trusted seed op, so it
  // boots the replica directly (it does not need a birdshot snapshot to load data).
  if (path === "/lakeload" && request.method === "POST") {
    const { endpointId, gatewayBoot, days, limit } = body;
    if (!endpointId || !gatewayBoot) return Response.json({ error: "missing endpointId/gatewayBoot" }, { status: 400 });
    const gw = getSandbox(env.GATEWAY, replicaDoId(endpointId, 0), { sleepAfter: GATEWAY_SLEEP_AFTER }) as unknown as GatewayHandle;
    await ensureGateway(gw, bootEnvFromConfig(gatewayBoot as GatewayBoot));
    const r = await gwFwd(gw, "/ctrl/load-hn", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ days, limit }),
    });
    return Response.json(r.json, { status: r.status });
  }

  if (path === "/gwprobe") return gwEgressProbe(env, url);

  if (path === "/lakeprobe" && request.method === "POST") return lakeIsolationProbe(env, body);

  if (path === "/selftest") return selftest(env, url);

  return new Response(
    "waddling data plane. Service-binding routes: POST /configure /query /run /snapshot /end, POST /gw/snapshot, GET /gw/status, POST /gw/revoke. GET /selftest?step=1|2 to self-verify. GET /gwprobe?pgHost=<host>&pgPort=5432 = Stage-D egress gate. POST /lakeprobe {dsn} = #9 metadata-schema isolation gate.\n",
    { status: 200 },
  );
}

// ── #9 ACCEPTANCE GATE: per-endpoint METADATA_SCHEMA isolation ───────────────────
// THE hard gate for #9 (the way /gwprobe gated egress). The whole per-org shared-catalog
// design rests on one property: two endpoints sharing ONE Postgres catalog DB but distinct
// METADATA_SCHEMA each see ONLY their own DuckLake tables. This boots two ducklake ATTACHes
// (different schema, local DATA_PATH each) inside a real GatewayDO container (linux/amd64,
// the production gateway image — has @duckdb/node-api), creates a table in each, and asserts
// neither sees the other's. Run against a postgres catalog + local data dir to isolate the
// genuinely-new surface (PG metadata schema) from R2. POST { dsn: "<libpq key=value DSN>" }
// with a THROWAWAY catalog. Also exercises the gateway's defensive CREATE SCHEMA path.
async function lakeIsolationProbe(env: Env, body: any): Promise<Response> {
  const dsn = typeof body?.dsn === "string" ? body.dsn : "";
  if (!dsn) {
    return Response.json(
      { error: "POST { dsn: '<libpq key=value postgres DSN>' } — the #9 metadata-schema isolation gate" },
      { status: 400 },
    );
  }
  // The probe script runs in-container. The DSN is embedded as a JSON literal (handles the
  // spaces/=/; in a libpq DSN) and the whole script is base64-piped to node, exactly like
  // the egress probe dodges shell-quoting. duckdb_tables() lists per-catalog tables.
  const script = `
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdirSync } from 'node:fs';
const DSN = ${"${JSON_DSN}"};
async function ensureSchema(c, schema) {
  await c.run("ATTACH '" + DSN.replace(/'/g, "''") + "' AS _pg (TYPE postgres)");
  try { await c.run('CREATE SCHEMA IF NOT EXISTS _pg.' + JSON.stringify(schema)); }
  finally { await c.run('DETACH _pg'); }
}
async function attachLake(c, alias, schema, dir) {
  await ensureSchema(c, schema);
  mkdirSync(dir, { recursive: true });
  await c.run("ATTACH 'ducklake:postgres:" + DSN.replace(/'/g, "''") + "' AS " + alias +
              " (DATA_PATH '" + dir + "/', METADATA_SCHEMA '" + schema + "')");
}
async function tablesIn(c, alias) {
  const r = await c.runAndReadAll("SELECT table_name FROM duckdb_tables() WHERE database_name = '" + alias + "' AND schema_name = 'main'");
  return r.getRowObjects().map(o => String(o.table_name));
}
async function main() {
  const inst = await DuckDBInstance.create(':memory:', { allow_unsigned_extensions: 'true' });
  const c = await inst.connect();
  await c.run('INSTALL ducklake; INSTALL postgres; INSTALL httpfs; LOAD ducklake; LOAD postgres;');
  await attachLake(c, 'lake_a', 'ep_probe_a', '/tmp/lakeprobe/a');
  await c.run('CREATE TABLE IF NOT EXISTS lake_a.main.t_only_a (id INTEGER)');
  await c.run('INSERT INTO lake_a.main.t_only_a VALUES (1)');
  await attachLake(c, 'lake_b', 'ep_probe_b', '/tmp/lakeprobe/b');
  await c.run('CREATE TABLE IF NOT EXISTS lake_b.main.t_only_b (id INTEGER)');
  await c.run('INSERT INTO lake_b.main.t_only_b VALUES (2)');
  const aTables = await tablesIn(c, 'lake_a');
  const bTables = await tablesIn(c, 'lake_b');
  const isolated = aTables.includes('t_only_a') && !aTables.includes('t_only_b')
                && bTables.includes('t_only_b') && !bTables.includes('t_only_a');
  // Cleanup so this is safe to run against a REAL org catalog: drop the probe schemas
  // (CASCADE removes the DuckLake metadata tables they hold). Best-effort.
  let cleaned = false;
  try {
    await c.run('DETACH lake_a'); await c.run('DETACH lake_b');
    await c.run("ATTACH '" + DSN.replace(/'/g, "''") + "' AS _pg (TYPE postgres)");
    try {
      await c.run('DROP SCHEMA IF EXISTS _pg.' + JSON.stringify('ep_probe_a') + ' CASCADE');
      await c.run('DROP SCHEMA IF EXISTS _pg.' + JSON.stringify('ep_probe_b') + ' CASCADE');
      cleaned = true;
    } finally { await c.run('DETACH _pg'); }
  } catch (e) { /* leave verdict intact; report cleanup miss */ }
  console.log('LAKEPROBE_RESULT:' + JSON.stringify({ aTables, bTables, isolated, cleaned }));
}
main().catch(e => console.log('LAKEPROBE_RESULT:' + JSON.stringify({ error: String((e && e.message) || e) })));
`.replace("${JSON_DSN}", () => JSON.stringify(dsn));

  const gw = getSandbox(env.GATEWAY, legacyGatewayDoId("lake-probe")) as unknown as GatewayHandle & {
    destroy(): Promise<void>;
  };
  try {
    await withBootRetry(() => gw.exec("echo ready"), "lake-probe warmup");
    const b64 = btoa(script); // script is pure ASCII → btoa is safe (matches the egress probe)
    const run = await gw.exec(`cd /opt/gateway && mkdir -p /tmp/lakeprobe && echo ${b64} | base64 -d | node --input-type=module`);
    const line = run.stdout.split("\n").find((l) => l.startsWith("LAKEPROBE_RESULT:"));
    const result = line ? JSON.parse(line.slice("LAKEPROBE_RESULT:".length)) : { error: "no result line", raw: run.stdout.slice(-2000) };
    return Response.json({
      gate: "issue-9-metadata-schema-isolation",
      ...result,
      pass: result.isolated === true,
      verdict: result.isolated === true
        ? "PASS — distinct METADATA_SCHEMA isolates endpoints inside one shared Postgres catalog"
        : "FAIL — cross-endpoint table visibility or boot error (see error/aTables/bTables)",
    });
  } finally {
    try { await gw.destroy(); } catch { /* may already be gone */ }
  }
}

// ── Stage D EGRESS GATE PROBE ───────────────────────────────────────────────────
// THE gate for the real per-endpoint DuckLake story. The gateway's birdshot-gated
// (trusted) connection ATTACHes `ducklake:postgres:<dsn>` (raw Postgres wire on :5432)
// + reads `s3://…` data over httpfs (:443). CF container egress historically passes
// only HTTP 80/443+DNS (the finding that forced quack onto :443) — so whether a raw
// 5432 connection LEAVES a GatewayDO container is unproven and gates the whole design.
// This probes it empirically from a real GatewayDO container (deploy-only):
//   1. raw TCP connect to <pgHost>:<pgPort> — does 5432 leave the container?
//   2. fetch the R2 endpoint over 443 — the s3:// data-path leg.
// Pass ?pgHost=<your real Postgres catalog host>&pgPort=5432. A CONNECTED (or even
// ECONNREFUSED — reached the host, no listener) means egress works; a TIMEOUT/
// unreachable means 5432 is BLOCKED and ducklake:postgres is not viable as-is.
async function gwEgressProbe(env: Env, url: URL): Promise<Response> {
  const pgHost = url.searchParams.get("pgHost");
  const pgPort = Number(url.searchParams.get("pgPort") ?? "5432");
  if (!pgHost) {
    return Response.json(
      { error: "pass ?pgHost=<postgres catalog host> (&pgPort=5432) — the Stage-D egress gate" },
      { status: 400 },
    );
  }
  const gw = getSandbox(env.GATEWAY, legacyGatewayDoId("egress-probe")) as unknown as GatewayHandle & {
    destroy(): Promise<void>;
  };
  try {
    await withBootRetry(() => gw.exec("echo ready"), "gw egress-probe warmup");

    // 1) raw TCP to host:5432 — base64-piped to dodge shell-quoting of the inline JS.
    const dialScript =
      `const net=require('net');` +
      `const s=net.connect({host:${JSON.stringify(pgHost)},port:${pgPort}},()=>{console.log('CONNECTED');s.destroy();process.exit(0)});` +
      `s.setTimeout(8000,()=>{console.log('TIMEOUT');try{s.destroy()}catch(e){}process.exit(0)});` +
      `s.on('error',e=>{console.log('ERROR:'+(e.code||e.message));process.exit(0)});`;
    const dialB64 = btoa(dialScript); // ASCII script → btoa is safe (no @types/node needed)
    const dial = await gw.exec(`echo ${dialB64} | base64 -d | node`);
    const pgRaw = dial.stdout.trim();

    // 2) R2 over 443 — the s3:// DATA_PATH leg (httpfs). Only proven localData so far.
    const r2Script =
      `fetch(${JSON.stringify(env.R2_ENDPOINT)}).then(r=>{console.log('R2:'+r.status)}).catch(e=>{console.log('R2ERR:'+(e.code||e.message))});`;
    const r2B64 = btoa(r2Script);
    const r2 = await gw.exec(`echo ${r2B64} | base64 -d | node`);
    const r2Raw = r2.stdout.trim();

    const pgConnected = /^CONNECTED/.test(pgRaw);
    const pgEgressLeaves = pgConnected || /^ERROR:ECONNREFUSED/.test(pgRaw);
    const r2Ok = /^R2:\d/.test(r2Raw);
    return Response.json({
      gate: "stage-d-egress",
      pgHost,
      pgPort,
      pg: {
        raw: pgRaw,
        egressLeavesContainer: pgEgressLeaves,
        verdict: pgConnected
          ? "5432 egress WORKS — ducklake:postgres catalog is viable from the container"
          : /^ERROR:ECONNREFUSED/.test(pgRaw)
            ? "reached the host but no listener (egress works; check host:port)"
            : "5432 BLOCKED (timeout/unreachable) — ducklake:postgres NOT viable as-is; needs a 443 catalog path or a managed file-catalog-on-R2 design",
      },
      r2: { raw: r2Raw, reachableOver443: r2Ok },
      pass: pgEgressLeaves && r2Ok,
    });
  } finally {
    // Free the container slot (probe DOs never idle-expire — see destroy() lesson).
    try {
      await gw.destroy();
    } catch {
      /* may already be gone */
    }
  }
}

// ── selftest: production-shaped, self-minting (proves the data-plane mechanics green
// independent of control-api). Split into 2 steps to stay under the edge timeout. ──
const ST_ENDPOINT = "ep-selftest";
const ST_WS = "ws-selftest";
const ST_AGENT = "agent-x";
const ST_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

async function mintSelftestAuthAndJwt(): Promise<{ auth: any; jwt: string }> {
  const { publicKey, privateKey } = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", publicKey)) as JWK & { n: string; e: string };
  const kid = "selftest-key-1";
  const audience = `gw:${ST_ENDPOINT}`;
  const auth = { issuer: "https://selftest.waddling.test/", audience, jwks: [{ kid, n: pub.n, e: pub.e }] };
  const principal = `agent:${ST_AGENT}`;
  const key = (await importJWK((await crypto.subtle.exportKey("jwk", privateKey)) as JWK, "RS256")) as CryptoKey;
  const jwt = await new SignJWT({ id: principal })
    .setProtectedHeader({ alg: "RS256", kid }).setSubject(principal)
    .setIssuer("https://selftest.waddling.test/").setAudience(audience)
    .setIssuedAt().setJti(crypto.randomUUID()).setExpirationTime("15m").sign(key);
  return { auth, jwt };
}

async function selftest(env: Env, url: URL): Promise<Response> {
  const step = url.searchParams.get("step") ?? "1";
  const ws = getSandbox(env.WORKSPACE, wsDoId(ST_WS, ST_AGENT)) as unknown as WsHandle;
  try {
    if (step === "1") {
      // Gateway: push birdshot snapshot (production RS256) — role agent_x → READ orders.
      const { auth, jwt } = await mintSelftestAuthAndJwt();
      const snapshot = {
        userRoles: [{ userId: `agent:${ST_AGENT}`, role: `agent_${ST_AGENT}` }],
        roleGrants: [{ role: `agent_${ST_AGENT}`, tableRef: "main.orders", action: "read" }],
      };
      const push = await getPool(env, ST_ENDPOINT).applySnapshot(ST_ENDPOINT, { snapshot, auth, lakeCatalog: "memory" });
      const status = await gwFwd(getSandbox(env.GATEWAY, replicaDoId(ST_ENDPOINT, 0), { sleepAfter: GATEWAY_SLEEP_AFTER }) as unknown as GatewayHandle, "/ctrl/status", { method: "GET" });
      const mode = status.json?.birdshot?.mode ?? "unknown";

      // Configure the workspace (boot, egress, restore-from-R2, ATTACH lake quack).
      const cfg = await configureWorkspace(env, { workspaceId: ST_WS, agentId: ST_AGENT, endpointId: ST_ENDPOINT, workspaceKey: ST_KEY, lakeToken: jwt, disableSsl: false });

      // Lake leg through the quack:443 tunnel: orders allowed, secrets denied.
      const allowed = await wsSidecar(ws, "/query", { sql: "SELECT * FROM lake.orders ORDER BY id" });
      const denied = await wsSidecar(ws, "/query", { sql: "SELECT ssn FROM lake.secrets" });
      // Isolation: s3:// + http:// blocked by configuration.
      const s3 = await wsSidecar(ws, "/query", { sql: "SELECT * FROM read_csv('s3://waddling-ws-probe/x/y.csv')" });
      const http = await wsSidecar(ws, "/query", { sql: "SELECT * FROM read_csv('http://example.com/y.csv')" });
      // Workspace durability seed: a table in the agent's OWN encrypted DB, then persist.
      await wsSidecar(ws, "/run", { sql: "CREATE TABLE IF NOT EXISTS keep AS SELECT 7 AS v" });
      await wsSidecar(ws, "/run", { sql: "DELETE FROM keep" });
      await wsSidecar(ws, "/run", { sql: "INSERT INTO keep VALUES (7)" });
      const snap = await wsSidecar(ws, "/snapshot");

      const allowedRows = allowed.status === 200 && (allowed.json?.rows?.length ?? 0) > 0;
      const deniedByAuthz = denied.status === 500 && /authoriz|permission|denied/i.test(String(denied.json?.error ?? ""));
      const s3Blocked = /disabled/i.test(String(s3.json?.error ?? ""));
      const httpBlocked = /disabled/i.test(String(http.json?.error ?? ""));
      const step1Ok = mode === "rs256" && cfg.lakeAttached && allowedRows && deniedByAuthz && s3Blocked && httpBlocked && snap.json?.ok === true;
      return Response.json({
        step: 1, ok: step1Ok,
        birdshotMode: mode, snapshotPush: push, lakeAttached: cfg.lakeAttached,
        allowedRowCount: allowed.json?.rows?.length ?? 0, deniedByAuthz, deniedError: denied.json?.error ?? null,
        s3Blocked, httpBlocked, workspaceSnapshot: snap.json,
        next: "GET /selftest?step=2 (cold reconnect → workspace durability)",
      });
    }
    // step 2: cold reconnect → durability. Destroy the workspace container, then a FRESH
    // configure (real restore-from-R2), then read back the seeded table.
    try { await ws.destroy(); } catch { /* may already be gone */ }
    // Mint a fresh keypair+JWT AND re-push the snapshot so the gateway's birdshot JWKS
    // matches this JWT — exactly what control-api does on every connect (pushSnapshot
    // with the current signing key, then mint the JWT with the matching kid). Without
    // the re-push the new JWT is signed by a key birdshot doesn't know → ATTACH fails
    // "Authentication failed".
    const { auth, jwt } = await mintSelftestAuthAndJwt();
    const snapshot = {
      userRoles: [{ userId: `agent:${ST_AGENT}`, role: `agent_${ST_AGENT}` }],
      roleGrants: [{ role: `agent_${ST_AGENT}`, tableRef: "main.orders", action: "read" }],
    };
    await getPool(env, ST_ENDPOINT).applySnapshot(ST_ENDPOINT, { snapshot, auth, lakeCatalog: "memory" });
    const cfg = await configureWorkspace(env, { workspaceId: ST_WS, agentId: ST_AGENT, endpointId: ST_ENDPOINT, workspaceKey: ST_KEY, lakeToken: jwt, disableSsl: false });
    const read = await wsSidecar(ws, "/query", { sql: "SELECT v FROM keep" });
    const durable = read.status === 200 && Number(read.json?.rows?.[0]?.[0]) === 7;
    return Response.json({
      step: 2, ok: durable && cfg.lakeAttached,
      durability: durable, value: read.json?.rows?.[0]?.[0] ?? null, lakeAttached: cfg.lakeAttached,
      verdict: durable && cfg.lakeAttached ? "STAGE-C-DATAPLANE-PASS" : "FAIL",
    });
  } finally {
    if (step === "2") { try { await ws.destroy(); } catch { /* free slot */ } }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }, { status: 500 });
    }
  },
};
