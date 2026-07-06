// Control-plane Worker.
//
// Stage A validated the three load-bearing Cloudflare bindings (Hyperdrive →
// Postgres, Secrets Store, R2 via SigV4). Stage B1 extends that with the
// control-plane foundation: the ported db pool, Better Auth (6 plugins), and
// node:crypto secret sealing — plus probe routes that de-risk each before the
// 24 /api/cp/* routes get ported on top.
//
// Probe routes are temporary scaffolding; later stages delete them. Errors are
// reported as JSON, never thrown, so a single failing piece does not take down
// the whole probe surface.

import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { AwsClient } from "aws4fetch";
import { Pool } from "pg";
import type { Env } from "./lib/env";
import { query, initPool } from "./lib/db";
import {
  sweepExpiredSessions,
  resetAllTierCredits,
  currentBillingPeriod,
  reconcileDebits,
} from "./lib/credits";
import { buildAuth, runMigrations, initAuth } from "./lib/auth";
import { oAuthDiscoveryMetadata } from "better-auth/plugins";
import { makeCrypto, initCrypto } from "./lib/secret-crypto";
import { initDataplane, gatewayClientFor } from "./lib/gateway-client";
import { drainGatewayDispatch, refreshWarmCatalogs } from "./lib/gateway-dispatch";
import { resolveCaller, AuthError } from "./lib/cp-shared";
import { handleMcp } from "./mcp/server";
import type { LoopbackResult } from "./mcp/tools";
import { datalakes } from "./routes/datalakes";
import { workspaces } from "./routes/workspaces";
import { whoami } from "./routes/whoami";
import { agents } from "./routes/agents";
import { notebooks } from "./routes/notebooks";
import { views } from "./routes/views";
import { settings } from "./routes/settings";
import { team } from "./routes/team";
import { usage } from "./routes/usage";
import { audit } from "./routes/audit";
import { billing } from "./routes/billing";
import { acl } from "./routes/acl";
import { roles } from "./routes/roles";
import { policies } from "./routes/policies";
import { delegations } from "./routes/delegations";
import { sessions } from "./routes/sessions";
import { deviceLink } from "./routes/device-link";
import { catalog } from "./routes/catalog";
import { quackboard } from "./routes/quackboard";
import { account } from "./routes/account";
import { onboarding } from "./routes/onboarding";

const app = new Hono<{ Bindings: Env }>();

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Initialize per-isolate singletons once, before any handler — the db pool plus
// the secret-crypto pair and the gateway transport the ported lib layer
// resolves through getCrypto()/gatewayClientFor(). All read from `c.env` (no
// ambient env on workerd) and are idempotent — only the first request in a warm
// isolate does work. The crypto secret uses WADDLING_SECRET_KEY with a
// BETTER_AUTH_SECRET fallback (mirrors the original getSecretEncryptionKey()).
// ─── CORS (cross-origin browser dashboard) ───────────────────────────────────
// The UI render plane runs on its own origin (WEB_ORIGIN) and calls /api/cp/* +
// /api/auth/* here cross-origin WITH credentials, so each non-simple request is
// preflighted. Credentialed CORS forbids `Access-Control-Allow-Origin: *`, so we
// ECHO the request origin only when it is in WEB_ORIGIN (comma-separated allowlist).
// Registered FIRST and scoped to /api/* so an OPTIONS preflight short-circuits here
// (Hono's cors answers it without next()) and never opens a DB/auth pool below.
//
// Why a factory function instead of inline cors({ origin: ... })? The WORA env
// (WEB_ORIGIN) can differ per deployment (CF vars vs GCP env), so we compute
// the allow-set at call time rather than at module-load time. The closure is
// cheap (an array split + trim on a short string) and keeps the origin check
// lockstep with the current env binding.
function buildApiCors(webOrigin: string | undefined) {
  const allow = (webOrigin ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return cors({
    // Return the EXACT origin if allowed, otherwise null. Never return "*" —
    // credentialed CORS (cookies) requires a concrete origin.
    origin: (origin) => {
      // origin is always a string here (Hono passes c.req.header("origin") || "").
      // An empty string means either same-origin or a direct server-to-server call;
      // we return null (no ACAO header) which is correct — same-origin doesn't need CORS.
      if (!origin) return null;
      if (allow.includes(origin)) return origin;
      // Origin not in the allowlist — block. Include the blocked origin in the log
      // for observability but never leak it in the response.
      if (allow.length > 0) {
        console.log(`[cors] blocked origin: ${origin} (allow: ${allow.join(", ")})`);
      }
      return null;
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    // allowHeaders lists every header the browser may include in cross-origin
    // API calls. "Content-Type" covers JSON POST/PATCH bodies; "Authorization"
    // covers Bearer tokens sent directly by browser-side code (non-cookie auth).
    // Cookie-based auth does NOT need its header listed — the browser manages
    // "Cookie" automatically and never puts it in Access-Control-Request-Headers.
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 600,
  });
}
app.use("/api/*", (c, next) => buildApiCors(c.env.WEB_ORIGIN)(c, next));

// ─── CORS for the hosted MCP endpoint + OAuth discovery ──────────────────────
// The MCP endpoint (/mcp) and the apex OAuth metadata are reached by third-party
// MCP clients (Claude.ai, etc.). MCP auth rides the `Authorization` Bearer header,
// not cookies, so this is NOT credentialed CORS — `*` origin is allowed. The
// `WWW-Authenticate` header MUST be exposed so OAuth-capable clients can start the
// consent flow. Registered BEFORE the `*` DB/auth scope so an OPTIONS preflight
// short-circuits here without opening a pool.
app.use(
  "/mcp",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Accept", "mcp-protocol-version", "mcp-session-id", "last-event-id"],
    exposeHeaders: ["WWW-Authenticate", "mcp-session-id", "mcp-protocol-version"],
    maxAge: 600,
  }),
);
app.use(
  "/.well-known/*",
  cors({ origin: "*", allowMethods: ["GET", "OPTIONS"], allowHeaders: ["Content-Type"], maxAge: 600 }),
);

