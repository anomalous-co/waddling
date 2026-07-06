/**
 * control-api grant-store WRITER + READER — the literal GRANT/DENY-SQL store (spec §12/§13).
 *
 * PORT of packages/db/src/grant-store.ts, adapted for control-api: it uses the Hyperdrive
 * db.ts helpers (never imports packages/db — that's the dev stack), always targets the
 * SHARED control DB tables `public.__birdshot_grants` / `public.__birdshot_meta`, and is
 * ALWAYS datalake-scoped (one shared store serves every tenant). The `stmt` text is the
 * single representation: authored here, pulled + enforced by birdshot, and rendered
 * verbatim by the UI. Every mutation bumps `public.__birdshot_meta.epoch` in the SAME
 * transaction as the row write (§12f) so the gateway re-hydrates on its next authorize.
 *
 * The grantee is written BARE (unquoted) — verified against the built extension: birdshot's
 * GRANT tokenizer keeps surrounding double-quotes IN the grantee name, so a quoted
 * `TO "agent:123"` lands under a different subject-self-role than the session's `agent:123`
 * and silently never enforces. Bare `TO agent:123` enforces. (agentIds are UUID/nanoid —
 * whitespace/comma/paren-free — so bare tokenizes cleanly.)
 */
import { query, withTransaction } from './db';

const GRANTS = 'public.__birdshot_grants';
const META = 'public.__birdshot_meta';

// ── statement builders (canonical, human-readable — shown verbatim in the UI) ──────

export type Grantee = { role: string } | { subject: string } | 'public';

/** `ROLE analyst` | `agent:123` (bare) | `PUBLIC` — the TO/FROM target. */
export function granteeSql(g: Grantee): string {
  if (g === 'public') return 'PUBLIC';
  if ('role' in g) return `ROLE ${g.role}`;
  return g.subject; // BARE — never quote (see file header)
}

/** The birdshot subject for an agent = its JWT `sub` (session-jwt.ts). */
export function agentSubject(agentId: string): string {
  return `agent:${agentId}`;
}

// The granular privilege vocabulary — birdshot's ENFORCED set. This REPLACES the coarse
// read/write/create/drop/alter enum (§13): an admin grants a specific privilege and the UI
// shows exactly that. NO write→ALL PRIVILEGES umbrella.
export const GRANULAR_PRIVILEGES = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
  'CREATE', 'DROP', 'ALTER', 'USAGE', 'EXECUTE', 'DETACH',
] as const;
export type Privilege = (typeof GRANULAR_PRIVILEGES)[number];

interface ObjectGrantOpts {
  privileges: string[];
  columns?: string[]; // optional per-privilege column list (SELECT (c1,c2))
  on: string; // objref: `sales.orders`, or `ALL TABLES IN SCHEMA sales`
  to: Grantee;
}

function privList(privileges: string[], columns?: string[]): string {
  const cols = columns && columns.length ? ` (${columns.join(', ')})` : '';
  return privileges.map((p) => `${p.toUpperCase()}${cols}`).join(', ');
}

/** `GRANT SELECT ON sales.orders TO ROLE analyst` */
export function grant(o: ObjectGrantOpts): string {
  return `GRANT ${privList(o.privileges, o.columns)} ON ${o.on} TO ${granteeSql(o.to)}`;
}
/** `DENY SELECT ON sales.pii TO ROLE analyst` (deny-wins carve-out) */
export function deny(o: ObjectGrantOpts): string {
  return `DENY ${privList(o.privileges, o.columns)} ON ${o.on} TO ${granteeSql(o.to)}`;
}
/** `REVOKE SELECT ON sales.orders FROM ROLE analyst` (append, never delete — §12f) */
export function revoke(o: ObjectGrantOpts): string {
  return `REVOKE ${privList(o.privileges, o.columns)} ON ${o.on} FROM ${granteeSql(o.to)}`;
}
/** `UNDENY SELECT ON sales.pii FROM ROLE analyst` */
export function undeny(o: ObjectGrantOpts): string {
  return `UNDENY ${privList(o.privileges, o.columns)} ON ${o.on} FROM ${granteeSql(o.to)}`;
}
/** role membership: `GRANT analyst TO agent:123` */
export function grantRole(role: string, to: string): string {
  return `GRANT ${role} TO ${to}`;
}
/** revoke role membership — append `REVOKE ROLE …`, NEVER delete the row (§12f). */
export function revokeRole(role: string, from: string): string {
  return `REVOKE ROLE ${role} FROM ${from}`;
}

// ── discriminated grantee input (grant-ux-plan §4/§8.1: agent | role | PUBLIC) ─────
// The UI authors object grants against one of three targets. This maps the wire shape to the
// builder's `Grantee`. (The legacy acl.ts subjectKind='user'|'org' → synthetic-role mapping is
// a SEPARATE concept and stays in acl.ts — do not route it through here.)
export type GranteeInput =
  | { kind: 'agent'; agentId: string }
  | { kind: 'role'; role: string }
  | { kind: 'public' };

