'use client';

/**
 * Catalog-aware scope picker — the shared authoring surface for agent access.
 *
 * Instead of free-text schema/table (which produced non-matching grants like
 * `main.*`), the user picks REAL tables from the datalake's live catalog, or an
 * explicit "entire schema / entire lake (incl. future tables)" scope. Each choice
 * becomes a concrete GrantRow that the control plane turns into an acl_rule.
 *
 * Used by the create-and-scope wizard (agents page) and the in-place scope editor
 * (agent detail). It manages a STAGED list of grants; the parent submits them.
 */
import { useEffect, useState, useCallback } from 'react';
import { Plus, X, RefreshCw, AlertCircle, Table2, Layers, Database } from 'lucide-react';
import { fetchCp } from '@/components/dashboard/fetch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

export type Capability = 'read' | 'write' | 'create' | 'drop' | 'alter' | 'detach';

export const SCOPE_CAPABILITIES: Capability[] = ['read', 'write', 'create', 'drop', 'alter', 'detach'];

export interface GrantRow {
  datalakeId: string;
  capability: Capability;
  schema: string;
  table: string;
  columns?: string[];
  rowLimit?: number;
  ttlSeconds?: number;
}

interface CatalogColumn { name: string; type: string; nullable: boolean }
interface CatalogTable { name: string; columns: CatalogColumn[] }
interface CatalogSchema { name: string; tables: CatalogTable[] }
interface CatalogResponse { datalakeId: string; schemas: CatalogSchema[]; fetchedAt: string | null; stale: boolean }

/** A short human label for a grant row (e.g. "read main.hn_posts" / "read main.* (all)"). */
export function grantLabel(g: GrantRow): string {
  const target =
    g.schema === '*' ? 'entire lake' : g.table === '*' ? `${g.schema}.* (whole schema)` : `${g.schema}.${g.table}`;
  return `${g.capability} ${target}`;
}

interface ScopePickerProps {
  /** Datalakes the user may scope against (id + name). */
  datalakes: { id: string; name: string }[];
  /** Currently staged grants. */
  grants: GrantRow[];
  onChange: (grants: GrantRow[]) => void;
  /** Pin to a single datalake (in-place editor on a session/agent already on one lake). */
  fixedDatalakeId?: string;
}

