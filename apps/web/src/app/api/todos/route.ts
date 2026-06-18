import { NextResponse } from "next/server";
import { listTodos, createTodo } from "@pglite-sandbox/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await listTodos());
}

export async function POST(req: Request) {
  let body: { title?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.title !== "string" || !body.title.trim()) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  const todo = await createTodo(body.title.trim());
  return NextResponse.json(todo, { status: 201 });
}
