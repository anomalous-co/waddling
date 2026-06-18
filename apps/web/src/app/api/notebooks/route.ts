import { NextResponse } from "next/server";
import { listNotebooks, saveNotebook, type NotebookCell } from "@pglite-sandbox/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await listNotebooks());
}

export async function POST(req: Request) {
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
  const notebook = await saveNotebook({ name: body.name.trim(), cells });
  return NextResponse.json(notebook, { status: 201 });
}
