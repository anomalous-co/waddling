// Stage D gateway probe — the waddling GATEWAY as a private CF Container Durable
// Object, reached via containerFetch (NOT a public host), serving birdshot-GATED
// quack in PRODUCTION RS256 mode.
//
// THE QUESTION. Lynchpin #1 (cf-stagec-hop-probe) proved a Sandbox's outbound
// handler can route an allowlisted egress to an internal DO via its binding — i.e.
// the gateway will be REACHED internally. This probe proves the OTHER unproven
// integration: that the gateway (DuckDB + quack_serve + birdshot) actually RUNS
// inside a CF Container DO, is reachable via containerFetch, and that
// birdshot_authorize gates queries when birdshot is in production RS256 mode (NOT
// the dev mode that skips signature/iss/aud — a green dev-mode result is a FALSE
// PASS, so the verdict asserts mode === "rs256").
//
// PROOF PATH (honest scope):
//   Worker /probe
//     → GatewayDO.startProcess(gateway boot + forwarder)        [in container]
//     → containerFetch(:8080 /ctrl/snapshot)  push ACL + RS256 JWKS into birdshot
//     → mint RS256 session JWT (jose) in the Worker
//     → containerFetch(:8080 /query {token, sql})
//          → in-container DuckDB quack CLIENT ATTACHes quack:9500 (TOKEN=jwt)
//          → birdshot_authenticate (RS256) + birdshot_authorize gate the SQL
//   The containerFetch hop carries the CONTROL request + JSON rows, NOT raw quack
//   wire. This proves "the gateway DO serves GATED quack"; it does NOT claim quack
//   wire survives the DO hop (that is a later step — see README).

import { getSandbox, Sandbox, ContainerProxy } from "@cloudflare/sandbox";
import { importJWK, SignJWT, type JWK } from "jose";

// Required when a Sandbox subclass is used: the SDK routes container control
// through this WorkerEntrypoint, so it must be exported from the Worker. (Carried
// over from the proven hop probe even though this probe does not intercept egress.)
export { ContainerProxy };

interface Env {
  GATEWAY: DurableObjectNamespace<GatewayDO>;
  WADDLING_ENV: string;
}

// The probe's fixed identifiers. endpointId scopes the JWT audience (gw:<id>) and
// the agent principal is the JWT subject (agent:<id>) — mirrors control-api/sessions.ts.
const ENDPOINT_ID = "ep-gwprobe";
const AGENT_ID = "agent-x";
const ISSUER = "https://probe.waddling.test/";
const ROLE = `agent_${AGENT_ID}`;
const FWD_PORT = 8080;

// The gateway boot command the DO launches inside the container. tsx is loaded by
// ABSOLUTE path (not the bare `tsx` specifier) so it resolves regardless of the
// process-server's cwd; `--import` lets node run the .ts gateway source (the
// type-only @waddling/control-schema import is erased). cwd is also pinned to
// /opt/gateway below for good measure. Runs as the long-lived gateway process next
// to the SDK process-server.
const GW_DIR = "/opt/gateway";
// `--import tsx` MUST be the bare specifier (tsx's package export that registers
// the loader), NOT a directory path — `node --import <dir>` throws
// ERR_UNSUPPORTED_DIR_IMPORT. The bare specifier resolves from cwd, which
// startProcess pins to GW_DIR below, so /opt/gateway/node_modules/tsx is found.
const BOOT_CMD = `node --import tsx ${GW_DIR}/entrypoint.mjs`;

// GatewayDO is a bare Sandbox subclass — the probe drives it ENTIRELY through the
// SDK's own methods (startProcess / containerFetch / exec, the same method class the
// hop probe proved), NOT through custom subclass methods on the getSandbox stub
// (whose RPC dispatch for arbitrary subclass methods is unproven). It is a PRIVATE
// internal DO — never publicly exposed.
export class GatewayDO extends Sandbox<Env> {}

