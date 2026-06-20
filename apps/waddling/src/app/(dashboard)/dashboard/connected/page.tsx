'use client';

import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Trash2, AlertCircle, Plus } from 'lucide-react';
import { toast } from 'sonner';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Field, FieldGroup, FieldLabel, FieldError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { fetchCp, cpPost, cpDelete } from '@/components/dashboard/fetch';
import type { AgentSummary, DatalakeSummary } from '@/lib/types';

// ── Types ─────────────────────────────────────────────────────────────────────

interface DelegationRow {
  id: string;
  orgId: string;
  userId: string;
  agentId?: string;
  clientId?: string;
  datalakeId?: string;
  schemaName: string;
  tableName: string;
  columns?: string[];
  capability: string;
  rowLimit?: number;
  windowStart?: string;
  windowEnd?: string;
  expiresAt?: string;
  createdBy: string;
  createdAt: string;
}

const CAPABILITY_VALUES = [
  'read', 'write', 'create', 'drop', 'alter',
  'read_source', 'copy_to', 'copy_from',
  'attach', 'detach', 'install', 'load', 'etl',
] as const;
type Capability = typeof CAPABILITY_VALUES[number];

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// A clientId delegation comes from OAuth (Claude / MCP). An agentId delegation
// is an autonomous sk_-keyed agent the user has explicitly scoped.
function subjectLabel(
  row: DelegationRow,
  agentById: Map<string, AgentSummary>,
): string {
  if (row.agentId) {
    const a = agentById.get(row.agentId);
    return a ? a.name : `agent:${row.agentId.slice(0, 8)}…`;
  }
  if (row.clientId) {
    // clientId comes from the OAuth consent (e.g. Claude Desktop).
    return `claude:${row.clientId.slice(0, 10)}…`;
  }
  return '—';
}

