'use client';

/**
 * Agent-detail "Access" section — the literal GRANT/DENY SQL governing this key
 * (spec §13). The control plane's SINGLE representation of a key's access is
 * literal SQL stored per datalake; birdshot PULLs + enforces it and we render the
 * verbatim `stmt`. This is the headline: the operator sees EXACTLY what the key
 * can and cannot do.
 *
 * Two surfaces, both datalake-scoped (control-api requires ?datalakeId=):
 *   1. Grant SQL (headline, read-only) — GET /api/cp/agents/:id/grants?datalakeId=
 *      → the RESOLVED statements: the subject's own rows ∪ PUBLIC ∪ transitive
 *      roles, verbatim. Exactly what the gateway enforces.
 *   2. This key's grants (editable) — GET /api/cp/acl?datalakeId= filtered to this
 *      agent's own rows (deletable, with ids); POST to author, DELETE to remove.
 *
 * Data path: fetchCp → cpUrl → control-api directly in prod; the /api/cp/* Next
 * route handlers are lab mocks that 404 once NEXT_PUBLIC_CONTROL_API_URL is set.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ban, Check, RefreshCw, Plus, Trash2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { fetchCp, cpPost, cpDelete } from '@/components/dashboard/fetch';
import { SectionCard } from '@/components/waddling/section-card';
import { EmptyState } from '@/components/waddling/empty-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

// ── Local contracts (granular literal-SQL model; control-schema still coarse) ──

/** The granular privilege vocabulary birdshot enforces (control-api grant-store). */
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
type AclEffect = 'allow' | 'deny';

/** A stored grant/deny row (control-api's camelCase mapRow shape). */
interface GrantStatementRow {
  id: string;
  datalakeId: string;
  granteeKind: 'subject' | 'role' | 'public';
  grantee: string;
  stmt: string;
  version: number;
  createdAt: string;
}

interface DatalakeOption {
  id: string;
  name: string;
}

/** The birdshot subject for an agent = its JWT `sub` (control-api agentSubject). */
const agentSubject = (agentId: string): string => `agent:${agentId}`;

/** A statement is a DENY if its leading keyword is DENY (case-insensitive). */
function isDeny(statement: string): boolean {
  return /^\s*deny\b/i.test(statement);
}

// ── One verbatim statement row; DENY gets the "blocked" treatment ──────────────

function StatementRow({
  statement,
  action,
}: {
  statement: string;
  action?: React.ReactNode;
}) {
  const deny = isDeny(statement);
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
      <code className="min-w-0 flex-1 break-all whitespace-pre-wrap">{statement}</code>
      {action}
    </div>
  );
}

// ── Section ────────────────────────────────────────────────────────────────────

