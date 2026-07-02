import { FIXTURE_BILLING } from '@/lab/fixtures/billing';

/**
 * GET /api/cp/billing
 * Mock handler — returns the org's prepaid-credits billing state for the UX lab.
 * Guarded: returns 404 when NEXT_PUBLIC_CONTROL_API_URL is set (real API in use).
 *
 * Shape: BillingInfo (see src/lab/fixtures/billing.ts) — all money in integer cents.
 */
export function GET() {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  return Response.json(FIXTURE_BILLING);
}

/**
 * POST /api/cp/billing/topup
 * Mock handler — "buys" credits. NO real payment: echoes the new balance so the
 * UI can optimistically reflect the top-up. Body: { amountCents: number }.
 */
export async function POST(request: Request) {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  const body = (await request.json().catch(() => ({}))) as {
    amountCents?: number;
  };
  const add = Math.max(0, Math.round(body.amountCents ?? 0));
  return Response.json({
    ok: true,
    creditBalanceCents: FIXTURE_BILLING.creditBalanceCents + add,
    addedCents: add,
  });
}
