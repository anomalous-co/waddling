import { NextResponse } from "next/server";
import { listViews, createView } from "@pglite-sandbox/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await listViews());
}

export async function POST(req: Request) {
  let body: { name?: unknown; sql?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (typeof body.sql !== "string" || !body.sql.trim()) {
    return NextResponse.json({ error: "sql is required" }, { status: 400 });
  }
  const view = await createView({ name: body.name.trim(), sql: body.sql });
  return NextResponse.json(view, { status: 201 });
}
