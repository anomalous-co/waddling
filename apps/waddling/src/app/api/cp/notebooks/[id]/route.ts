/**
 * /api/cp/notebooks/[id] (W1) — single notebook read / update / delete.
 *
 * GET    → full notebook { id, name, cells, updatedAt }.
 * PUT    → replace name + cells.
 * DELETE → remove the notebook.
 *
 * All org-scoped: a notebook is only reachable by its own org.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne } from '@/lib/db';
import { resolveCaller, parseBody, handle, ok, err } from '../../_shared';

const CellSchema = z.object({
  id: z.string().min(1),
  sql: z.string(),
  title: z.string().optional(),
});
const UpdateSchema = z.object({
  name: z.string().min(1),
  cells: z.array(CellSchema).default([]),
});

interface NotebookRow {
  id: string;
  org_id: string;
  name: string;
  cells: unknown;
  created_at: string;
  updated_at: string;
}

async function loadOwned(id: string, orgId: string): Promise<NotebookRow | null> {
  const nb = await queryOne<NotebookRow>(
    `SELECT id, org_id, name, cells, created_at, updated_at
       FROM waddling.notebook WHERE id = $1`,
    [id],
  );
  if (!nb || nb.org_id !== orgId) return null;
  return nb;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const { id } = await ctx.params;
    const nb = await loadOwned(id, caller.orgId);
    if (!nb) return err('notebook_not_found', 404);
    return ok({
      notebook: {
        id: nb.id,
        name: nb.name,
        cells: nb.cells,
        createdAt: nb.created_at,
        updatedAt: nb.updated_at,
      },
    });
  });
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const { id } = await ctx.params;
    const existing = await loadOwned(id, caller.orgId);
    if (!existing) return err('notebook_not_found', 404);
    const { name, cells } = await parseBody(req, UpdateSchema);
    const row = await queryOne<NotebookRow>(
      `UPDATE waddling.notebook
          SET name = $2, cells = $3::jsonb, updated_at = now()
        WHERE id = $1
        RETURNING id, name, cells, created_at, updated_at`,
      [id, name, JSON.stringify(cells)],
    );
    return ok({
      notebook: {
        id: row!.id,
        name: row!.name,
        cells: row!.cells,
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
    if (!existing) return err('notebook_not_found', 404);
    await query(`DELETE FROM waddling.notebook WHERE id = $1`, [id]);
    return ok({ ok: true });
  });
}
