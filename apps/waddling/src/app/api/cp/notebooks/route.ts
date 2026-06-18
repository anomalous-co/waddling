/**
 * /api/cp/notebooks (W1) — saved SQL workbooks for the dashboard Notebooks view.
 *
 * GET  → list the org's notebooks (id, name, cellCount, updatedAt).
 * POST → create a notebook { name, cells } → returns the full notebook.
 *
 * Org-scoped (shared across the org's members). Cells are stored as JSONB; each
 * is { id, sql, title? }. Execution happens via the session/query routes (the
 * notebook picks an endpoint + agent and runs each cell through that agent's ACL).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, queryOne } from '@/lib/db';
import { resolveCaller, parseBody, handle, ok } from '../_shared';

const CellSchema = z.object({
  id: z.string().min(1),
  sql: z.string(),
  title: z.string().optional(),
});

const CreateSchema = z.object({
  name: z.string().min(1),
  cells: z.array(CellSchema).default([]),
});

interface NotebookRow {
  id: string;
  name: string;
  cells: unknown;
  created_at: string;
  updated_at: string;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const rows = await query<NotebookRow>(
      `SELECT id, name, cells, created_at, updated_at
         FROM waddling.notebook WHERE org_id = $1
        ORDER BY updated_at DESC`,
      [caller.orgId],
    );
    const notebooks = rows.rows.map((r) => ({
      id: r.id,
      name: r.name,
      cellCount: Array.isArray(r.cells) ? r.cells.length : 0,
      updatedAt: r.updated_at,
    }));
    return ok({ notebooks });
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const { name, cells } = await parseBody(req, CreateSchema);
    const row = await queryOne<NotebookRow>(
      `INSERT INTO waddling.notebook (org_id, name, cells, created_by)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING id, name, cells, created_at, updated_at`,
      [caller.orgId, name, JSON.stringify(cells), caller.callerId],
    );
    return ok(
      {
        notebook: {
          id: row!.id,
          name: row!.name,
          cells: row!.cells,
          createdAt: row!.created_at,
          updatedAt: row!.updated_at,
        },
      },
      201,
    );
  });
}
