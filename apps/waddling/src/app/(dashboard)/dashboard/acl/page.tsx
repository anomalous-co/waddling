'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { RefreshCw, Trash2, AlertCircle, ShieldAlert } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
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
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { StatusBadge } from '@/components/dashboard/status';
import { fetchCp, cpPost, cpDelete } from '@/components/dashboard/fetch';
import type { AclRuleInput, DatalakeSummary, AgentSummary } from '@/lib/types';

// ── Types ─────────────────────────────────────────────────────────────────────

type SubjectKind = 'agent' | 'user' | 'org';
// Catalog capabilities — those keyed to a schema.table[.db] resource, authorable
// on this acl_rule form. read/write ride the bind-walk; create/drop/alter/detach
// are parse-layer-authorized (Phase 3). Non-catalog capabilities (read_source/
// copy/attach/install/load) gate a URI or extension name, NOT a table, so they
// are authored on the separate acl-policy surface, not here.
type Capability = 'read' | 'write' | 'create' | 'drop' | 'alter' | 'detach';

const CAPABILITIES: Capability[] = [
  'read',
  'write',
  'create',
  'drop',
  'alter',
  'detach',
];

interface AclRuleRow {
  id: string;
  datalakeId: string;
  agentId?: string;
  // Phase 1 subject/capability fields (defaulted server-side for legacy rows)
  subjectKind?: SubjectKind;
  userId?: string;
  capability?: Capability;
  schemaName: string;
  tableName: string;
  columns?: string[];
  verb: 'read' | 'write';
  effect: 'allow' | 'deny';
  rowLimit?: number;
  ttlSeconds?: number;
  windowStart?: string;
  windowEnd?: string;
  expiresAt?: string;
  priority: number;
  createdAt: string;
}

// Minimal member shape mirroring /api/cp/settings response.
interface MemberRow {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
}

// Sentinel for "specific agent" select when no agent is chosen yet.
const NO_AGENT_SENTINEL = '__none__';

// ── Skeleton ──────────────────────────────────────────────────────────────────

function AclSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-10 w-48" />
      <Skeleton className="h-72 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

// ── Delete confirm dialog ─────────────────────────────────────────────────────

