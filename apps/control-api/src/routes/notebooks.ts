/**
 * /api/cp/notebooks — Hono port of apps/waddling/src/app/api/cp/notebooks{,/[id]}/route.ts.
 * Saved SQL workbooks for the dashboard Notebooks view.
 *
 * GET    /     → list the org's notebooks (id, name, cellCount, updatedAt).
 * POST   /     → create a notebook { name, cells } → returns the full notebook.
 * GET    /:id  → full notebook { id, name, cells, updatedAt }.
 * PUT    /:id  → replace name + cells.
 * DELETE /:id  → remove the notebook.
 *
 * Org-scoped (shared across the org's members). Cells are stored as JSONB; each
 * is { id, sql, title? }. Execution happens via the session/query routes (the
 * notebook picks an endpoint + agent and runs each cell through that agent's ACL).
 */
import { z } from 'zod';
import { Hono } from 'hono';
import { query, queryOne } from '../lib/db';
import type { Env } from '../lib/env';
import { resolveCaller, parseBody, handle, ok, err } from '../lib/cp-shared';

const CellSchema = z.object({
  id: z.string().min(1),
  sql: z.string(),
  title: z.string().optional(),
});

const CreateSchema = z.object({
  name: z.string().min(1),
  cells: z.array(CellSchema).default([]),
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

const notebooks = new Hono<{ Bindings: Env }>();

// GET / — list the org's notebooks.
notebooks.get('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const rows = await query<NotebookRow>(
      `SELECT id, name, cells, created_at, updated_at
         FROM waddling.notebook WHERE org_id = $1
        ORDER BY updated_at DESC`,
      [caller.orgId],
    );
    const list = rows.rows.map((r) => ({
      id: r.id,
      name: r.name,
      cellCount: Array.isArray(r.cells) ? r.cells.length : 0,
      updatedAt: r.updated_at,
    }));
    return ok(c, { notebooks: list });
  }),
);

// POST / — create a notebook.
notebooks.post('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const { name, cells } = await parseBody(c, CreateSchema);
    const row = await queryOne<NotebookRow>(
      `INSERT INTO waddling.notebook (org_id, name, cells, created_by)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING id, name, cells, created_at, updated_at`,
      [caller.orgId, name, JSON.stringify(cells), caller.callerId],
    );
    return ok(
      c,
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
  }),
);

// GET /:id — full notebook.
notebooks.get('/:id', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    const nb = await loadOwned(id, caller.orgId);
    if (!nb) return err(c, 'notebook_not_found', 404);
    return ok(c, {
      notebook: {
        id: nb.id,
        name: nb.name,
        cells: nb.cells,
        createdAt: nb.created_at,
        updatedAt: nb.updated_at,
      },
    });
  }),
);

// PUT /:id — replace name + cells.
notebooks.put('/:id', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    const existing = await loadOwned(id, caller.orgId);
    if (!existing) return err(c, 'notebook_not_found', 404);
    const { name, cells } = await parseBody(c, UpdateSchema);
    const row = await queryOne<NotebookRow>(
      `UPDATE waddling.notebook
          SET name = $2, cells = $3::jsonb, updated_at = now()
        WHERE id = $1
        RETURNING id, name, cells, created_at, updated_at`,
      [id, name, JSON.stringify(cells)],
    );
    return ok(c, {
      notebook: {
        id: row!.id,
        name: row!.name,
        cells: row!.cells,
        updatedAt: row!.updated_at,
      },
    });
  }),
);

// DELETE /:id — remove the notebook.
notebooks.delete('/:id', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    const existing = await loadOwned(id, caller.orgId);
    if (!existing) return err(c, 'notebook_not_found', 404);
    await query(`DELETE FROM waddling.notebook WHERE id = $1`, [id]);
    return ok(c, { ok: true });
  }),
);

export { notebooks };
