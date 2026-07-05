// birdshot grant-store WRITER + READER (spec §12/§13).
//
// The single representation of an agent's access is literal GRANT/DENY SQL, stored in
// the protected `__birdshot_grants` table and enforced by birdshot (lazy pull + epoch
// freshness). There is NO compiler: callers build canonical statement strings with the
// builders below, `applyStatement` writes them, and `grantsForKey` reads them back
// verbatim for the UI. Every mutation bumps `__birdshot_meta.epoch` in the SAME
// transaction as the row write (§12f) so birdshot re-hydrates on the next authorize.
//
// The `Pg` interface is the minimal surface both PGlite (tests) and node-postgres
// (Cloud SQL) satisfy, so the same writer runs against either backend.

export interface Pg {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Optional store scoping. The default (no scope) targets an unqualified, un-scoped
 * `__birdshot_grants`/`__birdshot_meta` — the standalone/test backend (one store per
 * process, single epoch row), exactly what the pglite e2e uses.
 *
 * In the SHARED control DB one store serves every datalake, so a scope supplies:
 *  - `datalake`     — written into a `datalake` column on every row and used to
 *                     filter reads/version/epoch (mirrors birdshot's scoped pull,
 *                     `WHERE ... AND datalake = ?`).
 *  - `grantsTable`  — qualified name, e.g. `public.__birdshot_grants` (default
 *                     `__birdshot_grants`). Caller-controlled constant, never user input.
 *  - `metaTable`    — qualified `public.__birdshot_meta` (default `__birdshot_meta`).
 *                     Scoped mode keeps ONE epoch row per datalake (`ON CONFLICT (datalake)`).
 */
export interface StoreScope {
  datalake?: string;
  grantsTable?: string;
  metaTable?: string;
}

function grantsTableOf(scope?: StoreScope): string {
  return scope?.grantsTable ?? "__birdshot_grants";
}
function metaTableOf(scope?: StoreScope): string {
  return scope?.metaTable ?? "__birdshot_meta";
}

// ---- statement builders (canonical, human-readable — this text is shown in the UI) ----

export type Grantee = { role: string } | { subject: string } | "public";

/** `ROLE analyst` | `agent1` | `PUBLIC` — the TO/FROM target. */
export function granteeSql(g: Grantee): string {
  if (g === "public") return "PUBLIC";
  if ("role" in g) return `ROLE ${g.role}`;
  return g.subject;
}

interface ObjectGrantOpts {
  privileges: string[]; // granular: SELECT/INSERT/UPDATE/DELETE/TRUNCATE/CREATE/DROP/ALTER/USAGE/EXECUTE/DETACH
  columns?: string[]; // optional per-privilege column list (SELECT (c1,c2))
  on: string; // objref: `sales.orders`, or `ALL TABLES IN SCHEMA sales`
  to: Grantee;
}

function privList(privileges: string[], columns?: string[]): string {
  const cols = columns && columns.length ? ` (${columns.join(", ")})` : "";
  return privileges.map((p) => `${p.toUpperCase()}${cols}`).join(", ");
}

/** `GRANT SELECT (email) ON sales.orders TO ROLE analyst` */
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
/** role membership: `GRANT analyst TO agent1` */
export function grantRole(role: string, to: string): string {
  return `GRANT ${role} TO ${to}`;
}
/** revoke role membership (append `REVOKE ROLE …`, never delete — §12f) */
export function revokeRole(role: string, from: string): string {
  return `REVOKE ROLE ${role} FROM ${from}`;
}

// ---- grantee derivation (from the parsed stmt, so columns can't drift — §12f) ----

/**
 * Derive `(grantee_kind, grantee)` from a statement's trailing TO/FROM target. The
 * store columns are ONLY a pull index; the stmt's TO/FROM clause is the authority, so
 * we read them from it rather than accept them independently (prevents the drift that
 * would fail-open the freshness flush — §12f).
 */
export function deriveGrantee(stmt: string): { grantee_kind: "subject" | "role" | "public"; grantee: string } {
  const m = stmt.match(/\b(?:TO|FROM)\s+(ROLE\s+)?("?)([A-Za-z0-9_.:-]+|PUBLIC)\2\s*;?\s*$/i);
  if (!m) throw new Error(`grant-store: cannot derive grantee from statement: ${stmt}`);
  const isRole = !!m[1];
  const name = m[3];
  if (/^public$/i.test(name) && !isRole) return { grantee_kind: "public", grantee: "" };
  if (isRole) return { grantee_kind: "role", grantee: name };
  return { grantee_kind: "subject", grantee: name };
}

// ---- the one mutation: write a row + bump the epoch, transactionally ----

/**
 * Apply one GRANT/DENY/REVOKE/UNDENY (incl. role membership) to the store. Appends a row
 * with the next monotonic `version` AND bumps `__birdshot_meta.epoch` in a single
 * transaction, so birdshot's next authorize re-hydrates and reflects it. REVOKE/UNDENY
 * are appended rows (never deletions) so re-hydration applies them in order (§12f).
 */
export async function applyStatement(db: Pg, stmt: string, scope?: StoreScope): Promise<void> {
  const { grantee_kind, grantee } = deriveGrantee(stmt);
  const grants = grantsTableOf(scope);
  const meta = metaTableOf(scope);
  const dl = scope?.datalake;
  await db.query("BEGIN");
  try {
    if (dl != null) {
      // Scoped (shared control DB): the row carries its datalake, version is monotonic
      // PER datalake, and the epoch is one row per datalake (upserted + bumped).
      await db.query(
        `INSERT INTO ${grants} (datalake, grantee_kind, grantee, stmt, version)
         VALUES ($1, $2, $3, $4,
           (SELECT COALESCE(MAX(version), 0) + 1 FROM ${grants} WHERE datalake = $1))`,
        [dl, grantee_kind, grantee, stmt],
      );
      await db.query(
        `INSERT INTO ${meta} (datalake, epoch) VALUES ($1, 1)
         ON CONFLICT (datalake) DO UPDATE SET epoch = ${meta}.epoch + 1`,
        [dl],
      );
    } else {
      // Unscoped (standalone/tests): single global version + single epoch row.
      await db.query(
        `INSERT INTO ${grants} (grantee_kind, grantee, stmt, version)
         VALUES ($1, $2, $3, (SELECT COALESCE(MAX(version), 0) + 1 FROM ${grants}))`,
        [grantee_kind, grantee, stmt],
      );
      await db.query(`UPDATE ${meta} SET epoch = epoch + 1`);
    }
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}

// ---- reader: an agent key's literal statements, for the UI ----

/** Parse the role named by a membership stmt (`GRANT <role> TO <subject>`) — no ON clause. */
function membershipRole(stmt: string): string | null {
  const m = stmt.match(/^\s*GRANT\s+([A-Za-z0-9_:-]+)\s+TO\s+/i);
  // A membership grant has NO `ON`; an object grant (`GRANT SELECT ON …`) does.
  if (m && !/\bON\b/i.test(stmt)) return m[1];
  return null;
}

/**
 * The literal statements governing an agent key, in birdshot's resolution order:
 * the subject's own rows ∪ PUBLIC rows ∪ (transitively) each role the subject holds.
 * Returns verbatim `stmt` text (never re-rendered) — this is what the UI displays as
 * "this key's grants". Mirrors birdshot's hydration BFS (bounded, cycle-safe).
 */
export async function grantsForKey(db: Pg, subject: string, scope?: StoreScope): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const roleQueue: string[] = [];
  const visitedRoles = new Set<string>();
  const grants = grantsTableOf(scope);
  const dl = scope?.datalake;
  // Scoped mode filters every read to this datalake (extra bound param appended).
  const dlClause = dl != null ? " AND datalake = $%" : "";

  const push = (stmt: string) => {
    if (!seen.has(stmt)) {
      seen.add(stmt);
      out.push(stmt);
    }
  };

  // subject's own rows (+ discover role memberships)
  const subjRows = await db.query(
    `SELECT stmt FROM ${grants} WHERE grantee_kind = $1 AND grantee = $2${dlClause.replace("$%", "$3")} ORDER BY version`,
    dl != null ? ["subject", subject, dl] : ["subject", subject],
  );
  for (const r of subjRows.rows) {
    const stmt = r.stmt as string;
    push(stmt);
    const role = membershipRole(stmt);
    if (role && !visitedRoles.has(role)) roleQueue.push(role);
  }

  // PUBLIC rows reach every identity
  const pubRows = await db.query(
    `SELECT stmt FROM ${grants} WHERE grantee_kind = 'public'${dlClause.replace("$%", "$1")} ORDER BY version`,
    dl != null ? [dl] : [],
  );
  for (const r of pubRows.rows) push(r.stmt as string);

  // transitive role rows (bounded, cycle-safe)
  let depth = 0;
  while (roleQueue.length && depth < 64) {
    depth++;
    const role = roleQueue.shift() as string;
    if (visitedRoles.has(role)) continue;
    visitedRoles.add(role);
    const roleRows = await db.query(
      `SELECT stmt FROM ${grants} WHERE grantee_kind = 'role' AND grantee = $1${dlClause.replace("$%", "$2")} ORDER BY version`,
      dl != null ? [role, dl] : [role],
    );
    for (const r of roleRows.rows) {
      const stmt = r.stmt as string;
      push(stmt);
      const nested = membershipRole(stmt);
      if (nested && !visitedRoles.has(nested)) roleQueue.push(nested);
    }
  }

  return out;
}
