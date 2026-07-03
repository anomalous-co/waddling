/**
 * grant-parse — server-side statement DECOMPOSER (grant-ux-plan §4.3, the "one source of
 * truth" decision). Turns ONE literal GRANT/DENY/REVOKE/UNDENY statement (as emitted by the
 * lib/grant-store builders, or hand-authored) into a structured `ParsedStatement` the Picker
 * binds directly. It is PURE (no DB import) so it can be unit-tested standalone and reused on
 * every read response.
 *
 * Contract: return `null` for anything it can't confidently + LOSSLESSLY decompose. The caller
 * always preserves the original `sql` separately, so `null` is safe — the UI shows those in a
 * read-only "Advanced" bucket. Be strict, not clever: if a shape can't round-trip through the
 * builders (e.g. per-privilege column lists that DIFFER — the builder only ever applies ONE
 * shared column list to every privilege), return null rather than lie.
 */

export type ParsedStatement = {
  kind: 'object' | 'membership'; // object grant vs GRANT <role> TO <x>
  effect: 'allow' | 'deny'; // GRANT/REVOKE→allow-family, DENY/UNDENY→deny-family
  action: 'grant' | 'revoke' | 'deny' | 'undeny';
  privileges: string[]; // ['SELECT', …] (object kind); [] for membership
  columns: string[] | null; // shared per-privilege column list if present
  object:
    | { schema: string; table: string } // sales.orders
    | { schema: string; allTables: true } // ALL TABLES IN SCHEMA sales
    | { raw: string } // unparseable object → raw (still lossless)
    | null;
  grantee: { kind: 'subject' | 'role' | 'public'; name: string };
  role?: string; // membership: the role granted
};

// A single object-ref / grantee identifier char class (schemas, tables, colon subjects).
const IDENT = '[A-Za-z0-9_.:$-]';

/** Parse the TO/FROM target into a structured grantee (mirrors grant-store.deriveGrantee). */
function parseGrantee(raw: string): ParsedStatement['grantee'] | null {
  const m = raw.trim().match(new RegExp(`^(ROLE\\s+)?("?)(${IDENT}+|PUBLIC)\\2$`, 'i'));
  if (!m) return null;
  const isRole = !!m[1];
  const name = m[3];
  if (/^public$/i.test(name) && !isRole) return { kind: 'public', name: 'PUBLIC' };
  if (isRole) return { kind: 'role', name };
  return { kind: 'subject', name };
}

/** Parse `sales.orders` | `ALL TABLES IN SCHEMA sales` | else raw. Never null (raw fallback). */
function parseObject(raw: string): NonNullable<ParsedStatement['object']> {
  const s = raw.trim();
  const all = s.match(/^ALL\s+TABLES\s+IN\s+SCHEMA\s+("?)([A-Za-z0-9_$-]+)\1$/i);
  if (all) return { schema: all[2], allTables: true };
  const st = s.match(/^("?)([A-Za-z0-9_$-]+)\1\.("?)([A-Za-z0-9_$-]+)\3$/);
  if (st) return { schema: st[2], table: st[4] };
  return { raw: s };
}

/**
 * Parse the privilege list (`SELECT, INSERT` | `SELECT (id, ts), INSERT (id, ts)`). Returns the
 * privilege names + the SHARED column list, or null if the shape can't round-trip (differing
 * per-privilege columns, or some-with / some-without columns — the builder never emits that).
 */
function parsePrivileges(raw: string): { privileges: string[]; columns: string[] | null } | null {
  const priv = /([A-Za-z_]+)\s*(?:\(([^)]*)\))?/g;
  const privileges: string[] = [];
  const colSets: (string[] | null)[] = [];
  let consumed = 0;
  let m: RegExpExecArray | null;
  while ((m = priv.exec(raw)) !== null) {
    privileges.push(m[1].toUpperCase());
    colSets.push(
      m[2] !== undefined
        ? m[2].split(',').map((c) => c.trim()).filter((c) => c.length > 0)
        : null,
    );
    consumed += m[0].length;
    // Skip a following comma+space separator so the loop consumes the whole list contiguously.
    const rest = raw.slice(priv.lastIndex).match(/^\s*,\s*/);
    if (rest) priv.lastIndex += rest[0].length;
  }
  if (privileges.length === 0) return null;
  // Reject leftover garbage (proves we consumed the whole priv list, nothing exotic remained).
  const stripped = raw.replace(/[A-Za-z_]+\s*(?:\([^)]*\))?/g, '').replace(/[\s,]/g, '');
  if (stripped.length > 0) return null;

  // Column consistency: every privilege must carry the SAME column list (or all none).
  const key = (c: string[] | null) => (c === null ? '\0none' : c.join(','));
  const first = key(colSets[0]);
  if (!colSets.every((c) => key(c) === first)) return null;
  return { privileges, columns: colSets[0] };
}

export function parseStatement(sql: string): ParsedStatement | null {
  const s = sql.trim().replace(/;\s*$/, '').trim();
  if (!s) return null;

  // ── membership first: GRANT <role> TO <x> / REVOKE ROLE <role> FROM <x> (NO `ON` clause) ──
  if (!/\bON\b/i.test(s)) {
    const g = s.match(new RegExp(`^GRANT\\s+([A-Za-z0-9_:-]+)\\s+TO\\s+(.+)$`, 'i'));
    if (g) {
      const grantee = parseGrantee(g[2]);
      if (!grantee) return null;
      return {
        kind: 'membership', effect: 'allow', action: 'grant',
        privileges: [], columns: null, object: null, grantee, role: g[1],
      };
    }
    const r = s.match(new RegExp(`^REVOKE\\s+ROLE\\s+([A-Za-z0-9_:-]+)\\s+FROM\\s+(.+)$`, 'i'));
    if (r) {
      const grantee = parseGrantee(r[2]);
      if (!grantee) return null;
      return {
        kind: 'membership', effect: 'allow', action: 'revoke',
        privileges: [], columns: null, object: null, grantee, role: r[1],
      };
    }
    return null;
  }

  // ── object grants: <KW> <privs> ON <object> <TO|FROM> <grantee> ──
  const m = s.match(/^(GRANT|DENY|REVOKE|UNDENY)\s+([\s\S]+?)\s+ON\s+([\s\S]+?)\s+(TO|FROM)\s+([\s\S]+?)$/i);
  if (!m) return null;
  const kw = m[1].toUpperCase();
  const connector = m[4].toUpperCase();

  // Keyword/connector must pair the way the builders emit (GRANT/DENY→TO, REVOKE/UNDENY→FROM).
  const allowFamily = kw === 'GRANT' || kw === 'REVOKE';
  const usesTo = kw === 'GRANT' || kw === 'DENY';
  if ((usesTo && connector !== 'TO') || (!usesTo && connector !== 'FROM')) return null;

  const privs = parsePrivileges(m[2]);
  if (!privs) return null;
  const grantee = parseGrantee(m[5]);
  if (!grantee) return null;

  const action = kw.toLowerCase() as ParsedStatement['action'];
  return {
    kind: 'object',
    effect: allowFamily ? 'allow' : 'deny',
    action,
    privileges: privs.privileges,
    columns: privs.columns,
    object: parseObject(m[3]),
    grantee,
  };
}
