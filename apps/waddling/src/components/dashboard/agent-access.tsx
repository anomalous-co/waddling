'use client';

/**
 * In-place scope editor for an agent — the "expand / restrict / continue" surface.
 *
 * Shows the agent's current access (direct acl_rule grants) and lets an admin add
 * tables (catalog-aware), change a grant's capability/columns, extend or clear its
 * expiry (continuation), or revoke it — all without leaving the agent, and each
 * recompiling + pushing to the gateway. Catalog-driven, so a non-matching grant is
 * not constructable.
 */
import { useEffect, useState, useCallback } from 'react';
import { Plus, Trash2, Pencil, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import {
  Card, CardHeader, CardTitle, CardDescription, CardContent,
} from '@/components/ui/card';
import {
  Table, TableHeader, TableRow, TableHead, TableBody, TableCell,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { fetchCp, cpPost, cpPatch, cpDelete } from '@/components/dashboard/fetch';
import { ScopePicker, SCOPE_CAPABILITIES, type GrantRow, type Capability } from '@/components/dashboard/scope-picker';

interface AclRule {
  id: string;
  datalakeId: string;
  capability: Capability | string;
  schemaName: string;
  tableName: string;
  columns?: string[];
  effect: 'allow' | 'deny';
  rowLimit?: number;
  expiresAt?: string;
}

function targetLabel(r: AclRule): string {
  if (r.schemaName === '*') return 'entire lake';
  if (r.tableName === '*') return `${r.schemaName}.* (whole schema)`;
  return `${r.schemaName}.${r.tableName}`;
}

function expiryLabel(r: AclRule): string {
  if (!r.expiresAt) return '—';
  const d = new Date(r.expiresAt);
  const past = d.getTime() < Date.now();
  return `${past ? 'expired ' : ''}${d.toLocaleDateString()}`;
}

export function AgentAccess({ agentId }: { agentId: string }) {
  const [rules, setRules] = useState<AclRule[]>([]);
  const [datalakes, setDatalakes] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<AclRule | null>(null);

  const load = useCallback(async () => {
    const [aclRes, lakesRes] = await Promise.all([
      fetchCp<{ rules: AclRule[] }>(`/api/cp/acl?agentId=${agentId}`),
      fetchCp<{ datalakes: { id: string; name: string }[] }>('/api/cp/datalakes'),
    ]);
    if (!aclRes.ok) setError(aclRes.error);
    else {
      setRules(aclRes.data.rules.filter((r) => r.capability)); // agent-subject rules
      setError(null);
    }
    if (lakesRes.ok) setDatalakes(lakesRes.data.datalakes.map((d) => ({ id: d.id, name: d.name })));
    setLoading(false);
  }, [agentId]);

  useEffect(() => { void load(); }, [load]);

  const lakeName = (id: string) => datalakes.find((d) => d.id === id)?.name ?? id.slice(0, 8);

  const remove = async (r: AclRule) => {
    const res = await cpDelete(`/api/cp/acl/${r.id}`);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success('Access removed');
    void load();
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <div>
          <CardTitle>Access</CardTitle>
          <CardDescription>Tables and capabilities this agent is granted.</CardDescription>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)} disabled={datalakes.length === 0}>
          <Plus className="size-3.5" /> Add access
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <div className="flex items-center gap-2 text-sm text-destructive">
            {error}
            <Button size="sm" variant="ghost" onClick={() => { setLoading(true); void load(); }}>
              <RefreshCw className="size-3.5" /> Retry
            </Button>
          </div>
        ) : rules.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No access yet</EmptyTitle>
              <EmptyDescription>This agent can&apos;t reach any data until you grant a table.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data lake</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Capability</TableHead>
                <TableHead>Columns</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="w-20"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-muted-foreground">{lakeName(r.datalakeId)}</TableCell>
                  <TableCell className="font-mono text-xs">{targetLabel(r)}</TableCell>
                  <TableCell>
                    <Badge variant={r.effect === 'deny' ? 'destructive' : 'secondary'}>
                      {r.effect === 'deny' ? `deny ${r.capability}` : r.capability}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.columns?.length ? r.columns.join(', ') : 'all'}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{expiryLabel(r)}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button size="icon" variant="ghost" className="size-7" onClick={() => setEditing(r)}>
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button size="icon" variant="ghost" className="size-7 hover:text-destructive" onClick={() => void remove(r)}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <AddAccessDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        agentId={agentId}
        datalakes={datalakes}
        onDone={() => { setAddOpen(false); void load(); }}
      />
      <EditAccessDialog
        rule={editing}
        onOpenChange={(o) => !o && setEditing(null)}
        onDone={() => { setEditing(null); void load(); }}
      />
    </Card>
  );
}

