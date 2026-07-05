/**
 * Unit test for parseStatement (lib/grant-parse). Round-trips EVERY shape the grant-store
 * builders emit (build → parse → assert fields) plus hand-written variants and null-cases, so
 * "null is safe + lossless" is proven, not assumed.
 *
 * Run:  npx tsx apps/control-api/src/lib/grant-parse.test.ts   (from repo root)
 */
import assert from 'node:assert/strict';
import { parseStatement, type ParsedStatement } from './grant-parse';
import { grant, deny, revoke, undeny, grantRole, revokeRole } from './grant-store';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}: ${(e as Error).message}`);
  }
}
function eq(sql: string, expected: Partial<ParsedStatement>) {
  const p = parseStatement(sql);
  assert.ok(p, `expected parse, got null for: ${sql}`);
  for (const [k, v] of Object.entries(expected)) {
    assert.deepEqual((p as Record<string, unknown>)[k], v, `field ${k} for: ${sql}`);
  }
}
function isNull(sql: string) {
  assert.equal(parseStatement(sql), null, `expected null for: ${sql}`);
}

// ── round-trip: builder emits → parser decomposes ──
check('grant SELECT to ROLE', () => {
  const s = grant({ privileges: ['SELECT'], on: 'sales.orders', to: { role: 'analyst' } });
  assert.equal(s, 'GRANT SELECT ON sales.orders TO ROLE analyst');
  eq(s, {
    kind: 'object', effect: 'allow', action: 'grant',
    privileges: ['SELECT'], columns: null,
    object: { schema: 'sales', table: 'orders' },
    grantee: { kind: 'role', name: 'analyst' },
  });
});

check('grant multi-priv + shared columns to agent subject', () => {
  const s = grant({ privileges: ['SELECT'], columns: ['id', 'created_at'], on: 'analytics.orders', to: { subject: 'agent:123' } });
  assert.equal(s, 'GRANT SELECT (id, created_at) ON analytics.orders TO agent:123');
  eq(s, {
    kind: 'object', effect: 'allow', action: 'grant',
    privileges: ['SELECT'], columns: ['id', 'created_at'],
    object: { schema: 'analytics', table: 'orders' },
    grantee: { kind: 'subject', name: 'agent:123' },
  });
});

check('grant two privileges (no columns)', () => {
  const s = grant({ privileges: ['INSERT', 'UPDATE', 'DELETE'], on: 'staging.orders', to: { subject: 'agent:a' } });
  eq(s, { privileges: ['INSERT', 'UPDATE', 'DELETE'], columns: null, object: { schema: 'staging', table: 'orders' } });
});

check('grant on ALL TABLES IN SCHEMA to PUBLIC', () => {
  const s = grant({ privileges: ['SELECT'], on: 'ALL TABLES IN SCHEMA analytics', to: 'public' });
  assert.equal(s, 'GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO PUBLIC');
  eq(s, {
    kind: 'object', effect: 'allow', action: 'grant',
    object: { schema: 'analytics', allTables: true },
    grantee: { kind: 'public', name: 'PUBLIC' },
  });
});

check('deny → effect deny / action deny', () => {
  const s = deny({ privileges: ['SELECT'], on: 'analytics.pii', to: { subject: 'agent:123' } });
  assert.equal(s, 'DENY SELECT ON analytics.pii TO agent:123');
  eq(s, { kind: 'object', effect: 'deny', action: 'deny', object: { schema: 'analytics', table: 'pii' } });
});

check('revoke → allow-family / FROM', () => {
  const s = revoke({ privileges: ['SELECT'], on: 'sales.orders', to: { role: 'analyst' } });
  assert.equal(s, 'REVOKE SELECT ON sales.orders FROM ROLE analyst');
  eq(s, { kind: 'object', effect: 'allow', action: 'revoke', grantee: { kind: 'role', name: 'analyst' } });
});

check('undeny → deny-family / FROM', () => {
  const s = undeny({ privileges: ['SELECT'], on: 'sales.pii', to: { role: 'analyst' } });
  assert.equal(s, 'UNDENY SELECT ON sales.pii FROM ROLE analyst');
  eq(s, { kind: 'object', effect: 'deny', action: 'undeny' });
});

check('membership grant (GRANT <role> TO <subject>)', () => {
  const s = grantRole('analyst', 'agent:123');
  assert.equal(s, 'GRANT analyst TO agent:123');
  eq(s, {
    kind: 'membership', effect: 'allow', action: 'grant',
    privileges: [], columns: null, object: null,
    role: 'analyst', grantee: { kind: 'subject', name: 'agent:123' },
  });
});

check('membership revoke (REVOKE ROLE <role> FROM <subject>)', () => {
  const s = revokeRole('analyst', 'agent:123');
  assert.equal(s, 'REVOKE ROLE analyst FROM agent:123');
  eq(s, { kind: 'membership', effect: 'allow', action: 'revoke', role: 'analyst', grantee: { kind: 'subject', name: 'agent:123' } });
});

// ── hand-written variants ──
check('trailing semicolon tolerated', () => {
  eq('GRANT SELECT ON sales.orders TO ROLE analyst;', { privileges: ['SELECT'], grantee: { kind: 'role', name: 'analyst' } });
});
check('lowercase keywords tolerated', () => {
  eq('grant select on sales.orders to public', { effect: 'allow', privileges: ['SELECT'], grantee: { kind: 'public', name: 'PUBLIC' } });
});
check('3-part object → lossless raw fallback (not null)', () => {
  eq('GRANT SELECT ON cat.sch.tbl TO agent:1', {
    kind: 'object', privileges: ['SELECT'], object: { raw: 'cat.sch.tbl' },
  });
});

// ── null-cases (must be null: safe + lossless) ──
check('differing per-privilege columns → null', () => isNull('GRANT SELECT (a), INSERT (b) ON s.t TO agent:1'));
check('mixed some-cols/some-none → null', () => isNull('GRANT SELECT (a), INSERT ON s.t TO agent:1'));
check('no TO/FROM connector → null', () => isNull('GRANT SELECT ON s.t'));
check('exotic ALTER DEFAULT PRIVILEGES → null', () => isNull('ALTER DEFAULT PRIVILEGES IN SCHEMA s GRANT SELECT ON TABLES TO r'));
check('empty string → null', () => isNull('   '));
check('keyword/connector mismatch (GRANT … FROM) → null', () => isNull('GRANT SELECT ON s.t FROM ROLE r'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
