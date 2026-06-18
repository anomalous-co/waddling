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
import { AwsClient } from "aws4fetch";
import { importJWK, SignJWT, type JWK } from "jose";

export { ContainerProxy };

interface Env {
  GATEWAY: DurableObjectNamespace<GatewayDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceSandbox>;
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
const BOOT_CMD = `node --import tsx ${GW_DIR}/entrypoint.mjs`;
const WS_SIDECAR_CMD = "node --use-system-ca /opt/workspace/workspace-sidecar.mjs";
const PRESIGN_TTL_SEC = 3600;   // covers a full session (≤1h); R2 max is 7d. Sessions
                                 // longer than this need a periodic re-/init refresh (a
                                 // production follow-up; the DO holds the creds to do it).

// PER-ENDPOINT gateway addressing. The host is symbolic (never DNS-resolved — the
// outbound handler short-circuits it into the gateway DO).
const gatewayDoId = (endpointId: string): string => `gw:${endpointId}`;
const gatewayHost = (endpointId: string): string => `gw-${endpointId}.internal`;
function endpointFromGatewayHost(host: string): string | null {
  const m = /^gw-(.+)\.internal$/.exec(host);
  return m ? m[1] : null;
}

// DO id + R2 object key for a (workspace, agent). Lowercased (the SDK warns uppercase
// breaks case-insensitive preview hostnames). Object key is CONSTANT across sessions so
// a cold restore on a different DO instance hits the same R2 object.
const wsDoId = (workspaceId: string, agentId: string): string => `${workspaceId}:${agentId}`.toLowerCase();
const workspaceObjectKey = (workspaceId: string, agentId: string): string => `workspace/${workspaceId}/db/${agentId}.duckdb`;

// ── DO classes ─────────────────────────────────────────────────────────────────
// GatewayDO: the TRUSTED gateway. enableInternet=true so ALL egress ports leave the
// container — the production catalog is ducklake:postgres on :5432 (raw PG wire) plus
// R2 on :443. The gateway holds the lake creds and is the trusted side; only the
// WORKSPACE is locked down (enableInternet=false + deny-by-default allowlist + the one
// quack:443 tunnel). The SDK default would pass only 80/443/DNS, blocking the catalog.
export class GatewayDO extends Sandbox<Env> {
  enableInternet = true;
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
    const endpointId = endpointFromGatewayHost(u.hostname);
    if (!endpointId) return new Response(`bad gateway host: ${u.hostname}`, { status: 502 });
    const gw = getSandbox(env.GATEWAY, gatewayDoId(endpointId)) as unknown as {
      containerFetch(url: string, init: RequestInit, port?: number): Promise<Response>;
    };
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => { headers[k] = v; });
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const body = hasBody ? new Uint8Array(await request.arrayBuffer()) : undefined;
    return gw.containerFetch(`http://gw${u.pathname}${u.search}`, { method: request.method, headers, body }, GW_FWD_PORT);
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
    endpoint?: string; keyId?: string; secret?: string;
    region?: string; useSsl?: boolean; urlStyle?: 'path' | 'vhost';
  };
}

/** Translate a GatewayBoot descriptor into the entrypoint's per-process env. Only set keys
 *  that are present — the entrypoint supplies sane defaults and the selftest fallback. */