app.use("*", async (c, next) => {
  // Initialize module-level singletons (idempotent — first call wins).
  // On Node the server.ts startup already did this; on CF the first request does it.
  initCrypto(c.env.WADDLING_SECRET_KEY ?? c.env.BETTER_AUTH_SECRET);
  if (c.env.HYPERDRIVE) initPool(c.env.HYPERDRIVE.connectionString);
  initAuth(c.env);
  initDataplane(c.env.GATEWAY_BASE_URL);
  await next();
});

// ─── Better Auth ──────────────────────────────────────────────────────────────
// All auth/OAuth/MCP endpoints live under /api/auth/*. buildAuth returns this
// request's instance (constructed once per request inside runInAuthScope).
// Force an explicit approval screen on every MCP OAuth connection. The mcp plugin's
// authorize auto-issues the code right after login UNLESS prompt=consent (then it
// redirects to the consentPage and the /oauth2/consent endpoint engages). So we inject
// prompt=consent when absent. Registered BEFORE the /api/auth/* wildcard so it wins;
// the sign-in resume already carries prompt=consent → delegates straight through (no loop).
app.get("/api/auth/mcp/authorize", (c) => {
  const url = new URL(c.req.url);
  if (!url.searchParams.has("prompt")) {
    url.searchParams.set("prompt", "consent");
    return c.redirect(url.toString(), 302);
  }
  return buildAuth(c.env).handler(c.req.raw);
});

app.on(["GET", "POST"], "/api/auth/*", (c) => buildAuth(c.env).handler(c.req.raw));

// ─── Hosted MCP server (first-party, day-0) ──────────────────────────────────
// `/mcp` is the zero-install remote MCP endpoint third-party agents connect to.
// It supports BOTH day-0 auth paths via resolveCaller(allowDelegated=true): an
// `sk_agent_` API key (autonomous agents) OR a delegated OAuth access token
// (Claude.ai "add connector" → consent). An unauthenticated request returns 401
// with a `WWW-Authenticate` challenge pointing at the protected-resource metadata,
// which kicks off the OAuth flow in capable clients.
//
// The tools are NOT re-implemented here: each forwards the caller's inbound
// Authorization header to this Worker's own `/api/cp/*` routes (loopback app.fetch,
// the same in-process dispatch /probe/caller proves), so the existing handlers
// re-resolve + enforce exactly as for any external caller.

// OAuth Authorization Server Metadata (RFC 8414) at the apex — some clients default
// here instead of /api/auth/.well-known/*. Proxies to Better Auth's discovery doc.
app.get("/.well-known/oauth-authorization-server", (c) =>
  oAuthDiscoveryMetadata(buildAuth(c.env))(c.req.raw),
);

// OAuth Protected Resource Metadata (RFC 9728) — points clients at the auth server.
// `resource` MUST equal MCP_RESOURCE_URL (the audience cp-shared binds tokens to).
//
// Served at BOTH the apex and the RFC 9728 path-suffixed location for the resource.
// MCP_RESOURCE_URL has a path (`…/mcp`), so the spec-canonical metadata URL inserts
// `/.well-known/oauth-protected-resource` between host and path →
// `<origin>/.well-known/oauth-protected-resource/mcp`. The 401 challenge below
// advertises that exact URL; the apex route stays for clients that probe the root.
const protectedResourceMetadata = (c: Context<{ Bindings: Env }>) =>
  c.json({
    resource: c.env.MCP_RESOURCE_URL,
    authorization_servers: [c.env.BETTER_AUTH_URL],
    bearer_methods_supported: ["header"],
  });
