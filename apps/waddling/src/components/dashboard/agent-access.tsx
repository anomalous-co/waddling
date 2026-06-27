'use client';

/**
 * Agent access (detail page Access section) — the editor IS the view. We render
 * the catalog-aware AccessEditor inline (no read-only table, no modal), load the
 * agent's current grants/policies into it, and expose an inline Save that diffs
 * against what was loaded and issues the minimal POST/DELETE. Removing access is
 * gated behind a confirm, same as before — just without a popup to get here.
 */
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { fetchCp, cpPost, cpDelete } from '@/components/dashboard/fetch';
import { AccessEditor } from '@/components/dashboard/access-editor';
import { SectionHeader } from '@/components/dashboard/agent/kit';
import {
  diffAccess, modelFromExisting, mergeGrants, policyKindFor,
  type AccessModel, type ExistingRule, type ExistingPolicy,
} from '@/lib/access-diff';

interface AclRuleRow { id: string; datalakeId: string; capability: string; schemaName: string; tableName: string }
interface AclPolicyRow { id: string; datalakeId?: string; capability: string; pattern: string }

export function AgentAccess({ agentId, proposed }: { agentId: string; proposed?: AccessModel | null }) {
  const [model, setModel] = useState<AccessModel>({ grants: [], policies: [] });
  const [initialRules, setInitialRules] = useState<ExistingRule[]>([]);
  const [initialPolicies, setInitialPolicies] = useState<ExistingPolicy[]>([]);
  const [datalakes, setDatalakes] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Overlay the requested-access proposal (from the deep link) onto the loaded grants
  // exactly once, so it surfaces as a pending diff. Re-loads after a save reflect the
  // persisted state without re-injecting the proposal.
  const proposalApplied = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [aclRes, polRes, lakesRes] = await Promise.all([
      fetchCp<{ rules: AclRuleRow[] }>(`/api/cp/acl?agentId=${agentId}`),
      fetchCp<{ policies: AclPolicyRow[] }>(`/api/cp/acl-policy?agentId=${agentId}`),
      fetchCp<{ datalakes: { id: string; name: string }[] }>('/api/cp/datalakes'),
    ]);
    if (!aclRes.ok) { setError(aclRes.error); setLoading(false); return; }
    const rules: ExistingRule[] = aclRes.data.rules
      .filter((r) => r.capability)
      .map((r) => ({ id: r.id, datalakeId: r.datalakeId, schema: r.schemaName, table: r.tableName, capability: r.capability }));
    const policies: ExistingPolicy[] = (polRes.ok ? polRes.data.policies : []).map((p) => ({
      id: p.id, datalakeId: p.datalakeId, capability: p.capability, pattern: p.pattern,
    }));
    setInitialRules(rules);
    setInitialPolicies(policies);
    const base = modelFromExisting(rules, policies);
    if (proposed && !proposalApplied.current) {
      proposalApplied.current = true;
      setModel({ grants: mergeGrants(base.grants, proposed.grants), policies: base.policies });
    } else {
      setModel(base);
    }
    if (lakesRes.ok) setDatalakes(lakesRes.data.datalakes.map((d) => ({ id: d.id, name: d.name })));
    setError(null);
    setLoading(false);
  }, [agentId, proposed]);

  useEffect(() => { void load(); }, [load]);

  const diff = useMemo(
    () => diffAccess(initialRules, initialPolicies, model),
    [initialRules, initialPolicies, model],
  );
  const additions = diff.createRules.length + diff.createPolicies.length;
  const removals = diff.deleteRuleIds.length + diff.deletePolicyIds.length;
  const changeCount = additions + removals;
  const summary = changeCount === 0
    ? 'No unsaved changes'
    : [additions ? `+${additions}` : '', removals ? `−${removals}` : ''].filter(Boolean).join('  ') +
      `  (${changeCount} change${changeCount > 1 ? 's' : ''})`;

  const applyDiff = async () => {
    setSaving(true);
    let failed = 0;
    for (const r of diff.createRules) {
      const res = await cpPost('/api/cp/acl', {
        datalakeId: r.datalakeId, agentId, subjectKind: 'agent',
        capability: r.capability, schema: r.schema, table: r.table,
      });
      if (!res.ok) failed++;
    }
    for (const id of diff.deleteRuleIds) { if (!(await cpDelete(`/api/cp/acl/${id}`)).ok) failed++; }
    for (const p of diff.createPolicies) {
      const res = await cpPost('/api/cp/acl-policy', {
        datalakeId: p.datalakeId || undefined, agentId, subjectKind: 'agent',
        policyKind: policyKindFor(p.capability), capability: p.capability, pattern: p.pattern,
      });
      if (!res.ok) failed++;
    }
    for (const id of diff.deletePolicyIds) { if (!(await cpDelete(`/api/cp/acl-policy/${id}`)).ok) failed++; }
    setSaving(false);
    if (failed) toast.error(`${failed} change(s) failed`);
    else toast.success(`Access updated (${changeCount} change${changeCount > 1 ? 's' : ''})`);
    await load();
  };

  const onSave = () => {
    if (changeCount === 0) return;
    if (removals > 0) { setConfirmOpen(true); return; } // gate reductions
    void applyDiff();
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 pt-1">
      <SectionHeader
        title="Access"
        action={
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">{summary}</span>
            <Button size="sm" onClick={onSave} disabled={saving || changeCount === 0}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {saving ? 'Saving…' : changeCount ? `Save ${changeCount} change${changeCount > 1 ? 's' : ''}` : 'Save'}
            </Button>
          </div>
        }
      />

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading access…</p>
      ) : error ? (
        <div className="flex items-center gap-2 text-sm text-destructive">
          {error}
          <Button size="sm" variant="ghost" onClick={() => { void load(); }}>
            <RefreshCw className="size-3.5" /> Retry
          </Button>
        </div>
      ) : datalakes.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No data lakes yet — create one before scoping this agent.
        </p>
      ) : (
        <div className="min-h-0 flex-1">
          <AccessEditor
            datalakes={datalakes}
            value={model}
            onChange={setModel}
            defaultDatalakeId={proposed?.grants[0]?.datalakeId}
          />
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove access?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes {removals} grant{removals > 1 ? 's' : ''}
              {additions ? ` (and adds ${additions})` : ''}. Removing access takes effect immediately
              and can interrupt anything the agent is doing. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmOpen(false); void applyDiff(); }}>
              Yes, apply {changeCount} change{changeCount > 1 ? 's' : ''}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
