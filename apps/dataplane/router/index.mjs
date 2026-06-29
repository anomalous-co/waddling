// Public quack router. The ONE internet-facing ingress for the governed mesh.
//
// Why it exists: the quack wire protocol carries its auth token INSIDE the binary POST body
// (a serialized ConnectionRequestMessage), so a quack client cannot add an HTTP Authorization
// header. Our gateways are PRIVATE Cloud Run services (--no-allow-unauthenticated) that only
// accept a Google identity token. This router is the public, dumb, streaming proxy that bridges
// the gap: it mints a Google identity token for the target gateway and forwards the request
// unchanged. It performs NO auth of its own — birdshot inside the private gateway authenticates
// the per-user JWT (which it reads out of the quack body) and enforces the ACL. An unauthenticated
// request reaches a gateway that rejects it; no data is reachable without a valid birdshot JWT.
//
// Routing is on HOST only: the quack client ATTACHes `quack:<host>:443` and always POSTs to
// /quack with no path component, and the token is opaque to us — so the host is the only routing
// signal. `gw-<slug>` / `ws-<slug>` subdomains map to the `gw-<slug>` / `ws-<slug>` Cloud Run
// service. A fixed TARGET_SERVICE_URL (single-endpoint bring-up) is used when the host doesn't
// match the pattern, which also lets us test over the router's own *.run.app URL without DNS.
//
// quack transport requirements the proxy MUST preserve (from the quack server source + the
// reverse-proxy guidance): HTTP/1.1 keep-alive (the server holds per-connection cursor state
// across FETCHes), unbounded request bodies (PREPARE carries SQL, APPEND carries data chunks),
// long idle timeouts (queries sit between FETCHes), and NO response buffering (results stream
// back over repeated FETCH responses). We therefore pipe request and response through untouched.
// Statelessness is safe because each endpoint is a single max-instances=1 backend: every router
// instance forwarding to `gw-<slug>` reaches the same one process, so the sticky cursor resolves.

import http from "node:http";
import https from "node:https";
import { GoogleAuth } from "google-auth-library";

const PORT = Number(process.env.PORT ?? 8080);
const TARGET_SERVICE_URL = process.env.TARGET_SERVICE_URL ?? ""; // fixed-target fallback (bring-up)
const PROJECT = process.env.GCP_PROJECT ?? "project-bd87157a-f6fd-4d44-830";
const REGION = process.env.GCP_REGION ?? "us-west1";
const HOST_SUFFIX = process.env.ROUTER_HOST_SUFFIX ?? ""; // e.g. "getwaddling.com"; empty => host-routing off

const log = (...a) => console.log("[router]", ...a);

const auth = new GoogleAuth();

// Hop-by-hop headers must not be forwarded across the proxy (RFC 7230 §6.1).
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
]);

// ── Cloud Run service URL resolution (host → private gateway base URL) ───────────────
// A `gw-<slug>` / `ws-<slug>` host maps to the Cloud Run service of the same name; we look up
// its run.app URL via the Cloud Run Admin API (cached). When the host doesn't match, or host
// routing is disabled, we fall back to TARGET_SERVICE_URL (single-endpoint bring-up / no DNS).
const urlCache = new Map(); // serviceName -> { url, exp }
const URL_TTL_MS = 5 * 60 * 1000;

function serviceNameFromHost(hostHeader) {
  if (!HOST_SUFFIX) return null;
  const host = String(hostHeader ?? "").split(":")[0].toLowerCase();
  const m = host.match(/^((?:gw|ws)-[a-z0-9-]+)\./);
  if (!m) return null;
  if (!host.endsWith("." + HOST_SUFFIX) && host !== HOST_SUFFIX) return null;
  return m[1]; // "gw-<slug>" | "ws-<slug>"
}

// Cloud Run service URLs are deterministic per project: https://<service>-<hash>.<region>.run.app,
// where <hash> is derived from the project NUMBER and is therefore CONSTANT across all services in
// the project. So when RUN_URL_SUFFIX is set (e.g. "-ampdswzubq-uw.a.run.app") we construct the URL
// directly — no Cloud Run Admin API call, hence no run.viewer on the router SA. Falls back to the
// Admin API lookup (requires run.viewer) when the suffix is not configured.
const RUN_URL_SUFFIX = process.env.RUN_URL_SUFFIX ?? "";
async function resolveServiceUrl(serviceName) {
  if (RUN_URL_SUFFIX) return `https://${serviceName}${RUN_URL_SUFFIX}`;
  const cached = urlCache.get(serviceName);
  const now = Date.now();
  if (cached && cached.exp > now) return cached.url;
  // Cloud Run Admin API (run.googleapis.com v2): GET .../services/<name> → uri
  const client = await auth.getClient();
  const apiUrl = `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/services/${serviceName}`;
  const res = await client.request({ url: apiUrl });
  const url = res.data?.uri;
  if (!url) throw new Error(`no uri for service ${serviceName}`);
  urlCache.set(serviceName, { url, exp: now + URL_TTL_MS });
  return url;
}

