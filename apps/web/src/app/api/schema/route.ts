import { NextResponse } from "next/server";
import { getSchema } from "@pglite-sandbox/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getSchema());
}