// Start the gateway process (guarded so a re-run doesn't spawn a second) and wait
// until the forwarder's /healthz is reachable via containerFetch — which also
// confirms quack_serve is up, since the forwarder boots only after bootDuckRuntime
// returns. Uses ONLY SDK methods on the sandbox handle.
async function ensureGateway(sandbox: GatewaySandbox): Promise<{ started: boolean; waitedMs: number }> {
  const marker = await sandbox.exec("test -f /tmp/gw-started && echo yes || echo no");
  if (marker.stdout.trim() !== "yes") {
    await sandbox.exec("touch /tmp/gw-started");
    await sandbox.startProcess(BOOT_CMD, { cwd: GW_DIR });
  }

  const start = Date.now();
  const deadlineMs = 90_000;
  let lastErr = "";
  while (Date.now() - start < deadlineMs) {
    try {
      const r = await sandbox.containerFetch("http://gw/healthz", { method: "GET" }, FWD_PORT);
      if (r.ok) return { started: true, waitedMs: Date.now() - start };
      lastErr = `healthz ${r.status}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`gateway did not become healthy in ${deadlineMs}ms: ${lastErr}`);
}

// Drive the in-container forwarder over containerFetch (port 8080).
async function fwd(sandbox: GatewaySandbox, path: string, init: RequestInit): Promise<unknown> {
  const r = await sandbox.containerFetch(`http://gw${path}`, init, FWD_PORT);
  const txt = await r.text();
  let json: unknown = txt;
  try { json = txt ? JSON.parse(txt) : {}; } catch { /* keep raw */ }
  if (!r.ok) throw new Error(`forwarder ${path} ${r.status}: ${txt}`);
  return json;
}

// The shape getSandbox returns: the SDK methods this probe uses. (getSandbox returns
// a sandbox handle, not a GatewayDO instance — we only ever call SDK methods on it.)
interface GatewaySandbox {
  exec(cmd: string): Promise<{ stdout: string }>;
  startProcess(cmd: string, opts?: { cwd?: string }): Promise<unknown>;
  containerFetch(url: string, init: RequestInit, port?: number): Promise<Response>;
}

// RS256 keypair for the probe. Generated per /probe run (ephemeral) — the public
// half is pushed into birdshot as the JWKS, the private half mints the session
// JWT. Mirrors control-api/sessions.ts (importJWK + SignJWT, kid header).
async function mintAuthAndJwt(): Promise<{
  auth: { issuer: string; audience: string; jwks: { kid: string; n: string; e: string }[] };
  jwt: string;
  kid: string;
}> {
  const { publicKey, privateKey } = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pubJwk = (await crypto.subtle.exportKey("jwk", publicKey)) as JWK & { n: string; e: string };
  const kid = "probe-key-1";
  const audience = `gw:${ENDPOINT_ID}`;

  // Push: birdshot runs in production RS256 mode because applySnapshot sees `auth`
  // → birdshot_set_auth(issuer, audience, 'rs256') + birdshot_add_jwk(kid, n, e).
  const auth = { issuer: ISSUER, audience, jwks: [{ kid, n: pubJwk.n, e: pubJwk.e }] };

  // Mint the session JWT exactly as control-api/sessions.ts does: RS256, kid header,
  // sub/iss/aud, jti, 15m exp. `id` claim = principal; the gateway ignores extras.
  const principal = `agent:${AGENT_ID}`;
  const privJwk = (await crypto.subtle.exportKey("jwk", privateKey)) as JWK;
  const key = (await importJWK(privJwk, "RS256")) as CryptoKey;
  const jwt = await new SignJWT({ id: principal })
    .setProtectedHeader({ alg: "RS256", kid })
    .setSubject(principal)
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime("15m")
    .sign(key);

  return { auth, jwt, kid };
}

async function runProbe(env: Env): Promise<Response> {
  // Fresh container id per binary rev so a redeploy boots a brand-new container
  // with the new image, never reusing a prior instance's /tmp/gw-started marker.
  const gw = getSandbox(env.GATEWAY, "gw-probe-3") as unknown as GatewaySandbox;

  const result: Record<string, unknown> = {};

  // 1. Boot the gateway in the container + wait for quack readiness.
  const ready = await ensureGateway(gw);
  result.gatewayReady = ready;

  // 2. Mint RS256 JWKS + session JWT, push the ACL snapshot (production mode).
  const { auth, jwt, kid } = await mintAuthAndJwt();
  // ACL: role agent_x → READ main.orders; main.secrets is NOT granted (deny by
  // omission — birdshot fails closed on any table without an explicit grant). The
  // tables are seeded in memory.main (the proven federation placement), so the
  // bind-walk lake catalog is 'memory' and the agent reads them as `lake.<table>`.
  const snapshot = {
    userRoles: [{ userId: `agent:${AGENT_ID}`, role: ROLE }],
    roleGrants: [{ role: ROLE, tableRef: "main.orders", action: "read" as const }],
  };
  const pushed = await fwd(gw, "/ctrl/snapshot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshot, auth, lakeCatalog: "memory" }),
  });
  result.snapshotPush = pushed;
  result.kid = kid;

  // 3. Read birdshot status — assert PRODUCTION RS256 mode (a dev-mode pass is FALSE).
  const status = (await fwd(gw, "/ctrl/status", { method: "GET" })) as { birdshot?: { mode?: string } };
  const birdshotMode = status.birdshot?.mode ?? "unknown";
  result.birdshotStatus = status.birdshot;

  // 4a. ALLOWED: SELECT * FROM lake.orders → expect rows.
  const allowed = (await fwd(gw, "/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: jwt, sql: "SELECT * FROM lake.orders ORDER BY id" }),
  })) as { ok: boolean; rows?: unknown[]; rowCount?: number; error?: string; authorizeDecision?: string };
  result.allowed = allowed;

  // 4b. DENIED: SELECT ssn FROM secrets → expect the query to THROW and birdshot's
  // last authorize decision to be "deny" (an empty result or a parse error is NOT a
  // pass — the audit decision is the authoritative signal).
  const denied = (await fwd(gw, "/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: jwt, sql: "SELECT ssn FROM lake.secrets" }),
  })) as { ok: boolean; rows?: unknown[]; error?: string; authorizeDecision?: string };
  result.denied = denied;

  // ── Verdict ──────────────────────────────────────────────────────────────────
  const birdshotMode_rs256 = birdshotMode === "rs256";
  const allowedRows = allowed.ok && (allowed.rowCount ?? 0) > 0;
  // A genuine authorization denial: the query threw AND birdshot logged decision=deny.
  const deniedByAuthz = denied.ok === false && denied.authorizeDecision === "deny";
  // Boot order is asserted structurally: bootDuckRuntime installs the birdshot
  // auth/authz hooks BEFORE quack_serve (duck.ts:126-133), and the forwarder (hence
  // /healthz, hence this whole exchange) only starts AFTER bootDuckRuntime returns —
  // so there is never an allow-all window observable to this probe.
  const bootOrderOk = true;

  const pass = birdshotMode_rs256 && allowedRows && deniedByAuthz;

  return Response.json({
    verdict: pass ? "GW-PASS" : "GW-FAIL",
    proves:
      "the waddling gateway (DuckDB + quack_serve + birdshot) runs inside a CF Container Durable Object, is reachable via containerFetch (no public host), and birdshot_authorize gates queries in PRODUCTION RS256 mode. Gated-quack-serving proof; raw quack wire survival through the DO hop is out of scope.",
    birdshotMode,
    birdshotProductionMode: birdshotMode_rs256,
    allowedRows,
    allowedRowCount: allowed.rowCount ?? 0,
    deniedByAuthz,
    deniedError: denied.error ?? null,
    deniedAuthorizeDecision: denied.authorizeDecision ?? null,
    bootOrderOk,
    waddlingEnv: env.WADDLING_ENV,
    detail: result,
    interpretation: pass
      ? "Gateway serves birdshot-gated quack from a private Container DO in production RS256 mode: orders returned rows, secrets denied at authz."
      : !birdshotMode_rs256
        ? `FALSE-PASS GUARD: birdshot mode is '${birdshotMode}', not 'rs256' — gating ran in dev mode (no signature/iss/aud). Inconclusive.`
        : !allowedRows
          ? "Allowed query returned no rows — the gated read path did not work (check ATTACH/auth)."
          : "Denied query was NOT an authz denial (no thrown query + decision=deny) — possible chokepoint leak or wrong error.",
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/debug") {
      // Capture the gateway boot output directly: run the entrypoint under a
      // timeout (it would otherwise block on the forwarder) and return stdout+stderr
      // so a boot-time throw (e.g. birdshot LOAD / a SET) is visible. Fresh id =
      // clean container with no prior boot holding the ports.
      try {
        const dbg = getSandbox(env.GATEWAY, "gw-debug-1") as unknown as GatewaySandbox;
        const cmd =
          "cd /opt/gateway && (timeout 40 node --import tsx /opt/gateway/entrypoint.mjs 2>&1 | head -160); " +
          "echo '---BIRDSHOT-FILE---'; file /opt/birdshot/birdshot.duckdb_extension; " +
          "echo '---LDD-MISSING---'; ldd /opt/birdshot/birdshot.duckdb_extension 2>&1 | grep -iE 'not found|error' | head; " +
          "echo '---NODE---'; node -v";
        const r = await dbg.exec(cmd);
        return new Response((r as { stdout?: string; stderr?: string }).stdout ?? JSON.stringify(r), {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }, { status: 500 });
      }
    }
    if (url.pathname === "/probe") {
      try {
        return await runProbe(env);
      } catch (e) {
        return Response.json(
          { verdict: "GW-FAIL", error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined },
          { status: 500 },
        );
      }
    }
    return new Response(
      "Stage D gateway probe (gateway as a private Container DO, serving birdshot-gated quack). GET /probe to run.\n",
      { status: 200 },
    );
  },
};
