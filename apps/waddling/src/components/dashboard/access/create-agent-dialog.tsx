'use client';

/**
 * Create-agent dialog — identity fields in the header, the shared AccessManager
 * (mode="create") in the body, and a footer that creates the agent then persists
 * the draft's grants in one POST /api/cp/agents (server fans them out, target
 * defaulting to the new agent).
 *
 * Access at birth (P4): a new key is never born with zero access and an operator
 * left hunting — the same picker used on detail is embedded here.
 *
 * Create-persist is per-grant + best-effort (not transactional): the response
 * carries `grants: [{ datalakeId, sql, ok, error? }]`; partial failures are surfaced.
 */
import { useEffect, useState } from 'react';
import { XIcon, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogClose, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cpPost } from '@/components/dashboard/fetch';
import { AccessManager, type CreateDraft, type DatalakeOption } from './access-manager';
import { authorBody } from './access-draft';
import type { AgentSummary } from '@/lib/types';

interface CreateGrantResult {
  datalakeId: string | null;
  sql: string;
  ok: boolean;
  error?: string;
}

export function CreateAgentDialog({
  open,
  onOpenChange,
  datalakes,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  datalakes: DatalakeOption[];
  onCreated: (agent: AgentSummary, key: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [defaultRole, setDefaultRole] = useState('reader');
  const [agentMode, setAgentMode] = useState<'autonomous' | 'delegated'>('autonomous');
  const [draft, setDraft] = useState<CreateDraft>({ datalakeId: datalakes[0]?.id ?? '', statements: [] });
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
      setDefaultRole('reader');
      setAgentMode('autonomous');
      setDraft({ datalakeId: datalakes[0]?.id ?? '', statements: [] });
      setFieldError(null);
    }
  }, [open, datalakes]);

  const grantCount = draft.statements.length;

  const createAgent = async () => {
    if (!name.trim()) {
      setFieldError('Name is required');
      return;
    }
    setSaving(true);
    setFieldError(null);
    const grants = draft.statements.map((s) => authorBody(s, draft.datalakeId));
    const res = await cpPost<{ agent: AgentSummary; key?: string; grants?: CreateGrantResult[] }>('/api/cp/agents', {
      name,
      description,
      defaultRole,
      mode: agentMode,
      grants,
    });
    setSaving(false);
    if (!res.ok) {
      setFieldError(res.error);
      return;
    }
    const failures = (res.data.grants ?? []).filter((g) => !g.ok);
    onCreated(res.data.agent, res.data.key ?? '');
    if (failures.length) {
      toast.error(`Agent created, but ${failures.length} grant${failures.length > 1 ? 's' : ''} failed to apply`);
    } else {
      toast.success(`Agent "${res.data.agent.name}" created`);
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[88vh] flex-col gap-0 overflow-hidden p-0 top-[6vh] translate-y-0 sm:max-w-[min(1400px,92vw)]"
      >
        {/* header */}
        <div className="relative shrink-0 px-4 pt-4 pb-2 pr-12">
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription className="mt-1">
            Create the agent and grant its initial access in one step.
          </DialogDescription>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor="ca-name" className="text-xs text-muted-foreground">Name</Label>
              <Input id="ca-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="llm-analyst" autoFocus />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="ca-desc" className="text-xs text-muted-foreground">Description</Label>
              <Input id="ca-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="ca-role" className="text-xs text-muted-foreground">Default role</Label>
              <Select value={defaultRole} onValueChange={setDefaultRole}>
                <SelectTrigger id="ca-role" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="reader">reader</SelectItem>
                  <SelectItem value="analyst">analyst</SelectItem>
                  <SelectItem value="writer">writer</SelectItem>
                  <SelectItem value="admin">admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="ca-mode" className="text-xs text-muted-foreground">Mode</Label>
              <Select value={agentMode} onValueChange={(v) => setAgentMode(v as 'autonomous' | 'delegated')}>
                <SelectTrigger id="ca-mode" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="autonomous">autonomous</SelectItem>
                  <SelectItem value="delegated">delegated</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {fieldError && <p className="mt-2 text-sm text-destructive">{fieldError}</p>}
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" className="absolute right-3 top-3" aria-label="Close">
              <XIcon />
            </Button>
          </DialogClose>
        </div>

        {/* body */}
        <div className="min-h-0 flex-1 px-4 py-2">
          <div className="flex h-full flex-col overflow-hidden rounded-lg border bg-background/40 p-3">
            <AccessManager mode="create" fill datalakes={datalakes} draft={draft} onDraftChange={setDraft} />
          </div>
        </div>

        {/* footer */}
        <div className="flex shrink-0 items-center justify-between gap-3 px-4 pt-2 pb-4">
          <span className="text-xs text-muted-foreground">
            {grantCount > 0 ? `${grantCount} grant${grantCount > 1 ? 's' : ''} to create` : 'No initial access (you can add it later)'}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
            <Button onClick={() => void createAgent()} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {saving ? 'Creating…' : 'Create agent'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
