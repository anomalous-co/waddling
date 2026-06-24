/**
 * Complimentary ("free forever") access for the company's own domains.
 *
 * An org is COMPED when its OWNER has an email in a comp domain. Comped orgs:
 *   - bypass the payment-onboarding gate (treated as paid in GET /billing/status), and
 *   - are never cut off for an exhausted credit balance (hasCredit).
 *
 * Owner-based (not any-member) on purpose: otherwise an external org could comp itself
 * by inviting a company user as a member. The check is org-scoped so it covers the
 * agent/session credit path (which has no human email), not just the human gate.
 *
 * Email verification is enforced at signup (ANO-56, requireEmailVerification), so the
 * comp check requires `emailVerified` — a signup can't claim a comp domain it doesn't
 * control (it could never confirm the verification email). Founder accounts verify like
 * any other, so this doesn't lock them out.
 */
import { queryOne } from './db';

/**
 * Email domains that receive complimentary "free forever" access. Edit here.
 * `anomalous.compute` / `anomalous.compter` are founder typo variants of
 * `anomalous.computer` (used by existing internal accounts). They aren't real TLDs, so
 * no external party can own an address there — comping them only covers our own accounts.
 */
export const COMP_EMAIL_DOMAINS = [
  'anomalous.computer',
  'anomalous.compute',
  'anomalous.compter',
  'getwaddling.com',
] as const;

/** True if an email address belongs to a comp domain. */
export function isCompEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return (COMP_EMAIL_DOMAINS as readonly string[]).includes(domain);
}

/**
 * True if the org's owner has a comp-domain email. Fail-closed (false) on any error —
 * a DB blip should never accidentally hand out free access, only ever withhold the comp.
 */
export async function isOrgComped(orgId: string): Promise<boolean> {
  try {
    const likeClause = COMP_EMAIL_DOMAINS.map((_, i) => `lower(u.email) LIKE $${i + 2}`).join(' OR ');
    const row = await queryOne<{ one: number }>(
      `SELECT 1 AS one
         FROM "member" m
         JOIN "user" u ON u.id = m."userId"
        WHERE m."organizationId" = $1
          AND m.role = 'owner'
          AND u."emailVerified" = true
          AND (${likeClause})
        LIMIT 1`,
      [orgId, ...COMP_EMAIL_DOMAINS.map((d) => `%@${d.toLowerCase()}`)],
    );
    return !!row;
  } catch {
    return false;
  }
}