app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
app.get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata);

app.on(["GET", "POST", "DELETE"], "/mcp", async (c) => {
  // Gate: authenticate the caller (both API-key and delegated-OAuth paths). org is
  // resolved per-tool, so requireOrg=false here.
  try {
    await resolveCaller(c, false, true);
  } catch (e) {
    if (e instanceof AuthError) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (e.status === 401) {
        // RFC 9728: metadata URL inserts the well-known path between host and the
        // resource's path. MCP_RESOURCE_URL = `<origin>/mcp` ⇒
        // `<origin>/.well-known/oauth-protected-resource/mcp` (NOT `<origin>/mcp/.well-known/…`,
        // which 404s — the route lives under the well-known prefix, not under /mcp).
        const ru = new URL(c.env.MCP_RESOURCE_URL);
        const metadataUrl = `${ru.origin}/.well-known/oauth-protected-resource${ru.pathname}`;
        headers["WWW-Authenticate"] = `Bearer resource_metadata="${metadataUrl}"`;
      }
      return new Response(JSON.stringify({ error: e.code, reason: e.message }), { status: e.status, headers });
    }
    throw e;
  }

  // Loopback client: forward the caller's credential into our own /api/cp/* routes.
  const authorization = c.req.header("authorization") ?? "";
  const loopback = async (
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<LoopbackResult> => {
    const res = await app.fetch(
      new Request(`https://control.internal${path}`, {
        method: init?.method ?? "GET",
        headers: { authorization, "content-type": "application/json" },
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      }),
      c.env,
    );
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    return { ok: res.ok, status: res.status, data };
  };

  // appUrl bases the dashboard deep-links some tools emit (e.g. the agent access
  // "propose" URL). It must be the UI origin, not this API origin — prefer WEB_ORIGIN
  // (app.getwaddling.com), then APP_URL, then the API base as a last resort.
  const appUrl = (
    c.env.WEB_ORIGIN?.split(",")[0]?.trim() ||
    c.env.APP_URL ||
    c.env.BETTER_AUTH_URL
  ).replace(/\/+$/, "");
  return handleMcp(c.req.raw, { loopback, appUrl });
});

// ─── /probe/db ──────────────────────────────────────────────────────────────
// Opens a pg Pool against the Hyperdrive (CF) or DATABASE_URL (Node) connection
// string and runs two trivial queries.
async function probeDb(env: Env) {
  const connStr = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!connStr) {
    return { ok: false, error: 'Postgres not configured (no HYPERDRIVE or DATABASE_URL)' };
  }
  const pool = new Pool({ connectionString: connStr, max: 5 });
  try {
    const one = await pool.query("SELECT 1 AS one");
    const version = await pool.query("SELECT version()");
    return {
      ok: true,
      one: one.rows[0]?.one,
      version: version.rows[0]?.version as string,
    };
  } catch (e) {
    return {
      ok: false,
      error: errMessage(e),
      hint:
        "A TLS/cert error means PlanetScale's CA must be uploaded via `wrangler cert`. " +
        "Hyperdrive uses WebPKI and ignores the libpq `sslrootcert` option.",
    };
  } finally {
    await pool.end().catch(() => {});
  }
}

// ─── /probe/secret ──────────────────────────────────────────────────────────
// Reads the master key from Secrets Store. The value is NEVER returned or logged;
// we only report presence, length, and whether it is still the Stage-A placeholder.
async function probeSecret(env: Env) {
  try {
    const v = await env.MASTER_KEY.get();
    return {
      ok: !!v,
      length: v?.length ?? 0,
      isPlaceholder: v?.startsWith("PLACEHOLDER") ?? false,
    };
  } catch (e) {
    return { ok: false, length: 0, isPlaceholder: false, error: errMessage(e) };
  }
}

