import {
  FIXTURE_GRANT_ROWS,
  GRANULAR_PRIVILEGES,
  agentSubject,
  type AclPrivilege,
  type GrantStatementRow,
} from '@/lab/fixtures/grants';

/**
 * /api/cp/acl — literal GRANT/DENY-SQL authoring (spec §13). Lab MOCKS mirroring
 * control-api's routes/acl.ts. In production these do NOT run — the browser hits
 * control-api directly (fetchCp → cpUrl); these 404 once NEXT_PUBLIC_CONTROL_API_URL
 * is set, and only serve local/UX-lab single-origin dev.
 *
 * GET  /?datalakeId=… → { statements: GrantStatementRow[] } (the datalake's rows, verbatim)
 * POST /              → author one GRANT/DENY from granular privilege inputs → { statement }
 */

function objRef(schema: string, table: string): string {
  if (table === '*') return `ALL TABLES IN SCHEMA ${schema}`;
  return `${schema}.${table}`;
}

function granteeSql(kind: 'subject' | 'role' | 'public', name: string): string {
  if (kind === 'public') return 'PUBLIC';
  if (kind === 'role') return `ROLE ${name}`;
  return name; // bare subject (e.g. agent:123) — birdshot grantee is unquoted
}

// ── GET / — the datalake's literal statements ──────────────────────────────────
export function GET(request: Request) {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  const datalakeId = new URL(request.url).searchParams.get('datalakeId');
  if (!datalakeId) {
    return Response.json(
      { error: 'datalakeId query param is required', code: 'datalakeId_required' },
      { status: 400 },
    );
  }
  const statements = FIXTURE_GRANT_ROWS.filter((r) => r.datalakeId === datalakeId);
  return Response.json({ statements });
}

interface GrantInputBody {
  datalakeId: string;
  agentId?: string;
  subjectKind?: 'agent' | 'user' | 'org';
  userId?: string;
  privilege?: AclPrivilege;
  privileges?: AclPrivilege[];
  schema?: string;
  table?: string;
  columns?: string[];
  effect?: 'allow' | 'deny';
}

// ── POST / — author one literal GRANT/DENY from granular inputs ─────────────────
export async function POST(request: Request) {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }

  const body = (await request.json()) as GrantInputBody;
  const privileges = (
    body.privileges?.length ? body.privileges : body.privilege ? [body.privilege] : []
  ).filter((p) => (GRANULAR_PRIVILEGES as readonly string[]).includes(p));
  if (privileges.length === 0) {
    return Response.json(
      { error: 'a privilege (or non-empty privileges[]) is required', code: 'privilege_required' },
      { status: 400 },
    );
  }

  const subjectKind = body.subjectKind ?? 'agent';
  const kind: GrantStatementRow['granteeKind'] = subjectKind === 'agent' ? 'subject' : 'role';
  const grantee =
    subjectKind === 'agent'
      ? agentSubject(body.agentId ?? 'unknown')
      : subjectKind === 'user'
        ? `user_${body.userId ?? 'unknown'}`
        : 'org_lab';

  const cols = body.columns?.length ? ` (${body.columns.join(', ')})` : '';
  const privList = privileges.map((p) => `${p}${cols}`).join(', ');
  const verb = body.effect === 'deny' ? 'DENY' : 'GRANT';
  const stmt = `${verb} ${privList} ON ${objRef(body.schema ?? '*', body.table ?? '*')} TO ${granteeSql(kind, grantee)}`;

  return Response.json({ statement: stmt }, { status: 201 });
}
