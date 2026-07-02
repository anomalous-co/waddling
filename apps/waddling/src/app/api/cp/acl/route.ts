import { FIXTURE_ACL_RULES } from '@/lab/fixtures/acl';
import type { AclRuleRow } from '@/lab/fixtures/acl';
import type { AclRuleInput } from '@/lib/types';

/**
 * GET /api/cp/acl
 * Mock handler — returns all fixture ACL rules for the UX lab.
 * Guards against serving when the real control-api is configured.
 */
export function GET() {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }
  return Response.json({ rules: FIXTURE_ACL_RULES });
}

/**
 * POST /api/cp/acl
 * Mock handler — creates an ACL rule granting a specific verb on a table to an
 * agent. Echoes the posted data back as a rule with a generated id.
 * Returns 402 if the org is on a free plan (not simulated in the lab — always
 * returns 201 here).
 * Guards against serving when the real control-api is configured.
 */
export async function POST(request: Request) {
  if (process.env.NEXT_PUBLIC_CONTROL_API_URL) {
    return new Response(null, { status: 404 });
  }

  const body = (await request.json()) as AclRuleInput;

  const randomHex = () =>
    Math.random().toString(16).slice(2).padStart(8, '0');

  const rule: AclRuleRow = {
    ...body,
    id: `rule_${randomHex()}`,
    orgId: 'org_01j8k9m2n3p4q5r6s7t8u9v0w',
    createdAt: new Date().toISOString(),
    effect: body.effect ?? 'allow',
  };

  return Response.json({ rule }, { status: 201 });
}
