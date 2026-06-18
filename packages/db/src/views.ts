import { randomUUID } from "node:crypto";
import { getStack } from "./stack.ts";

/** A named, saved SELECT query pinned to the Home tab as a "custom data view". */
export interface SavedView {
  id: string;
  name: string;
  sql: string;
  created_at: string;
}

export async function listViews(): Promise<SavedView[]> {
  const { privateDb } = await getStack();
  const result = await privateDb.query<SavedView>(
    "SELECT id, name, sql, created_at FROM saved_views ORDER BY created_at",
  );
  return result.rows;
}

export async function createView(input: { name: string; sql: string }): Promise<SavedView> {
  const { privateDb } = await getStack();
  const result = await privateDb.query<SavedView>(
    `INSERT INTO saved_views (id, name, sql)
     VALUES ($1, $2, $3)
     RETURNING id, name, sql, created_at`,
    [randomUUID(), input.name, input.sql],
  );
  return result.rows[0]!;
}

export async function deleteView(id: string): Promise<boolean> {
  const { privateDb } = await getStack();
  const result = await privateDb.query<{ id: string }>(
    "DELETE FROM saved_views WHERE id = $1 RETURNING id",
    [id],
  );
  return result.rows.length > 0;
}
