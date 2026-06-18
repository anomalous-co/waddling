import { getStack } from "./stack.ts";

export interface Todo {
  id: number;
  title: string;
  done: boolean;
  created_at: string;
}

export async function listTodos(): Promise<Todo[]> {
  const { db } = await getStack();
  const result = await db.query<Todo>("SELECT * FROM todos ORDER BY id");
  return result.rows;
}

export async function getTodo(id: number): Promise<Todo | null> {
  const { db } = await getStack();
  const result = await db.query<Todo>("SELECT * FROM todos WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function createTodo(title: string): Promise<Todo> {
  const { db } = await getStack();
  const result = await db.query<Todo>(
    "INSERT INTO todos (title) VALUES ($1) RETURNING *",
    [title],
  );
  return result.rows[0]!;
}

export async function updateTodo(
  id: number,
  patch: { title?: string; done?: boolean },
): Promise<Todo | null> {
  const { db } = await getStack();
  const result = await db.query<Todo>(
    `UPDATE todos
     SET title = COALESCE($1, title),
         done  = COALESCE($2, done)
     WHERE id = $3
     RETURNING *`,
    [patch.title ?? null, patch.done ?? null, id],
  );
  return result.rows[0] ?? null;
}

export async function deleteTodo(id: number): Promise<boolean> {
  const { db } = await getStack();
  const result = await db.query<{ id: number }>(
    "DELETE FROM todos WHERE id = $1 RETURNING id",
    [id],
  );
  return result.rows.length > 0;
}