function bootEnvFromConfig(boot?: GatewayBoot): Record<string, string> | undefined {
  if (!boot) return undefined;
  const env: Record<string, string> = {};
  const set = (k: string, v: unknown) => { if (v !== undefined && v !== null && v !== '') env[k] = String(v); };
  set('GW_SERVER_TOKEN', boot.serverToken);
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
async function ensureGateway(gw: GatewayHandle, bootEnv?: Record<string, string>): Promise<{ waitedMs: number }> {
  const marker = await withBootRetry(() => gw.exec("test -f /tmp/gw-started && echo yes || echo no"), "gw warmup");
  if (marker.stdout.trim() !== "yes") {
    await gw.exec("touch /tmp/gw-started");
    // bootEnv carries the per-endpoint lake config (catalog DSN, metadata schema, s3 creds).
    // A HOT gateway is NOT re-bootstrapped — its config is fixed at first boot, so callers
    // must gw.destroy() to re-apply changed config (e.g. after deploying a new entrypoint).
    await gw.startProcess(BOOT_CMD, { cwd: GW_DIR, env: bootEnv });
  }
  const start = Date.now();
  let lastErr = "";
  while (Date.now() - start < 90_000) {
    try {
      const r = await gw.containerFetch("http://gw/healthz", { method: "GET" }, GW_FWD_PORT);
      if (r.ok) return { waitedMs: Date.now() - start };
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

/** Push a birdshot ACL snapshot + RS256 JWKS to a per-endpoint gateway (boots it if cold,
 *  injecting bootEnv as the per-process lake config on a cold boot). */
async function pushGatewaySnapshot(env: Env, endpointId: string, snapshot: unknown, auth: unknown, lakeCatalog?: string, bootEnv?: Record<string, string>): Promise<{ status: number; json: any }> {
  const gw = getSandbox(env.GATEWAY, gatewayDoId(endpointId)) as unknown as GatewayHandle;
  await ensureGateway(gw, bootEnv);
  return gwFwd(gw, "/ctrl/snapshot", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshot, auth, lakeCatalog: lakeCatalog ?? "memory" }),
  });
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
    lockConfiguration: true,
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

  // ── gateway control plane (control-api gateway-client) ─────────────────────────
  if (path === "/gw/snapshot" && request.method === "POST") {
    const { endpointId, snapshot, auth, lakeCatalog, gatewayBoot } = body;
    if (!endpointId || !snapshot) return Response.json({ error: "missing endpointId/snapshot" }, { status: 400 });
    const r = await pushGatewaySnapshot(env, endpointId, snapshot, auth, lakeCatalog, bootEnvFromConfig(gatewayBoot as GatewayBoot | undefined));
    return Response.json(r.json, { status: r.status });
  }
  if (path === "/gw/status") {
    const endpointId = url.searchParams.get("endpointId");
    if (!endpointId) return Response.json({ error: "missing endpointId" }, { status: 400 });
    const gw = getSandbox(env.GATEWAY, gatewayDoId(endpointId)) as unknown as GatewayHandle;
    const r = await gwFwd(gw, "/ctrl/status", { method: "GET" });
    return Response.json(r.json, { status: r.status });
  }
  if (path === "/gw/revoke" && request.method === "POST") {
    // Forward-only jti/user/session denylist on the PER-ENDPOINT gateway. The denylist
    // is in-memory on the gateway's trusted control connection, so we forward to the
    // live container. A COLD gateway has no live sessions (and an empty denylist on its
    // next boot), so a forward failure = nothing to revoke → no-op ok. We do NOT boot a
    // cold gateway just to revoke.
    const { endpointId, kind, id, reason, expiresUs } = body;
    if (!endpointId || !kind || !id) {
      return Response.json({ error: "missing endpointId/kind/id" }, { status: 400 });
    }
    const gw = getSandbox(env.GATEWAY, gatewayDoId(endpointId)) as unknown as GatewayHandle;
    try {
      const r = await gwFwd(gw, "/ctrl/revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, id, reason, expiresUs }),
      });
      return Response.json(r.json, { status: r.status });
    } catch {
      return Response.json({ ok: true, note: "gateway cold — no live session to revoke" });
    }
  }

  // ── workspace lifecycle (control-api configure; mcp-external query/run) ─────────
  if (path === "/configure" && request.method === "POST") {
    const { workspaceId, agentId, endpointId, workspaceKey, lakeToken, disableSsl } = body;
    if (!workspaceId || !agentId || !endpointId || !workspaceKey || !lakeToken) {
      return Response.json({ error: "missing workspaceId/agentId/endpointId/workspaceKey/lakeToken" }, { status: 400 });
    }
    const out = await configureWorkspace(env, { workspaceId, agentId, endpointId, workspaceKey, lakeToken, disableSsl });
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

  if (path === "/gwprobe") return gwEgressProbe(env, url);

  if (path === "/selftest") return selftest(env, url);

  return new Response(
    "waddling data plane. Service-binding routes: POST /configure /query /run /snapshot /end, POST /gw/snapshot, GET /gw/status, POST /gw/revoke. GET /selftest?step=1|2 to self-verify. GET /gwprobe?pgHost=<host>&pgPort=5432 = Stage-D egress gate.\n",
    { status: 200 },
  );
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
  const gw = getSandbox(env.GATEWAY, gatewayDoId("egress-probe")) as unknown as GatewayHandle & {
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
      const push = await pushGatewaySnapshot(env, ST_ENDPOINT, snapshot, auth, "memory");
      const status = await gwFwd(getSandbox(env.GATEWAY, gatewayDoId(ST_ENDPOINT)) as unknown as GatewayHandle, "/ctrl/status", { method: "GET" });
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
        birdshotMode: mode, snapshotPush: push.json, lakeAttached: cfg.lakeAttached,
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
    await pushGatewaySnapshot(env, ST_ENDPOINT, snapshot, auth, "memory");
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
