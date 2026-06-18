/**
 * /api/cp/views (W1) — saved views: named queries pinned from a notebook cell.
 *
 * GET  → list the org's saved views (id, name, sql, timestamps).
 * POST → create a view { name, sql } → returns the full view.
 *
 * Org-scoped (shared across the org's members). A view holds only SQL; it is
 * executed via the session/query routes — the Views page picks an endpoint +
 * agent and runs each view through that agent's ACL (the gateway query proxy).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne } from '@/lib/db';
import { resolveCaller, parseBody, handle, ok } from '../_shared';

const CreateSchema = z.object({
  name: z.string().min(1),
  sql: z.string().min(1),
});

interface ViewRow {
  id: string;
  name: string;
  sql: string;
  created_at: string;
  updated_at: string;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const rows = await query<ViewRow>(
      `SELECT id, name, sql, created_at, updated_at
         FROM waddling.saved_view WHERE org_id = $1
        ORDER BY updated_at DESC`,
      [caller.orgId],
    );
    const views = rows.rows.map((r) => ({
      id: r.id,
      name: r.name,
      sql: r.sql,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
    return ok({ views });
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const { name, sql } = await parseBody(req, CreateSchema);
    const row = await queryOne<ViewRow>(
      `INSERT INTO waddling.saved_view (org_id, name, sql, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, sql, created_at, updated_at`,
      [caller.orgId, name, sql, caller.callerId],
    );
    return ok(
      {
        view: {
          id: row!.id,
          name: row!.name,
          sql: row!.sql,
          createdAt: row!.created_at,
          updatedAt: row!.updated_at,
        },
      },
      201,
    );
  });
}