export function GrantsSection({ agentId }: { agentId: string }) {
  const [datalakes, setDatalakes] = useState<DatalakeOption[] | null>(null);
  const [datalakeId, setDatalakeId] = useState<string | null>(null);

  const [statements, setStatements] = useState<string[] | null>(null);
  const [ownRows, setOwnRows] = useState<GrantStatementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load the org's datalakes once — the panel is datalake-scoped.
  useEffect(() => {
    let cancelled = false;
    void fetchCp<{ datalakes: DatalakeOption[] }>('/api/cp/datalakes').then((res) => {
      if (cancelled) return;
      const list = res.ok ? res.data.datalakes.map((d) => ({ id: d.id, name: d.name })) : [];
      setDatalakes(list);
      setDatalakeId((cur) => cur ?? list[0]?.id ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    if (!datalakeId) return;
    setLoading(true);
    const dl = encodeURIComponent(datalakeId);
    const [grantsRes, aclRes] = await Promise.all([
      fetchCp<{ statements: string[] }>(
        `/api/cp/agents/${encodeURIComponent(agentId)}/grants?datalakeId=${dl}`,
      ),
      fetchCp<{ statements: GrantStatementRow[] }>(`/api/cp/acl?datalakeId=${dl}`),
    ]);
    if (!grantsRes.ok) {
      setError(grantsRes.error);
      setStatements(null);
      setLoading(false);
      return;
    }
    setError(null);
    setStatements(grantsRes.data.statements);
    const subject = agentSubject(agentId);
    setOwnRows(
      aclRes.ok
        ? aclRes.data.statements.filter(
            (r) => r.granteeKind === 'subject' && r.grantee === subject,
          )
        : [],
    );
    setLoading(false);
  }, [agentId, datalakeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const removeRow = useCallback(
    async (row: GrantStatementRow) => {
      const res = await cpDelete<{ success: boolean }>(
        `/api/cp/acl/${encodeURIComponent(row.id)}`,
      );
      if (res.ok) {
        toast.success('Statement removed');
        await load();
      } else {
        toast.error(res.error ?? 'Failed to remove statement');
      }
    },
    [load],
  );

  const datalakeSelect =
    datalakes && datalakes.length > 1 ? (
      <Select value={datalakeId ?? undefined} onValueChange={setDatalakeId}>
        <SelectTrigger size="sm" className="w-44">
          <SelectValue placeholder="Data lake" />
        </SelectTrigger>
        <SelectContent>
          {datalakes.map((d) => (
            <SelectItem key={d.id} value={d.id}>
              {d.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : null;

  // ── No datalakes at all ──────────────────────────────────────────────────────
  if (datalakes !== null && datalakes.length === 0) {
    return (
      <SectionCard title="Access">
        <EmptyState
          icon={<ShieldCheck aria-hidden="true" />}
          title="No data lakes yet"
          description="Create a data lake before you can grant this key access to tables."
        />
      </SectionCard>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ── Grant SQL (headline, read-only) ─────────────────────────────────── */}
      <SectionCard title="Grant SQL" headerActions={datalakeSelect}>
        <p className="text-xs text-muted-foreground">
          The literal GRANT / DENY statements this key resolves to, verbatim —
          including role-inherited and PUBLIC access. This is exactly what the
          gateway enforces.
        </p>

        <div className="mt-3">
          {loading || statements === null ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-9 w-full rounded-md" />
              <Skeleton className="h-9 w-full rounded-md" />
              <Skeleton className="h-9 w-3/4 rounded-md" />
            </div>
          ) : error ? (
            <Alert variant="destructive">
              <Ban className="size-4" />
              <AlertTitle>Couldn&apos;t load grants</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-3">
                {error}
                <Button variant="outline" size="sm" onClick={() => void load()}>
                  <RefreshCw data-icon="inline-start" />
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          ) : statements.length === 0 ? (
            <EmptyState
              icon={<ShieldCheck aria-hidden="true" />}
              title="No grants"
              description="This key has no access on this data lake. Add a grant below to give it access to a table."
            />
          ) : (
            <div className="flex flex-col gap-1.5">
              {statements.map((s, i) => (
                <StatementRow key={`${i}-${s}`} statement={s} />
              ))}
            </div>
          )}
        </div>
      </SectionCard>

      {/* ── This key's own statements (editable) ────────────────────────────── */}
      <SectionCard
        title="This key's grants"
        headerActions={
          <AddGrantDialog
            agentId={agentId}
            datalakeId={datalakeId}
            onAdded={load}
          />
        }
      >
        <p className="text-xs text-muted-foreground">
          Statements authored directly for this key. Role-inherited and PUBLIC
          access appears in Grant SQL above but is managed on the role, not here.
        </p>

        <div className="mt-3">
          {loading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-9 w-full rounded-md" />
              <Skeleton className="h-9 w-full rounded-md" />
            </div>
          ) : ownRows.length === 0 ? (
            <EmptyState
              icon={<ShieldCheck aria-hidden="true" />}
              title="No direct grants"
              description="Use “Add grant” to grant or deny this key access to a table."
            />
          ) : (
            <div className="flex flex-col gap-1.5">
              {ownRows.map((row) => (
                <StatementRow
                  key={row.id}
                  statement={row.stmt}
                  action={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 opacity-60 transition-opacity group-hover:opacity-100"
                      onClick={() => void removeRow(row)}
                      aria-label="Remove statement"
                    >
                      <Trash2 />
                    </Button>
                  }
                />
              ))}
            </div>
          )}
        </div>
      </SectionCard>
    </div>
  );
}

// ── Granular authoring dialog ──────────────────────────────────────────────────

function AddGrantDialog({
  agentId,
  datalakeId,
  onAdded,
}: {
  agentId: string;
  datalakeId: string | null;
  onAdded: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [effect, setEffect] = useState<AclEffect>('allow');
  const [selected, setSelected] = useState<Set<AclPrivilege>>(
    () => new Set<AclPrivilege>(['SELECT']),
  );
  const [schema, setSchema] = useState('');
  const [allTables, setAllTables] = useState(false);
  const [table, setTable] = useState('');
  const [columns, setColumns] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const togglePrivilege = (p: AclPrivilege) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  const reset = () => {
    setEffect('allow');
    setSelected(new Set<AclPrivilege>(['SELECT']));
    setSchema('');
    setAllTables(false);
    setTable('');
    setColumns('');
  };

  const tableValue = allTables ? '*' : table.trim();
  const canSubmit =
    !!datalakeId && selected.size > 0 && schema.trim().length > 0 && tableValue.length > 0;

  // Live preview of the literal statement this dialog will author.
  const preview = useMemo(() => {
    if (!canSubmit) return null;
    const cols = columns
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    const colSql = cols.length ? ` (${cols.join(', ')})` : '';
    const privList = [...selected].map((p) => `${p}${colSql}`).join(', ');
    const on = tableValue === '*' ? `ALL TABLES IN SCHEMA ${schema.trim()}` : `${schema.trim()}.${tableValue}`;
    const verb = effect === 'deny' ? 'DENY' : 'GRANT';
    return `${verb} ${privList} ON ${on} TO ${agentSubject(agentId)}`;
  }, [agentId, canSubmit, columns, effect, schema, selected, tableValue]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!datalakeId || !canSubmit) return;
    setSubmitting(true);
    const cols = columns
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    // One statement carrying every selected privilege (control-api's `privileges[]`).
    const res = await cpPost<{ statement: string }>('/api/cp/acl', {
      datalakeId,
      agentId,
      subjectKind: 'agent',
      privileges: [...selected],
      schema: schema.trim(),
      table: tableValue,
      effect,
      ...(cols.length > 0 ? { columns: cols } : {}),
    });
    setSubmitting(false);
    if (!res.ok) {
      if (res.status === 402 || res.code === 'upgrade_required') {
        toast.error('Dynamic grants require the Pro plan.');
      } else {
        toast.error(res.error ?? 'Failed to add grant');
      }
      return;
    }
    await onAdded();
    toast.success(effect === 'deny' ? 'Deny added' : 'Grant added');
    reset();
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={!datalakeId}>
          <Plus data-icon="inline-start" />
          Add grant
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add grant or deny</DialogTitle>
          <DialogDescription>
            Author a literal statement for{' '}
            <code className="font-mono text-xs">{agentSubject(agentId)}</code>.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="grant-effect">Effect</FieldLabel>
            <Select value={effect} onValueChange={(v) => setEffect(v as AclEffect)}>
              <SelectTrigger id="grant-effect" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="allow">GRANT (allow)</SelectItem>
                <SelectItem value="deny">DENY (block)</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel>Privileges</FieldLabel>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
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

          <Field>
            <FieldLabel htmlFor="grant-schema">Schema</FieldLabel>
            <Input
              id="grant-schema"
              value={schema}
              onChange={(e) => setSchema(e.target.value)}
              placeholder="sales"
              autoComplete="off"
            />
          </Field>

          <Field>
            <div className="flex items-center justify-between">
              <FieldLabel htmlFor="grant-table">Table</FieldLabel>
              <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground select-none">
                <Checkbox
                  checked={allTables}
                  onCheckedChange={(v) => setAllTables(v === true)}
                  aria-label="All tables in schema"
                />
                All tables in schema
              </label>
            </div>
            <Input
              id="grant-table"
              value={allTables ? '*' : table}
              onChange={(e) => setTable(e.target.value)}
              placeholder="orders"
              autoComplete="off"
              disabled={allTables}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="grant-columns">Columns (optional)</FieldLabel>
            <Input
              id="grant-columns"
              value={columns}
              onChange={(e) => setColumns(e.target.value)}
              placeholder="email, region  (comma-separated; blank = all)"
              autoComplete="off"
            />
          </Field>

          {preview ? (
            <StatementRow statement={preview} />
          ) : (
            <p className="text-xs text-muted-foreground">
              Pick at least one privilege and a schema.table to preview the statement.
            </p>
          )}

          <DialogFooter>
            <Button type="submit" disabled={submitting || !canSubmit}>
              {submitting ? 'Adding…' : 'Add statement'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