// ── add access (catalog-aware) ──────────────────────────────────────────────────

function AddAccessDialog({
  open, onOpenChange, agentId, datalakes, onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  agentId: string;
  datalakes: { id: string; name: string }[];
  onDone: () => void;
}) {
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { if (open) setGrants([]); }, [open]);

  const submit = async () => {
    if (grants.length === 0) return;
    setSubmitting(true);
    let failed = 0;
    for (const g of grants) {
      const res = await cpPost(`/api/cp/acl`, {
        datalakeId: g.datalakeId,
        agentId,
        subjectKind: 'agent',
        capability: g.capability,
        schema: g.schema,
        table: g.table,
      });
      if (!res.ok) failed++;
    }
    setSubmitting(false);
    if (failed) toast.error(`${failed} grant(s) failed`);
    else toast.success(`Added ${grants.length} grant${grants.length > 1 ? 's' : ''}`);
    onDone();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add access</DialogTitle>
          <DialogDescription>Pick real tables from the lake&apos;s catalog, or grant a whole schema / lake.</DialogDescription>
        </DialogHeader>
        <ScopePicker datalakes={datalakes} grants={grants} onChange={setGrants} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={submitting || grants.length === 0}>
            {submitting ? 'Adding…' : `Grant ${grants.length || ''} access`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── edit access (capability / columns / expiry — the continuation lever) ─────────

function EditAccessDialog({
  rule, onOpenChange, onDone,
}: {
  rule: AclRule | null;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}) {
  const [capability, setCapability] = useState<Capability>('read');
  const [columns, setColumns] = useState('');
  const [ttlDays, setTtlDays] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (rule) {
      setCapability((SCOPE_CAPABILITIES.includes(rule.capability as Capability) ? rule.capability : 'read') as Capability);
      setColumns(rule.columns?.join(', ') ?? '');
      setTtlDays('');
    }
  }, [rule]);

  const submit = async () => {
    if (!rule) return;
    setSubmitting(true);
    const cols = columns.trim() ? columns.split(',').map((s) => s.trim()).filter(Boolean) : null;
    const body: Record<string, unknown> = { capability, columns: cols };
    if (ttlDays.trim()) body.ttlSeconds = Math.max(1, Math.round(Number(ttlDays) * 86400));
    const res = await cpPatch(`/api/cp/acl/${rule.id}`, body);
    setSubmitting(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success('Access updated');
    onDone();
  };

  const clearExpiry = async () => {
    if (!rule) return;
    setSubmitting(true);
    const res = await cpPatch(`/api/cp/acl/${rule.id}`, { expiresAt: null });
    setSubmitting(false);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success('Expiry cleared');
    onDone();
  };

  return (
    <Dialog open={!!rule} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit access</DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {rule ? targetLabel(rule) : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Capability</Label>
            <Select value={capability} onValueChange={(v) => setCapability(v as Capability)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SCOPE_CAPABILITIES.map((cap) => <SelectItem key={cap} value={cap}>{cap}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Columns (comma-separated, blank = all)</Label>
            <Input value={columns} onChange={(e) => setColumns(e.target.value)} placeholder="title, points" />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Extend / set expiry (days from now, blank = no change)</Label>
            <div className="flex gap-2">
              <Input value={ttlDays} onChange={(e) => setTtlDays(e.target.value)} placeholder="30" type="number" className="flex-1" />
              <Button variant="outline" size="sm" onClick={() => void clearExpiry()} disabled={submitting}>Clear expiry</Button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={submitting}>{submitting ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
