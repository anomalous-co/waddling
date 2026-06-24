'use client';

/**
 * The access editor MODAL — a fixed-height, top-anchored dialog whose chrome stays
 * put while the body scrolls:
 *
 *   ┌ header (title, the X, + create-mode fields) ───────────────┐
 *   │ ┌ rounded scroll container ──────────────────────────────┐ │
 *   │ │  [section nav] │ [active section content — scrolls]    │ │
 *   │ └────────────────────────────────────────────────────────┘ │
 *   └ footer (pending-change summary · Cancel · Save N changes) ──┘
 *
 * Footer + X live OUTSIDE the scroll container (always reachable). The primary
 * button shows the pending-edit count; if a save REMOVES access, a confirm
 * AlertDialog gates it. Used for both creating an agent and editing one's access.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { XIcon, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogClose, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { fetchCp, cpPost, cpDelete } from '@/components/dashboard/fetch';
import { AccessEditor } from '@/components/dashboard/access-editor';
import {
  diffAccess, modelFromExisting, flattenGrants, policyKindFor,
  type AccessModel, type ExistingRule, type ExistingPolicy,
} from '@/lib/access-diff';
import type { AgentSummary } from '@/lib/types';

interface AclRuleRow { id: string; datalakeId: string; capability: string; schemaName: string; tableName: string }
interface AclPolicyRow { id: string; datalakeId?: string; capability: string; pattern: string }

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  datalakes: { id: string; name: string }[];
} & (
  | { mode: 'edit'; agentId: string; agentName?: string; onSaved: () => void }
  | { mode: 'create'; onCreated: (agent: AgentSummary, key: string) => void }
);

const EMPTY: AccessModel = { grants: [], policies: [] };

export function AccessEditorDialog(props: Props) {
  const { open, onOpenChange, datalakes, mode } = props;
  const [model, setModel] = useState<AccessModel>(EMPTY);
  const [initialRules, setInitialRules] = useState<ExistingRule[]>([]);
  const [initialPolicies, setInitialPolicies] = useState<ExistingPolicy[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // create-mode fields
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [defaultRole, setDefaultRole] = useState('reader');
  const [agentMode, setAgentMode] = useState<'autonomous' | 'delegated'>('autonomous');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const agentId = props.mode === 'edit' ? props.agentId : undefined;

  const seed = useCallback(async () => {
    if (mode === 'create') {
      setModel(EMPTY); setInitialRules([]); setInitialPolicies([]);
      setName(''); setDescription(''); setDefaultRole('reader'); setAgentMode('autonomous'); setFieldError(null);
      return;
    }
    setLoading(true);
    const [aclRes, polRes] = await Promise.all([
      fetchCp<{ rules: AclRuleRow[] }>(`/api/cp/acl?agentId=${agentId}`),
      fetchCp<{ policies: AclPolicyRow[] }>(`/api/cp/acl-policy?agentId=${agentId}`),
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
    setModel(modelFromExisting(rules, policies));
    setError(null);
    setLoading(false);
  }, [mode, agentId]);

  useEffect(() => { if (open) void seed(); }, [open, seed]);

  const diff = useMemo(
    () => diffAccess(initialRules, initialPolicies, model),
    [initialRules, initialPolicies, model],
  );
  const additions = diff.createRules.length + diff.createPolicies.length;
  const removals = diff.deleteRuleIds.length + diff.deletePolicyIds.length;
  const changeCount = additions + removals;

  const summary = mode === 'create'
    ? (additions ? `${additions} grant${additions > 1 ? 's' : ''} to create` : 'No initial access (you can add it later)')
    : changeCount === 0
      ? 'No changes'
      : [additions ? `+${additions}` : '', removals ? `−${removals}` : ''].filter(Boolean).join('  ') +
        `  (${changeCount} change${changeCount > 1 ? 's' : ''})`;

  // ── persistence ───────────────────────────────────────────────────────────────
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
    if (props.mode === 'edit') props.onSaved();
    onOpenChange(false);
  };

  const onSaveClick = () => {
    if (changeCount === 0) return;
    if (removals > 0) { setConfirmOpen(true); return; } // gate reductions
    void applyDiff();
  };

  const createAgent = async () => {
    if (!name.trim()) { setFieldError('Name is required'); return; }
    setSaving(true);
    setFieldError(null);
    const grants = flattenGrants(model.grants).map((r) => ({
      datalakeId: r.datalakeId, capability: r.capability, schema: r.schema, table: r.table,
    }));
    const res = await cpPost<{ agent: AgentSummary; key?: string; apiKey?: string; agentId?: string }>(
      '/api/cp/agents', { name, description, defaultRole, mode: agentMode, grants },
    );
    if (!res.ok) { setSaving(false); setFieldError(res.error); return; }
    const newId = res.data.agentId ?? res.data.agent.id;
    const policies = model.policies.filter((p) => p.pattern.trim());
    let policyFails = 0;
    for (const p of policies) {
      const pr = await cpPost('/api/cp/acl-policy', {
        datalakeId: p.datalakeId || undefined, agentId: newId, subjectKind: 'agent',
        policyKind: policyKindFor(p.capability), capability: p.capability, pattern: p.pattern,
      });
      if (!pr.ok) policyFails++;
    }
    setSaving(false);
    if (props.mode === 'create') props.onCreated(res.data.agent, res.data.key ?? res.data.apiKey ?? '');
    if (policyFails) toast.error(`Agent created, but ${policyFails} source policy(ies) failed`);
    else toast.success(`Agent "${res.data.agent.name}" created`);
    onOpenChange(false);
  };

  const title = props.mode === 'create'
    ? 'New agent'
    : `Edit access${props.agentName ? ` — ${props.agentName}` : ''}`;
  const primaryLabel = mode === 'create'
    ? (saving ? 'Creating…' : 'Create agent')
    : (saving ? 'Saving…' : changeCount ? `Save ${changeCount} change${changeCount > 1 ? 's' : ''}` : 'Save');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[88vh] flex-col gap-0 overflow-hidden p-0 top-[6vh] translate-y-0 sm:max-w-[min(1400px,92vw)]"
      >
        {/* header */}
        <div className="relative shrink-0 px-4 pt-4 pb-2 pr-12">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="mt-1">
            {mode === 'create' ? 'Create the agent and grant its initial access in one step.' : 'Grant, expand, or revoke this agent’s access. Changes apply on save.'}
          </DialogDescription>
          {mode === 'create' && (
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="flex flex-col gap-1">
                <Label htmlFor="ae-name" className="text-xs text-muted-foreground">Name</Label>
                <Input id="ae-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="llm-analyst" autoFocus />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="ae-desc" className="text-xs text-muted-foreground">Description</Label>
                <Input id="ae-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="ae-role" className="text-xs text-muted-foreground">Default role</Label>
                <Select value={defaultRole} onValueChange={setDefaultRole}>
                  <SelectTrigger id="ae-role" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="reader">reader</SelectItem>
                    <SelectItem value="analyst">analyst</SelectItem>
                    <SelectItem value="writer">writer</SelectItem>
                    <SelectItem value="admin">admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="ae-mode" className="text-xs text-muted-foreground">Mode</Label>
                <Select value={agentMode} onValueChange={(v) => setAgentMode(v as 'autonomous' | 'delegated')}>
                  <SelectTrigger id="ae-mode" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="autonomous">autonomous</SelectItem>
                    <SelectItem value="delegated">delegated</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          {fieldError && <p className="mt-2 text-sm text-destructive">{fieldError}</p>}
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" className="absolute right-3 top-3" aria-label="Close">
              <XIcon />
            </Button>
          </DialogClose>
        </div>

        {/* body — rounded scroll container */}
        <div className="min-h-0 flex-1 px-4 py-2">
          <div className="h-full overflow-hidden rounded-lg border bg-background/40 p-3">
            {loading ? (
              <p className="p-2 text-sm text-muted-foreground">Loading access…</p>
            ) : error ? (
              <p className="p-2 text-sm text-destructive">{error}</p>
            ) : (
              <AccessEditor datalakes={datalakes} value={model} onChange={setModel} />
            )}
          </div>
        </div>

        {/* footer — outside the scroll container, always reachable */}
        <div className="flex shrink-0 items-center justify-between gap-3 px-4 pt-2 pb-4">
          <span className="text-xs text-muted-foreground">{summary}</span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
            {mode === 'create' ? (
              <Button onClick={() => void createAgent()} disabled={saving}>{primaryLabel}</Button>
            ) : (
              <Button onClick={onSaveClick} disabled={saving || changeCount === 0}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                {primaryLabel}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>

      {/* confirm gate for reductions */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove access?</AlertDialogTitle>
            <AlertDialogDescription>
              This save removes {removals} grant{removals > 1 ? 's' : ''} from this agent
              {additions ? ` (and adds ${additions})` : ''}. Removing access takes effect immediately and
              can interrupt anything the agent is doing. Continue?
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
    </Dialog>
  );
}
