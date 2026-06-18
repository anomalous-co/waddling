import type { PGlite } from "@electric-sql/pglite";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { StackConfig } from "./config.ts";
import { datasetFor } from "./seed.ts";

/**
 * Host-side control plane for the `birdshot` DuckDB extension.
 *
 * birdshot enforces per-role table ACLs, logs queries/violations, and supports
 * instant revocation inside DuckDB's quack auth/authz hooks. It holds all policy
 * in process memory and never reads a database itself — this module is the only
 * thing that touches the isolated `authDb` PGlite store, reading roles / grants /
 * revocations and PUSHING them into the extension via `birdshot_*` functions.
 *
 * See docs/internal/duckdb/birdshot/design.md.
 */

/** Single-quote escape for inlining a string into a DuckDB SQL literal. */
function q(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/** Create the `birdshot.*` schema in authDb and seed defaults for federation. */
export async function bootstrapAuthSchema(authDb: PGlite, instance: string): Promise<void> {
  const localUser = datasetFor(instance).localUser;
  await authDb.exec(`
    CREATE SCHEMA IF NOT EXISTS birdshot;

    CREATE TABLE IF NOT EXISTS birdshot.role (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- user_id references Better Auth's user(id); not FK-constrained here so the
    -- birdshot schema can bootstrap before Better Auth's migrations run.
    CREATE TABLE IF NOT EXISTS birdshot.user_role (
      user_id    TEXT NOT NULL,
      role_id    TEXT NOT NULL REFERENCES birdshot.role(id) ON DELETE CASCADE,
      granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, role_id)
    );

    CREATE TABLE IF NOT EXISTS birdshot.role_grant (
      role_id   TEXT NOT NULL REFERENCES birdshot.role(id) ON DELETE CASCADE,
      table_ref TEXT NOT NULL,
      action    TEXT NOT NULL CHECK (action IN ('read','write')),
      PRIMARY KEY (role_id, table_ref, action)
    );

    CREATE TABLE IF NOT EXISTS birdshot.revocation (
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('user','jti','session')),
      subject_id   TEXT NOT NULL,
      reason       TEXT,
      revoked_by   TEXT,
      revoked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at   TIMESTAMPTZ,
      PRIMARY KEY (subject_kind, subject_id)
    );

    -- Optional durable audit sink. birdshot keeps an in-memory ring; the host
    -- drains it (drainAudit) and appends here for long-term querying.
    CREATE TABLE IF NOT EXISTS birdshot.audit (
      id        BIGSERIAL PRIMARY KEY,
      ts        TIMESTAMPTZ NOT NULL,
      event     TEXT NOT NULL,
      sid       TEXT,
      user_id   TEXT,
      decision  TEXT NOT NULL,
      reason    TEXT,
      query     TEXT
    );

    -- Roles:
    --   peer   - other quack instances (static federation token). Shared todos only.
    --   member - this instance's authenticated humans. Read todos + PII.
    --   owner  - full read/write on everything.
    INSERT INTO birdshot.role (id, name, description) VALUES
      ('peer',   'Federation peer', 'Other quack instances over the federation token'),
      ('member', 'Member',          'Authenticated local user: may read PII (contacts/addresses/memories)'),
      ('owner',  'Owner',           'Full read/write on shared + PII data')
    ON CONFLICT (id) DO NOTHING;

    -- Peers get the shared todos and NOTHING else: contacts/addresses/memories are
    -- NOT granted, so a quack peer reading peer_db.main.contacts is denied by birdshot.
    INSERT INTO birdshot.role_grant (role_id, table_ref, action) VALUES
      ('peer',   'main.todos',     'read'),
      ('member', 'main.todos',     'read'),
      ('member', 'main.contacts',  'read'),
      ('member', 'main.addresses', 'read'),
      ('member', 'main.memories',  'read'),
      ('owner',  'main.todos',     'read'), ('owner', 'main.todos',     'write'),
      ('owner',  'main.contacts',  'read'), ('owner', 'main.contacts',  'write'),
      ('owner',  'main.addresses', 'read'), ('owner', 'main.addresses', 'write'),
      ('owner',  'main.memories',  'read'), ('owner', 'main.memories',  'write')
    ON CONFLICT DO NOTHING;

    -- The quack federation service token authenticates as the synthetic user
    -- 'peer'; bind that identity to the 'peer' role so its grants resolve.
    INSERT INTO birdshot.user_role (user_id, role_id) VALUES ('peer', 'peer')
    ON CONFLICT DO NOTHING;
  `);

  // This instance's distinct local human user -> member (can read its own PII).
  await authDb.query(
    "INSERT INTO birdshot.user_role (user_id, role_id) VALUES ($1, 'member') ON CONFLICT DO NOTHING",
    [localUser.id],
  );
}

/** LOAD the compiled birdshot extension. Returns false if unset/unloadable. */
export async function loadBirdshotExtension(duck: DuckDBConnection, config: StackConfig): Promise<boolean> {
  if (!config.birdshotExtensionPath) return false;
  try {
    await duck.run(`LOAD ${q(config.birdshotExtensionPath)}`);
    return true;
  } catch (err) {
    console.warn(`[${config.instance}] birdshot: LOAD failed, falling back to peer_read_only macro:`, err);
    return false;
  }
}

/**
 * Read policy from authDb and push it into the loaded birdshot extension, then
 * point the quack hooks at birdshot. Idempotent — safe to call on every reload.
 */
export async function pushSnapshot(duck: DuckDBConnection, authDb: PGlite, config: StackConfig): Promise<void> {
  const mode = process.env.BIRDSHOT_AUTH_MODE ?? "dev"; // dev | hs256 | rs256
  const issuer = process.env.BASE_URL ?? "";
  const audience = process.env.BIRDSHOT_AUDIENCE ?? issuer;
  const secret = process.env.BIRDSHOT_SECRET ?? "";

  await duck.run("SELECT birdshot_reset_config()");
  await duck.run(`SELECT birdshot_set_auth(${q(issuer)}, ${q(audience)}, ${q(mode)})`);
  if (secret) await duck.run(`SELECT birdshot_set_secret(${q(secret)})`);

  // RS256: pull Better Auth's JWKS and register each RSA key (kid, n, e).
  if (mode === "rs256") {
    for (const k of await fetchJwks()) {
      if (k.kty === "RSA" && k.n && k.e) {
        await duck.run(`SELECT birdshot_add_jwk(${q(k.kid ?? "")}, ${q(k.n)}, ${q(k.e)})`);
      }
    }
  }

  // Roles -> grants.
  const grants = await authDb.query<{ role_id: string; table_ref: string; action: string }>(
    "SELECT role_id, table_ref, action FROM birdshot.role_grant",
  );
  for (const g of grants.rows) {
    await duck.run(`SELECT birdshot_add_role_grant(${q(g.role_id)}, ${q(g.table_ref)}, ${q(g.action)})`);
  }

  // Users -> roles.
  const userRoles = await authDb.query<{ user_id: string; role_id: string }>(
    "SELECT user_id, role_id FROM birdshot.user_role",
  );
  for (const ur of userRoles.rows) {
    await duck.run(`SELECT birdshot_add_user_role(${q(ur.user_id)}, ${q(ur.role_id)})`);
  }

  // The static quack federation token authenticates as the 'peer' user.
  await duck.run(`SELECT birdshot_add_service_token(${q(config.quackToken)}, 'peer')`);

  await duck.run("SELECT birdshot_commit_config()");

  // Reconcile the durable revocation table into the in-memory denylist.
  const revs = await authDb.query<{
    subject_kind: string;
    subject_id: string;
    reason: string | null;
    expires_us: string | null;
  }>(
    `SELECT subject_kind, subject_id, reason,
            (extract(epoch FROM expires_at) * 1000000)::bigint::text AS expires_us
       FROM birdshot.revocation`,
  );
  for (const r of revs.rows) {
    const exp = r.expires_us ? r.expires_us : "NULL";
    await duck.run(
      `SELECT birdshot_revoke(${q(r.subject_kind)}, ${q(r.subject_id)}, ${q(r.reason ?? "")}, ${exp})`,
    );
  }

  // Hand the quack hooks to birdshot (global-scoped per the quack contract).
  await duck.run("SET GLOBAL quack_authentication_function = 'birdshot_authenticate'");
  await duck.run("SET GLOBAL quack_authorization_function  = 'birdshot_authorize'");

  // NOTE (pending hardening): an engine-level extension lockdown
  // (allow_unsigned_extensions/autoinstall/autoload off, lock_configuration) would
  // close the autoload-RCE vector, but a global SET of these here BREAKS quack/
  // postgres federation (peer ATTACH stops working — verified). It needs to be
  // scoped to peer connections, not set globally on the instance. Tracked as a
  // known limitation; birdshot_authorize's statement+function deny is the current
  // guard. See memory: birdshot-audit round 2.
}

/**
 * Instant, automated revocation. Writes the durable row (survives reload) AND
 * pushes the in-memory denylist entry (takes effect on the subject's next query).
 */
export async function revoke(
  duck: DuckDBConnection,
  authDb: PGlite,
  kind: "user" | "jti" | "session",
  id: string,
  reason = "",
  expiresAtMs?: number,
): Promise<void> {
  const expiresIso = expiresAtMs ? new Date(expiresAtMs).toISOString() : null;
  await authDb.query(
    `INSERT INTO birdshot.revocation (subject_kind, subject_id, reason, revoked_by, expires_at)
     VALUES ($1, $2, $3, 'automation', $4)
     ON CONFLICT (subject_kind, subject_id)
     DO UPDATE SET reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at, revoked_at = now()`,
    [kind, id, reason, expiresIso],
  );
  const expUs = expiresAtMs ? String(expiresAtMs * 1000) : "NULL";
  await duck.run(`SELECT birdshot_revoke(${q(kind)}, ${q(id)}, ${q(reason)}, ${expUs})`);
}

export async function unrevoke(
  duck: DuckDBConnection,
  authDb: PGlite,
  kind: "user" | "jti" | "session",
  id: string,
): Promise<void> {
  await authDb.query("DELETE FROM birdshot.revocation WHERE subject_kind = $1 AND subject_id = $2", [kind, id]);
  await duck.run(`SELECT birdshot_unrevoke(${q(kind)}, ${q(id)})`);
}

export interface AuditRecord {
  ts: Date;
  event: string;
  sid: string;
  user_id: string;
  decision: string;
  reason: string;
  query: string;
}

/** Drain birdshot's in-memory audit ring and (optionally) persist to authDb. */
export async function drainAudit(
  duck: DuckDBConnection,
  authDb: PGlite | null = null,
  max = 1000,
): Promise<AuditRecord[]> {
  const reader = await duck.runAndReadAll(`SELECT birdshot_log_drain(${max}) AS blob`);
  const blob = (reader.getRowObjects()[0]?.blob as string) ?? "";
  const out: AuditRecord[] = [];
  for (const line of blob.split("\n")) {
    if (!line) continue;
    // ts \t event \t b64(sid) \t b64(user_id) \t decision \t b64(reason) \t b64(query)
    const [tsUs, event, sidB64, userB64, decision, reasonB64, queryB64] = line.split("\t");
    out.push({
      ts: new Date(Number(tsUs) / 1000),
      event,
      sid: b64urlDecode(sidB64 ?? ""),
      user_id: b64urlDecode(userB64 ?? ""),
      decision,
      reason: b64urlDecode(reasonB64 ?? ""),
      query: b64urlDecode(queryB64 ?? ""),
    });
  }
  if (authDb && out.length) {
    for (const r of out) {
      await authDb.query(
        `INSERT INTO birdshot.audit (ts, event, sid, user_id, decision, reason, query)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [r.ts.toISOString(), r.event, r.sid, r.user_id, r.decision, r.reason, r.query],
      );
    }
  }
  return out;
}

// --- helpers ---------------------------------------------------------------

function b64urlDecode(s: string): string {
  if (!s) return "";
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

interface Jwk {
  kty?: string;
  kid?: string;
  n?: string;
  e?: string;
}

/** Fetch Better Auth's published JWKS (RS256 mode). Tolerates the server being down. */
async function fetchJwks(): Promise<Jwk[]> {
  const base = process.env.BASE_URL ?? "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/auth/jwks`);
    if (!res.ok) return [];
    const body = (await res.json()) as { keys?: Jwk[] };
    return body.keys ?? [];
  } catch {
    return [];
  }
}
