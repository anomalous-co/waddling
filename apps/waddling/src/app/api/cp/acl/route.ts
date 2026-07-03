import {
  authorFromBody,
  makeAclRows,
  makeLegacyRows,
  type AclPostBody,
} from '@/lab/fixtures/grants';

/**
 * /api/cp/acl — literal GRANT/DENY-SQL authoring (spec §13). Lab MOCKS mirroring
 * control-api's routes/acl.ts. In production these do NOT run — the browser hits
 * control-api directly; these 404 once NEXT_PUBLIC_CONTROL_API_URL is set.
 *
 * GET  /?datalakeId=&agentId= → AclRow[] (the key's own, deletable rows — new shape)
 * GET  /?datalakeId=          → { statements: GrantStatementRow[] } (legacy ACL browser)
 * POST /                      → author one statement (target-, membership-, or raw-sql body)
 *                               → { id, sql, parsed, createdAt }
 */

// ── GET / ──────────────────────────────────────────────────────────────────────
export function GET(request: Request) {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  const url = new URL(request.url);
  const datalakeId = url.searchParams.get('datalakeId');
  const agentId = url.searchParams.get('agentId');
  if (!datalakeId) {
    return Response.json(
      { error: 'datalakeId query param is required', code: 'datalakeId_required' },
      { status: 400 },
    );
  }
  // New AccessManager path: agent-scoped own rows in a { statements } envelope,
  // each row carrying `sql` + `parsed` (server-decomposed).
  if (agentId) {
    return Response.json({ statements: makeAclRows(datalakeId, agentId) });
  }
  // Legacy: the standalone ACL browser expects { statements: GrantStatementRow[] }.
  return Response.json({ statements: makeLegacyRows(datalakeId) });
}

// ── POST / ─────────────────────────────────────────────────────────────────────
export async function POST(request: Request) {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  const body = (await request.json()) as AclPostBody;

  const hasMembership = !!body.membership;
  const hasRaw = typeof body.sql === 'string' && body.sql.trim().length > 0;
  const hasPrivileges = (body.privileges?.length ?? 0) > 0;
  if (!hasMembership && !hasRaw && !hasPrivileges) {
    return Response.json(
      { error: 'a target grant (privileges), a membership, or raw sql is required', code: 'invalid_grant' },
      { status: 400 },
    );
  }

  const row = authorFromBody(body);
  // `statement` is a legacy alias for `sql` (the standalone ACL browser reads it).
  return Response.json({ ...row, statement: row.sql }, { status: 201 });
}
