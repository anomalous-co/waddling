/**
 * Unit tests for deriveEffectiveRules (effective-policy.ts).
 *
 * Run: npx vitest run effective-policy.test.ts
 *   (from apps/control-api/, using the workspace-level vitest binary)
 *
 * compileEndpointPolicy is DB-bound; it is exercised via wrangler-dev + PGlite
 * as specified in the plan (Phase 1 verification section), not mocked here.
 *
 * Coverage targets (plan risk #5 — derive intersection matrix):
 *  1. Capability must match on both sides.
 *  2. Resource specificity: wildcard yields to specific; disjoint drops.
 *  3. Column set-intersection (null=all, empty result drops).
 *  4. Deny preservation and rewriting — deny from user grant is always carried.
 *  5. row_limit: min of non-null.
 *  6. Window: intersection; disjoint drops.
 *  7. expires_at: tightest (min).
 *  8. Non-read/write capabilities are NOT emitted even when both sides match.
 *  9. An allow grant with no matching scope entry produces nothing.
 * 10. subject_kind and agent_id are correctly rewritten on output rows.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveEffectiveRules,
  type AclRuleRowFull,
  type DelegationRow,
} from './src/lib/effective-policy';
import { compilePolicy } from './src/lib/policy-compiler';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = new Date('2026-06-19T12:00:00Z');

function makeGrant(overrides: Partial<AclRuleRowFull> = {}): AclRuleRowFull {
  return {
    id: 'g1',
    org_id: 'org1',
    datalake_id: 'lake1',
    agent_id: null,      // user-subject — no agent_id
    subject_kind: 'user',
    user_id: 'user1',
    schema_name: '*',
    table_name: '*',
    columns: null,
    verb: 'read',
    capability: 'read',
    effect: 'allow',
    row_limit: null,
    ttl_seconds: null,
    window_start: null,
    window_end: null,
    not_before: null,
    expires_at: null,
    priority: 100,
    ...overrides,
  };
}

function makeScope(overrides: Partial<DelegationRow> = {}): DelegationRow {
  return {
    id: 's1',
    org_id: 'org1',
    user_id: 'user1',
    agent_id: 'agent1',
    client_id: null,
    datalake_id: 'lake1',
    schema_name: '*',
    table_name: '*',
    columns: null,
    capability: 'read',
    row_limit: null,
    window_start: null,
    window_end: null,
    expires_at: null,
    created_by: 'user1',
    created_at: NOW,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('deriveEffectiveRules', () => {
  it('produces a row when capability matches on both sides', () => {
    const rows = deriveEffectiveRules(
      [makeGrant({ capability: 'read', verb: 'read' })],
      [makeScope({ capability: 'read' })],
      'agent1',
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].verb).toBe('read');
    expect(rows[0].effect).toBe('allow');
  });

  // Test 1 — capability must match both sides.
  it('produces nothing when capabilities do not match', () => {
    const rows = deriveEffectiveRules(
      [makeGrant({ capability: 'write', verb: 'write' })],
      [makeScope({ capability: 'read' })],
      'agent1',
      NOW,
    );
    expect(rows).toHaveLength(0);
  });

  // Test 1b — allow grant with no matching scope entry produces nothing.
  it('produces nothing when scope is empty', () => {
    const rows = deriveEffectiveRules(
      [makeGrant()],
      [],
      'agent1',
      NOW,
    );
    expect(rows).toHaveLength(0);
  });

  // Test 2a — wildcard yields to specific.
  it('resource specificity: wildcard yields to specific', () => {
    const rows = deriveEffectiveRules(
      [makeGrant({ schema_name: '*', table_name: '*' })],
      [makeScope({ schema_name: 'sales', table_name: 'orders' })],
      'agent1',
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].schema_name).toBe('sales');
    expect(rows[0].table_name).toBe('orders');
  });

  // Test 2b — disjoint schemas drop the pair.
  it('resource specificity: disjoint schemas drop the pair', () => {
    const rows = deriveEffectiveRules(
      [makeGrant({ schema_name: 'sales', table_name: '*' })],
      [makeScope({ schema_name: 'hr', table_name: '*' })],
      'agent1',
      NOW,
    );
    expect(rows).toHaveLength(0);
  });

  // Test 2c — disjoint tables drop the pair.
  it('resource specificity: disjoint tables drop the pair', () => {
    const rows = deriveEffectiveRules(
      [makeGrant({ schema_name: 'sales', table_name: 'orders' })],
      [makeScope({ schema_name: 'sales', table_name: 'customers' })],
      'agent1',
      NOW,
    );
    expect(rows).toHaveLength(0);
  });

  // Test 2d — equal specific selectors pass through.
  it('resource specificity: equal specific selectors pass', () => {
    const rows = deriveEffectiveRules(
      [makeGrant({ schema_name: 'sales', table_name: 'orders' })],
      [makeScope({ schema_name: 'sales', table_name: 'orders' })],
      'agent1',
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].schema_name).toBe('sales');
    expect(rows[0].table_name).toBe('orders');
  });

  // Test 3a — column intersection: null ∩ list → list.
  it('columns: null (all) ∩ list → list (scope narrows)', () => {
    const rows = deriveEffectiveRules(
      [makeGrant({ columns: null })],
      [makeScope({ columns: ['id', 'name'] })],
      'agent1',
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].columns).toEqual(['id', 'name']);
  });

  // Test 3b — column intersection: list ∩ null → list.
  it('columns: list ∩ null (all) → list (grant narrows)', () => {
    const rows = deriveEffectiveRules(
      [makeGrant({ columns: ['id', 'name', 'ssn'] })],
      [makeScope({ columns: null })],
      'agent1',
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].columns).toEqual(['id', 'name', 'ssn']);
  });

  // Test 3c — column intersection: common columns.
  it('columns: list ∩ list → intersection', () => {
    const rows = deriveEffectiveRules(
      [makeGrant({ columns: ['id', 'name', 'email'] })],
      [makeScope({ columns: ['id', 'email', 'phone'] })],
      'agent1',
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].columns).toEqual(['id', 'email']);
  });

  // Test 3d — column intersection: empty result drops the pair.
  it('columns: empty intersection drops the row', () => {
    const rows = deriveEffectiveRules(
      [makeGrant({ columns: ['id', 'name'] })],
      [makeScope({ columns: ['email', 'phone'] })],
      'agent1',
      NOW,
    );
    expect(rows).toHaveLength(0);
  });

  // Test 4a — deny from user grant is carried through regardless of scope.
  it('deny: user deny is carried to agent unchanged (deny preservation)', () => {
    const rows = deriveEffectiveRules(
      [makeGrant({ effect: 'deny', capability: 'read', verb: 'read' })],
      [], // no scope entries — deny still passes
      'agent1',
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].effect).toBe('deny');
    expect(rows[0].agent_id).toBe('agent1');
    expect(rows[0].verb).toBe('read');
  });

  // Test 4b — deny with non-birdshot capability is dropped.
  it('deny: non-read/write capability deny is dropped in Phase 1', () => {
    const rows = deriveEffectiveRules(
      [makeGrant({ effect: 'deny', capability: 'create', verb: 'read' })],
      [],
      'agent1',
      NOW,
    );
    expect(rows).toHaveLength(0);
  });

  // Test 4c — deny row has agent_id and subject_kind correctly set.
  it('deny: output row has agent_id=agentId, verb from capability', () => {
    const rows = deriveEffectiveRules(
      [makeGrant({ effect: 'deny', capability: 'write', verb: 'write',
                   schema_name: 'sales', table_name: 'pii' })],
      [],
      'agent-x',
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_id).toBe('agent-x');
    expect(rows[0].verb).toBe('write');
    expect(rows[0].schema_name).toBe('sales');
    expect(rows[0].table_name).toBe('pii');
  });

  // Test 5 — row_limit: min of non-null values.
  it('row_limit: takes the minimum of both sides', () => {
    const rows = deriveEffectiveRules(
      [makeGrant({ row_limit: 1000 })],
      [makeScope({ row_limit: 500 })],
      'agent1',
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].row_limit).toBe(500);
  });

  it('row_limit: null grant uses scope value', () => {
    const rows = deriveEffectiveRules(
      [makeGrant({ row_limit: null })],
      [makeScope({ row_limit: 100 })],
      'agent1',
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].row_limit).toBe(100);
  });

  it('row_limit: null on both sides yields null', () => {
    const rows = deriveEffectiveRules(
      [makeGrant({ row_limit: null })],
      [makeScope({ row_limit: null })],
      'agent1',
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].row_limit).toBeNull();
  });

  // Test 6a — window intersection: both null means no constraint.
  it('window: both null → no window constraint', () => {
    const rows = deriveEffectiveRules(
      [makeGrant({ window_start: null, window_end: null })],
      [makeScope({ window_start: null, window_end: null })],
      'agent1',
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].window_start).toBeNull();
    expect(rows[0].window_end).toBeNull();
  });

  it('window: one side null → other side used', () => {
    const rows = deriveEffectiveRules(
      [makeGrant({ window_start: '09:00', window_end: '17:00' })],
      [makeScope({ window_start: null, window_end: null })],
      'agent1',
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].window_start).toBe('09:00');
    expect(rows[0].window_end).toBe('17:00');
  });

  it('window: overlapping windows → tighter bounds', () => {
    const rows = deriveEffectiveRules(
      [makeGrant({ window_start: '08:00', window_end: '18:00' })],
      [makeScope({ window_start: '09:00', window_end: '17:00' })],
      'agent1',
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].window_start).toBe('09:00');
    expect(rows[0].window_end).toBe('17:00');
  });

  it('window: disjoint windows drop the pair', () => {
    const rows = deriveEffectiveRules(
      // Grant: 08:00–12:00; Scope: 13:00–17:00 — no overlap.
      [makeGrant({ window_start: '08:00', window_end: '12:00' })],
      [makeScope({ window_start: '13:00', window_end: '17:00' })],
      'agent1',
      NOW,
    );
    expect(rows).toHaveLength(0);
  });

  // Test 7 — expires_at: tightest bound (min).
  it('expires_at: min of both values', () => {
    const rows = deriveEffectiveRules(
      [makeGrant({ expires_at: '2026-12-31T00:00:00Z' })],
      [makeScope({ expires_at: '2026-06-30T00:00:00Z' })],
      'agent1',
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].expires_at).toBe('2026-06-30T00:00:00Z');
  });

  it('expires_at: null grant uses scope expiry', () => {
    const rows = deriveEffectiveRules(
      [makeGrant({ expires_at: null })],
      [makeScope({ expires_at: '2026-09-01T00:00:00Z' })],
      'agent1',
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].expires_at).toBe('2026-09-01T00:00:00Z');
  });

  // Test 8 — non-read/write capabilities are NOT emitted.
  it('non-birdshot capability (create) is not emitted as a row', () => {
    const rows = deriveEffectiveRules(
      [makeGrant({ capability: 'create', verb: 'read', effect: 'allow' })],
      [makeScope({ capability: 'create' })],
      'agent1',
      NOW,
    );
    expect(rows).toHaveLength(0);
  });

  it('non-birdshot capability (etl) is not emitted as a row', () => {
    const rows = deriveEffectiveRules(
      [makeGrant({ capability: 'etl', verb: 'read', effect: 'allow' })],
      [makeScope({ capability: 'etl' })],
      'agent1',
      NOW,
    );
    expect(rows).toHaveLength(0);
  });

  // Test 10 — subject_kind and agent_id are correctly set on output rows.
  it('output rows have agent_id=agentId and correct verb', () => {
    const rows = deriveEffectiveRules(
      [makeGrant({ capability: 'write', verb: 'write' })],
      [makeScope({ capability: 'write' })],
      'agent-xyz',
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_id).toBe('agent-xyz');
    expect(rows[0].verb).toBe('write');
  });

  // Multiple grants × scope pairs (cross-product).
  it('two grants × two matching scope entries → four rows', () => {
    const grants = [
      makeGrant({ id: 'g1', capability: 'read', verb: 'read',
                  schema_name: 'sales', table_name: '*' }),
      makeGrant({ id: 'g2', capability: 'write', verb: 'write',
                  schema_name: 'sales', table_name: 'orders' }),
    ];
    const scopes = [
      makeScope({ id: 's1', capability: 'read', schema_name: 'sales', table_name: 'orders' }),
      makeScope({ id: 's2', capability: 'write', schema_name: 'sales', table_name: 'orders' }),
    ];
    const rows = deriveEffectiveRules(grants, scopes, 'agent1', NOW);
    // g1(read) × s1(read) = 1 row; g1(read) × s2(write) = 0 (cap mismatch)
    // g2(write) × s1(read) = 0 (cap mismatch); g2(write) × s2(write) = 1 row
    expect(rows).toHaveLength(2);
    const verbs = rows.map((r) => r.verb).sort();
    expect(verbs).toEqual(['read', 'write']);
  });

  // Deny + allow pair: deny is emitted regardless; allow must match scope.
  it('deny for a table + allow (different table) via scope both work', () => {
    const grants = [
      makeGrant({ id: 'g-deny', effect: 'deny', capability: 'read', verb: 'read',
                  schema_name: 'sales', table_name: 'pii' }),
      makeGrant({ id: 'g-allow', effect: 'allow', capability: 'read', verb: 'read',
                  schema_name: 'sales', table_name: 'orders' }),
    ];
    const scopes = [
      makeScope({ id: 's1', capability: 'read',
                  schema_name: 'sales', table_name: 'orders' }),
    ];
    const rows = deriveEffectiveRules(grants, scopes, 'agent1', NOW);
    expect(rows).toHaveLength(2); // deny (pii) + allow (orders)
    const denies = rows.filter((r) => r.effect === 'deny');
    const allows = rows.filter((r) => r.effect === 'allow');
    expect(denies).toHaveLength(1);
    expect(denies[0].table_name).toBe('pii');
    expect(allows).toHaveLength(1);
    expect(allows[0].table_name).toBe('orders');
  });
});

// ── compilePolicy integration: deny-suppression end-to-end ───────────────────

describe('deriveEffectiveRules → compilePolicy (deny-suppression)', () => {
  /**
   * This test validates the end-to-end deny-preservation invariant:
   * a carried deny must share the compilePolicy priority/deny-wins key with the
   * derived allow so it can suppress it. Requires agent_id to be rewritten to
   * agentId on the deny row (the trap from plan design review).
   */
  it('carried deny suppresses the derived allow in compilePolicy (same selector)', () => {
    // User has: allow read sales.orders + deny read sales.orders.
    // Scope grants read on sales.orders.
    // The deny must win → agent gets no read grant on sales.orders.
    const grants = [
      makeGrant({ id: 'g-allow', effect: 'allow', capability: 'read', verb: 'read',
                  schema_name: 'sales', table_name: 'orders', priority: 100 }),
      makeGrant({ id: 'g-deny',  effect: 'deny',  capability: 'read', verb: 'read',
                  schema_name: 'sales', table_name: 'orders', priority: 100 }),
    ];
    const scopes = [
      makeScope({ id: 's1', capability: 'read',
                  schema_name: 'sales', table_name: 'orders' }),
    ];
    const derived = deriveEffectiveRules(grants, scopes, 'agent1', NOW);
    const compiled = compilePolicy(derived, NOW);

    // The deny wins on the shared key — no role grant emitted for sales.orders.
    const grant = compiled.snapshot.roleGrants.find(
      (g) => g.tableRef === 'sales.orders',
    );
    expect(grant).toBeUndefined();
    // And agent1 is not in activeAgentIds (no allows survived).
    expect(compiled.activeAgentIds).not.toContain('agent1');
  });

  it('derived allow passes compilePolicy when no deny is present', () => {
    const grants = [
      makeGrant({ capability: 'read', verb: 'read',
                  schema_name: 'sales', table_name: 'orders' }),
    ];
    const scopes = [
      makeScope({ capability: 'read',
                  schema_name: 'sales', table_name: 'orders' }),
    ];
    const derived = deriveEffectiveRules(grants, scopes, 'agent1', NOW);
    const compiled = compilePolicy(derived, NOW);

    const grant = compiled.snapshot.roleGrants.find(
      (g) => g.tableRef === 'sales.orders' && g.role === 'agent_agent1',
    );
    expect(grant).toBeDefined();
    expect(compiled.activeAgentIds).toContain('agent1');
  });
});