export function ScopePicker({ datalakes, grants, onChange, fixedDatalakeId }: ScopePickerProps) {
  const [datalakeId, setDatalakeId] = useState<string>(fixedDatalakeId ?? datalakes[0]?.id ?? '');
  const [capability, setCapability] = useState<Capability>('read');
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set()); // "schema.table"
  const [wholeSchema, setWholeSchema] = useState<string>('');
  const [mode, setMode] = useState<'tables' | 'schema' | 'lake'>('tables');

  const loadCatalog = useCallback(async (id: string, refresh = false) => {
    if (!id) return;
    setLoadingCatalog(true);
    setCatalogError(null);
    const path = `/api/cp/datalakes/${id}/catalog`;
    const res = refresh
      ? await fetchCp<CatalogResponse>(path + '/refresh', { method: 'POST', body: '{}' })
      : await fetchCp<CatalogResponse>(path);
    setLoadingCatalog(false);
    if (!res.ok) {
      setCatalog(null);
      setCatalogError(res.error);
      return;
    }
    setCatalog(res.data);
  }, []);

  useEffect(() => {
    setChecked(new Set());
    setWholeSchema('');
    void loadCatalog(datalakeId);
  }, [datalakeId, loadCatalog]);

  const schemas = catalog?.schemas ?? [];
  const empty = !loadingCatalog && !catalogError && schemas.length === 0;

  const toggle = (key: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const addGrants = () => {
    const rows: GrantRow[] = [];
    if (mode === 'lake') {
      rows.push({ datalakeId, capability, schema: '*', table: '*' });
    } else if (mode === 'schema') {
      if (!wholeSchema) return;
      rows.push({ datalakeId, capability, schema: wholeSchema, table: '*' });
    } else {
      for (const key of checked) {
        const [schema, ...rest] = key.split('.');
        rows.push({ datalakeId, capability, schema, table: rest.join('.') });
      }
    }
    if (rows.length === 0) return;
    // Dedupe against existing staged grants (same datalake/capability/schema/table).
    const seen = new Set(grants.map((g) => `${g.datalakeId}|${g.capability}|${g.schema}|${g.table}`));
    const fresh = rows.filter((r) => !seen.has(`${r.datalakeId}|${r.capability}|${r.schema}|${r.table}`));
    if (fresh.length) onChange([...grants, ...fresh]);
    setChecked(new Set());
    setWholeSchema('');
  };

  const removeGrant = (i: number) => onChange(grants.filter((_, idx) => idx !== i));

  const dlName = (id: string) => datalakes.find((d) => d.id === id)?.name ?? id;
  const canAdd =
    mode === 'lake' || (mode === 'schema' && !!wholeSchema) || (mode === 'tables' && checked.size > 0);

  return (
    <div className="flex flex-col gap-3">
      {/* datalake + capability */}
      <div className="grid grid-cols-2 gap-2">
        {!fixedDatalakeId && (
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Data lake</Label>
            <Select value={datalakeId} onValueChange={setDatalakeId}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Select a lake" /></SelectTrigger>
              <SelectContent>
                {datalakes.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className={`flex flex-col gap-1 ${fixedDatalakeId ? 'col-span-2' : ''}`}>
          <Label className="text-xs text-muted-foreground">Capability</Label>
          <Select value={capability} onValueChange={(v) => setCapability(v as Capability)}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {SCOPE_CAPABILITIES.map((cap) => <SelectItem key={cap} value={cap}>{cap}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* scope mode */}
      <Tabs value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
        <TabsList className="w-full">
          <TabsTrigger value="tables" className="flex-1 gap-1"><Table2 className="size-3.5" />Tables</TabsTrigger>
          <TabsTrigger value="schema" className="flex-1 gap-1"><Layers className="size-3.5" />Schema</TabsTrigger>
          <TabsTrigger value="lake" className="flex-1 gap-1"><Database className="size-3.5" />Lake</TabsTrigger>
        </TabsList>

        <TabsContent value="tables" className="mt-2">
          {loadingCatalog ? (
            <p className="text-sm text-muted-foreground py-3">Loading catalog…</p>
          ) : catalogError ? (
            <div className="flex items-center gap-2 text-sm text-destructive py-2">
              <AlertCircle className="size-4" /> {catalogError}
              <Button size="sm" variant="ghost" onClick={() => void loadCatalog(datalakeId, true)}>
                <RefreshCw className="size-3.5" /> Retry
              </Button>
            </div>
          ) : empty ? (
            <p className="text-sm text-muted-foreground py-3">
              No tables found in this lake yet. Create one via ETL, then refresh.
            </p>
          ) : (
            <ScrollArea className="h-48 rounded-md border p-2">
              <div className="flex flex-col gap-2">
                {schemas.map((s) => (
                  <div key={s.name} className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted-foreground">{s.name}</span>
                    {s.tables.map((t) => {
                      const key = `${s.name}.${t.name}`;
                      return (
                        <label key={key} className="flex items-center gap-2 pl-2 py-0.5 cursor-pointer text-sm">
                          <Checkbox checked={checked.has(key)} onCheckedChange={() => toggle(key)} />
                          <span className="font-mono">{t.name}</span>
                          <span className="text-xs text-muted-foreground">{t.columns.length} cols</span>
                        </label>
                      );
                    })}
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </TabsContent>

        <TabsContent value="schema" className="mt-2">
          <Label className="text-xs text-muted-foreground">Entire schema (incl. future tables)</Label>
          <Select value={wholeSchema} onValueChange={setWholeSchema}>
            <SelectTrigger className="w-full mt-1"><SelectValue placeholder="Select a schema" /></SelectTrigger>
            <SelectContent>
              {schemas.map((s) => <SelectItem key={s.name} value={s.name}>{s.name} ({s.tables.length})</SelectItem>)}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-1.5">
            Grants every current and future table in the schema (read/write expand automatically).
          </p>
        </TabsContent>

        <TabsContent value="lake" className="mt-2">
          <p className="text-sm">Grant <span className="font-medium">{capability}</span> on the <span className="font-medium">entire lake</span> — every schema and table, including future ones.</p>
        </TabsContent>
      </Tabs>

      <Button type="button" variant="secondary" size="sm" onClick={addGrants} disabled={!canAdd} className="self-start">
        <Plus className="size-3.5" /> Add to scope
      </Button>

      {/* staged grants */}
      {grants.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-md border p-2">
          <span className="text-xs text-muted-foreground">Scope ({grants.length})</span>
          <div className="flex flex-wrap gap-1.5">
            {grants.map((g, i) => (
              <Badge key={i} variant="secondary" className="gap-1 font-mono text-xs">
                {!fixedDatalakeId && datalakes.length > 1 && (
                  <span className="text-muted-foreground">{dlName(g.datalakeId)}:</span>
                )}
                {grantLabel(g)}
                <button type="button" onClick={() => removeGrant(i)} className="ml-0.5 hover:text-destructive">
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