// ─── /probe/r2 ────────────────────────────────────────────────────────────────
// Model B: there is no native R2 binding. We read S3 credentials from Secrets
// Store and exercise a presigned-URL round-trip (PUT then GET) against the R2
// S3 endpoint. With PLACEHOLDER creds R2 answers 403 — that is the expected,
// fail-closed state, reported gracefully (not thrown).
async function probeR2(env: Env) {
  try {
    const accessKeyId = await env.R2_ACCESS_KEY_ID.get();
    const secretAccessKey = await env.R2_SECRET_ACCESS_KEY.get();
    const credsArePlaceholder =
      (accessKeyId?.startsWith("PLACEHOLDER") ?? false) ||
      (secretAccessKey?.startsWith("PLACEHOLDER") ?? false);

    const client = new AwsClient({
      accessKeyId,
      secretAccessKey,
      region: env.R2_REGION,
      service: "s3",
    });

    const key = `probe/stage-b-${crypto.randomUUID()}.txt`;
    const objectUrl = `${env.R2_ENDPOINT}/${env.R2_BUCKET}/${key}`;
    const body = `stage-b-probe ${new Date().toISOString()}`;

    const putUrl = new URL(objectUrl);
    putUrl.searchParams.set("X-Amz-Expires", "300");
    const signedPut = await client.sign(putUrl.toString(), {
      method: "PUT",
      aws: { signQuery: true },
    });
    const putRes = await fetch(signedPut.url, { method: "PUT", body });
    const putStatus = putRes.status;
    const putErr = putRes.ok ? undefined : (await putRes.clone().text()).slice(0, 400);

    const getUrl = new URL(objectUrl);
    getUrl.searchParams.set("X-Amz-Expires", "300");
    const signedGet = await client.sign(getUrl.toString(), {
      method: "GET",
      aws: { signQuery: true },
    });
    const getRes = await fetch(signedGet.url, { method: "GET" });
    const getStatus = getRes.status;
    const roundTripMatch = getRes.ok ? (await getRes.text()) === body : false;

    const ok = putRes.ok && getRes.ok && roundTripMatch;
    const result: Record<string, unknown> = {
      ok,
      putStatus,
      getStatus,
      roundTripMatch,
      credsArePlaceholder,
      putErr,
    };
    if (credsArePlaceholder) {
      result.ok = false;
      result.note =
        "PENDING a real R2 S3 API token. Placeholder creds fail-closed (403 expected). " +
        "Mint a token in the dashboard → Manage R2 API Tokens, then update " +
        "r2-access-key-id / r2-secret-access-key in Secrets Store.";
    }
    return result;
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}

// ─── /probe/crypto ────────────────────────────────────────────────────────────
// The node:crypto de-risk. Seals + opens a JSON payload via AES-256-GCM. If
// node:crypto's GCM path is unavailable on workerd, this catches and REPORTS
// (nodeCryptoWorks:false) so the conductor knows whether a SubtleCrypto fallback
// is needed — it does NOT build one here.
function probeCrypto(env: Env) {
  try {
    const { sealJson, openJson } = makeCrypto(env.BETTER_AUTH_SECRET);
    const sealed = sealJson({ hello: "world", n: 42 });
    const back = openJson<{ hello: string; n: number }>(sealed);
    return { ok: back.n === 42, nodeCryptoWorks: true };
  } catch (e) {
    return { ok: false, nodeCryptoWorks: false, error: errMessage(e) };
  }
}

// ─── /probe/jwks ──────────────────────────────────────────────────────────────
// Reads the jwt plugin's JWKS via the Better Auth server API. A non-empty key set
// proves the jwt plugin loaded AND a DB read succeeded (keys live in the `jwks`
// table; the first read lazily generates the RS256 keypair).
//
// SAME schema precondition as /probe/auth: the `jwks` table is created by the
// Better Auth migration. On a greenfield PlanetScale this fails with
// `relation "jwks" does not exist` — run GET /probe/migrate FIRST. The raw error
// is surfaced verbatim so missing-schema is distinguishable from a real failure.
async function probeJwks(env: Env) {
  try {
    const auth = buildAuth(env);
    const jwks = (await auth.api.getJwks()) as { keys?: unknown[] };
    const keyCount = Array.isArray(jwks.keys) ? jwks.keys.length : 0;
    return { ok: keyCount > 0, keyCount };
  } catch (e) {
    return { ok: false, keyCount: 0, error: errMessage(e) };
  }
}

// ─── /probe/auth ──────────────────────────────────────────────────────────────
// The central de-risk: a full sign-up → sign-in round trip via the Better Auth
// server API against PlanetScale through Hyperdrive. This writes user + account
// rows in a transaction — proving the Kysely/pg adapter works on workerd.
//
// IMPORTANT diagnostic note for the conductor: a failure here is only meaningful
// if the Better Auth schema EXISTS in the target DB. PlanetScale is the migration
// target and may be greenfield. A `relation "user" does not exist` error means the
// schema was never migrated (run GET /probe/migrate first), NOT that Better Auth
// fails on workerd. The raw Postgres error string is surfaced verbatim below so
// missing-relation can be told apart from a real runtime/pg failure.
async function probeAuth(env: Env) {
  const email = `probe+${crypto.randomUUID()}@stage-b-probe.invalid`;
  const password = `Pw-${crypto.randomUUID()}`;
  try {
    const auth = buildAuth(env);
    const up = await auth.api.signUpEmail({
      body: { email, password, name: "Stage B Probe" },
    });
    const signedUp = !!up?.user?.id;
    const userId = up?.user?.id;

    const inRes = await auth.api.signInEmail({
      body: { email, password },
    });
    const signedIn = !!inRes?.user?.id;

    return { ok: signedUp && signedIn, signedUp, signedIn, userId };
  } catch (e) {
    // Surface the raw error verbatim so the conductor can distinguish a missing
    // schema (relation does not exist → run /probe/migrate) from a true failure.
    return { ok: false, signedUp: false, signedIn: false, error: errMessage(e) };
  }
}

// ─── /probe/migrate ───────────────────────────────────────────────────────────
// Bootstrap helper (NOT one of the originally-enumerated probes). Runs Better
// Auth's own schema migration so /probe/auth becomes testable against a fresh
// PlanetScale instance. Idempotent. DDL flows through Hyperdrive. Conductor-
// invoked once after deploy if the schema is greenfield.
async function probeMigrate(env: Env) {
  try {
    await runMigrations(env);
    return { ok: true, migrated: true };
  } catch (e) {
    return { ok: false, migrated: false, error: errMessage(e) };
  }
}

// ─── /probe/caller ────────────────────────────────────────────────────────────
// The Stage B2 de-risk: prove the API-KEY request path end-to-end on workerd —
// resolveCaller + db pool + the mounted /api/cp/endpoints route. Server-side, no
// cookies. Steps (each via the Better Auth server API, verified against the
// installed @better-auth packages):
//   1. signUpEmail → fresh user.
//   2. createOrganization WITHOUT headers but WITH `userId` in the body — this hits
//      the "system action" branch (no session required) and adds the user as owner.
//   3. createApiKey WITHOUT headers but WITH `userId` — same system-action branch.
//      Default config references the user; the returned `{ id, key }` gives both the
//      plaintext bearer and the apikey id we bind the agent to.
//   4. INSERT a waddling.agent row (org_id=org, api_key_id=key.id, status='active').
//   5. Self-dispatch GET /api/cp/endpoints with `Authorization: Bearer <key>`
//      through app.fetch — exercises route mounting + db middleware + resolveCaller.
//
// SCHEMA PRECONDITION (mirrors /probe/auth): the `waddling.*` tables come from
// packages/control-schema (schema.sql + migrations), NOT from Better Auth's
// getMigrations (which only creates auth.* + plugin tables). On a PlanetScale that
// has only had /probe/migrate run, the agent INSERT and the endpoints SELECT both
// hit `relation "waddling.agent"/"waddling.datalake" does not exist`. That is a
// MISSING-SCHEMA signal, not a workerd failure — the raw PG error is surfaced
// verbatim so the two are distinguishable. Apply control-schema to PlanetScale
// before expecting this probe to go green.
async function probeCaller(env: Env) {
  const email = `probe+${crypto.randomUUID()}@stage-b2-probe.invalid`;
  const password = `Pw-${crypto.randomUUID()}`;
  // Unique slug per run — createOrganization throws ORGANIZATION_ALREADY_EXISTS on
  // a slug collision, so a re-run must not reuse one.
  const slug = `b2-${crypto.randomUUID().slice(0, 12)}`;
  try {
    const auth = buildAuth(env);

    const up = await auth.api.signUpEmail({
      body: { email, password, name: "Stage B2 Caller Probe" },
    });
    const userId = up?.user?.id;
    if (!userId) return { ok: false, error: "signUpEmail returned no user id" };

    // System-action org create: no headers/request, userId in the body.
    const org = await auth.api.createOrganization({
      body: { name: "B2 Probe Org", slug, userId },
    });
    const orgId = (org as { id?: string } | null)?.id;
    if (!orgId) return { ok: false, error: "createOrganization returned no org id" };

    // System-action api-key create: no headers, userId in the body. Returns plaintext
    // `key` (shown once) + `id` (→ waddling.agent.api_key_id, what verifyApiKey echoes).
    const apiKey = (await auth.api.createApiKey({
      body: { userId, prefix: "sk_agent_", name: "b2-probe" },
    })) as { id?: string; key?: string };
    if (!apiKey?.id || !apiKey?.key) {
      return { ok: false, error: "createApiKey returned no id/key" };
    }

    // Bind a waddling.agent to the key (the unit resolveCaller resolves to).
    await query(
      `INSERT INTO waddling.agent (org_id, name, api_key_id, status)
         VALUES ($1, $2, $3, 'active')`,
      [orgId, `b2-probe-${slug}`, apiKey.id],
    );

    // Self-dispatch the real route with the bearer — full request path on workerd.
    const res = await app.fetch(
      new Request("https://probe.invalid/api/cp/endpoints", {
        method: "GET",
        headers: { authorization: `Bearer ${apiKey.key}` },
      }),
      env,
    );
    const endpointsStatus = res.status;
    const body = (await res.json().catch(() => ({}))) as {
      endpoints?: unknown[];
      error?: string;
    };

    // The route returns only the endpoint list, not the resolved caller, so re-run
    // resolveCaller directly against a synthesized context to assert the resolved
    // shape (kind/orgId). This is the same code path the route just exercised.
    const synthReq = new Request("https://probe.invalid/api/cp/endpoints", {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey.key}` },
    });
    const synthCtx = {
      env,
      req: { header: (n: string) => synthReq.headers.get(n) ?? undefined, raw: synthReq },
    } as unknown as Parameters<typeof resolveCaller>[0];
    const caller = await resolveCaller(synthCtx, true, true);

    return {
      ok:
        endpointsStatus === 200 &&
        caller.kind === "agent" &&
        caller.orgId === orgId &&
        Array.isArray(body.endpoints),
      resolvedKind: caller.kind,
      orgMatches: caller.orgId === orgId,
      agentId: caller.agentId,
      endpointsStatus,
      endpointCount: Array.isArray(body.endpoints) ? body.endpoints.length : undefined,
      routeError: body.error,
    };
  } catch (e) {
    // Surface raw — a `relation "waddling.…" does not exist` here means the
    // control-schema was not applied, NOT a workerd/request-path failure.
    return { ok: false, error: errMessage(e) };
  }
}

// ─── /api/cp/* control-plane routes ─────────────────────────────────────────────
// B2 mounts one representative router (endpoints). The bulk port (B3) mounts the
// remaining /api/cp/* routes here the same way.
app.route("/api/cp/datalakes", datalakes);
// Deprecated alias: the old path keeps resolving to the same handler during the
// endpoint→datalake cutover (external callers + any not-yet-updated UI link).
app.route("/api/cp/endpoints", datalakes);
app.route("/api/cp/workspaces", workspaces);
app.route("/api/cp/agents", agents);
app.route("/api/cp/notebooks", notebooks);
app.route("/api/cp/views", views);
app.route("/api/cp/settings", settings);
app.route("/api/cp/team", team);
app.route("/api/cp/usage", usage);
app.route("/api/cp/audit", audit);
app.route("/api/cp/billing", billing);
app.route("/api/cp/acl", acl);
app.route("/api/cp/roles", roles);
app.route("/api/cp/acl-policy", policies);
app.route("/api/cp/delegations", delegations);
app.route("/api/cp/sessions", sessions);
app.route("/api/cp/whoami", whoami);
app.route("/api/cp/device-link", deviceLink);
app.route("/api/cp/catalog", catalog);
app.route("/api/cp/quackboard", quackboard);
app.route("/api/cp/account", account);
app.route("/api/cp/onboarding", onboarding);

app.get("/", (c) =>
  c.text(
    [
      "waddling control-api — Stage B control-plane probe",
      "",
      "Routes:",
      "  GET /probe         — run db/secret/r2/crypto/jwks/auth/caller, combined + summary",
      "  GET /probe/db      — Hyperdrive → PlanetScale Postgres",
      "  GET /probe/secret  — Secrets Store master key (presence only)",
      "  GET /probe/r2      — R2 presigned-URL round-trip (SigV4, Model B)",
      "  GET /probe/crypto  — node:crypto AES-256-GCM seal/open",
      "  GET /probe/jwks    — Better Auth jwt plugin JWKS (proves jwt + DB read)",
      "  GET /probe/auth    — Better Auth sign-up → sign-in round trip",
      "  GET /probe/caller  — B2: API-key request path (resolveCaller + /api/cp/endpoints)",
      "  GET /probe/migrate — bootstrap Better Auth schema (run before /probe/auth on a fresh DB)",
      "  *   /api/auth/*    — Better Auth handler (auth + OAuth/MCP)",
      "  *   /api/cp/endpoints — control-plane endpoints route (GET list, POST create)",
      "",
      "These /probe/* routes are temporary scaffolding; later stages replace them.",
    ].join("\n"),
  ),
);

// SECURITY: /probe/* are diagnostic scaffolding (db/secret/jwks/gw-push/migrate/cols/…) that expose
// internals + run privileged operations. Once control-api is fronted by the public LB
// (api.getwaddling.com), these must NOT be reachable. Gate ALL of them behind ENABLE_PROBES — unset
// in production ⇒ 404. Registered before the routes so the guard runs first (Hono middleware order).
app.use("/probe", async (c, next) => (process.env.ENABLE_PROBES === "1" ? next() : c.text("not found", 404)));
app.use("/probe/*", async (c, next) => (process.env.ENABLE_PROBES === "1" ? next() : c.text("not found", 404)));

app.get("/probe/db", async (c) => c.json(await probeDb(c.env)));
app.get("/probe/secret", async (c) => c.json(await probeSecret(c.env)));
app.get("/probe/r2", async (c) => c.json(await probeR2(c.env)));
app.get("/probe/crypto", (c) => c.json(probeCrypto(c.env)));
app.get("/probe/jwks", async (c) => c.json(await probeJwks(c.env)));
app.get("/probe/auth", async (c) => c.json(await probeAuth(c.env)));
app.get("/probe/caller", async (c) => c.json(await probeCaller(c.env)));
app.get("/probe/migrate", async (c) => c.json(await probeMigrate(c.env)));
// Proves the DEPLOYED control-api drives the live gateway: gatewayClientFor().pushSnapshot
// mints a Google identity token for GATEWAY_BASE_URL and POSTs /ctrl/snapshot. A {ok:true}
// ack means the SA identity-token → private gateway path works end-to-end on Cloud Run.
app.get("/probe/gw-push", async (c) => {
  try {
    const ack = await gatewayClientFor().pushSnapshot({
      datalakeId: "probe",
      auth: { issuer: "probe-iss", audience: "gw:probe", mode: "rs256", jwks: [] },
      lakeCatalog: "lake",
    });
    return c.json({ ok: true, ack });
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// Temporary diagnostic: list a table's columns (default 'apikey') to ground-truth the
// Better-Auth-owned schema (case/quoting). Remove with the rest of /probe/* scaffolding.
app.get("/probe/cols", async (c) => {
  const table = new URL(c.req.url).searchParams.get("table") ?? "apikey";
  try {
    const r = await query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = $1 ORDER BY ordinal_position`,
      [table],
    );
    return c.json({ ok: true, table, columns: r.rows });
  } catch (e) {
    return c.json({ ok: false, table, error: errMessage(e) });
  }
});

