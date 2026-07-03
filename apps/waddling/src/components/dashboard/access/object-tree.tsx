'use client';

/**
 * Live schema browser (P1 — browse, don't recall). A tree of the datalake's real
 * schemas → tables → columns, fetched from GET /api/cp/datalakes/:id/catalog. Every
 * node shows its RESOLVED status + provenance (P2/P6), computed client-side from the
 * server's `parsed` facts (own draft ∪ role ∪ PUBLIC ∪ denies) — never by parsing SQL.
 *
 * Editing is object-centric: a per-node CapabilityControl authors/edits ONE own
 * object grant for that scope; an Allow/Deny toggle turns a table grant into a
 * deny carve-out; expanding a table reveals a column multiselect drawn from the
 * table's REAL columns.
 *
 * Salvages access-editor.tsx's collapsible `renderSchema` shell + discovery states.
 */
import { useMemo, useState } from 'react';
import {
  ChevronRight,
  Layers,
  Table2,
  Database,
  Ban,
  Check,
  RefreshCw,
  AlertCircle,
  Plus,
  Search,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { CapabilityControl } from './capability-control';
import {
  nodeStatus,
  type AclEffect,
  type CatalogColumn,
  type CatalogSchema,
  type GrantFact,
  type NodeStatus,
  type Privilege,
} from './access-draft';

/** The resolved catalog fetch state (owned + narrowed by AccessManager). */
export type CatalogState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'provisioning' }
  | { kind: 'ready'; schemas: CatalogSchema[]; fetchedAt: string | null; stale?: boolean };

/** The scope a tree node grants on. */
export type NodeScope =
  | { schema: string; table: string }
  | { schema: string; allTables: true };

/** The editable own-grant state at a node (or null = no own grant). */
export interface NodeOwnValue {
  privileges: Privilege[];
  columns: string[] | null;
  effect: AclEffect;
}

interface ObjectTreeProps {
  catalog: CatalogState;
  facts: GrantFact[];
  /** Read the draft's own grant for a scope (null = none authored on this key). */
  readNode: (scope: NodeScope) => NodeOwnValue | null;
  /** Upsert (or remove, with null) the draft's own grant for a scope. */
  writeNode: (scope: NodeScope, value: NodeOwnValue | null) => void;
  onRefresh: () => void;
  refreshing: boolean;
  /** Extra (free-text) schema names authored on this key but absent from the catalog. */
  extraSchemas: string[];
  onAddExtraSchema: (name: string) => void;
  readOnly?: boolean;
}

// ── Status chip ──────────────────────────────────────────────────────────────

function StatusChip({ status }: { status: NodeStatus }) {
  if (status.status === 'none') return null;
  if (status.status === 'denied') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
        <Ban className="size-3" />
        {status.via === 'carve-out' ? 'carve-out · overrides schema grant' : 'denied'}
      </span>
    );
  }
  const viaLabel =
    status.via === 'schema'
      ? 'via schema wildcard'
      : status.via === 'role'
        ? `via role ${status.role ?? ''}`.trim()
        : status.via === 'public'
          ? 'PUBLIC'
          : null;
  const priv =
    status.privileges.length > 0
      ? status.privileges.join(', ') + (status.columns && status.columns.length ? ` (${status.columns.join(', ')})` : '')
      : '';
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <Check className="size-3 text-emerald-600 dark:text-emerald-400" />
      {priv && <span className="font-mono text-emerald-700 dark:text-emerald-400">{priv}</span>}
      {viaLabel && (
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{viaLabel}</span>
      )}
    </span>
  );
}

// ── Allow / Deny segmented toggle ────────────────────────────────────────────

function EffectToggle({
  effect,
  onChange,
  disabled,
}: {
  effect: AclEffect;
  onChange: (e: AclEffect) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border" role="group" aria-label="Effect">
      {(['allow', 'deny'] as const).map((e) => (
        <button
          key={e}
          type="button"
          disabled={disabled}
          onClick={() => onChange(e)}
          className={cn(
            'px-2 py-0.5 text-[11px] font-medium capitalize transition-colors',
            effect === e
              ? e === 'deny'
                ? 'bg-destructive/10 text-destructive'
                : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
              : 'text-muted-foreground hover:bg-muted',
          )}
        >
          {e}
        </button>
      ))}
    </div>
  );
}

// ── Tree ─────────────────────────────────────────────────────────────────────

