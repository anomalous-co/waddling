/**
 * /api/cp/views/[id] (W1) — single saved view update / delete.
 *
 * PUT    → rename / replace SQL.
 * DELETE → remove the view.
 *
 * All org-scoped: a view is only reachable by its own org.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne } from '@/lib/db';
import { resolveCaller, parseBody, handle, ok, err } from '../../_shared';

const UpdateSchema = z.object({
  name: z.string().min(1).optional(),
  sql: z.string().min(1).optional(),
});

interface ViewRow {
  id: string;
  org_id: string;
  name: string;
  sql: string;
  created_at: string;
  updated_at: string;
}

async function loadOwned(id: string, orgId: string): Promise<ViewRow | null> {
  const v = await queryOne<ViewRow>(
    `SELECT id, org_id, name, sql, created_at, updated_at
       FROM waddling.saved_view WHERE id = $1`,
    [id],
  );
  if (!v || v.org_id !== orgId) return null;
  return v;
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const { id } = await ctx.params;
    const existing = await loadOwned(id, caller.orgId);
    if (!existing) return err('view_not_found', 404);
    const { name, sql } = await parseBody(req, UpdateSchema);
    const row = await queryOne<ViewRow>(
      `UPDATE waddling.saved_view
          SET name = COALESCE($2, name),
              sql = COALESCE($3, sql),
              updated_at = now()
        WHERE id = $1
        RETURNING id, name, sql, created_at, updated_at`,
      [id, name ?? null, sql ?? null],
    );
    return ok({
      view: {
        id: row!.id,
        name: row!.name,
        sql: row!.sql,
        createdAt: row!.created_at,
        updatedAt: row!.updated_at,
      },
    });
  });
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const { id } = await ctx.params;
    const existing = await loadOwned(id, caller.orgId);
    if (!existing) return err('view_not_found', 404);
    await query(`DELETE FROM waddling.saved_view WHERE id = $1`, [id]);
    return ok({ ok: true });
  });
}
