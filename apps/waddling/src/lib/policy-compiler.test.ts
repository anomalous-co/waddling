/**
 * Policy compiler unit tests (vitest-style). W1 owns.
 *
 * NOTE: vitest is not yet a workspace dependency (see W1 report — missing dep).
 * Written runnable: `pnpm --filter @waddling/app exec vitest run src/lib/policy-compiler.test.ts`
 * once `vitest` is installed.
 */
import { describe, it, expect } from 'vitest';
import {
  compilePolicy,
  isRuleActive,
  grantsForAgent,
  birdshotRoleName,
  birdshotPrincipal,
  type AclRuleRow,
} from './policy-compiler';

const base: Omit<AclRuleRow, 'id' | 'verb' | 'effect'> = {
  org_id: 'org1',
  endpoint_id: 'ep1',
  agent_id: 'a1',
  schema_name: 'sales',
  table_name: 'orders',
  columns: null,
  row_limit: null,
  ttl_seconds: null,
  window_start: null,
  window_end: null,
  not_before: null,
  expires_at: null,
  priority: 100,
};

function rule(p: Partial<AclRuleRow>): AclRuleRow {
  return { id: crypto.randomUUID(), verb: 'read', effect: 'allow', ...base, ...p };
}

const NOW = new Date('2026-06-12T12:00:00Z');

describe('isRuleActive', () => {
  it('honors not_before / expires_at', () => {
    expect(isRuleActive(rule({ not_before: '2026-06-13T00:00:00Z' }), NOW)).toBe(false);
    expect(isRuleActive(rule({ expires_at: '2026-06-12T00:00:00Z' }), NOW)).toBe(false);
    expect(isRuleActive(rule({ expires_at: '2026-06-13T00:00:00Z' }), NOW)).toBe(true);
  });
  it('honors UTC time-of-day window (incl. overnight wrap)', () => {
    expect(isRuleActive(rule({ window_start: '09:00', window_end: '17:00' }), NOW)).toBe(true);
    expect(isRuleActive(rule({ window_start: '13:00', window_end: '17:00' }), NOW)).toBe(false);
    // overnight 22:00→06:00, now 12:00 ⇒ closed
    expect(isRuleActive(rule({ window_start: '22:00', window_end: '06:00' }), NOW)).toBe(false);
    // overnight 22:00→13:00, now 12:00 ⇒ open
    expect(isRuleActive(rule({ window_start: '22:00', window_end: '13:00' }), NOW)).toBe(true);
  });
});

describe('compilePolicy — birdshot snapshot (§3e)', () => {
  it('emits add_user_role + add_role_grant for an allow rule', () => {
    const r = compilePolicy([rule({ verb: 'read' })], NOW);
    expect(r.snapshot.userRoles).toEqual([
      { userId: birdshotPrincipal('a1'), role: birdshotRoleName('a1') },
    ]);
    expect(r.snapshot.roleGrants).toEqual([
      { role: 'agent_a1', tableRef: 'sales.orders', action: 'read' },
    ]);
    expect(r.constraints).toEqual([]);
  });

  it('omits the grant for a deny rule (default-deny)', () => {
    const r = compilePolicy(
      [rule({ verb: 'write', effect: 'deny' })],
      NOW,
    );
    expect(r.snapshot.roleGrants).toEqual([]);
    expect(r.snapshot.userRoles).toEqual([]);
  });

  it('deny wins over allow at the same selector/priority', () => {
    const r = compilePolicy(
      [rule({ effect: 'allow' }), rule({ effect: 'deny' })],
      NOW,
    );
    expect(r.snapshot.roleGrants).toEqual([]);
  });

  it('lower priority wins (stronger)', () => {
    const r = compilePolicy(
      [
        rule({ effect: 'deny', priority: 100 }),
        rule({ effect: 'allow', priority: 10 }),
      ],
      NOW,
    );
    expect(r.snapshot.roleGrants).toEqual([
      { role: 'agent_a1', tableRef: 'sales.orders', action: 'read' },
    ]);
  });

  it('drops temporally-inactive rules', () => {
    const r = compilePolicy(
      [rule({ expires_at: '2026-06-12T00:00:00Z' })],
      NOW,
    );
    expect(r.snapshot.roleGrants).toEqual([]);
  });

  it('dedupes grants and user-role for multiple rules on same agent', () => {
    const r = compilePolicy(
      [
        rule({ verb: 'read', table_name: 'orders' }),
        rule({ verb: 'read', table_name: 'orders' }),
        rule({ verb: 'write', table_name: 'events' }),
      ],
      NOW,
    );
    expect(r.snapshot.userRoles).toHaveLength(1);
    expect(r.snapshot.roleGrants).toHaveLength(2);
  });
});

describe('compilePolicy — gateway constraints (§3d)', () => {
  it('emits a constraint for column allow-list', () => {
    const r = compilePolicy(
      [rule({ table_name: 'customers', columns: ['id', 'name'] })],
      NOW,
    );
    expect(r.constraints).toEqual([
      {
        agentId: 'a1',
        schema: 'sales',
        table: 'customers',
        columns: ['id', 'name'],
        rowLimit: undefined,
        window: undefined,
        notBefore: undefined,
        expiresAt: undefined,
      },
    ]);
    // birdshot still gets the table-level grant (backstop)
    expect(r.snapshot.roleGrants).toEqual([
      { role: 'agent_a1', tableRef: 'sales.customers', action: 'read' },
    ]);
  });

  it('emits rowLimit + window constraints', () => {
    const r = compilePolicy(
      [rule({ row_limit: 100, window_start: '09:00', window_end: '17:00' })],
      NOW,
    );
    expect(r.constraints[0].rowLimit).toBe(100);
    expect(r.constraints[0].window).toEqual({ start: '09:00', end: '17:00' });
  });
});

describe('grantsForAgent', () => {
  it('builds a SessionGrant merging verbs + constraints', () => {
    const r = compilePolicy(
      [
        rule({ verb: 'read', table_name: 'orders' }),
        rule({ verb: 'write', table_name: 'orders' }),
        rule({ verb: 'read', table_name: 'customers', columns: ['id'], row_limit: 50 }),
      ],
      NOW,
    );
    const g = grantsForAgent(r, 'a1');
    const orders = g.tables.find((t) => t.table === 'orders');
    const customers = g.tables.find((t) => t.table === 'customers');
    expect(orders?.verbs.sort()).toEqual(['read', 'write']);
    expect(customers?.columns).toEqual(['id']);
    expect(customers?.rowLimit).toBe(50);
  });
});