function subjectKind(row: DelegationRow): string {
  if (row.agentId) return 'autonomous';
  if (row.clientId) return 'delegated';
  return '—';
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function ConnectedSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-10 w-56" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

// ── Revoke confirm dialog ─────────────────────────────────────────────────────

function RevokeDialog({
  open,
  onOpenChange,
  onConfirm,
  pending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke delegation?</DialogTitle>
          <DialogDescription>
            The agent or OAuth client will lose derived access at the next policy
            refresh. This cannot be undone; you will need to re-grant access.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? 'Revoking…' : 'Revoke'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Add delegation dialog ─────────────────────────────────────────────────────

interface AddDelegationDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  agents: AgentSummary[];
  datalakes: DatalakeSummary[];
  onCreated: (row: DelegationRow) => void;
}

// Sentinel for Select when "all lakes" is chosen.
const ALL_LAKES = '__all__';
const ALL_AGENTS_SENTINEL = '__agent__';

function AddDelegationDialog({
  open,
  onOpenChange,
  agents,
  datalakes,
  onCreated,
}: AddDelegationDialogProps) {
  const [agentId, setAgentId] = useState('');
  const [datalakeId, setDatalakeId] = useState(ALL_LAKES);
  const [schema, setSchema] = useState('*');
  const [table, setTable] = useState('*');
  const [capability, setCapability] = useState<Capability>('read');
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setAgentId('');
      setDatalakeId(ALL_LAKES);
      setSchema('*');
      setTable('*');
      setCapability('read');
      setFieldError(null);
    }
  }, [open]);

  const submit = async () => {
    if (!agentId || agentId === ALL_AGENTS_SENTINEL) {
      setFieldError('Select an agent');
      return;
    }
    setSubmitting(true);
    setFieldError(null);
    const payload = {
      agentId,
      datalakeId: datalakeId === ALL_LAKES ? undefined : datalakeId,
      schema,
      table,
      capability,
    };
    const res = await cpPost<{ delegation: DelegationRow }>('/api/cp/delegations', payload);
    setSubmitting(false);
    if (!res.ok) {
      setFieldError(res.error);
      return;
    }
    if (res.data.delegation) onCreated(res.data.delegation);
    toast.success('Delegation added');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add delegation</DialogTitle>
          <DialogDescription>
            Grant one of your agents a scoped subset of your own access. The
            agent's effective grants are always clamped to what you yourself have.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup className="py-1">
          <Field>
            <FieldLabel htmlFor="d-agent">Agent *</FieldLabel>
            <Select
              value={agentId || ALL_AGENTS_SENTINEL}
              onValueChange={(v) => setAgentId(v === ALL_AGENTS_SENTINEL ? '' : v)}
            >
              <SelectTrigger id="d-agent" className="w-full">
                <SelectValue placeholder="— select agent —" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_AGENTS_SENTINEL} disabled>
                  — select agent —
                </SelectItem>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="d-lake">Data lake (blank = all)</FieldLabel>
            <Select value={datalakeId} onValueChange={setDatalakeId}>
              <SelectTrigger id="d-lake" className="w-full">
                <SelectValue placeholder="All data lakes" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_LAKES}>All data lakes</SelectItem>
                {datalakes.map((dl) => (
                  <SelectItem key={dl.id} value={dl.id}>
                    {dl.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="d-schema">Schema</FieldLabel>
            <Input
              id="d-schema"
              value={schema}
              onChange={(e) => setSchema(e.target.value)}
              placeholder="* or sales"
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="d-table">Table</FieldLabel>
            <Input
              id="d-table"
              value={table}
              onChange={(e) => setTable(e.target.value)}
              placeholder="* or orders"
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="d-capability">Capability</FieldLabel>
            <Select
              value={capability}
              onValueChange={(v) => setCapability(v as Capability)}
            >
              <SelectTrigger id="d-capability" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CAPABILITY_VALUES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {fieldError ? <FieldError>{fieldError}</FieldError> : null}
        </FieldGroup>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={submitting}>
            {submitting ? 'Adding…' : 'Add delegation'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ConnectedPage() {
  const [delegations, setDelegations] = useState<DelegationRow[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [datalakes, setDatalakes] = useState<DatalakeSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [revokeTargetId, setRevokeTargetId] = useState<string | null>(null);
  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false);
  const [revokePending, setRevokePending] = useState(false);

  const agentById = new Map(agents.map((a) => [a.id, a]));
  const datalakeById = new Map(datalakes.map((dl) => [dl.id, dl]));

  const load = useCallback(async () => {
    const [delegRes, agentRes, lakeRes] = await Promise.all([
      fetchCp<{ delegations: DelegationRow[]; grants: unknown[] }>('/api/cp/delegations'),
      fetchCp<{ agents: AgentSummary[] }>('/api/cp/agents'),
      fetchCp<{ datalakes: DatalakeSummary[] }>('/api/cp/datalakes'),
    ]);
    if (!delegRes.ok) {
      setError(delegRes.error);
    } else {
      setDelegations(delegRes.data.delegations);
      setAgents(agentRes.ok ? agentRes.data.agents : []);
      setDatalakes(lakeRes.ok ? lakeRes.data.datalakes : []);
      setError(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openRevokeDialog = (id: string) => {
    setRevokeTargetId(id);
    setRevokeDialogOpen(true);
  };

  const confirmRevoke = async () => {
    if (!revokeTargetId) return;
    setRevokePending(true);
    const res = await cpDelete<{ success: boolean }>(`/api/cp/delegations/${revokeTargetId}`);
    setRevokePending(false);
    if (res.ok) {
      setDelegations((prev) => prev.filter((d) => d.id !== revokeTargetId));
      toast.success('Delegation revoked');
    } else {
      toast.error(res.error ?? 'Failed to revoke delegation');
    }
    setRevokeDialogOpen(false);
    setRevokeTargetId(null);
  };

  if (loading) return <ConnectedSkeleton />;

  if (error)
    return (
      <Alert variant="destructive">
        <AlertCircle className="size-4" />
        <AlertTitle>Couldn't load delegations</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          {error}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setLoading(true);
              void load();
            }}
          >
            <RefreshCw data-icon="inline-start" />
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );

  return (
    <>
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Connected agents</h1>
            <p className="text-sm text-muted-foreground">
              Agents and OAuth clients acting on your behalf, scoped to a subset
              of your own grants.
            </p>
          </div>
          <Button onClick={() => setAddOpen(true)}>
            <Plus data-icon="inline-start" />
            Add delegation
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Active delegations</CardTitle>
            <CardDescription>
              Each row is a capability scope you have granted to an agent or
              connected client. Effective access is your grants intersected with
              this scope — revoking a row shrinks the agent immediately.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {delegations.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No delegations yet</EmptyTitle>
                  <EmptyDescription>
                    When you connect Claude or another agent via OAuth, the scope
                    it was granted appears here. You can also add an explicit
                    delegation to a named agent above.
                  </EmptyDescription>
                </EmptyHeader>
                <Button onClick={() => setAddOpen(true)}>
                  <Plus data-icon="inline-start" />
                  Add delegation
                </Button>
              </Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent / Client</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Data lake</TableHead>
                    <TableHead>Schema.Table</TableHead>
                    <TableHead>Capability</TableHead>
                    <TableHead>Added</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {delegations.map((d) => {
                    const dl = d.datalakeId ? datalakeById.get(d.datalakeId) : null;
                    return (
                      <TableRow key={d.id}>
                        <TableCell className="font-mono text-xs">
                          {subjectLabel(d, agentById)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">{subjectKind(d)}</Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {dl ? (
                            dl.name
                          ) : d.datalakeId ? (
                            `${d.datalakeId.slice(0, 8)}…`
                          ) : (
                            <span className="text-muted-foreground">all lakes</span>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {d.schemaName}.{d.tableName}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{d.capability}</Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {relativeTime(d.createdAt)}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => openRevokeDialog(d.id)}
                            aria-label="Revoke delegation"
                          >
                            <Trash2 />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <AddDelegationDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        agents={agents}
        datalakes={datalakes}
        onCreated={(row) => setDelegations((prev) => [row, ...prev])}
      />

      <RevokeDialog
        open={revokeDialogOpen}
        onOpenChange={(v) => {
          if (!revokePending) setRevokeDialogOpen(v);
        }}
        onConfirm={() => void confirmRevoke()}
        pending={revokePending}
      />
    </>
  );
}
