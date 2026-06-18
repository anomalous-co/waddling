// Stage C/D full :443 loop probe — the CAPSTONE. Proves the waddling invariant END
// TO END on real Cloudflare: agent SQL reaches the lake through exactly one path —
// the workspace's locked DuckDB ATTACHes quack to a PRIVATE gateway DO, gated by
// birdshot_authorize — with the quack egress pinned to HTTPS:443 and intercepted by
// the workspace's own outbound handler.
//
// THE NEW THING (explicitly out of scope for the gw-probe, which carried CONTROL
// requests + JSON rows over containerFetch, NOT raw quack): does the raw quack wire
// survive the chain
//   workspace quack client → interceptHttps (ephemeral CA) → outbound handler →
//   GATEWAY DO binding → containerFetch(:8080 forwarder) → forwarder proxy →
//   quack_serve:9500 → birdshot
// and back? This combines the three proven lynchpins in ONE worker so the workspace
// can reach the gateway over an in-worker DO binding:
//   #1 hop  (cf-stagec-hop-probe): outbound handler → internal DO via binding;
//   #2 gw   (cf-stagec-gw-probe):  GatewayDO serves birdshot-gated quack (RS256);
//   #3 ws   (cf-stagec-ws-probe):  WorkspaceSandbox = locked, isolated DuckDB.
//
// PROOF PATH:
//   /probe
//     → boot GatewayDO (real packages/gateway), push birdshot snapshot (RS256 JWKS +
//       role agent_x → READ main.orders), mint the session JWT;
//     → boot WorkspaceSandbox, wire egress: setAllowedHosts([GW_HOST]) +
//       setOutboundByHost(GW_HOST,"toGateway"); /init with lakeProxy=GW_HOST:443 +
//       lakeToken=jwt → the sidecar ATTACHes quack:GW_HOST:443 (SSL on);
//     → workspace /query "SELECT * FROM lake.orders"  → rows  (ALLOWED through tunnel)
//     → workspace /query "SELECT ssn FROM lake.secrets" → throws (DENIED by birdshot)
//   LOOP-PASS = the allowed read returns the seeded rows AND the forbidden read is an
//   authorization denial — all through the one quack:443 tunnel into the private DO.

import { getSandbox, Sandbox, ContainerProxy } from "@cloudflare/sandbox";
import { importJWK, SignJWT, type JWK } from "jose";

// Required for a Sandbox subclass: the SDK routes container control through this
// WorkerEntrypoint, so it must be exported. ALSO the self-reference the outbound
// proxy uses to invoke our handler.
export { ContainerProxy };

interface Env {
  GATEWAY: DurableObjectNamespace<GatewayDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceSandbox>;
  WADDLING_ENV: string;
}

// ── identifiers ──────────────────────────────────────────────────────────────────
const ENDPOINT_ID = "ep-loopprobe";
const AGENT_ID = "agent-x";
const ISSUER = "https://probe.waddling.test/";
const ROLE = `agent_${AGENT_ID}`;

// The SYMBOLIC gateway host the workspace ATTACHes / allowlists / routes. It is never
// DNS-resolved: the outbound handler short-circuits every request to it into the
// gateway DO. quack ATTACHes quack:GW_HOST:443 (SSL on → interceptHttps captures it).
const GW_HOST = "gw.loop.internal";
const GW_ID = "gw-loop-1";       // stable gateway DO id (booted once, reused)
const GW_FWD_PORT = 8080;        // gateway forwarder (proxies non-/ctrl → quack:9500)
const WS_SIDECAR_PORT = 8080;    // workspace sidecar control port (its own container)

// Gateway boot command (same as the proven gw-probe): bare `tsx` specifier, cwd pinned.
const GW_DIR = "/opt/gateway";
const BOOT_CMD = `node --import tsx ${GW_DIR}/entrypoint.mjs`;

