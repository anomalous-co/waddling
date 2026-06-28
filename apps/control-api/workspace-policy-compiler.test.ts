/**
 * Unit tests for compileWorkspaceSnapshot (workspace-policy-compiler.ts).
 *
 * Run: npx vitest run workspace-policy-compiler.test.ts
 *   (from apps/control-api/, using the workspace-level vitest binary)
 *
 * Pure function — no DB. Covers: principal→role membership dedup, multi-action
 * roles, explicit role override, and the assembled /ctrl/snapshot request body.
 */
import { describe, it, expect } from 'vitest';
import {
  compileWorkspaceSnapshot,
  buildWorkspaceSnapshotRequest,
  type WorkspaceGrant,
} from './src/lib/workspace-policy-compiler';

describe('compileWorkspaceSnapshot', () => {
  it('empty grants → empty snapshot', () => {
    const snap = compileWorkspaceSnapshot([]);
    expect(snap.userRoles).toEqual([]);
    expect(snap.roleGrants).toEqual([]);
    expect(snap.roleConstraints).toEqual([]);
  });

  it('single grant → one role + one membership + one grant', () => {
    const grants: WorkspaceGrant[] = [{ userId: 'agent:X', tableRef: 'main.t', action: 'read' }];
    const snap = compileWorkspaceSnapshot(grants);
    expect(snap.userRoles).toEqual([{ userId: 'agent:X', role: 'ws_read_agent_X' }]);
    expect(snap.roleGrants).toEqual([{ role: 'ws_read_agent_X', tableRef: 'main.t', action: 'read' }]);
  });

  it('same principal, two tables same action → one membership, two grants', () => {
    const grants: WorkspaceGrant[] = [
      { userId: 'agent:X', tableRef: 'main.a', action: 'read' },
      { userId: 'agent:X', tableRef: 'main.b', action: 'read' },
    ];
    const snap = compileWorkspaceSnapshot(grants);
    // membership deduped to one (same userId+role)
    expect(snap.userRoles).toHaveLength(1);
    expect(snap.roleGrants).toHaveLength(2);
  });

  it('same principal, two actions → two roles, two memberships', () => {
    const grants: WorkspaceGrant[] = [
      { userId: 'agent:X', tableRef: 'main.t', action: 'read' },
      { userId: 'agent:X', tableRef: 'main.t', action: 'write' },
    ];
    const snap = compileWorkspaceSnapshot(grants);
    expect(snap.userRoles.map((r) => r.role).sort()).toEqual([
      'ws_read_agent_X',
      'ws_write_agent_X',
    ]);
    expect(snap.roleGrants).toHaveLength(2);
  });

  it('explicit role override is honored', () => {
    const grants: WorkspaceGrant[] = [
      { userId: 'agent:X', tableRef: 'main.t', action: 'read', role: 'r1' },
    ];
    const snap = compileWorkspaceSnapshot(grants);
    expect(snap.userRoles).toEqual([{ userId: 'agent:X', role: 'r1' }]);
    expect(snap.roleGrants).toEqual([{ role: 'r1', tableRef: 'main.t', action: 'read' }]);
  });

  it('buildWorkspaceSnapshotRequest assembles snapshot + auth + catalog', () => {
    const req = buildWorkspaceSnapshotRequest(
      [{ userId: 'agent:X', tableRef: 'main.t', action: 'read' }],
      { issuer: 'iss', audience: 'aud', jwks: [{ kid: 'k1', n: 'n', e: 'AQAB' }] },
    );
    expect(req.lakeCatalog).toBe('main');
    expect(req.auth.issuer).toBe('iss');
    expect(req.snapshot.roleGrants).toHaveLength(1);
  });
});
