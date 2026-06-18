import { NextResponse } from "next/server";
import { getTodo, updateTodo, deleteTodo } from "@pglite-sandbox/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && String(n) === raw ? n : null;
}

export async function GET(_req: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const todo = await getTodo(id);
  if (!todo) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(todo);
}

export async function PATCH(req: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  let body: { title?: unknown; done?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.title === undefined && body.done === undefined) {
    return NextResponse.json({ error: "Provide title and/or done" }, { status: 400 });
  }
  const patch: { title?: string; done?: boolean } = {};
  if (typeof body.title === "string") patch.title = body.title;
  if (typeof body.done === "boolean") patch.done = body.done;

  const todo = await updateTodo(id, patch);
  if (!todo) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(todo);
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const id = parseId((await params).id);
  if (id === null) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const ok = await deleteTodo(id);
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