async function targetForRequest(req) {
  const svc = serviceNameFromHost(req.headers.host);
  if (svc) return await resolveServiceUrl(svc);
  if (TARGET_SERVICE_URL) return TARGET_SERVICE_URL;
  throw new Error(`no target: host '${req.headers.host}' did not match gw-/ws- and no TARGET_SERVICE_URL set`);
}

// ── Identity tokens (per target audience, cached just under the 1h lifetime) ─────────
const tokenCache = new Map(); // targetUrl -> { token, exp }
async function idTokenFor(targetUrl) {
  const cached = tokenCache.get(targetUrl);
  const now = Date.now();
  if (cached && cached.exp > now) return cached.token;
  const client = await auth.getIdTokenClient(targetUrl);
  // fetchIdToken returns the raw ID token string (audience = targetUrl) — robust across
  // google-auth-library versions, unlike getRequestHeaders() whose return shape (plain object
  // vs Headers) varies and silently yields "Bearer undefined".
  let token = await client.idTokenProvider.fetchIdToken(targetUrl);
  if (!token) {
    const headers = await client.getRequestHeaders(targetUrl);
    const authz = headers?.get ? headers.get("authorization") : (headers?.Authorization || headers?.authorization);
    token = String(authz || "").replace(/^Bearer\s+/i, "");
  }
  if (!token) throw new Error(`failed to mint identity token for ${targetUrl}`);
  log(`minted id token for ${targetUrl} (len ${token.length})`);
  tokenCache.set(targetUrl, { token, exp: now + 55 * 60 * 1000 });
  return token;
}

// Persistent upstream agent — keep-alive is required for quack's per-connection cursor state.
const keepAliveAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 256 });

const server = http.createServer((req, res) => {
  void forward(req, res).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    log(`${req.method} ${req.headers.host}${req.url} → 502: ${msg}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`router error: ${msg}`);
  });
});

async function forward(req, res) {
  // Lightweight liveness on the router itself (never proxied).
  if (req.method === "GET" && (req.url === "/__router/health" || req.url === "/healthz")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, target: TARGET_SERVICE_URL || "(host-routed)" }));
    return;
  }

  // ── SECURITY: allowlist the quack DATA path only ──────────────────────────────────────
  // The public router must expose ONLY the birdshot-gated quack wire protocol (POST /quack;
  // OPTIONS /quack for wasm-client CORS preflight). The gateway's /ctrl/* (snapshot/revoke —
  // which install the JWKS that is birdshot's root of trust) and /governed-load are TRUSTED,
  // UNAUTHENTICATED endpoints; forwarding them publicly would be a full auth-bypass. They are
  // reachable only by callers with run.invoker on the private gateway (control-api presenting a
  // Google identity token directly — quack clients can't set that header, which is what makes
  // this split clean). Default-DENY so a newly-added control endpoint isn't silently exposed.
  const reqPath = (req.url || "/").split("?")[0];
  if (!(reqPath === "/quack" && (req.method === "POST" || req.method === "OPTIONS"))) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found — the router forwards only the quack data path (POST /quack). Control endpoints are reached directly by authenticated control-plane callers.");
    return;
  }

  const targetBase = await targetForRequest(req);
  const token = await idTokenFor(targetBase);
  const target = new URL(req.url, targetBase);

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null || HOP_BY_HOP.has(k.toLowerCase())) continue;
    headers[k] = v;
  }
  headers["authorization"] = `Bearer ${token}`;
  headers["host"] = target.host;

  const upstream = https.request(
    target,
    { method: req.method, headers, agent: keepAliveAgent },
    (up) => {
      const outHeaders = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (HOP_BY_HOP.has(k.toLowerCase())) continue;
        outHeaders[k] = v;
      }
      res.writeHead(up.statusCode || 502, outHeaders);
      up.pipe(res); // stream, no buffering
    },
  );
  upstream.setTimeout(600_000, () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`upstream error: ${e.message}`);
  });
  req.pipe(upstream); // stream request body (PREPARE/APPEND can be large), no buffering
}

server.keepAliveTimeout = 620_000;
server.headersTimeout = 625_000;
server.requestTimeout = 0; // long-lived quack requests sit idle between FETCHes
server.listen(PORT, "0.0.0.0", () => log(`listening on :${PORT}, fixed target=${TARGET_SERVICE_URL || "(none)"} host-suffix=${HOST_SUFFIX || "(off)"}`));