app.get("/probe", async (c) => {
  const [db, secret, r2, crypto_, jwks, auth, caller] = await Promise.all([
    probeDb(c.env),
    probeSecret(c.env),
    probeR2(c.env),
    Promise.resolve(probeCrypto(c.env)),
    probeJwks(c.env),
    probeAuth(c.env),
    probeCaller(c.env),
  ]);
  return c.json({
    db,
    secret,
    r2,
    crypto: crypto_,
    jwks,
    auth,
    caller,
    summary: {
      db: db.ok ? "ok" : "fail",
      secret: secret.ok ? "ok" : "fail",
      // R2 is expected pending while creds are placeholders — surface distinctly.
      r2: r2.ok
        ? "ok"
        : (r2 as { credsArePlaceholder?: boolean }).credsArePlaceholder
          ? "pending-r2-token"
          : "fail",
      crypto: crypto_.ok ? "ok" : "fail",
      jwks: jwks.ok ? "ok" : "fail",
      auth: auth.ok ? "ok" : "fail",
      caller: caller.ok ? "ok" : "fail",
    },
  });
});

/** Initialize module-level singletons from a pre-built config. Call at Node server startup
 *  before serving; on CF the `*` middleware handles this lazily on the first request. */
export function startupInit(config: Env): void {
  initCrypto(config.WADDLING_SECRET_KEY ?? config.BETTER_AUTH_SECRET);
  const connStr = config.HYPERDRIVE?.connectionString ?? config.DATABASE_URL ?? '';
  initPool(connStr);
  initAuth(config);
  initDataplane(config.GATEWAY_BASE_URL);
}

