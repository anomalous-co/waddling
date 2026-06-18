import { randomUUID } from "node:crypto";
import { getStack } from "./stack.ts";

/** A single editor cell: a SQL query the user can run on demand. */
export interface NotebookCell {
  id: string;
  title?: string;
  sql: string;
}

export interface Notebook {
  id: string;
  name: string;
  cells: NotebookCell[];
  created_at: string;
  updated_at: string;
}

/** Lightweight notebook listing (no cells) for the picker. */
export interface NotebookSummary {
  id: string;
  name: string;
  updated_at: string;
}

interface NotebookRow {
  id: string;
  name: string;
  cells: NotebookCell[] | string;
  created_at: string;
  updated_at: string;
}

function parseCells(cells: NotebookCell[] | string): NotebookCell[] {
  if (Array.isArray(cells)) return cells;
  try {
    return JSON.parse(cells) as NotebookCell[];
  } catch {
    return [];
  }
}

export async function listNotebooks(): Promise<NotebookSummary[]> {
  const { privateDb } = await getStack();
  const result = await privateDb.query<NotebookSummary>(
    "SELECT id, name, updated_at FROM notebooks ORDER BY updated_at DESC",
  );
  return result.rows;
}

export async function getNotebook(id: string): Promise<Notebook | null> {
  const { privateDb } = await getStack();
  const result = await privateDb.query<NotebookRow>(
    "SELECT id, name, cells, created_at, updated_at FROM notebooks WHERE id = $1",
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...row, cells: parseCells(row.cells) };
}

/** Upsert a notebook (create if `id` is new, otherwise replace name + cells). */
export async function saveNotebook(input: {
  id?: string;
  name: string;
  cells: NotebookCell[];
}): Promise<Notebook> {
  const { privateDb } = await getStack();
  const id = input.id ?? randomUUID();
  const result = await privateDb.query<NotebookRow>(
    `INSERT INTO notebooks (id, name, cells)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name,
           cells = EXCLUDED.cells,
           updated_at = now()
     RETURNING id, name, cells, created_at, updated_at`,
    [id, input.name, JSON.stringify(input.cells)],
  );
  const row = result.rows[0]!;
  return { ...row, cells: parseCells(row.cells) };
}

export async function deleteNotebook(id: string): Promise<boolean> {
  const { privateDb } = await getStack();
  const result = await privateDb.query<{ id: string }>(
    "DELETE FROM notebooks WHERE id = $1 RETURNING id",
    [id],
  );
  return result.rows.length > 0;
}
