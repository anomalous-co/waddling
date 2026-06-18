/**
 * /api/cp/views — Hono port of apps/waddling/src/app/api/cp/views{,/[id]}/route.ts.
 * Saved views: named queries pinned from a notebook cell.
 *
 * GET    /     → list the org's saved views (id, name, sql, timestamps).
 * POST   /     → create a view { name, sql } → returns the full view.
 * PUT    /:id  → rename / replace SQL.
 * DELETE /:id  → remove the view.
 *
 * Org-scoped (shared across the org's members). A view holds only SQL; it is
 * executed via the session/query routes — the Views page picks an endpoint +
 * agent and runs each view through that agent's ACL (the gateway query proxy).
 */
import { z } from 'zod';
import { Hono } from 'hono';
import { query, queryOne } from '../lib/db';
import type { Env } from '../lib/env';
import { resolveCaller, parseBody, handle, ok, err } from '../lib/cp-shared';

const CreateSchema = z.object({
  name: z.string().min(1),
  sql: z.string().min(1),
});

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

const views = new Hono<{ Bindings: Env }>();

// GET / — list the org's saved views.
views.get('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const rows = await query<ViewRow>(
      `SELECT id, name, sql, created_at, updated_at
         FROM waddling.saved_view WHERE org_id = $1
        ORDER BY updated_at DESC`,
      [caller.orgId],
    );
    const list = rows.rows.map((r) => ({
      id: r.id,
      name: r.name,
      sql: r.sql,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
    return ok(c, { views: list });
  }),
);

// POST / — create a view.
views.post('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const { name, sql } = await parseBody(c, CreateSchema);
    const row = await queryOne<ViewRow>(
      `INSERT INTO waddling.saved_view (org_id, name, sql, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, sql, created_at, updated_at`,
      [caller.orgId, name, sql, caller.callerId],
    );
    return ok(
      c,
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
  }),
);

// PUT /:id — rename / replace SQL.
views.put('/:id', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    const existing = await loadOwned(id, caller.orgId);
    if (!existing) return err(c, 'view_not_found', 404);
    const { name, sql } = await parseBody(c, UpdateSchema);
    const row = await queryOne<ViewRow>(
      `UPDATE waddling.saved_view
          SET name = COALESCE($2, name),
              sql = COALESCE($3, sql),
              updated_at = now()
        WHERE id = $1
        RETURNING id, name, sql, created_at, updated_at`,
      [id, name ?? null, sql ?? null],
    );
    return ok(c, {
      view: {
        id: row!.id,
        name: row!.name,
        sql: row!.sql,
        createdAt: row!.created_at,
        updatedAt: row!.updated_at,
      },
    });
  }),
);

// DELETE /:id — remove the view.
views.delete('/:id', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const id = c.req.param('id');
    const existing = await loadOwned(id, caller.orgId);
    if (!existing) return err(c, 'view_not_found', 404);
    await query(`DELETE FROM waddling.saved_view WHERE id = $1`, [id]);
    return ok(c, { ok: true });
  }),
);

export { views };