/**
 * Scheduled (cron) handler — the prepaid-credit driver. Exported so the Node server
 * can call it on a timer. The CF scheduled() wrapper below calls it too.
 *
 * Each tick: (1) sweeps expired sessions + debits wall-clock COGS, (2) resets monthly
 * tier-credit allotments (idempotent per period), (3) reconciles billed debits for drift.
 */
// Context-graph maintenance pass: for each WARM quackboard, drain any un-embedded nodes through
// the private embeddings service, then rebuild derived edges IF new vectors landed. Status-gated
// (never cold-boots a sleeping board just to embed) and cheap when quiescent (embed-batch returns
// 0 immediately once a board is fully embedded, so no edge recompute fires). Embedding stays off
// the agent write path — this is the async drain the two graph invariants require.
async function drainQuackboardEmbeddings(env: Env): Promise<{ boards: number; embedded: number; recomputed: number }> {
  const embeddingsUrl = env.EMBEDDINGS_URL;
  if (!embeddingsUrl) return { boards: 0, embedded: 0, recomputed: 0 };
  const { rows } = await query<{ id: string; gateway_url: string | null }>(
    `SELECT id, gateway_url FROM waddling.datalake WHERE kind = 'quackboard' AND status = 'running'`,
  );
  let boards = 0, embedded = 0, recomputed = 0;
  for (const ep of rows) {
    try {
      const gwc = gatewayClientFor({ gateway_url: ep.gateway_url });
      const st = await gwc.status(ep.id); // no-wake probe: skip sleeping boards
      if (st.state !== 'running') continue;
      boards++;
      let boardEmbedded = 0;
      for (let i = 0; i < 20; i++) {
        const r = await gwc.qbEmbedBatch({ embeddingsUrl });
        boardEmbedded += r.embedded;
        if (r.remaining === 0 || r.embedded === 0) break;
      }
      embedded += boardEmbedded;
      if (boardEmbedded > 0) {
        await gwc.qbEdgesRecompute({});
        recomputed++;
      }
    } catch (e) {
      console.log(`[cron] qb-embed ${ep.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { boards, embedded, recomputed };
}

export async function scheduledHandler(env: Env): Promise<void> {
  const connStr = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL ?? '';
  initPool(connStr);
  initAuth(env);
  // Per-isolate singletons for the gateway-reaching cron blocks (no request middleware here):
  // initCrypto so recompile→resolveGatewayBoot can seal/open per-endpoint boot secrets;
  // initDataplane so the catalog refresh + dispatch drain reach the gateway (URL on Node).
  initCrypto(env.WADDLING_SECRET_KEY ?? env.BETTER_AUTH_SECRET);
  initDataplane(env.GATEWAY_BASE_URL);
  try {
    // Catalog-freshness pass: pull the live catalog from each WARM gateway (status-gated,
    // never cold-boots a sleeping pool) and upsert waddling.datalake_catalog so the authoring
    // picker reads a fresh schema tree. DECOUPLED from grant compilation (pull model): purely
    // refreshes the cache, no snapshot dispatch. `refreshCatalog` never wipes a populated cache
    // to empty, so a mid-boot warm gateway can't blank the picker.
    const { scanned, warm, changed } = await refreshWarmCatalogs(env);
    if (warm > 0 || changed > 0) console.log(`[cron] catalog refresh: scanned=${scanned} warm=${warm} changed=${changed}`);
  } catch (e) {
    console.log(`[cron] refreshWarmCatalogs failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    // Retry/reconcile backstop for the durable control→gateway dispatch outbox (migration 020).
    const { delivered, failed } = await drainGatewayDispatch(env);
    if (delivered > 0 || failed > 0) console.log(`[cron] dispatch drain: ${delivered} delivered, ${failed} failed`);
  } catch (e) {
    console.log(`[cron] drainGatewayDispatch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const { boards, embedded, recomputed } = await drainQuackboardEmbeddings(env);
    if (embedded > 0 || recomputed > 0) console.log(`[cron] qb-embed: ${embedded} node(s) across ${boards} board(s), ${recomputed} edge recompute(s)`);
  } catch (e) {
    console.log(`[cron] drainQuackboardEmbeddings failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const n = await sweepExpiredSessions();
    if (n > 0) console.log(`[cron] swept + debited ${n} session(s)`);
  } catch (e) {
    console.log(`[cron] sweepExpiredSessions failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const reset = await resetAllTierCredits(currentBillingPeriod());
    if (reset > 0) console.log(`[cron] reset tier credit for ${reset} org(s)`);
  } catch (e) {
    console.log(`[cron] resetAllTierCredits failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const { checked, drift } = await reconcileDebits();
    if (drift.length > 0) {
      console.log(`[cron] reconcile: DRIFT on ${drift.length}/${checked} billed session(s) — review needed`);
    }
  } catch (e) {
    console.log(`[cron] reconcileDebits failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function scheduled(
  _event: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  await scheduledHandler(env);
}

// Exported for in-process loopback (onboarding seed dispatches /sessions+/etl on the same
// app — a Worker can't reliably fetch its own public domain). Runtime-only use keeps the
// circular import (index ⇄ routes/onboarding) safe.
export { app };

export default { fetch: app.fetch, scheduled };