export function ObjectTree(props: ObjectTreeProps) {
  const { catalog, facts, readNode, writeNode, onRefresh, refreshing, readOnly } = props;
  const [query, setQuery] = useState('');
  const [openSchemas, setOpenSchemas] = useState<Set<string>>(new Set());
  const [openTables, setOpenTables] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState('');

  const q = query.trim().toLowerCase();

  const schemas: CatalogSchema[] = useMemo(() => {
    const base = catalog.kind === 'ready' ? catalog.schemas : [];
    const extraNodes: CatalogSchema[] = props.extraSchemas
      .filter((s) => !base.some((b) => b.name === s))
      .map((s) => ({ name: s, tables: [] }));
    return [...base, ...extraNodes];
  }, [catalog, props.extraSchemas]);

  const toggleSchema = (name: string) =>
    setOpenSchemas((prev) => {
      const n = new Set(prev);
      n.has(name) ? n.delete(name) : n.add(name);
      return n;
    });
  const toggleTable = (key: string) =>
    setOpenTables((prev) => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });

  // ── discovery states ───────────────────────────────────────────────────────
  if (catalog.kind === 'loading') {
    return (
      <div className="flex flex-col gap-2 pt-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-7 w-full rounded-md" />
        ))}
      </div>
    );
  }
  if (catalog.kind === 'error') {
    return (
      <div className="flex flex-col items-start gap-2 py-4">
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="size-4" /> Couldn&apos;t reach this lake&apos;s gateway.
        </div>
        <p className="text-xs text-muted-foreground">{catalog.message}</p>
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} /> Retry
        </Button>
        <p className="pt-1 text-xs text-muted-foreground">
          You can still author a grant on a known object below (free-text fallback).
        </p>
        <FreeTextFallback value={extra} onChange={setExtra} onAdd={props.onAddExtraSchema} readOnly={readOnly} />
      </div>
    );
  }
  if (catalog.kind === 'provisioning') {
    return (
      <div className="flex flex-col items-start gap-2 py-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Database className="size-4" /> Catalog still provisioning.
        </div>
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} /> Refresh
        </Button>
        <FreeTextFallback value={extra} onChange={setExtra} onAdd={props.onAddExtraSchema} readOnly={readOnly} />
      </div>
    );
  }

  const empty = schemas.length === 0;

  return (
    <div className="flex flex-col gap-2">
      {/* search + freshness */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search schemas, tables, columns…"
            className="h-8 pl-7"
          />
        </div>
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          {catalog.fetchedAt ? (
            <>
              <span title={catalog.fetchedAt}>{catalog.stale ? 'stale · ' : ''}snapshot</span>
              <Button
                size="icon"
                variant="ghost"
                className="size-6"
                onClick={onRefresh}
                disabled={refreshing}
                aria-label="Refresh catalog"
              >
                <RefreshCw className={cn('size-3', refreshing && 'animate-spin')} />
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {/* legend */}
      <div className="flex flex-wrap items-center gap-3 border-b pb-1.5 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Check className="size-3 text-emerald-600 dark:text-emerald-400" /> allowed
        </span>
        <span className="inline-flex items-center gap-1">
          <Ban className="size-3 text-destructive" /> denied / carve-out
        </span>
        <span>chips show provenance</span>
      </div>

      {empty ? (
        <p className="py-4 text-sm text-muted-foreground">No schemas or tables in this lake yet.</p>
      ) : (
        <div className="flex flex-col">
          {schemas.map((s) => {
            const schemaScope: NodeScope = { schema: s.name, allTables: true };
            const schemaStatus = nodeStatus(facts, s.name, null);
            const own = readNode(schemaScope);
            const tables = q
              ? s.tables.filter(
                  (t) =>
                    t.name.toLowerCase().includes(q) ||
                    s.name.toLowerCase().includes(q) ||
                    t.columns.some((c) => c.name.toLowerCase().includes(q)),
                )
              : s.tables;
            const schemaMatches = !q || s.name.toLowerCase().includes(q) || tables.length > 0;
            if (!schemaMatches) return null;
            const open = openSchemas.has(s.name) || (q ? tables.length > 0 : false);
            return (
              <Collapsible
                key={s.name}
                open={open}
                onOpenChange={() => toggleSchema(s.name)}
                className="border-b"
              >
                <div className="flex items-center justify-between gap-2 py-1.5">
                  <CollapsibleTrigger className="flex min-w-0 items-center gap-1.5 text-sm font-medium hover:text-foreground/80">
                    <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
                    <Layers className="size-3.5 text-muted-foreground" />
                    <span className="font-mono">{s.name}</span>
                    <span className="truncate text-xs font-normal text-muted-foreground">
                      {s.tables.length ? `${s.tables.length} tables · all tables in schema` : 'whole schema (incl. future)'}
                    </span>
                  </CollapsibleTrigger>
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusChip status={schemaStatus} />
                    <CapabilityControl
                      privileges={own?.privileges ?? []}
                      disabled={readOnly}
                      onChange={(next) =>
                        writeNode(
                          schemaScope,
                          next.length
                            ? { privileges: next, columns: null, effect: own?.effect ?? 'allow' }
                            : null,
                        )
                      }
                    />
                  </div>
                </div>
                <CollapsibleContent className="pl-6">
                  {tables.length === 0 ? (
                    <p className="py-1 text-xs text-muted-foreground">No tables yet.</p>
                  ) : (
                    tables.map((t) => {
                      const tableScope: NodeScope = { schema: s.name, table: t.name };
                      const tkey = `${s.name}.${t.name}`;
                      const status = nodeStatus(facts, s.name, t.name);
                      const tOwn = readNode(tableScope);
                      const colsOpen = openTables.has(tkey);
                      // Offer a Deny carve-out when the table is covered by a schema allow.
                      const showDeny = tOwn != null || status.status === 'allowed';
                      return (
                        <div key={t.name} className="border-b border-dashed py-1 last:border-0">
                          <div className="flex items-center justify-between gap-2">
                            <button
                              type="button"
                              onClick={() => t.columns.length && toggleTable(tkey)}
                              className="flex min-w-0 items-center gap-1.5 text-sm hover:text-foreground/80"
                            >
                              <ChevronRight
                                className={cn(
                                  'size-3 text-muted-foreground transition-transform',
                                  colsOpen && 'rotate-90',
                                  !t.columns.length && 'invisible',
                                )}
                              />
                              <Table2 className="size-3.5 text-muted-foreground" />
                              <span className="font-mono">{t.name}</span>
                              <span className="text-xs text-muted-foreground">{t.columns.length} cols</span>
                            </button>
                            <div className="flex shrink-0 items-center gap-2">
                              <StatusChip status={status} />
                              {showDeny && (
                                <EffectToggle
                                  effect={tOwn?.effect ?? 'allow'}
                                  disabled={readOnly}
                                  onChange={(effect) => {
                                    const base = tOwn ?? {
                                      privileges: status.status === 'allowed' ? status.privileges as Privilege[] : ['SELECT'],
                                      columns: null,
                                      effect: 'allow' as AclEffect,
                                    };
                                    writeNode(tableScope, { ...base, effect });
                                  }}
                                />
                              )}
                              <CapabilityControl
                                privileges={tOwn?.privileges ?? []}
                                disabled={readOnly}
                                onChange={(next) =>
                                  writeNode(
                                    tableScope,
                                    next.length
                                      ? {
                                          privileges: next,
                                          columns: tOwn?.columns ?? null,
                                          effect: tOwn?.effect ?? 'allow',
                                        }
                                      : null,
                                  )
                                }
                              />
                            </div>
                          </div>
                          {colsOpen && t.columns.length > 0 && (
                            <ColumnPicker
                              columns={t.columns}
                              selected={tOwn?.columns ?? null}
                              disabled={readOnly}
                              onChange={(cols) => {
                                const base = tOwn ?? { privileges: ['SELECT'] as Privilege[], columns: null, effect: 'allow' as AclEffect };
                                writeNode(tableScope, {
                                  ...base,
                                  privileges: base.privileges.length ? base.privileges : (['SELECT'] as Privilege[]),
                                  columns: cols && cols.length ? cols : null,
                                });
                              }}
                            />
                          )}
                        </div>
                      );
                    })
                  )}
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>
      )}

      <FreeTextFallback value={extra} onChange={setExtra} onAdd={props.onAddExtraSchema} readOnly={readOnly} />
    </div>
  );
}

// ── Column multiselect ───────────────────────────────────────────────────────

function ColumnPicker({
  columns,
  selected,
  onChange,
  disabled,
}: {
  columns: CatalogColumn[];
  selected: string[] | null;
  onChange: (cols: string[] | null) => void;
  disabled?: boolean;
}) {
  const set = new Set(selected ?? []);
  const toggle = (name: string) => {
    const n = new Set(set);
    n.has(name) ? n.delete(name) : n.add(name);
    const ordered = columns.map((c) => c.name).filter((c) => n.has(c));
    onChange(ordered.length ? ordered : null);
  };
  return (
    <div className="mt-1 flex flex-wrap gap-1.5 rounded-md bg-muted/40 p-2 pl-6">
      <span className="w-full pb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        Columns {selected && selected.length ? `· ${selected.length} selected` : '· all columns'}
      </span>
      {columns.map((c) => (
        <label
          key={c.name}
          className="flex cursor-pointer items-center gap-1.5 rounded border bg-background px-1.5 py-0.5 text-xs has-[:checked]:border-primary has-[:checked]:bg-primary/5"
        >
          <Checkbox
            checked={set.has(c.name)}
            disabled={disabled}
            onCheckedChange={() => toggle(c.name)}
            aria-label={c.name}
            className="size-3.5"
          />
          <span className="font-mono">{c.name}</span>
          <span className="text-[10px] text-muted-foreground">{c.type}</span>
        </label>
      ))}
    </div>
  );
}

// ── Free-text fallback (§5.4) ────────────────────────────────────────────────

function FreeTextFallback({
  value,
  onChange,
  onAdd,
  readOnly,
}: {
  value: string;
  onChange: (v: string) => void;
  onAdd: (name: string) => void;
  readOnly?: boolean;
}) {
  const commit = () => {
    const name = value.trim();
    if (!name || /[^a-zA-Z0-9_]/.test(name)) return;
    onAdd(name);
    onChange('');
  };
  return (
    <div className="flex items-center gap-2 pt-2">
      <span className="text-[11px] text-muted-foreground">Not in the catalog?</span>
      <Input
        value={value}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        placeholder="grant a schema by name (e.g. marketing)"
        className="h-7 flex-1 font-mono text-xs"
      />
      <Button type="button" size="sm" variant="secondary" onClick={commit} disabled={readOnly || !value.trim()}>
        <Plus className="size-3.5" /> Add
      </Button>
    </div>
  );
}
