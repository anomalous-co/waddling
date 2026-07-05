'use client';

/**
 * Access rules — the datalake's literal GRANT/DENY SQL (spec §13). The control
 * plane's SINGLE representation of access is literal SQL stored per datalake;
 * birdshot PULLs + enforces it and we render the verbatim `stmt`. There is NO
 * coarse read/write model any more — an admin grants a specific granular
 * privilege (SELECT/INSERT/…) to a subject and we show exactly that statement.
 *
 * Both the list and authoring are datalake-scoped (control-api requires
 * ?datalakeId=). Data path: fetchCp → cpUrl → control-api directly in prod; the
 * /api/cp/* Next handlers are lab mocks that 404 once the API origin is set.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Ban, Check, RefreshCw, Trash2, AlertCircle, ShieldAlert, Plus } from 'lucide-react';
import { toast } from 'sonner';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardAction,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
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
import { Field, FieldLabel } from '@/components/ui/field';
import { cn } from '@/lib/utils';
import { fetchCp, cpPost, cpDelete } from '@/components/dashboard/fetch';
import type { DatalakeSummary, AgentSummary } from '@/lib/types';

// ── Local contracts (granular literal-SQL model) ───────────────────────────────

const PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'CREATE',
  'DROP',
  'ALTER',
  'USAGE',
  'EXECUTE',
] as const;
type AclPrivilege = (typeof PRIVILEGES)[number];
type SubjectKind = 'agent' | 'user' | 'org';
type AclEffect = 'allow' | 'deny';

interface GrantStatementRow {
  id: string;
  datalakeId: string;
  granteeKind: 'subject' | 'role' | 'public';
  grantee: string;
  stmt: string;
  version: number;
  createdAt: string;
}

interface MemberRow {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
}

const NO_AGENT_SENTINEL = '__none__';

function isDeny(statement: string): boolean {
  return /^\s*deny\b/i.test(statement);
}

// ── One verbatim statement row; DENY gets the "blocked" treatment ──────────────

function StatementRow({
  row,
  onDelete,
  pending,
}: {
  row: GrantStatementRow;
  onDelete: () => void;
  pending: boolean;
}) {
  const deny = isDeny(row.stmt);
  const granteeLabel =
    row.granteeKind === 'public'
      ? 'PUBLIC'
      : row.granteeKind === 'role'
        ? `role ${row.grantee}`
        : row.grantee;
  return (
    <div
      data-effect={deny ? 'deny' : 'allow'}
      className={cn(
        'group flex items-start gap-3 rounded-md border-l-2 py-2 pr-2 pl-3 font-mono text-xs leading-relaxed',
        deny
          ? 'border-l-destructive bg-destructive/5 text-destructive'
          : 'border-l-emerald-500 bg-emerald-500/5 text-foreground dark:border-l-emerald-400',
      )}
    >
      {deny ? (
        <Ban className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-label="deny" />
      ) : (
        <Check
          className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
          aria-label="grant"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <code className="break-all whitespace-pre-wrap">{row.stmt}</code>
        <span className="font-sans text-[10px] tracking-wide text-muted-foreground uppercase">
          {granteeLabel}
        </span>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0 opacity-60 transition-opacity group-hover:opacity-100"
        onClick={onDelete}
        disabled={pending}
        aria-label="Delete statement"
      >
        <Trash2 />
      </Button>
    </div>
  );
}

/** Non-interactive literal-SQL preview (mirrors the deny/allow row treatment). */
function StatementPreview({ stmt }: { stmt: string }) {
  const deny = isDeny(stmt);
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-md border-l-2 py-2 pr-2 pl-3 font-mono text-xs leading-relaxed',
        deny
          ? 'border-l-destructive bg-destructive/5 text-destructive'
          : 'border-l-emerald-500 bg-emerald-500/5 text-foreground dark:border-l-emerald-400',
      )}
    >
      {deny ? (
        <Ban className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden="true" />
      ) : (
        <Check
          className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
          aria-hidden="true"
        />
      )}
      <code className="min-w-0 flex-1 break-all whitespace-pre-wrap">{stmt}</code>
    </div>
  );
}