// ── DO classes ─────────────────────────────────────────────────────────────────
// GatewayDO: the TRUSTED gateway. enableInternet=true so all egress ports leave the
// container — needed for the real catalog (ducklake:postgres on :5432) + R2 (:443).
// The gateway is the trusted side (holds lake creds); only the WORKSPACE is locked
// down (enableInternet=false + allowlist). Without this flag the SDK default would
// (per Stage-0 research) pass only 80/443/DNS, so 5432 would falsely appear blocked.
export class GatewayDO extends Sandbox<Env> {
  enableInternet = true;
}

// WorkspaceSandbox: the agent's locked workspace, with deny-by-default egress. The
// egress fields are carried verbatim from the proven ws/hop probes; the allowlist is
// engaged at RUNTIME (setAllowedHosts), and the outbound handler (registered below
// via the SETTER, the corrected #1 pattern) is engaged at RUNTIME per host
// (setOutboundByHost) — a static class FIELD would bypass the SDK dispatch registry.
export class WorkspaceSandbox extends Sandbox<Env> {
  enableInternet = false;
  interceptHttps = true;
  allowedHosts: string[] = [];
}

// THE #1 HOP, now carrying raw quack. The workspace's one allowlisted egress
// (quack:GW_HOST:443) is intercepted and handed here as an HTTP Request; we forward it
// into the PRIVATE gateway container's :8080 forwarder (which proxies non-/ctrl paths
// byte-for-byte to quack_serve:9500) via the GATEWAY DO binding. `env` is the live
// ContainerProxy env (2nd arg) so the binding is callable. The gateway is NEVER
// publicly exposed; no gateway TLS cert (the workspace container trusts the ephemeral
// interception CA). Anything not routed here is blocked at the allowlist gate (520).
(WorkspaceSandbox as unknown as {
  outboundHandlers: Record<string, (request: Request, env: Env) => Promise<Response>>;
}).outboundHandlers = {
  toGateway: async (request: Request, env: Env): Promise<Response> => {
    const gw = getSandbox(env.GATEWAY, GW_ID) as unknown as {
      containerFetch(url: string, init: RequestInit, port?: number): Promise<Response>;
    };
    const u = new URL(request.url);
    // Preserve quack's method/headers/body verbatim; the forwarder strips hop-by-hop
    // on its side. Buffer the body (containerFetch wants a concrete body, and quack
    // requests are small).
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => { headers[k] = v; });
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const body = hasBody ? new Uint8Array(await request.arrayBuffer()) : undefined;
    // containerFetch routes by PORT; the URL host is ignored, only path+query matter.
    return gw.containerFetch(`http://gw${u.pathname}${u.search}`, { method: request.method, headers, body }, GW_FWD_PORT);
  },
};

// ── cold-boot retry (proven in the ws-probe) ───────────────────────────────────
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
  startProcess(cmd: string, opts?: { cwd?: string }): Promise<unknown>;
  containerFetch(url: string, init: RequestInit, port?: number): Promise<Response>;
}
interface WsHandle {
  exec(cmd: string): Promise<{ stdout: string; stderr?: string }>;
  startProcess(cmd: string, opts?: { cwd?: string }): Promise<unknown>;
  containerFetch(url: string, init: RequestInit, port?: number): Promise<Response>;
  setAllowedHosts(hosts: string[]): Promise<void>;
  setOutboundByHost(host: string, handlerName: string): Promise<void>;
  destroy(): Promise<void>;
}

