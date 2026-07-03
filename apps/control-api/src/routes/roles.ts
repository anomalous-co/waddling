/**
 * /api/cp/roles — birdshot role listing for a datalake (grant-ux-plan §8.1, the Roles-node
 * combobox). There is no roles TABLE: roles exist implicitly in `__birdshot_grants` as either
 * (a) `grantee_kind='role'` object grants (`… TO ROLE analyst`) or (b) membership rows
 * (`GRANT analyst TO agent:123`, stored `grantee_kind='subject'`). This route derives the
 * distinct role set from both, plus a member count.
 *
 * GET / ?datalakeId= → { roles: Array<{ name, memberCount }> }
 *   name        — distinct role name (union of role-grantee rows ∪ membership role targets)
 *   memberCount — distinct subjects with a `GRANT <role> TO <subject>` membership row.
 *                 NOTE: memberships are APPENDED `REVOKE ROLE …` never deleted (§12f), so this
 *                 does NOT net out revoked memberships and may overcount. It is a headcount of
 *                 grant-membership rows, not a live-membership resolution.
 */
import { Hono } from 'hono';
import { queryOne } from '../lib/db';
import type { Env } from '../lib/env';
import { listStatements } from '../lib/grant-store';
import { resolveCaller, assertOrg, handle, ok, err } from '../lib/cp-shared';

const roles = new Hono<{ Bindings: Env }>();

// `GRANT <role> TO <subject>` (membership grant) — no ON clause.
const MEMBERSHIP_GRANT = /^\s*GRANT\s+([A-Za-z0-9_:-]+)\s+TO\s+([A-Za-z0-9_.:-]+)\s*;?\s*$/i;
// `REVOKE ROLE <role> FROM <subject>` (membership revoke).
const MEMBERSHIP_REVOKE = /^\s*REVOKE\s+ROLE\s+([A-Za-z0-9_:-]+)\s+FROM\s+([A-Za-z0-9_.:-]+)\s*;?\s*$/i;

roles.get('/', (c) =>
  handle(c, async () => {
    const caller = await resolveCaller(c);
    const url = new URL(c.req.url);
    const datalakeId = url.searchParams.get('datalakeId');
    if (!datalakeId) return err(c, 'datalakeId_required', 400, 'datalakeId query param is required');

    const ep = await queryOne<{ org_id: string }>(
      `SELECT org_id FROM waddling.datalake WHERE id = $1`,
      [datalakeId],
    );
    if (!ep) return err(c, 'endpoint_not_found', 404);
    assertOrg(caller, ep.org_id);

    const rows = await listStatements(datalakeId);
    const names = new Set<string>();
    const members = new Map<string, Set<string>>(); // role → distinct subjects (grant memberships)

    for (const r of rows) {
      if (r.grantee_kind === 'role' && r.grantee) names.add(r.grantee);
      // Membership rows are stored grantee_kind='subject' — parse the role out of the stmt.
      const mg = r.stmt.match(MEMBERSHIP_GRANT);
      if (mg && !/\bON\b/i.test(r.stmt)) {
        names.add(mg[1]);
        const set = members.get(mg[1]) ?? new Set<string>();
        set.add(mg[2]);
        members.set(mg[1], set);
      }
      const mr = r.stmt.match(MEMBERSHIP_REVOKE);
      if (mr && !/\bON\b/i.test(r.stmt)) names.add(mr[1]);
    }

    const out = [...names]
      .sort()
      .map((name) => ({ name, memberCount: members.get(name)?.size ?? 0 }));
    return ok(c, { roles: out });
  }),
);

export { roles };
