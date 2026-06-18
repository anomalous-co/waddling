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

import { Hono } from "hono";
import { AwsClient } from "aws4fetch";
import { Pool } from "pg";
import type { Env } from "./lib/env";
import { runInDbScope, query } from "./lib/db";
import { buildAuth, runMigrations, runInAuthScope } from "./lib/auth";
import { makeCrypto, initCrypto } from "./lib/secret-crypto";
import { initDataplane } from "./lib/gateway-client";
import { resolveCaller } from "./lib/cp-shared";
import { endpoints } from "./routes/endpoints";
import { agents } from "./routes/agents";
import { notebooks } from "./routes/notebooks";
import { views } from "./routes/views";
import { settings } from "./routes/settings";
import { usage } from "./routes/usage";
import { audit } from "./routes/audit";
import { billing } from "./routes/billing";
import { acl } from "./routes/acl";
import { sessions } from "./routes/sessions";
import { deviceLink } from "./routes/device-link";
import { catalog } from "./routes/catalog";

const app = new Hono<{ Bindings: Env }>();

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Initialize per-isolate singletons once, before any handler — the db pool plus
// the secret-crypto pair and the DATAPLANE service binding the ported lib layer
// resolves through getCrypto()/gatewayClientFor(). All read from `c.env` (no
// ambient env on workerd) and are idempotent — only the first request in a warm
// isolate does work. The crypto secret uses WADDLING_SECRET_KEY with a
// BETTER_AUTH_SECRET fallback (mirrors the original getSecretEncryptionKey()).
app.use("*", async (c, next) => {
  initCrypto(c.env.WADDLING_SECRET_KEY ?? c.env.BETTER_AUTH_SECRET);
  initDataplane(c.env.DATAPLANE);
  // Per-request DB + Better Auth scopes: each request opens its OWN pool(s), closed after
  // the response. Hyperdrive pools server-side, so caching a pool across requests is both
  // redundant and unsafe on workerd (a connection bound to a prior request hangs → 1101).
  let exCtx: { waitUntil(p: Promise<unknown>): void } | undefined;
  try { exCtx = c.executionCtx; } catch { exCtx = undefined; }
  await runInDbScope(exCtx, c.env.HYPERDRIVE.connectionString, () => runInAuthScope(exCtx, next));
});

// ─── Better Auth ──────────────────────────────────────────────────────────────
// All auth/OAuth/MCP endpoints live under /api/auth/*. buildAuth returns this
// request's instance (constructed once per request inside runInAuthScope).
app.on(["GET", "POST"], "/api/auth/*", (c) => buildAuth(c.env).handler(c.req.raw));

// ─── /probe/db ──────────────────────────────────────────────────────────────
// Opens a pg Pool against the Hyperdrive connection string and runs two trivial
// queries. NOTE: local `wrangler dev` bypasses the real Hyperdrive proxy, so the
// authoritative result is from the DEPLOYED Worker.
async function probeDb(env: Env) {
  const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 5 });
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
// hit `relation "waddling.agent"/"waddling.endpoint" does not exist`. That is a
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
app.route("/api/cp/endpoints", endpoints);
app.route("/api/cp/agents", agents);
app.route("/api/cp/notebooks", notebooks);
app.route("/api/cp/views", views);
app.route("/api/cp/settings", settings);
app.route("/api/cp/usage", usage);
app.route("/api/cp/audit", audit);
app.route("/api/cp/billing", billing);
app.route("/api/cp/acl", acl);
app.route("/api/cp/sessions", sessions);
app.route("/api/cp/device-link", deviceLink);
app.route("/api/cp/catalog", catalog);

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

app.get("/probe/db", async (c) => c.json(await probeDb(c.env)));
app.get("/probe/secret", async (c) => c.json(await probeSecret(c.env)));
app.get("/probe/r2", async (c) => c.json(await probeR2(c.env)));
app.get("/probe/crypto", (c) => c.json(probeCrypto(c.env)));
app.get("/probe/jwks", async (c) => c.json(await probeJwks(c.env)));
app.get("/probe/auth", async (c) => c.json(await probeAuth(c.env)));
app.get("/probe/caller", async (c) => c.json(await probeCaller(c.env)));
app.get("/probe/migrate", async (c) => c.json(await probeMigrate(c.env)));

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

export default { fetch: app.fetch };