// ── gateway helpers (from the proven gw-probe) ─────────────────────────────────
async function ensureGateway(gw: GatewayHandle): Promise<{ waitedMs: number }> {
  const marker = await gw.exec("test -f /tmp/gw-started && echo yes || echo no");
  if (marker.stdout.trim() !== "yes") {
    await gw.exec("touch /tmp/gw-started");
    await gw.startProcess(BOOT_CMD, { cwd: GW_DIR });
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

// RS256 keypair: public half → birdshot JWKS, private half → session JWT (from gw-probe).
async function mintAuthAndJwt(): Promise<{ auth: { issuer: string; audience: string; jwks: { kid: string; n: string; e: string }[] }; jwt: string; kid: string }> {
  const { publicKey, privateKey } = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  )) as CryptoKeyPair;
  const pubJwk = (await crypto.subtle.exportKey("jwk", publicKey)) as JWK & { n: string; e: string };
  const kid = "loop-key-1";
  const audience = `gw:${ENDPOINT_ID}`;
  const auth = { issuer: ISSUER, audience, jwks: [{ kid, n: pubJwk.n, e: pubJwk.e }] };
  const principal = `agent:${AGENT_ID}`;
  const privJwk = (await crypto.subtle.exportKey("jwk", privateKey)) as JWK;
  const key = (await importJWK(privJwk, "RS256")) as CryptoKey;
  const jwt = await new SignJWT({ id: principal })
    .setProtectedHeader({ alg: "RS256", kid })
    .setSubject(principal).setIssuer(ISSUER).setAudience(audience)
    .setIssuedAt().setJti(crypto.randomUUID()).setExpirationTime("15m")
    .sign(key);
  return { auth, jwt, kid };
}

// ── workspace helpers (trimmed from the ws-probe: NO R2 — the loop only needs an
// ephemeral encrypted workspace that ATTACHes the lake; durability was proven in #3) ─
const WS_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const WS_SIDECAR_CMD = "node --use-system-ca /opt/workspace/workspace-sidecar.mjs";

