import type { AclRuleInput } from '@/lib/types';

/**
 * AclRuleRow — lab-local type for ACL rule responses.
 *
 * GUESSED: `control-schema` defines `AclRuleInput` (the POST body shape) but
 * does not yet define a server-response `AclRuleRow` that adds server-assigned
 * fields. This type captures the expected shape based on the fetch.ts contract
 * comment (`POST /api/cp/acl → { rule: AclRuleRow }`).
 */
export interface AclRuleRow extends AclRuleInput {
  /** Server-assigned opaque rule identifier. */
  id: string;
  /** Org that owns this rule. */
  orgId: string;
  /** ISO timestamp of when the rule was created. */
  createdAt: string;
}

/** Fixture ACL rules for the UX lab — covers both fixture lakes and agents. */
export const FIXTURE_ACL_RULES: AclRuleRow[] = [
  // analytics-etl → Event Lake: read analytics.events
  {
    id: 'rule_01aclread01',
    orgId: 'org_01j8k9m2n3p4q5r6s7t8u9v0w',
    datalakeId: 'dl_01j8events',
    agentId: 'agt_01j8k9m2n3p4q5r6s7t8u9v0w',
    schema: 'analytics',
    table: 'events',
    verb: 'read',
    effect: 'allow',
    createdAt: '2026-05-15T10:00:00Z',
  },
  // analytics-etl → Event Lake: read analytics.conversions
  {
    id: 'rule_01aclread02',
    orgId: 'org_01j8k9m2n3p4q5r6s7t8u9v0w',
    datalakeId: 'dl_01j8events',
    agentId: 'agt_01j8k9m2n3p4q5r6s7t8u9v0w',
    schema: 'analytics',
    table: 'conversions',
    verb: 'read',
    effect: 'allow',
    createdAt: '2026-05-15T10:00:00Z',
  },
  // analytics-etl → Event Lake: write analytics.conversions (ETL target)
  {
    id: 'rule_01aclwrite01',
    orgId: 'org_01j8k9m2n3p4q5r6s7t8u9v0w',
    datalakeId: 'dl_01j8events',
    agentId: 'agt_01j8k9m2n3p4q5r6s7t8u9v0w',
    schema: 'analytics',
    table: 'conversions',
    verb: 'write',
    effect: 'allow',
    createdAt: '2026-05-15T10:00:00Z',
  },
  // insight-bot → Event Lake: read analytics.events + analytics.sessions
  {
    id: 'rule_02aclread01',
    orgId: 'org_01j8k9m2n3p4q5r6s7t8u9v0w',
    datalakeId: 'dl_01j8events',
    agentId: 'agt_02j8k9m2n3p4q5r6s7t8u9v0x',
    schema: 'analytics',
    table: 'events',
    verb: 'read',
    effect: 'allow',
    createdAt: '2026-06-01T08:30:00Z',
  },
  {
    id: 'rule_02aclread02',
    orgId: 'org_01j8k9m2n3p4q5r6s7t8u9v0w',
    datalakeId: 'dl_01j8events',
    agentId: 'agt_02j8k9m2n3p4q5r6s7t8u9v0x',
    schema: 'analytics',
    table: 'sessions',
    verb: 'read',
    effect: 'allow',
    createdAt: '2026-06-01T08:30:00Z',
  },
];