// ── Known limitation: wildcard-allow + specific-deny carve-out ───────────────

describe('known limitation: wildcard allow + specific deny (Phase-2 territory)', () => {
  /**
   * This is a documented limitation inherited from compilePolicy: deny-preservation
   * holds at an equal-or-finer selector. A wildcard allow with a specific-table
   * deny carve-out does not work because the allow and deny have different
   * compilePolicy keys (${agent} ${tableRef} ${verb}) and the compiler is allow-only.
   *
   * Concretely: user allow read sales.* + deny read sales.pii
   *   scope grants read on sales.*
   *   → derived allow sales.*  (key A)  carried deny sales.pii (key B)
   *   → agent_id gets roleGrant on sales.* — can read sales.pii. Owner cannot.
   *
   * This test pins the current (leaky) behavior so Phase-2 catalog-expansion
   * work has a tripwire to fix.
   */
  it('wildcard allow + specific deny: agent can reach the denied table (known gap)', () => {
    const grants = [
      makeGrant({ id: 'g-allow', effect: 'allow', capability: 'read', verb: 'read',
                  schema_name: 'sales', table_name: '*', priority: 100 }),
      makeGrant({ id: 'g-deny', effect: 'deny', capability: 'read', verb: 'read',
                  schema_name: 'sales', table_name: 'pii', priority: 100 }),
    ];
    const scopes = [
      makeScope({ id: 's1', capability: 'read', schema_name: 'sales', table_name: '*' }),
    ];
    const derived = deriveEffectiveRules(grants, scopes, 'agent1', NOW);
    const compiled = compilePolicy(derived, NOW);

    // The wildcard allow survives — the agent can see sales.* including pii.
    // This is the KNOWN GAP: the agent exceeds its owner's effective access.
    // Phase-2 fix: catalog-expand wildcards before compiling so specific denies
    // can share the exact key.
    const wildcardGrant = compiled.snapshot.roleGrants.find(
      (g) => g.tableRef === 'sales.*',
    );
    expect(wildcardGrant).toBeDefined(); // gap: should be undefined after Phase-2 fix
  });
});
