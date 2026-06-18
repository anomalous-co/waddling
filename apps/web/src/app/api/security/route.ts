// Security control plane for birdshot.
//
//   GET  /api/security  — drain birdshot's audit ring (persisting to authDb),
//                         return recent events + any subjects tripping the
//                         repeated-violation threshold (the automated-response
//                         trigger: violation logging feeds revocation).
//   POST /api/security  — { action: "revoke" | "unrevoke", kind, id, reason?,
//                           expiresAtMs? } for instant, automated revocation.
import { NextResponse } from "next/server";
import { getStack, drainAudit, revoke, unrevoke } from "@pglite-sandbox/db";

const VIOLATION_THRESHOLD = 5;

export async function GET() {
  const stack = await getStack();
  if (!stack.birdshotActive) {
    return NextResponse.json({ birdshotActive: false, events: [], flagged: [] });
  }
  const events = await drainAudit(stack.duck, stack.authDb, 1000);

  // Count denials per user; surface anyone over the threshold so an operator (or
  // a cron) can revoke them. Wiring this straight to revoke() makes it automatic.
  const denials = new Map<string, number>();
  for (const e of events) {
    if (e.decision === "deny" && e.user_id) {
      denials.set(e.user_id, (denials.get(e.user_id) ?? 0) + 1);
    }
  }
  const flagged = [...denials.entries()]
    .filter(([, n]) => n >= VIOLATION_THRESHOLD)
    .map(([user_id, count]) => ({ user_id, count }));

  return NextResponse.json({ birdshotActive: true, events, flagged });
}

export async function POST(req: Request) {
  const stack = await getStack();
  if (!stack.birdshotActive) {
    return NextResponse.json({ error: "birdshot is not active" }, { status: 409 });
  }
  const body = (await req.json()) as {
    action: "revoke" | "unrevoke";
    kind: "user" | "jti" | "session";
    id: string;
    reason?: string;
    expiresAtMs?: number;
  };
  if (!body.id || !body.kind) {
    return NextResponse.json({ error: "kind and id are required" }, { status: 400 });
  }
  if (body.action === "unrevoke") {
    await unrevoke(stack.duck, stack.authDb, body.kind, body.id);
  } else {
    await revoke(stack.duck, stack.authDb, body.kind, body.id, body.reason ?? "", body.expiresAtMs);
  }
  return NextResponse.json({ ok: true });
}
