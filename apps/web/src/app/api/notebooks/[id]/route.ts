import { NextResponse } from "next/server";
import {
  getNotebook,
  saveNotebook,
  deleteNotebook,
  type NotebookCell,
} from "@pglite-sandbox/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const notebook = await getNotebook((await params).id);
  if (!notebook) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(notebook);
}

export async function PUT(req: Request, { params }: Ctx) {
  const { id } = await params;
  let body: { name?: unknown; cells?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const cells = Array.isArray(body.cells) ? (body.cells as NotebookCell[]) : [];
  const notebook = await saveNotebook({ id, name: body.name.trim(), cells });
  return NextResponse.json(notebook);
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const ok = await deleteNotebook((await params).id);
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