export function granteeFromInput(g: GranteeInput): Grantee {
  if (g.kind === 'agent') return { subject: agentSubject(g.agentId) };
  if (g.kind === 'role') return { role: g.role };
  return 'public';
}

// ── grantee derivation (from the parsed stmt, so the store columns can't drift — §12f) ──

export function deriveGrantee(stmt: string): { grantee_kind: 'subject' | 'role' | 'public'; grantee: string } {
  const m = stmt.match(/\b(?:TO|FROM)\s+(ROLE\s+)?("?)([A-Za-z0-9_.:-]+|PUBLIC)\2\s*;?\s*$/i);
  if (!m) throw new Error(`grant-store: cannot derive grantee from statement: ${stmt}`);
  const isRole = !!m[1];
  const name = m[3];
  if (/^public$/i.test(name) && !isRole) return { grantee_kind: 'public', grantee: '' };
  if (isRole) return { grantee_kind: 'role', grantee: name };
  return { grantee_kind: 'subject', grantee: name };
}

// ── mutations — always datalake-scoped, always epoch-bumped in the same txn ────────

/**
 * Apply one GRANT/DENY/REVOKE/UNDENY (incl. role membership) to a datalake's store.
 * Appends a row with the next per-datalake `version` AND bumps that datalake's epoch, in
 * ONE transaction (via withTransaction — a single pooled client, so BEGIN/INSERT/UPSERT/
 * COMMIT are atomic; do NOT reconstruct this with bare pooled query()s).
 */
export async function applyStatement(datalake: string, stmt: string): Promise<void> {
  const { grantee_kind, grantee } = deriveGrantee(stmt);
  await withTransaction(async (q) => {
    await q(
      `INSERT INTO ${GRANTS} (datalake, grantee_kind, grantee, stmt, version)
       VALUES ($1, $2, $3, $4,
         (SELECT COALESCE(MAX(version), 0) + 1 FROM ${GRANTS} WHERE datalake = $1))`,
      [datalake, grantee_kind, grantee, stmt],
    );
    await q(
      `INSERT INTO ${META} (datalake, epoch) VALUES ($1, 1)
       ON CONFLICT (datalake) DO UPDATE SET epoch = ${META}.epoch + 1`,
      [datalake],
    );
  });
}

/**
 * Object REVOKE / admin delete of a single grant ROW (by id) + epoch bump, one txn.
 * Only used for OBJECT/column grants and denies — a role-MEMBERSHIP row must never be
 * deleted (§12f: deletion leaves a stale user_roles edge → fail-open); membership revoke
 * is an appended `REVOKE ROLE …` via applyStatement instead. Returns the deleted stmt (or
 * null if the id/datalake didn't match).
 */
export async function deleteGrantById(datalake: string, id: string): Promise<string | null> {
  return withTransaction(async (q) => {
    const del = await q<{ stmt: string }>(
      `DELETE FROM ${GRANTS} WHERE id = $1 AND datalake = $2 RETURNING stmt`,
      [id, datalake],
    );
    if (del.rows.length === 0) return null;
    await q(
      `INSERT INTO ${META} (datalake, epoch) VALUES ($1, 1)
       ON CONFLICT (datalake) DO UPDATE SET epoch = ${META}.epoch + 1`,
      [datalake],
    );
    return del.rows[0].stmt;
  });
}

// ── reads ──────────────────────────────────────────────────────────────────────────

export interface GrantRow {
  id: string;
  grantee_kind: 'subject' | 'role' | 'public';
  grantee: string;
  stmt: string;
  version: string;
  created_at: string;
}

/** Every literal statement row for a datalake, newest-version last (the GET / list view). */
export async function listStatements(datalake: string): Promise<GrantRow[]> {
  const r = await query<GrantRow>(
    `SELECT id, grantee_kind, grantee, stmt, version, created_at
       FROM ${GRANTS} WHERE datalake = $1 ORDER BY version`,
    [datalake],
  );
  return r.rows;
}

/** Bump a datalake's store epoch (the freshness cursor birdshot compares against its hydrated
 *  epoch). A config re-arm on the gateway runs birdshot_commit_config, which does `live_ =
 *  staging_` and CLOBBERS every live-hydrated grant while leaving the subject marked hydrated —
 *  so without a fresh epoch the clobbered grants never re-pull and the agent wrongly denies.
 *  Bumping the epoch after such a re-arm makes birdshot FlushHydrated + re-hydrate on the next
 *  authorize. Idempotent-safe: a spurious bump only costs one re-pull. */
export async function bumpEpoch(datalake: string): Promise<void> {
  await query(
    `INSERT INTO ${META} (datalake, epoch) VALUES ($1, 1)
     ON CONFLICT (datalake) DO UPDATE SET epoch = ${META}.epoch + 1`,
    [datalake],
  );
}

/** The current epoch (freshness/version signal) for a datalake; 0 if none yet. */
export async function epochFor(datalake: string): Promise<number> {
  const r = await query<{ epoch: string }>(
    `SELECT epoch FROM ${META} WHERE datalake = $1`,
    [datalake],
  );
  return r.rows.length ? Number(r.rows[0].epoch) : 0;
}

/** Parse the role named by a membership stmt (`GRANT <role> TO <subject>`) — no ON clause. */
function membershipRole(stmt: string): string | null {
  const m = stmt.match(/^\s*GRANT\s+([A-Za-z0-9_:-]+)\s+TO\s+/i);
  if (m && !/\bON\b/i.test(stmt)) return m[1];
  return null;
}

/**
 * The literal statements governing a key, in birdshot's resolution order: the subject's own
 * rows ∪ PUBLIC rows ∪ (transitively) each role the subject holds. Verbatim `stmt` text —
 * this is exactly what the UI renders as "this key's grants". Mirrors birdshot's hydration
 * BFS (bounded, cycle-safe), all reads scoped to `datalake`.
 */
export async function grantsForKey(datalake: string, subject: string): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const roleQueue: string[] = [];
  const visitedRoles = new Set<string>();

  const push = (stmt: string) => {
    if (!seen.has(stmt)) {
      seen.add(stmt);
      out.push(stmt);
    }
  };

  const subjRows = await query<{ stmt: string }>(
    `SELECT stmt FROM ${GRANTS} WHERE datalake = $1 AND grantee_kind = 'subject' AND grantee = $2 ORDER BY version`,
    [datalake, subject],
  );
  for (const r of subjRows.rows) {
    push(r.stmt);
    const role = membershipRole(r.stmt);
    if (role && !visitedRoles.has(role)) roleQueue.push(role);
  }

  const pubRows = await query<{ stmt: string }>(
    `SELECT stmt FROM ${GRANTS} WHERE datalake = $1 AND grantee_kind = 'public' ORDER BY version`,
    [datalake],
  );
  for (const r of pubRows.rows) push(r.stmt);

  let depth = 0;
  while (roleQueue.length && depth < 64) {
    depth++;
    const role = roleQueue.shift() as string;
    if (visitedRoles.has(role)) continue;
    visitedRoles.add(role);
    const roleRows = await query<{ stmt: string }>(
      `SELECT stmt FROM ${GRANTS} WHERE datalake = $1 AND grantee_kind = 'role' AND grantee = $2 ORDER BY version`,
      [datalake, role],
    );
    for (const r of roleRows.rows) {
      push(r.stmt);
      const nested = membershipRole(r.stmt);
      if (nested && !visitedRoles.has(nested)) roleQueue.push(nested);
    }
  }

  return out;
}

/** Where a resolved statement came from, for the UI's read-only "inherited" marking. */
export type Provenance = null | { via: 'role'; role: string } | { via: 'public' };
export interface ResolvedStatement {
  stmt: string;
  inherited: Provenance;
}

/**
 * Like grantsForKey, but each resolved statement CARRIES its provenance so the UI can render
 * role/PUBLIC-derived rows read-only (grant-ux-plan §4.1). Resolution order = the subject's own
 * rows (inherited=null) → PUBLIC (via:public) → transitive roles (via:role) — first-seen wins on
 * dedup, exactly matching grantsForKey's ordering so the two never disagree.
 */
export async function grantsForKeyDetailed(datalake: string, subject: string): Promise<ResolvedStatement[]> {
  const out: ResolvedStatement[] = [];
  const seen = new Set<string>();
  const roleQueue: string[] = [];
  const visitedRoles = new Set<string>();

  const push = (stmt: string, inherited: Provenance) => {
    if (!seen.has(stmt)) {
      seen.add(stmt);
      out.push({ stmt, inherited });
    }
  };

  const subjRows = await query<{ stmt: string }>(
    `SELECT stmt FROM ${GRANTS} WHERE datalake = $1 AND grantee_kind = 'subject' AND grantee = $2 ORDER BY version`,
    [datalake, subject],
  );
  for (const r of subjRows.rows) {
    push(r.stmt, null);
    const role = membershipRole(r.stmt);
    if (role && !visitedRoles.has(role)) roleQueue.push(role);
  }

  const pubRows = await query<{ stmt: string }>(
    `SELECT stmt FROM ${GRANTS} WHERE datalake = $1 AND grantee_kind = 'public' ORDER BY version`,
    [datalake],
  );
  for (const r of pubRows.rows) push(r.stmt, { via: 'public' });

  let depth = 0;
  while (roleQueue.length && depth < 64) {
    depth++;
    const role = roleQueue.shift() as string;
    if (visitedRoles.has(role)) continue;
    visitedRoles.add(role);
    const roleRows = await query<{ stmt: string }>(
      `SELECT stmt FROM ${GRANTS} WHERE datalake = $1 AND grantee_kind = 'role' AND grantee = $2 ORDER BY version`,
      [datalake, role],
    );
    for (const r of roleRows.rows) {
      push(r.stmt, { via: 'role', role });
      const nested = membershipRole(r.stmt);
      if (nested && !visitedRoles.has(nested)) roleQueue.push(nested);
    }
  }

  return out;
}