async function sidecar(ws: WsHandle, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await ws.containerFetch(`http://ws${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }, WS_SIDECAR_PORT);
  const txt = await r.text();
  let json: any = txt;
  try { json = txt ? JSON.parse(txt) : {}; } catch { /* keep raw */ }
  return { status: r.status, json };
}

/** Boot the workspace sidecar, engage egress (allowlist + route GW_HOST → the
 *  outbound handler), and /init it to ATTACH quack to the gateway. */
async function ensureWorkspaceLake(env: Env, wsId: string, lakeToken: string): Promise<{ initStatus: number; initJson: any }> {
  const ws = getSandbox(env.WORKSPACE, wsId) as unknown as WsHandle;

  await withBootRetry(() => ws.exec("echo ready"), `warmup ${wsId}`);
  // Deny-by-default egress: ONLY GW_HOST may leave, and route it to the toGateway
  // handler (the #1 hop into the private gateway DO). Both boot-retried — egress
  // config changes can momentarily restart the container.
  await withBootRetry(() => ws.setAllowedHosts([GW_HOST]), `setAllowedHosts ${wsId}`);
  await withBootRetry(() => ws.setOutboundByHost(GW_HOST, "toGateway"), `setOutboundByHost ${wsId}`);

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
  if (!healthy) throw new Error(`sidecar not healthy in 90s: ${lastErr}`);

  // /init with the lake leg ENGAGED (no presigned R2 → fresh ephemeral encrypted DB).
  // disableSsl:false → quack speaks HTTPS:443 so interceptHttps captures it; the
  // sidecar ATTACHes quack:GW_HOST:443 AS lake (TOKEN <jwt>). lockConfiguration after.
  const init = await sidecar(ws, "/init", {
    key: WS_KEY,
    lakeProxy: `${GW_HOST}:443`,
    lakeToken,
    disableSsl: false,
    getStatus404Ok: true,
    lockConfiguration: true,
  });
  return { initStatus: init.status, initJson: init.json };
}

// ── /probe ─────────────────────────────────────────────────────────────────────
async function runProbe(env: Env): Promise<Response> {
  const result: Record<string, unknown> = {};
  const wsId = `ws-loop-${crypto.randomUUID().slice(0, 8)}`;

  // 1. Boot the gateway; push the birdshot snapshot (production RS256); mint the JWT.
  const gw = getSandbox(env.GATEWAY, GW_ID) as unknown as GatewayHandle;
  result.gatewayReady = await ensureGateway(gw);

  const { auth, jwt, kid } = await mintAuthAndJwt();
  const snapshot = {
    userRoles: [{ userId: `agent:${AGENT_ID}`, role: ROLE }],
    roleGrants: [{ role: ROLE, tableRef: "main.orders", action: "read" as const }],
  };
  const push = await gwFwd(gw, "/ctrl/snapshot", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshot, auth, lakeCatalog: "memory" }),
  });
  result.snapshotPush = push.json;
  result.kid = kid;

  const status = await gwFwd(gw, "/ctrl/status", { method: "GET" });
  const birdshotMode = (status.json?.birdshot?.mode as string) ?? "unknown";
  result.birdshotMode = birdshotMode;

  // 2. Boot the workspace + wire egress + ATTACH quack to the gateway over :443.
  const ws = getSandbox(env.WORKSPACE, wsId) as unknown as WsHandle;
  try {
    const lake = await ensureWorkspaceLake(env, wsId, jwt);
    result.workspaceInit = lake;
    const lakeAttached = lake.initStatus === 200 && lake.initJson?.lakeAttached === true;
    result.lakeAttached = lakeAttached;

    // 3a. ALLOWED: read orders THROUGH the quack:443 tunnel into the private gateway DO.
    const allowed = await sidecar(ws, "/query", { sql: "SELECT * FROM lake.orders ORDER BY id" });
    result.allowed = allowed.json;
    const allowedRows = allowed.status === 200 && Array.isArray(allowed.json?.rows) && allowed.json.rows.length > 0;

    // 3b. DENIED: secrets has no grant → birdshot denies → the query THROWS. We assert
    // the error is an AUTHORIZATION denial (not a missing-table/parse error) — the
    // allowed read above proves the tunnel + table resolution work, so a secrets throw
    // that names authorization is a genuine birdshot deny on the SAME tunnel.
    const denied = await sidecar(ws, "/query", { sql: "SELECT ssn FROM lake.secrets" });
    result.denied = denied.json;
    const deniedErr = String(denied.json?.error ?? "");
    const looksAuthz = /authoriz|permission|denied|not allowed|forbidden/i.test(deniedErr);
    const looksMissing = /does not exist|not found|no such|catalog|parser|syntax/i.test(deniedErr);
    const deniedByAuthz = denied.status === 500 && looksAuthz && !looksMissing;
    result.deniedDetail = { deniedErr, looksAuthz, looksMissing };

    const birdshotModeRs256 = birdshotMode === "rs256";
    const pass = birdshotModeRs256 && lakeAttached && allowedRows && deniedByAuthz;

    return Response.json({
      verdict: pass ? "LOOP-PASS" : "LOOP-FAIL",
      proves:
        "the waddling invariant end-to-end on real Cloudflare: the workspace's locked DuckDB ATTACHes quack over HTTPS:443, the workspace outbound handler routes that ONE egress to a PRIVATE gateway DO via a binding (raw quack wire surviving intercept → handler → containerFetch → forwarder → quack_serve), and birdshot_authorize gates the read inside the gateway in production RS256 mode — orders allowed, secrets denied.",
      birdshotMode, birdshotProductionMode: birdshotModeRs256,
      lakeAttached, allowedRows, allowedRowCount: allowed.json?.rows?.length ?? 0,
      deniedByAuthz, deniedError: deniedErr || null,
      waddlingEnv: env.WADDLING_ENV,
      detail: result,
      interpretation: pass
        ? "Full :443 loop holds: agent SQL reached the lake through exactly one quack tunnel into the private gateway DO, birdshot-gated (orders rows returned, secrets denied at authz). Raw quack wire survives the DO hop."
        : !birdshotModeRs256 ? `FALSE-PASS GUARD: birdshot mode '${birdshotMode}' != 'rs256'.`
        : !lakeAttached ? "Workspace did not ATTACH the lake — the quack:443 tunnel did not establish (check TLS trust of the interception CA by quack, or the outbound route)."
        : !allowedRows ? "ATTACH ok but the allowed read returned no rows — quack wire may not survive the hop for the query/fetch round-trips."
        : "Allowed read worked but the forbidden read was not an authz denial — check the deny path on the tunnel.",
    });
  } finally {
    try { await (getSandbox(env.WORKSPACE, wsId) as unknown as WsHandle).destroy(); } catch { /* free the slot */ }
  }
}

// ── Stage D egress GATE: can raw Postgres :5432 leave a GatewayDO container? ─────
// The gateway's trusted connection ATTACHes `ducklake:postgres:<dsn>` — raw PG wire on
// :5432 — for the real per-endpoint (per-org PlanetScale) catalog. CF container egress
// historically passes only HTTP 80/443+DNS (the finding that forced quack onto :443),
// so 5432 from this container is unproven and gates the whole real-lake/provisioning
// design. Dials the host from inside the SAME gateway container image the data plane
// uses, so the result transfers 1:1. Run against a real PlanetScale PG host:
//   GET /egress?pgHost=us-east-4.pg.psdb.cloud&pgPort=5432
const R2_ENDPOINT_FOR_PROBE = "https://866403f7ed22a791871b45539ac6fbd7.r2.cloudflarestorage.com";
async function egressProbe(env: Env, url: URL): Promise<Response> {
  const pgHost = url.searchParams.get("pgHost");
  const pgPort = Number(url.searchParams.get("pgPort") ?? "5432");
  if (!pgHost) return Response.json({ error: "pass ?pgHost=<postgres host>&pgPort=5432" }, { status: 400 });
  const gw = getSandbox(env.GATEWAY, GW_ID) as unknown as GatewayHandle;
  await withBootRetry(() => gw.exec("echo ready"), "gw egress warmup");

  // base64-pipe the inline JS to dodge shell quoting.
  const dialJs =
    `const net=require('net');` +
    `const s=net.connect({host:${JSON.stringify(pgHost)},port:${pgPort}},()=>{console.log('CONNECTED');s.destroy();process.exit(0)});` +
    `s.setTimeout(8000,()=>{console.log('TIMEOUT');try{s.destroy()}catch(e){}process.exit(0)});` +
    `s.on('error',e=>{console.log('ERROR:'+(e.code||e.message))});`;
  const dial = await gw.exec(`echo ${btoa(dialJs)} | base64 -d | node`);
  const pgRaw = dial.stdout.trim();

  const r2Js = `fetch(${JSON.stringify(R2_ENDPOINT_FOR_PROBE)}).then(r=>console.log('R2:'+r.status)).catch(e=>console.log('R2ERR:'+(e.code||e.message)))`;
  const r2 = await gw.exec(`echo ${btoa(r2Js)} | base64 -d | node`);
  const r2Raw = r2.stdout.trim();

  const pgConnected = /^CONNECTED/.test(pgRaw);
  const pgEgressLeaves = pgConnected || /^ERROR:ECONNREFUSED/.test(pgRaw);
  return Response.json({
    gate: "stage-d-egress-5432",
    pgHost, pgPort,
    pg: {
      raw: pgRaw,
      egressLeavesContainer: pgEgressLeaves,
      verdict: pgConnected
        ? "5432 egress WORKS — ducklake:postgres (per-org PlanetScale) is viable from the container"
        : /^ERROR:ECONNREFUSED/.test(pgRaw)
          ? "reached host, no listener (egress works; check host:port)"
          : "5432 BLOCKED (timeout/unreachable) — ducklake:postgres NOT viable as-is",
    },
    r2: { raw: r2Raw, reachableOver443: /^R2:\d/.test(r2Raw) },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/probe") {
      try {
        return await runProbe(env);
      } catch (e) {
        return Response.json(
          { verdict: "LOOP-FAIL", error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined },
          { status: 500 },
        );
      }
    }
    if (url.pathname === "/egress") {
      try {
        return await egressProbe(env, url);
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
      }
    }
    return new Response(
      "Stage C/D full :443 loop probe. GET /probe (full loop) or GET /egress?pgHost=<h>&pgPort=5432 (Stage D 5432 gate).\n",
      { status: 200 },
    );
  },
};
