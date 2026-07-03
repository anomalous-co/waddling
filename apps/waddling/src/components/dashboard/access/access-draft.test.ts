/**
 * access-draft unit tests (vitest-style).
 * Run: `pnpm --filter @waddling/app exec vitest run src/components/dashboard/access/access-draft.test.ts`
 *
 * Covers the two correctness-critical pure functions — `emitStatement` (the single
 * grammar the string-identity diff depends on) and `diffDraft` — plus the tree
 * provenance resolver `nodeStatus`.
 */
import { describe, it, expect } from 'vitest';
import {
  emitStatement,
  diffDraft,
  nodeStatus,
  factFromParsed,
  type DraftStatement,
  type GrantFact,
  type ParsedStatement,
} from './access-draft';

const agent = { kind: 'agent', agentId: 'a1' } as const;

describe('emitStatement', () => {
  it('emits a table grant', () => {
    expect(
      emitStatement({
        kind: 'object',
        effect: 'allow',
        privileges: ['SELECT'],
        object: { schema: 'analytics', table: 'events' },
        grantee: agent,
      }),
    ).toBe('GRANT SELECT ON analytics.events TO agent:a1');
  });

  it('emits ALL TABLES IN SCHEMA for a schema wildcard', () => {
    expect(
      emitStatement({
        kind: 'object',
        effect: 'allow',
        privileges: ['SELECT'],
        object: { schema: 'analytics', allTables: true },
        grantee: agent,
      }),
    ).toBe('GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO agent:a1');
  });

  it('appends columns to each privilege', () => {
    expect(
      emitStatement({
        kind: 'object',
        effect: 'allow',
        privileges: ['SELECT'],
        columns: ['id', 'created_at'],
        object: { schema: 'analytics', table: 'orders' },
        grantee: agent,
      }),
    ).toBe('GRANT SELECT (id, created_at) ON analytics.orders TO agent:a1');
  });

  it('emits DENY for a deny effect', () => {
    expect(
      emitStatement({
        kind: 'object',
        effect: 'deny',
        privileges: ['SELECT'],
        object: { schema: 'analytics', table: 'pii' },
        grantee: agent,
      }),
    ).toBe('DENY SELECT ON analytics.pii TO agent:a1');
  });

  it('emits ROLE and PUBLIC grantees', () => {
    expect(
      emitStatement({
        kind: 'object',
        effect: 'allow',
        privileges: ['SELECT'],
        object: { schema: 'analytics', table: 'sessions' },
        grantee: { kind: 'role', role: 'analyst' },
      }),
    ).toBe('GRANT SELECT ON analytics.sessions TO ROLE analyst');
    expect(
      emitStatement({
        kind: 'object',
        effect: 'allow',
        privileges: ['USAGE'],
        object: { schema: 'analytics', table: 'public_report' },
        grantee: { kind: 'public' },
      }),
    ).toBe('GRANT USAGE ON analytics.public_report TO PUBLIC');
  });

  it('emits role membership without ON', () => {
    expect(emitStatement({ kind: 'membership', role: 'analyst', grantee: agent })).toBe(
      'GRANT analyst TO agent:a1',
    );
  });
});

describe('diffDraft', () => {
  const row = (sql: string, id?: string): DraftStatement => ({ sql, parsed: null, id });

  it('detects additions and removals by string identity', () => {
    const existing = [row('GRANT SELECT ON a.b TO agent:a1', 'r1'), row('DENY SELECT ON a.c TO agent:a1', 'r2')];
    const draft = [row('GRANT SELECT ON a.b TO agent:a1', 'r1'), row('GRANT INSERT ON a.d TO agent:a1')];
    const diff = diffDraft(existing, draft);
    expect(diff.added.map((s) => s.sql)).toEqual(['GRANT INSERT ON a.d TO agent:a1']);
    expect(diff.removed).toEqual([{ id: 'r2', sql: 'DENY SELECT ON a.c TO agent:a1' }]);
  });

  it('is a no-op when drafts match', () => {
    const existing = [row('GRANT SELECT ON a.b TO agent:a1', 'r1')];
    const diff = diffDraft(existing, [row('GRANT SELECT ON a.b TO agent:a1', 'r1')]);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it('never tries to delete an unpersisted row', () => {
    const existing = [row('GRANT SELECT ON a.b TO agent:a1')]; // no id
    const diff = diffDraft(existing, []);
    expect(diff.removed).toHaveLength(0);
  });
});

describe('nodeStatus', () => {
  const parsed = (
    effect: 'allow' | 'deny',
    object: ParsedStatement['object'],
    privileges: string[] = ['SELECT'],
  ): ParsedStatement => ({
    kind: 'object',
    effect,
    action: effect,
    privileges,
    columns: null,
    object,
    grantee: { kind: 'subject', name: 'agent:a1' },
  });

  const fact = (p: ParsedStatement, inh: Parameters<typeof factFromParsed>[1] = null): GrantFact =>
    factFromParsed(p, inh)!;

  it('reports none when nothing matches', () => {
    expect(nodeStatus([], 'analytics', 'events')).toEqual({ status: 'none' });
  });

  it('reports allowed-direct for an exact table grant', () => {
    const facts = [fact(parsed('allow', { schema: 'analytics', table: 'events' }))];
    expect(nodeStatus(facts, 'analytics', 'events')).toMatchObject({ status: 'allowed', via: 'direct' });
  });

  it('reports allowed-via-schema for a wildcard covering the table', () => {
    const facts = [fact(parsed('allow', { schema: 'analytics', allTables: true }))];
    expect(nodeStatus(facts, 'analytics', 'events')).toMatchObject({ status: 'allowed', via: 'schema' });
  });

  it('reports allowed-via-role for a role-inherited grant', () => {
    const facts = [fact(parsed('allow', { schema: 'analytics', table: 'sessions' }), { via: 'role', role: 'analyst' })];
    expect(nodeStatus(facts, 'analytics', 'sessions')).toMatchObject({ status: 'allowed', via: 'role', role: 'analyst' });
  });

  it('reports a carve-out when a table deny sits under a schema allow', () => {
    const facts = [
      fact(parsed('allow', { schema: 'analytics', allTables: true })),
      fact(parsed('deny', { schema: 'analytics', table: 'pii' })),
    ];
    expect(nodeStatus(facts, 'analytics', 'pii')).toMatchObject({ status: 'denied', via: 'carve-out' });
  });

  it('reports an explicit deny with no broader allow', () => {
    const facts = [fact(parsed('deny', { schema: 'analytics', table: 'pii' }))];
    expect(nodeStatus(facts, 'analytics', 'pii')).toMatchObject({ status: 'denied', via: 'direct' });
  });
});
