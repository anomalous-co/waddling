/**
 * Literal GRANT/DENY-SQL fixtures for the UX lab (spec §13). The control plane's
 * single representation of a key's access is literal GRANT/DENY SQL stored per
 * datalake; birdshot PULLs + enforces it and the UI renders the `stmt` verbatim.
 *
 * These fixtures back the lab mocks for:
 *   GET /api/cp/agents/:id/grants?datalakeId=  → { statements: string[] } (resolved, verbatim)
 *   GET /api/cp/acl?datalakeId=                → { statements: GrantStatementRow[] } (deletable rows)
 *
 * The real production data comes straight from control-api (browser → cpUrl);
 * these only serve when NEXT_PUBLIC_CONTROL_API_URL is unset (local/lab).
 */

/** The granular privilege vocabulary birdshot enforces (mirrors control-api grant-store). */
export const GRANULAR_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'CREATE',
  'DROP',
  'ALTER',
  'USAGE',
  'EXECUTE',
] as const;

export type AclPrivilege = (typeof GRANULAR_PRIVILEGES)[number];

/** A stored grant/deny row (control-api's camelCase mapRow shape). */
export interface GrantStatementRow {
  id: string;
  datalakeId: string;
  granteeKind: 'subject' | 'role' | 'public';
  grantee: string;
  stmt: string;
  version: number;
  createdAt: string;
}

/** The birdshot subject for an agent = its JWT `sub` (mirrors control-api agentSubject). */
export function agentSubject(agentId: string): string {
  return `agent:${agentId}`;
}

/**
 * Per-datalake fixture grant rows across a few subjects — enough to exercise the
 * literal-SQL panel (GRANT vs DENY, columns, role membership, PUBLIC, role grant).
 */
export const FIXTURE_GRANT_ROWS: GrantStatementRow[] = [
  // ── dl_01j8events — analytics-etl (agt_01…) ────────────────────────────────
  {
    id: 'grant_01j8events01',
    datalakeId: 'dl_01j8events',
    granteeKind: 'subject',
    grantee: 'agent:agt_01j8k9m2n3p4q5r6s7t8u9v0w',
    stmt: 'GRANT SELECT ON analytics.events TO agent:agt_01j8k9m2n3p4q5r6s7t8u9v0w',
    version: 1,
    createdAt: '2026-05-15T10:00:00Z',
  },
  {
    id: 'grant_01j8events02',
    datalakeId: 'dl_01j8events',
    granteeKind: 'subject',
    grantee: 'agent:agt_01j8k9m2n3p4q5r6s7t8u9v0w',
    stmt: 'GRANT SELECT (id, converted_at) ON analytics.conversions TO agent:agt_01j8k9m2n3p4q5r6s7t8u9v0w',
    version: 2,
    createdAt: '2026-05-15T10:01:00Z',
  },
  {
    id: 'grant_01j8events03',
    datalakeId: 'dl_01j8events',
    granteeKind: 'subject',
    grantee: 'agent:agt_01j8k9m2n3p4q5r6s7t8u9v0w',
    stmt: 'GRANT INSERT, UPDATE ON analytics.conversions TO agent:agt_01j8k9m2n3p4q5r6s7t8u9v0w',
    version: 3,
    createdAt: '2026-05-15T10:02:00Z',
  },
  {
    id: 'grant_01j8events04',
    datalakeId: 'dl_01j8events',
    granteeKind: 'subject',
    grantee: 'agent:agt_01j8k9m2n3p4q5r6s7t8u9v0w',
    stmt: 'DENY SELECT ON analytics.pii TO agent:agt_01j8k9m2n3p4q5r6s7t8u9v0w',
    version: 4,
    createdAt: '2026-05-15T10:03:00Z',
  },
  // ── dl_01j8events — insight-bot (agt_02…) ──────────────────────────────────
  {
    id: 'grant_01j8events05',
    datalakeId: 'dl_01j8events',
    granteeKind: 'subject',
    grantee: 'agent:agt_02j8k9m2n3p4q5r6s7t8u9v0x',
    stmt: 'GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO agent:agt_02j8k9m2n3p4q5r6s7t8u9v0x',
    version: 5,
    createdAt: '2026-06-01T08:30:00Z',
  },
  // ── dl_01j8events — a role membership + a role-scoped grant + PUBLIC ────────
  {
    id: 'grant_01j8events06',
    datalakeId: 'dl_01j8events',
    granteeKind: 'role',
    grantee: 'analyst',
    stmt: 'GRANT SELECT ON analytics.sessions TO ROLE analyst',
    version: 6,
    createdAt: '2026-06-01T08:31:00Z',
  },
  {
    id: 'grant_01j8events07',
    datalakeId: 'dl_01j8events',
    granteeKind: 'subject',
    grantee: 'agent:agt_01j8k9m2n3p4q5r6s7t8u9v0w',
    stmt: 'GRANT analyst TO agent:agt_01j8k9m2n3p4q5r6s7t8u9v0w',
    version: 7,
    createdAt: '2026-06-01T08:32:00Z',
  },
  {
    id: 'grant_01j8events08',
    datalakeId: 'dl_01j8events',
    granteeKind: 'public',
    grantee: '',
    stmt: 'GRANT USAGE ON analytics.public_report TO PUBLIC',
    version: 8,
    createdAt: '2026-06-01T08:33:00Z',
  },
];

/**
 * The resolved statements governing one key on a datalake, in birdshot's order:
 * the subject's own rows ∪ PUBLIC ∪ (transitively) each role it holds. Verbatim
 * `stmt` text — exactly what the grants panel renders. Mirrors grantsForKey().
 */
export function makeFixtureKeyGrants(agentId: string, datalakeId: string): string[] {
  const subject = agentSubject(agentId);
  const rows = FIXTURE_GRANT_ROWS.filter((r) => r.datalakeId === datalakeId);

  // The subject's own rows (+ any role memberships it declares).
  const own = rows.filter((r) => r.granteeKind === 'subject' && r.grantee === subject);
  const heldRoles = new Set(
    own
      .map((r) => r.stmt.match(/^\s*GRANT\s+([A-Za-z0-9_:-]+)\s+TO\s+/i))
      .filter((m): m is RegExpMatchArray => !!m && !/\bON\b/i.test(m.input ?? ''))
      .map((m) => m[1]),
  );

  const roleRows = rows.filter((r) => r.granteeKind === 'role' && heldRoles.has(r.grantee));
  const publicRows = rows.filter((r) => r.granteeKind === 'public');

  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of [...own, ...roleRows, ...publicRows]) {
    if (!seen.has(r.stmt)) {
      seen.add(r.stmt);
      out.push(r.stmt);
    }
  }
  return out;
}
