/**
 * /api/cp/endpoints/[id]/describe (W1) — governed schema introspection.
 *
 * GET ?agentId=&schema=&table= → the tables + columns + types the given agent is
 * allowed to see on this endpoint. Used by the dashboard Notebooks/Views editor
 * for column-aware autocomplete, and by the external MCP `waddling_describe`
 * tool (which calls this exact path) before an agent writes a query.
 *
 * The lake's real column types live only in the gateway's DuckDB, so this:
 *   1. compiles the agent's ACL → granted tables (+ column allow-lists),
 *   2. asks the gateway to introspect those tables (columns + types),
 *   3. INTERSECTS: keeps only granted tables, and only granted columns where an
 *      allow-list is defined (undefined ⇒ all columns, per the compiler).
 *
 * Step 3 is the non-leak guarantee — describe must never reveal a table or column
 * the agent could not query through the gateway proxy. Agent (api-key) callers
 * describe themselves; dashboard users pass ?agentId to run-as a chosen agent.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { gatewayClientFor, GatewayError } from '@/lib/gateway-client';
import { compilePolicy, grantsForAgent, type AclRuleRow } from '@/lib/policy-compiler';
import { resolveCaller, assertOrg, handle, ok, err } from '../../../_shared';
import type { DescribeResult, TableInfo } from '@/lib/types';

interface EndpointRow {
  id: string;
  org_id: string;
  status: string;
  gateway_host: string | null;
  quack_port: number | null;
  server_token: string;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return handle(async () => {
    // Data-plane read (waddling_describe) — allow delegated OAuth/MCP callers.
    const caller = await resolveCaller(req, true, true);
    const { id: endpointId } = await ctx.params;
    const u = new URL(req.url);
    const schemaFilter = u.searchParams.get('schema');
    const tableFilter = u.searchParams.get('table');

    // Agent identity: api-key callers describe themselves; users pass ?agentId.
    const agentId = caller.agentId ?? u.searchParams.get('agentId') ?? undefined;
    if (!agentId) {
      return err('agent_required', 400, 'describe requires an agentId to run as');
    }

    const endpoint = await queryOne<EndpointRow>(
      `SELECT id, org_id, status, gateway_host, quack_port, server_token
         FROM waddling.endpoint WHERE id = $1`,
      [endpointId],
    );
    if (!endpoint) return err('endpoint_not_found', 404);
    assertOrg(caller, endpoint.org_id);

    // Org-scope the target agent for run-as (tenant isolation).
    if (!caller.agentId) {
      const target = await queryOne<{ org_id: string }>(
        `SELECT org_id FROM waddling.agent WHERE id = $1`,
        [agentId],
      );
      if (!target) return err('agent_not_found', 404);
      assertOrg(caller, target.org_id);
    }

    // Compile the agent's grants (tables + per-table column allow-lists).
    const ruleRows = await query<AclRuleRow>(
      `SELECT * FROM waddling.acl_rule
        WHERE endpoint_id = $1 AND (agent_id = $2 OR agent_id IS NULL)`,
      [endpointId, agentId],
    );
    const compiled = compilePolicy(ruleRows.rows, new Date());
    const granted = grantsForAgent(compiled, agentId);
    if (granted.tables.length === 0) {
      return ok<DescribeResult>({ endpointId, tables: [] });
    }
    if (endpoint.status !== 'running') {
      // Can't introspect a stopped gateway; grants are known but types aren't.
      return ok<DescribeResult>({ endpointId, tables: [] });
    }

    // Ask the gateway for columns/types of just the granted tables.
    let described: { tables: { schema: string; table: string; columns: { name: string; type: string; nullable?: boolean }[] }[] };
    try {
      described = await gatewayClientFor(endpoint).describe(
        granted.tables.map((t) => ({ schema: t.schema, table: t.table })),
      );
    } catch (e) {
      // A failed probe must never break the editor — degrade to no schema.
      if (e instanceof GatewayError) return ok<DescribeResult>({ endpointId, tables: [] });
      throw e;
    }

    const describedByRef = new Map(
      described.tables.map((t) => [`${t.schema}.${t.table}`.toLowerCase(), t]),
    );

    // Intersect introspected columns with the grant (non-leak guarantee).
    const tables: TableInfo[] = [];
    for (const g of granted.tables) {
      if (schemaFilter && g.schema !== schemaFilter) continue;
      if (tableFilter && g.table !== tableFilter) continue;
      const d = describedByRef.get(`${g.schema}.${g.table}`.toLowerCase());
      if (!d) continue; // granted but not present in the lake — omit
      // Allow-list defined ⇒ keep only those columns; undefined ⇒ all columns.
      const allow = g.columns ? new Set(g.columns.map((c) => c.toLowerCase())) : null;
      const columns = (allow ? d.columns.filter((c) => allow.has(c.name.toLowerCase())) : d.columns).map(
        (c) => ({ name: c.name, type: c.type, nullable: c.nullable }),
      );
      tables.push({ schema: g.schema, table: g.table, columns });
    }

    return ok<DescribeResult>({ endpointId, tables });
  });
}