function DeleteRuleDialog({
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
          <DialogTitle>Delete ACL rule?</DialogTitle>
          <DialogDescription>
            This rule will be removed immediately. Active sessions that relied on
            this grant may lose access at next policy refresh.
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
            {pending ? 'Deleting…' : 'Delete rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Expiry badge ──────────────────────────────────────────────────────────────

function ExpiryBadge({ expiresAt }: { expiresAt?: string }) {
  if (!expiresAt) return <span className="text-xs text-muted-foreground">—</span>;
  const d = new Date(expiresAt);
  const expired = d < new Date();
  return (
    <Badge variant={expired ? 'destructive' : 'outline'}>
      {expired ? 'expired' : d.toLocaleDateString()}
    </Badge>
  );
}

// ── 402 upgrade prompt ────────────────────────────────────────────────────────

function UpgradeAlert() {
  return (
    <Alert>
      <ShieldAlert className="size-4" />
      <AlertTitle>Pro plan required</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        Dynamic ACL rules require the Pro plan. Free tier supports static
        reader/writer roles only.
        <Button asChild size="sm" variant="outline">
          <Link href="/dashboard/billing">Upgrade to Pro</Link>
        </Button>
      </AlertDescription>
    </Alert>
  );
}

// ── Rule builder ──────────────────────────────────────────────────────────────

const DEFAULT_FORM: AclRuleInput = {
  datalakeId: '',
  agentId: undefined,
  schema: '*',
  table: '*',
  columns: undefined,
  verb: 'read',
  effect: 'allow',
  rowLimit: undefined,
  ttlSeconds: undefined,
};

function RuleBuilder({
  datalakes,
  agents,
  members,
  onCreated,
}: {
  datalakes: DatalakeSummary[];
  agents: AgentSummary[];
  members: MemberRow[];
  onCreated: (rule: AclRuleRow) => void;
}) {
  const [form, setForm] = useState<AclRuleInput>(DEFAULT_FORM);
  const [columnsRaw, setColumnsRaw] = useState('');
  const [priority, setPriority] = useState<number | undefined>(undefined);
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');
  // Subject + capability — separate state (not in AclRuleInput)
  const [subjectKind, setSubjectKind] = useState<SubjectKind>('agent');
  const [userId, setUserId] = useState<string | undefined>(undefined);
  const [capability, setCapability] = useState<Capability>('read');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upgradeRequired, setUpgradeRequired] = useState(false);

  const set = <K extends keyof AclRuleInput>(k: K, v: AclRuleInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    if (!form.datalakeId) {
      setError('Data lake is required');
      return;
    }
    if (subjectKind === 'agent' && !form.agentId) {
      setError('Select an agent, or choose User or Org-wide as the subject');
      return;
    }
    if (subjectKind === 'user' && !userId) {
      setError('Select a user');
      return;
    }
    setLoading(true);
    setError(null);
    setUpgradeRequired(false);

    const payload: AclRuleInput & {
      priority?: number;
      subjectKind?: SubjectKind;
      userId?: string;
      capability?: Capability;
    } = {
      ...form,
      // agentId is only meaningful for agent-subject rules
      agentId: subjectKind === 'agent' ? (form.agentId || undefined) : undefined,
      columns: columnsRaw.trim()
        ? columnsRaw.split(',').map((c) => c.trim()).filter(Boolean)
        : undefined,
      window:
        windowStart && windowEnd
          ? { start: windowStart, end: windowEnd }
          : undefined,
      // capability is the source of truth; verb is the legacy read|write filler
      // (write-class → write, else read). The server keys on capability.
      verb: capability === 'write' ? 'write' : 'read',
      subjectKind,
      userId: subjectKind === 'user' ? userId : undefined,
      capability,
      ...(priority !== undefined ? { priority } : {}),
    };

    const res = await cpPost<{ rule: AclRuleRow }>('/api/cp/acl', payload);
    setLoading(false);
    if (!res.ok) {
      if (res.status === 402 || res.code === 'upgrade_required') {
        setUpgradeRequired(true);
      } else {
        setError(res.error);
      }
      return;
    }
    toast.success('Rule added');
    onCreated(res.data.rule);
    setForm(DEFAULT_FORM);
    setColumnsRaw('');
    setPriority(undefined);
    setWindowStart('');
    setWindowEnd('');
    setSubjectKind('agent');
    setUserId(undefined);
    setCapability('read');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add ACL rule</CardTitle>
        <CardDescription>
          Define who can access what resource. Deny wins over allow on priority
          tie.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {upgradeRequired ? <UpgradeAlert /> : null}

        <FieldGroup className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <Field>
            <FieldLabel htmlFor="r-datalake">Data lake *</FieldLabel>
            <Select
              value={form.datalakeId}
              onValueChange={(v) => set('datalakeId', v)}
            >
              <SelectTrigger id="r-datalake" className="w-full">
                <SelectValue placeholder="— select —" />
              </SelectTrigger>
              <SelectContent>
                {datalakes.map((dl) => (
                  <SelectItem key={dl.id} value={dl.id}>
                    {dl.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {/* Subject kind: Agent | User | Org-wide */}
          <Field>
            <FieldLabel htmlFor="r-subject-kind">Subject</FieldLabel>
            <Select
              value={subjectKind}
              onValueChange={(v) => {
                setSubjectKind(v as SubjectKind);
                // Reset target selections when kind changes
                set('agentId', undefined);
                setUserId(undefined);
              }}
            >
              <SelectTrigger id="r-subject-kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="agent">Agent</SelectItem>
                <SelectItem value="user">User</SelectItem>
                <SelectItem value="org">Org-wide</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {/* Target picker — agent or member depending on subject kind */}
          {subjectKind === 'agent' ? (
            <Field>
              <FieldLabel htmlFor="r-agent">Agent *</FieldLabel>
              <Select
                value={form.agentId ?? NO_AGENT_SENTINEL}
                onValueChange={(v) =>
                  set('agentId', v === NO_AGENT_SENTINEL ? undefined : v)
                }
              >
                <SelectTrigger id="r-agent" className="w-full">
                  <SelectValue placeholder="— select agent —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_AGENT_SENTINEL}>— select agent —</SelectItem>
                  {agents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : subjectKind === 'user' ? (
            <Field>
              <FieldLabel htmlFor="r-user">User *</FieldLabel>
              <Select
                value={userId ?? NO_AGENT_SENTINEL}
                onValueChange={(v) =>
                  setUserId(v === NO_AGENT_SENTINEL ? undefined : v)
                }
              >
                <SelectTrigger id="r-user" className="w-full">
                  <SelectValue placeholder="— select member —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_AGENT_SENTINEL}>— select member —</SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.userId} value={m.userId}>
                      {m.name} ({m.email})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : (
            /* org-wide: no target selector needed */
            <div />
          )}

          <Field>
            <FieldLabel htmlFor="r-schema">Schema</FieldLabel>
            <Input
              id="r-schema"
              value={form.schema}
              onChange={(e) => set('schema', e.target.value)}
              placeholder="* or sales"
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="r-table">Table</FieldLabel>
            <Input
              id="r-table"
              value={form.table}
              onChange={(e) => set('table', e.target.value)}
              placeholder="* or orders"
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="r-columns">
              Columns (comma-sep, blank = all)
            </FieldLabel>
            <Input
              id="r-columns"
              value={columnsRaw}
              onChange={(e) => setColumnsRaw(e.target.value)}
              placeholder="id, name, amount"
            />
          </Field>

          {/* Capability replaces the old Verb selector; drives both verb + capability fields */}
          <Field>
            <FieldLabel htmlFor="r-capability">Capability</FieldLabel>
            <Select
              value={capability}
              onValueChange={(v) => setCapability(v as Capability)}
            >
              <SelectTrigger id="r-capability" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CAPABILITIES.map((cap) => (
                  <SelectItem key={cap} value={cap}>
                    {cap}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="r-effect">Effect</FieldLabel>
            <Select
              value={form.effect ?? 'allow'}
              onValueChange={(v) => set('effect', v as 'allow' | 'deny')}
            >
              <SelectTrigger id="r-effect" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="allow">allow</SelectItem>
                <SelectItem value="deny">deny</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="r-rowlimit">Row limit (blank = ∞)</FieldLabel>
            <Input
              id="r-rowlimit"
              type="number"
              value={form.rowLimit ?? ''}
              onChange={(e) =>
                set('rowLimit', e.target.value ? Number(e.target.value) : undefined)
              }
              placeholder="1000"
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="r-ttl">TTL seconds (blank = no expiry)</FieldLabel>
            <Input
              id="r-ttl"
              type="number"
              value={form.ttlSeconds ?? ''}
              onChange={(e) =>
                set('ttlSeconds', e.target.value ? Number(e.target.value) : undefined)
              }
              placeholder="3600"
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="r-priority">Priority</FieldLabel>
            <Input
              id="r-priority"
              type="number"
              value={priority ?? ''}
              onChange={(e) =>
                setPriority(e.target.value ? Number(e.target.value) : undefined)
              }
              placeholder="0"
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="r-window-start">Window start (HH:MM)</FieldLabel>
            <Input
              id="r-window-start"
              value={windowStart}
              onChange={(e) => setWindowStart(e.target.value)}
              placeholder="08:00"
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="r-window-end">Window end (HH:MM)</FieldLabel>
            <Input
              id="r-window-end"
              value={windowEnd}
              onChange={(e) => setWindowEnd(e.target.value)}
              placeholder="18:00"
            />
          </Field>
        </FieldGroup>

        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : null}

        <div>
          <Button onClick={() => void submit()} disabled={loading}>
            {loading ? 'Adding…' : 'Add rule'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AclPage() {
  const [rules, setRules] = useState<AclRuleRow[]>([]);
  const [datalakes, setDatalakes] = useState<DatalakeSummary[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Delete dialog state
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);

  const datalakeById = new Map(datalakes.map((dl) => [dl.id, dl]));
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const memberByUserId = new Map(members.map((m) => [m.userId, m]));

  const load = useCallback(async () => {
    const [rulesRes, endRes, agentRes, settingsRes] = await Promise.all([
      fetchCp<{ rules: AclRuleRow[] }>('/api/cp/acl'),
      fetchCp<{ datalakes: DatalakeSummary[] }>('/api/cp/datalakes'),
      fetchCp<{ agents: AgentSummary[] }>('/api/cp/agents'),
      fetchCp<{ members: MemberRow[] }>('/api/cp/settings'),
    ]);
    if (!rulesRes.ok) {
      setError(rulesRes.error);
    } else {
      setRules(rulesRes.data.rules);
      setDatalakes(endRes.ok ? endRes.data.datalakes : []);
      setAgents(agentRes.ok ? agentRes.data.agents : []);
      setMembers(settingsRes.ok ? settingsRes.data.members : []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openDeleteDialog = (id: string) => {
    setDeleteTargetId(id);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = async () => {
    if (!deleteTargetId) return;
    setDeletePending(true);
    const res = await cpDelete<{ ok: boolean }>(`/api/cp/acl/${deleteTargetId}`);
    setDeletePending(false);
    if (res.ok) {
      setRules((prev) => prev.filter((r) => r.id !== deleteTargetId));
      toast.success('Rule deleted');
    } else {
      toast.error(res.error ?? 'Failed to delete rule');
    }
    setDeleteDialogOpen(false);
    setDeleteTargetId(null);
  };

  if (loading) return <AclSkeleton />;

  if (error)
    return (
      <Alert variant="destructive">
        <AlertCircle className="size-4" />
        <AlertTitle>Couldn't load ACL rules</AlertTitle>
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
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Access rules</h1>
        <p className="text-sm text-muted-foreground">
          Per-agent table-level ACLs enforced by birdshot. Deny wins over allow
          on priority tie.
        </p>
      </div>

      <RuleBuilder
        datalakes={datalakes}
        agents={agents}
        members={members}
        onCreated={(rule) => setRules((prev) => [rule, ...prev])}
      />

      <Card>
        <CardHeader>
          <CardTitle>Active rules</CardTitle>
          <CardDescription>
            {rules.length === 1 ? '1 rule' : `${rules.length} rules`} — evaluated
            in priority order
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rules.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No ACL rules</EmptyTitle>
                <EmptyDescription>
                  Add a rule above to grant or restrict agent access to tables.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data Lake</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Schema.Table</TableHead>
                  <TableHead>Columns</TableHead>
                  <TableHead>Capability</TableHead>
                  <TableHead>Effect</TableHead>
                  <TableHead>Row limit</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.map((r) => {
                  const dl = datalakeById.get(r.datalakeId);
                  const ag = r.agentId ? agentById.get(r.agentId) : null;
                  const kind = r.subjectKind ?? (r.agentId ? 'agent' : 'org');
                  const member = r.userId ? memberByUserId.get(r.userId) : null;
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs">
                        {dl ? (
                          <Link
                            href={`/dashboard/datalakes/${r.datalakeId}`}
                            className="text-primary hover:underline"
                          >
                            {dl.name}
                          </Link>
                        ) : (
                          `${r.datalakeId.slice(0, 8)}…`
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {kind === 'user' ? (
                          member ? (
                            <span>{member.name}</span>
                          ) : r.userId ? (
                            <span className="font-mono">{r.userId.slice(0, 8)}…</span>
                          ) : (
                            <span className="text-muted-foreground">user</span>
                          )
                        ) : kind === 'org' ? (
                          <span className="text-muted-foreground">org-wide</span>
                        ) : r.agentId ? (
                          ag ? (
                            <Link
                              href={`/dashboard/agents/${r.agentId}`}
                              className="font-mono text-primary hover:underline"
                            >
                              {ag.name}
                            </Link>
                          ) : (
                            <span className="font-mono">{r.agentId.slice(0, 8)}…</span>
                          )
                        ) : (
                          <span className="text-muted-foreground">all agents</span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {r.schemaName}.{r.tableName}
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.columns ? (
                          r.columns.join(', ')
                        ) : (
                          <span className="text-muted-foreground">all</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{r.capability ?? r.verb}</Badge>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={r.effect} />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.rowLimit != null ? r.rowLimit.toLocaleString() : '∞'}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.priority}
                      </TableCell>
                      <TableCell>
                        <ExpiryBadge expiresAt={r.expiresAt} />
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => openDeleteDialog(r.id)}
                          aria-label="Delete rule"
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

      <DeleteRuleDialog
        open={deleteDialogOpen}
        onOpenChange={(v) => {
          if (!deletePending) setDeleteDialogOpen(v);
        }}
        onConfirm={() => void confirmDelete()}
        pending={deletePending}
      />
    </div>
  );
}
