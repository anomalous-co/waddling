import { NextResponse } from "next/server";
import { getDialect } from "@pglite-sandbox/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getDialect());
}
