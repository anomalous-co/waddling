import { NextResponse } from "next/server";
import { getAnalytics } from "@pglite-sandbox/db";

// Live cross-instance reads — never statically cached, always Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const data = await getAnalytics();
  return NextResponse.json(data);
}
