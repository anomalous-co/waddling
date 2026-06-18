/**
 * /api/cp/acl/[id] (W1) — single ACL rule read/delete; delete recompiles (§3e).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { recompileAndPush } from '../recompile';
import { resolveCaller, assertOrg, handle, ok, err } from '../../_shared';

interface RuleRow {
  id: string;
  org_id: string;
  endpoint_id: string;
  agent_id: string | null;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const { id } = await ctx.params;
    const rule = await queryOne<RuleRow & Record<string, unknown>>(
      `SELECT * FROM waddling.acl_rule WHERE id = $1`,
      [id],
    );
    if (!rule) return err('rule_not_found', 404);
    assertOrg(caller, rule.org_id);
    return ok({ rule });
  });
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return handle(async () => {
    const caller = await resolveCaller(req);
    const { id } = await ctx.params;
    const rule = await queryOne<RuleRow>(
      `SELECT id, org_id, endpoint_id, agent_id FROM waddling.acl_rule WHERE id = $1`,
      [id],
    );
    if (!rule) return err('rule_not_found', 404);
    assertOrg(caller, rule.org_id);

    await query(`DELETE FROM waddling.acl_rule WHERE id = $1`, [id]);
    const compiled = await recompileAndPush(rule.endpoint_id, rule.agent_id ?? undefined);

    await query(
      `INSERT INTO waddling.audit_event (org_id, source, event, agent_id, endpoint_id, decision, actor)
       VALUES ($1,'control-plane','revoke',$2,$3,'deny',$4)`,
      [rule.org_id, rule.agent_id, rule.endpoint_id, caller.callerId],
    );

    return ok({ success: true, ruleId: id, compiledGrants: compiled.snapshot });
  });
}