// ── Skeleton ────────────────────────────────────────────────────────────────────

function AclSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-10 w-48" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

// ── Delete confirm dialog ─────────────────────────────────────────────────────

function DeleteStatementDialog({
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
          <DialogTitle>Delete statement?</DialogTitle>
          <DialogDescription>
            This statement is removed immediately and the datalake epoch bumps.
            The gateway re-hydrates on its next authorize — active sessions may
            lose access.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending ? 'Deleting…' : 'Delete statement'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Rule builder (granular authoring) ──────────────────────────────────────────

function RuleBuilder({
  datalakeId,
  agents,
  members,
  onCreated,
}: {
  datalakeId: string | null;
  agents: AgentSummary[];
  members: MemberRow[];
  onCreated: () => void;
}) {
  const [subjectKind, setSubjectKind] = useState<SubjectKind>('agent');
  const [agentId, setAgentId] = useState<string | undefined>(undefined);
  const [userId, setUserId] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<Set<AclPrivilege>>(
    () => new Set<AclPrivilege>(['SELECT']),
  );
  const [schema, setSchema] = useState('');
  const [allTables, setAllTables] = useState(false);
  const [table, setTable] = useState('');
  const [columns, setColumns] = useState('');
  const [effect, setEffect] = useState<AclEffect>('allow');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upgradeRequired, setUpgradeRequired] = useState(false);

  const togglePrivilege = (p: AclPrivilege) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  const tableValue = allTables ? '*' : table.trim();
  const canSubmit =
    !!datalakeId &&
    selected.size > 0 &&
    schema.trim().length > 0 &&
    tableValue.length > 0 &&
    (subjectKind !== 'agent' || !!agentId) &&
    (subjectKind !== 'user' || !!userId);

  const preview = useMemo(() => {
    if (selected.size === 0 || !schema.trim() || !tableValue) return null;
    const cols = columns.split(',').map((c) => c.trim()).filter(Boolean);
    const colSql = cols.length ? ` (${cols.join(', ')})` : '';
    const privList = [...selected].map((p) => `${p}${colSql}`).join(', ');
    const on =
      tableValue === '*'
        ? `ALL TABLES IN SCHEMA ${schema.trim()}`
        : `${schema.trim()}.${tableValue}`;
    const to =
      subjectKind === 'agent'
        ? agentId
          ? `agent:${agentId}`
          : 'agent:…'
        : subjectKind === 'user'
          ? `ROLE user_${userId ?? '…'}`
          : 'ROLE org_…';
    return `${effect === 'deny' ? 'DENY' : 'GRANT'} ${privList} ON ${on} TO ${to}`;
  }, [agentId, columns, effect, schema, selected, subjectKind, tableValue, userId]);

  const submit = async () => {
    if (!datalakeId) {
      setError('Select a data lake');
      return;
    }
    if (!canSubmit) {
      setError('Pick a subject, at least one privilege, and a schema.table');
      return;
    }
    setLoading(true);
    setError(null);
    setUpgradeRequired(false);

    const cols = columns.split(',').map((c) => c.trim()).filter(Boolean);
    const res = await cpPost<{ statement: string }>('/api/cp/acl', {
      datalakeId,
      subjectKind,
      agentId: subjectKind === 'agent' ? agentId : undefined,
      userId: subjectKind === 'user' ? userId : undefined,
      privileges: [...selected],
      schema: schema.trim(),
      table: tableValue,
      effect,
      ...(cols.length ? { columns: cols } : {}),
    });
    setLoading(false);
    if (!res.ok) {
      if (res.status === 402 || res.code === 'upgrade_required') setUpgradeRequired(true);
      else setError(res.error);
      return;
    }
    toast.success(effect === 'deny' ? 'Deny added' : 'Grant added');
    // Reset the volatile bits; keep subject kind for rapid authoring.
    setSelected(new Set<AclPrivilege>(['SELECT']));
    setSchema('');
    setAllTables(false);
    setTable('');
    setColumns('');
    setEffect('allow');
    onCreated();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add statement</CardTitle>
        <CardDescription>
          Grant or deny a granular privilege to an agent, user, or the whole org.
          DENY wins over GRANT (deny carve-out).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {upgradeRequired ? (
          <Alert>
            <ShieldAlert className="size-4" />
            <AlertTitle>Pro plan required</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-3">
              Dynamic access rules require the Pro plan.
              <Button asChild size="sm" variant="outline">
                <Link href="/billing">Upgrade to Pro</Link>
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-3 md:grid-cols-3">
          <Field>
            <FieldLabel htmlFor="r-effect">Effect</FieldLabel>
            <Select value={effect} onValueChange={(v) => setEffect(v as AclEffect)}>
              <SelectTrigger id="r-effect" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="allow">GRANT (allow)</SelectItem>
                <SelectItem value="deny">DENY (block)</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="r-subject-kind">Subject</FieldLabel>
            <Select
              value={subjectKind}
              onValueChange={(v) => {
                setSubjectKind(v as SubjectKind);
                setAgentId(undefined);
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

          {subjectKind === 'agent' ? (
            <Field>
              <FieldLabel htmlFor="r-agent">Agent</FieldLabel>
              <Select
                value={agentId ?? NO_AGENT_SENTINEL}
                onValueChange={(v) => setAgentId(v === NO_AGENT_SENTINEL ? undefined : v)}
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
              <FieldLabel htmlFor="r-user">User</FieldLabel>
              <Select
                value={userId ?? NO_AGENT_SENTINEL}
                onValueChange={(v) => setUserId(v === NO_AGENT_SENTINEL ? undefined : v)}
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
            <div />
          )}
        </div>

        <Field>
          <FieldLabel>Privileges</FieldLabel>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
            {PRIVILEGES.map((p) => (
              <label
                key={p}
                className="flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-xs font-medium select-none has-[:checked]:border-primary has-[:checked]:bg-primary/5"
              >
                <Checkbox
                  checked={selected.has(p)}
                  onCheckedChange={() => togglePrivilege(p)}
                  aria-label={p}
                />
                {p}
              </label>
            ))}
          </div>
        </Field>

        <Separator />

        <div className="grid gap-3 md:grid-cols-3">
          <Field>
            <FieldLabel htmlFor="r-schema">Schema</FieldLabel>
            <Input
              id="r-schema"
              value={schema}
              onChange={(e) => setSchema(e.target.value)}
              placeholder="sales"
              autoComplete="off"
            />
          </Field>

          <Field>
            <div className="flex items-center justify-between">
              <FieldLabel htmlFor="r-table">Table</FieldLabel>
              <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground select-none">
                <Checkbox
                  checked={allTables}
                  onCheckedChange={(v) => setAllTables(v === true)}
                  aria-label="All tables in schema"
                />
                All tables
              </label>
            </div>
            <Input
              id="r-table"
              value={allTables ? '*' : table}
              onChange={(e) => setTable(e.target.value)}
              placeholder="orders"
              autoComplete="off"
              disabled={allTables}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="r-columns">Columns (optional)</FieldLabel>
            <Input
              id="r-columns"
              value={columns}
              onChange={(e) => setColumns(e.target.value)}
              placeholder="email, region"
              autoComplete="off"
            />
          </Field>
        </div>

        {preview ? (
          <StatementPreview stmt={preview} />
        ) : (
          <p className="text-xs text-muted-foreground">
            Pick privileges and a schema.table to preview the literal statement.
          </p>
        )}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <div>
          <Button onClick={() => void submit()} disabled={loading || !canSubmit}>
            <Plus data-icon="inline-start" />
            {loading ? 'Adding…' : 'Add statement'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AclPage() {
  const [datalakes, setDatalakes] = useState<DatalakeSummary[]>([]);
  const [datalakeId, setDatalakeId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [statements, setStatements] = useState<GrantStatementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [listLoading, setListLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);

  // Bootstrap: datalakes + agents + members (for the authoring form).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [dlRes, agentRes, settingsRes] = await Promise.all([
        fetchCp<{ datalakes: DatalakeSummary[] }>('/api/cp/datalakes'),
        fetchCp<{ agents: AgentSummary[] }>('/api/cp/agents'),
        fetchCp<{ members: MemberRow[] }>('/api/cp/settings'),
      ]);
      if (cancelled) return;
      if (!dlRes.ok) {
        setError(dlRes.error);
        setLoading(false);
        return;
      }
      setDatalakes(dlRes.data.datalakes);
      setDatalakeId((cur) => cur ?? dlRes.data.datalakes[0]?.id ?? null);
      setAgents(agentRes.ok ? agentRes.data.agents : []);
      setMembers(settingsRes.ok ? settingsRes.data.members : []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadStatements = useCallback(async () => {
    if (!datalakeId) return;
    setListLoading(true);
    const res = await fetchCp<{ statements: GrantStatementRow[] }>(
      `/api/cp/acl?datalakeId=${encodeURIComponent(datalakeId)}`,
    );
    if (res.ok) {
      setStatements(res.data.statements);
      setError(null);
    } else {
      setError(res.error);
    }
    setListLoading(false);
  }, [datalakeId]);

  useEffect(() => {
    void loadStatements();
  }, [loadStatements]);

  const confirmDelete = async () => {
    if (!deleteTargetId) return;
    setDeletePending(true);
    const res = await cpDelete<{ success: boolean }>(
      `/api/cp/acl/${encodeURIComponent(deleteTargetId)}`,
    );
    setDeletePending(false);
    if (res.ok) {
      setStatements((prev) => prev.filter((r) => r.id !== deleteTargetId));
      toast.success('Statement deleted');
    } else {
      toast.error(res.error ?? 'Failed to delete statement');
    }
    setDeleteOpen(false);
    setDeleteTargetId(null);
  };

  if (loading) return <AclSkeleton />;

  if (error && datalakes.length === 0)
    return (
      <Alert variant="destructive">
        <AlertCircle className="size-4" />
        <AlertTitle>Couldn&apos;t load access rules</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          {error}
          <Button variant="outline" size="sm" onClick={() => location.reload()}>
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
          Per-agent table-level ACLs enforced by birdshot, stored as literal
          GRANT / DENY SQL. What you see is exactly what the gateway enforces.
        </p>
      </div>

      {datalakes.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No data lakes yet</EmptyTitle>
            <EmptyDescription>
              Create a data lake before authoring access rules.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <RuleBuilder
            datalakeId={datalakeId}
            agents={agents}
            members={members}
            onCreated={() => void loadStatements()}
          />

          <Card>
            <CardHeader>
              <CardTitle>Statements</CardTitle>
              <CardDescription>
                {statements.length === 1 ? '1 statement' : `${statements.length} statements`} on
                this data lake, in resolution order.
              </CardDescription>
              <CardAction>
                <Select value={datalakeId ?? undefined} onValueChange={setDatalakeId}>
                  <SelectTrigger size="sm" className="w-48">
                    <SelectValue placeholder="Data lake" />
                  </SelectTrigger>
                  <SelectContent>
                    {datalakes.map((dl) => (
                      <SelectItem key={dl.id} value={dl.id}>
                        {dl.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </CardAction>
            </CardHeader>
            <CardContent>
              {listLoading ? (
                <div className="flex flex-col gap-1.5">
                  <Skeleton className="h-10 w-full rounded-md" />
                  <Skeleton className="h-10 w-full rounded-md" />
                  <Skeleton className="h-10 w-3/4 rounded-md" />
                </div>
              ) : statements.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>No statements</EmptyTitle>
                    <EmptyDescription>
                      Add a statement above to grant or deny access on this data lake.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {statements.map((row) => (
                    <StatementRow
                      key={row.id}
                      row={row}
                      pending={deletePending && deleteTargetId === row.id}
                      onDelete={() => {
                        setDeleteTargetId(row.id);
                        setDeleteOpen(true);
                      }}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <DeleteStatementDialog
        open={deleteOpen}
        onOpenChange={(v) => {
          if (!deletePending) setDeleteOpen(v);
        }}
        onConfirm={() => void confirmDelete()}
        pending={deletePending}
      />
    </div>
  );
}
