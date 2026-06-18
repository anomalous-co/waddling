import { NextResponse } from "next/server";
import { runReadOnlyQuery } from "@pglite-sandbox/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { sql?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.sql !== "string" || !body.sql.trim()) {
    return NextResponse.json({ error: "sql is required" }, { status: 400 });
  }
  try {
    const result = await runReadOnlyQuery(body.sql);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Query failed" },
      { status: 400 },
    );
  }
}
