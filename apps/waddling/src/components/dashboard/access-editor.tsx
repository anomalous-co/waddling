'use client';

/**
 * Access editor body — a settings-style LEFT section nav (Catalog / Sources /
 * Extensions, collapsible) with the active section's content on the right. The
 * parent supplies the rounded scroll container + fixed height + footer; this
 * component just fills it and edits the controlled AccessModel via value/onChange.
 *
 *  - Catalog   : resource tree (lake → schema → table) with a compact per-row
 *                capability dropdown (read/write/create/drop/alter/detach).
 *  - Sources   : read_source / copy_from / copy_to / attach — each expands to a
 *                list of add/remove pattern boxes (one acl_policy row per box).
 *  - Extensions: install / load — same pattern-box treatment.
 *
 * Catalog grants are TABLE-LEVEL (no column allow-list) on purpose: the compiler's
 * fail-closed guard drops any role that mixes a column allow-list with a
 * parse-authorized capability/policy — exactly the ETL/source-agent shape.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronRight, ChevronDown, Plus, X, RefreshCw, AlertCircle,
  Database, Layers, Table2, Globe, PanelLeftClose, PanelLeft,
  ArrowDownToLine, Download, Upload, Link2, Package, PackageOpen, Pencil, Check,
} from 'lucide-react';
import { fetchCp } from '@/components/dashboard/fetch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuCheckboxItem, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  CATALOG_CAPABILITIES,
  policyPatternHint,
  type AccessModel,
  type CatalogCapability,
  type GrantTarget,
  type PolicyCapability,
  type PolicyEntry,
} from '@/lib/access-diff';

const SOURCE_CAPS: PolicyCapability[] = ['read_source', 'copy_from', 'copy_to', 'attach'];
const EXTENSION_CAPS: PolicyCapability[] = ['install', 'load'];

const POLICY_ICON: Record<PolicyCapability, typeof Database> = {
  read_source: ArrowDownToLine,
  copy_from: Download,
  copy_to: Upload,
  attach: Link2,
  install: Package,
  load: PackageOpen,
};
// Short, header-visible description so you don't have to expand a row to know what it is.
const POLICY_BLURB: Record<PolicyCapability, string> = {
  read_source: 'read external files — https host or exact s3:// glob',
  copy_from: 'COPY FROM an external source',
  copy_to: 'COPY TO an external destination',
  attach: 'ATTACH an external database — host or DSN',
  install: 'INSTALL a DuckDB extension, by name',
  load: 'LOAD a DuckDB extension, by name',
};

type Section = 'catalog' | 'sources' | 'extensions';
const SECTIONS: { id: Section; label: string; icon: typeof Database }[] = [
  { id: 'catalog', label: 'Catalog', icon: Database },
  { id: 'sources', label: 'Sources', icon: Globe },
  { id: 'extensions', label: 'Extensions', icon: Layers },
];

interface CatalogColumn { name: string; type: string; nullable: boolean }
interface CatalogTable { name: string; columns: CatalogColumn[] }
interface CatalogSchema { name: string; tables: CatalogTable[] }
interface CatalogResponse { datalakeId: string; schemas: CatalogSchema[]; fetchedAt: string | null; stale: boolean }

interface AccessEditorProps {
  datalakes: { id: string; name: string }[];
  value: AccessModel;
  onChange: (m: AccessModel) => void;
  /** Pin to one lake (agent detail). Otherwise the user picks which lake's tree to edit. */
  fixedDatalakeId?: string;
}

export function AccessEditor({ datalakes, value, onChange, fixedDatalakeId }: AccessEditorProps) {
  const [datalakeId, setDatalakeId] = useState<string>(fixedDatalakeId ?? datalakes[0]?.id ?? '');
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openSchemas, setOpenSchemas] = useState<Set<string>>(new Set());
  const [openPolicies, setOpenPolicies] = useState<Set<PolicyCapability>>(new Set());
  const [extraSchema, setExtraSchema] = useState('');
  const [section, setSection] = useState<Section>('catalog');
  const [navOpen, setNavOpen] = useState(true); // inline nav collapse (md+)
  const [navSheetOpen, setNavSheetOpen] = useState(false); // slide-over nav (small screens)
  // policy-pattern entry state: a trailing empty "draft" per capability, and which
  // saved pattern (if any) is being edited in place.
  const [drafts, setDrafts] = useState<Partial<Record<PolicyCapability, string>>>({});
  const [editing, setEditing] = useState<{ cap: PolicyCapability; index: number } | null>(null);
  const [editBuf, setEditBuf] = useState('');

  const loadCatalog = useCallback(async (id: string, refresh = false) => {
    if (!id) return;
    setLoading(true);
    setError(null);
    const path = `/api/cp/datalakes/${id}/catalog`;
    const res = refresh
      ? await fetchCp<CatalogResponse>(path + '/refresh', { method: 'POST', body: '{}' })
      : await fetchCp<CatalogResponse>(path);
    setLoading(false);
    if (!res.ok) { setCatalog(null); setError(res.error); return; }
    setCatalog(res.data);
  }, []);

  useEffect(() => { void loadCatalog(datalakeId); }, [datalakeId, loadCatalog]);

  // ── model accessors (scoped to the selected lake) ─────────────────────────────
  const capsFor = useCallback(
    (schema: string, table: string): CatalogCapability[] =>
      value.grants.find((g) => g.datalakeId === datalakeId && g.schema === schema && g.table === table)?.caps ?? [],
    [value.grants, datalakeId],
  );
  const setCapsFor = (schema: string, table: string, caps: CatalogCapability[]) => {
    const rest = value.grants.filter(
      (g) => !(g.datalakeId === datalakeId && g.schema === schema && g.table === table),
    );
    const next: GrantTarget[] = caps.length ? [...rest, { datalakeId, schema, table, caps }] : rest;
    onChange({ ...value, grants: next });
  };
  const patternsFor = useCallback(
    (cap: PolicyCapability): PolicyEntry[] =>
      value.policies.filter((p) => p.datalakeId === datalakeId && p.capability === cap),
    [value.policies, datalakeId],
  );
  const setPatternsFor = (cap: PolicyCapability, patterns: string[]) => {
    const rest = value.policies.filter((p) => !(p.datalakeId === datalakeId && p.capability === cap));
    onChange({ ...value, policies: [...rest, ...patterns.map((pattern) => ({ datalakeId, capability: cap, pattern }))] });
  };

  const catalogSchemaNames = useMemo(() => (catalog?.schemas ?? []).map((s) => s.name), [catalog]);
  const extraSchemaNames = useMemo(() => {
    const fromGrants = value.grants
      .filter((g) => g.datalakeId === datalakeId && g.schema !== '*' && g.table === '*')
      .map((g) => g.schema);
    return [...new Set(fromGrants)].filter((s) => !catalogSchemaNames.includes(s));
  }, [value.grants, datalakeId, catalogSchemaNames]);

  const toggleSchema = (name: string) =>
    setOpenSchemas((prev) => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n; });
  const togglePolicy = (cap: PolicyCapability) =>
    setOpenPolicies((prev) => { const n = new Set(prev); n.has(cap) ? n.delete(cap) : n.add(cap); return n; });

  const addExtraSchema = () => {
    const name = extraSchema.trim();
    if (!name || /[^a-zA-Z0-9_]/.test(name)) return;
    if (!value.grants.some((g) => g.datalakeId === datalakeId && g.schema === name && g.table === '*')) {
      onChange({ ...value, grants: [...value.grants, { datalakeId, schema: name, table: '*', caps: [] }] });
    }
    setOpenSchemas((prev) => new Set(prev).add(name));
    setExtraSchema('');
  };

  // ── count grants/patterns per section for the nav badges ──────────────────────
  const catalogCount = value.grants.filter((g) => g.datalakeId === datalakeId && g.caps.length > 0).length;
  const sourcesCount = value.policies.filter((p) => p.datalakeId === datalakeId && SOURCE_CAPS.includes(p.capability) && p.pattern.trim()).length;
  const extensionsCount = value.policies.filter((p) => p.datalakeId === datalakeId && EXTENSION_CAPS.includes(p.capability) && p.pattern.trim()).length;
  const sectionCount: Record<Section, number> = { catalog: catalogCount, sources: sourcesCount, extensions: extensionsCount };

  const verbRow = (schema: string, table: string) => (
    <CapabilityMenu value={capsFor(schema, table)} onChange={(c) => setCapsFor(schema, table, c)} />
  );

  const renderSchema = (name: string, tables: CatalogTable[]) => {
    const open = openSchemas.has(name);
    return (
      <Collapsible key={name} open={open} onOpenChange={() => toggleSchema(name)} className="border-b">
        <div className="flex items-center justify-between gap-2 py-1.5">
          <CollapsibleTrigger className="flex items-center gap-1.5 text-sm font-medium hover:text-foreground/80">
            <ChevronRight className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
            <Layers className="size-3.5 text-muted-foreground" />
            <span className="font-mono">{name}</span>
            <span className="text-xs text-muted-foreground">
              {tables.length ? `${tables.length} tables · whole schema` : 'whole schema (incl. future)'}
            </span>
          </CollapsibleTrigger>
          {verbRow(name, '*')}
        </div>
        <CollapsibleContent className="pl-6">
          {tables.map((t) => (
            <div key={t.name} className="flex items-center justify-between gap-2 py-1">
              <span className="flex items-center gap-1.5 text-sm">
                <Table2 className="size-3.5 text-muted-foreground" />
                <span className="font-mono">{t.name}</span>
                <span className="text-xs text-muted-foreground">{t.columns.length} cols</span>
              </span>
              {verbRow(name, t.name)}
            </div>
          ))}
        </CollapsibleContent>
      </Collapsible>
    );
  };

  const commitNew = (cap: PolicyCapability) => {
    const v = (drafts[cap] ?? '').trim();
    if (!v) return;
    const patterns = patternsFor(cap).map((e) => e.pattern);
    if (!patterns.includes(v)) setPatternsFor(cap, [...patterns, v]);
    setDrafts((d) => ({ ...d, [cap]: '' }));
  };
  const commitEdit = (cap: PolicyCapability, index: number) => {
    const v = editBuf.trim();
    const patterns = patternsFor(cap).map((e) => e.pattern);
    setPatternsFor(cap, v ? patterns.map((p, j) => (j === index ? v : p)) : patterns.filter((_, j) => j !== index));
    setEditing(null);
    setEditBuf('');
  };

  const renderPolicyCap = (cap: PolicyCapability) => {
    const patterns = patternsFor(cap).map((e) => e.pattern);
    const open = openPolicies.has(cap) || patterns.length > 0;
    const Icon = POLICY_ICON[cap];
    return (
      <Collapsible key={cap} open={open} onOpenChange={() => togglePolicy(cap)} className="border-b">
        <div className="flex items-center justify-between gap-2 py-2">
          <CollapsibleTrigger className="flex min-w-0 items-center gap-2 text-sm hover:text-foreground/80">
            <ChevronRight className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="font-medium">{cap}</span>
            <span className="truncate text-xs text-muted-foreground">{POLICY_BLURB[cap]}</span>
          </CollapsibleTrigger>
          {patterns.length > 0 && (
            <span className="shrink-0 text-xs text-muted-foreground">{patterns.length} pattern{patterns.length > 1 ? 's' : ''}</span>
          )}
        </div>
        <CollapsibleContent className="pl-7 pb-2">
          <div className="flex flex-col gap-1.5">
            {patterns.map((p, i) =>
              editing && editing.cap === cap && editing.index === i ? (
                <div key={i} className="flex items-center gap-1">
                  <Input
                    autoFocus
                    value={editBuf}
                    onChange={(e) => setEditBuf(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitEdit(cap, i); }
                      if (e.key === 'Escape') { setEditing(null); setEditBuf(''); }
                    }}
                    onBlur={() => commitEdit(cap, i)}
                    className="h-7 flex-1 font-mono text-xs"
                  />
                </div>
              ) : (
                <div key={i} className="flex items-center gap-1 rounded-md border bg-muted/40 py-1 pl-2 pr-1">
                  <span className="flex-1 truncate font-mono text-xs">{p}</span>
                  <Button type="button" size="icon" variant="ghost" className="size-6"
                    onClick={() => { setEditing({ cap, index: i }); setEditBuf(p); }} aria-label="Edit pattern">
                    <Pencil className="size-3" />
                  </Button>
                  <Button type="button" size="icon" variant="ghost" className="size-6 hover:text-destructive"
                    onClick={() => setPatternsFor(cap, patterns.filter((_, j) => j !== i))} aria-label="Remove pattern">
                    <X className="size-3" />
                  </Button>
                </div>
              ),
            )}
            {/* trailing empty input — no "Add pattern" click needed for the first one */}
            <div className="flex items-center gap-1">
              <Input
                value={drafts[cap] ?? ''}
                title={policyPatternHint(cap)}
                onChange={(e) => setDrafts((d) => ({ ...d, [cap]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitNew(cap); } }}
                onBlur={() => commitNew(cap)}
                placeholder={patterns.length ? 'add another pattern…' : 'add a pattern…'}
                className="h-7 flex-1 font-mono text-xs"
              />
              {(drafts[cap] ?? '').trim() && (
                <Button type="button" size="icon" variant="ghost" className="size-6" onClick={() => commitNew(cap)} aria-label="Add pattern">
                  <Check className="size-3" />
                </Button>
              )}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  };

  const navButtons = (onPick?: () => void) =>
    SECTIONS.map((s) => {
      const Icon = s.icon;
      const active = section === s.id;
      return (
        <button
          key={s.id}
          type="button"
          onClick={() => { setSection(s.id); onPick?.(); }}
          className={cn(
            'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
            active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
          )}
        >
          <Icon className="size-4" />
          <span className="flex-1">{s.label}</span>
          {sectionCount[s.id] > 0 && (
            <span className="rounded bg-primary/15 px-1.5 text-xs text-primary">{sectionCount[s.id]}</span>
          )}
        </button>
      );
    });

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {!fixedDatalakeId && datalakes.length > 1 && (
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">Data lake</Label>
          <Select value={datalakeId} onValueChange={setDatalakeId}>
            <SelectTrigger className="h-8 w-64"><SelectValue placeholder="Select a lake" /></SelectTrigger>
            <SelectContent>
              {datalakes.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {/* settings-style left section nav — inline on md+, a slide-over on small screens */}
        {navOpen ? (
          <nav className="hidden w-44 shrink-0 flex-col gap-0.5 border-r pr-2 md:flex">
            <div className="flex items-center justify-between px-1 pb-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Sections</span>
              <Button type="button" size="icon" variant="ghost" className="size-6" onClick={() => setNavOpen(false)} aria-label="Collapse sections">
                <PanelLeftClose className="size-3.5" />
              </Button>
            </div>
            {navButtons()}
          </nav>
        ) : (
          <Button type="button" size="icon" variant="ghost" className="mr-2 hidden size-7 self-start md:flex" onClick={() => setNavOpen(true)} aria-label="Open sections">
            <PanelLeft className="size-4" />
          </Button>
        )}

        {/* content (active section) */}
        <div className="flex min-h-0 flex-1 flex-col md:pl-3">
          {/* small-screen section switcher → opens the in-modal sheet */}
          <Button type="button" size="sm" variant="outline" className="mb-2 self-start md:hidden" onClick={() => setNavSheetOpen(true)}>
            <PanelLeft className="size-3.5" /> {SECTIONS.find((s) => s.id === section)?.label}
          </Button>
          <ScrollArea type="auto" className="min-h-0 flex-1 pr-2">
          {section === 'catalog' && (
            <div className="flex flex-col">
              <div className="flex items-center justify-between border-b pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <span>Resource</span><span>Capabilities</span>
              </div>
              <div className="flex items-center justify-between gap-2 border-b py-1.5">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Database className="size-3.5 text-muted-foreground" />
                  Entire lake
                  <span className="text-xs text-muted-foreground">all schemas &amp; tables, incl. future</span>
                </span>
                {verbRow('*', '*')}
              </div>
              {loading ? (
                <p className="py-3 text-sm text-muted-foreground">Loading catalog…</p>
              ) : error ? (
                <div className="flex items-center gap-2 py-2 text-sm text-destructive">
                  <AlertCircle className="size-4" /> {error}
                  <Button size="sm" variant="ghost" onClick={() => void loadCatalog(datalakeId, true)}>
                    <RefreshCw className="size-3.5" /> Retry
                  </Button>
                </div>
              ) : (
                <>
                  {(catalog?.schemas ?? []).map((s) => renderSchema(s.name, s.tables))}
                  {extraSchemaNames.map((name) => renderSchema(name, []))}
                </>
              )}
              <div className="flex items-center gap-2 pt-2">
                <Input
                  value={extraSchema}
                  onChange={(e) => setExtraSchema(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addExtraSchema(); } }}
                  placeholder="grant a schema not yet in the catalog (e.g. marketing)"
                  className="h-7 flex-1 font-mono text-xs"
                />
                <Button type="button" size="sm" variant="secondary" onClick={addExtraSchema} disabled={!extraSchema.trim()}>
                  <Plus className="size-3.5" /> Add schema
                </Button>
              </div>
            </div>
          )}

          {section === 'sources' && (
            <div className="flex flex-col">
              <p className="pb-2 text-xs text-muted-foreground">
                External read/write sources &amp; ATTACH targets — authorizes egress (e.g.
                <span className="font-mono"> read_parquet</span>/<span className="font-mono">read_json</span>) per pattern.
              </p>
              {SOURCE_CAPS.map(renderPolicyCap)}
            </div>
          )}

          {section === 'extensions' && (
            <div className="flex flex-col">
              <p className="pb-2 text-xs text-muted-foreground">
                DuckDB extensions this agent may <span className="font-mono">INSTALL</span> /
                <span className="font-mono"> LOAD</span>, by name.
              </p>
              {EXTENSION_CAPS.map(renderPolicyCap)}
            </div>
          )}
          </ScrollArea>
        </div>

        {/* small-screen slide-over nav, contained INSIDE the modal */}
        {navSheetOpen && (
          <div className="absolute inset-0 z-20 md:hidden">
            <div className="absolute inset-0 bg-black/20" onClick={() => setNavSheetOpen(false)} />
            <nav className="absolute inset-y-0 left-0 flex w-48 flex-col gap-0.5 border-r bg-popover p-2 shadow-lg">
              <div className="flex items-center justify-between px-1 pb-1">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Sections</span>
                <Button type="button" size="icon" variant="ghost" className="size-6" onClick={() => setNavSheetOpen(false)} aria-label="Close sections">
                  <X className="size-3.5" />
                </Button>
              </div>
              {navButtons(() => setNavSheetOpen(false))}
            </nav>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Compact per-row capability control: one button summarizing the granted verbs,
 * opening a checkbox list of the catalog capabilities. Replaces a row of toggles.
 */
function CapabilityMenu({
  value,
  onChange,
}: {
  value: CatalogCapability[];
  onChange: (caps: CatalogCapability[]) => void;
}) {
  const ordered = CATALOG_CAPABILITIES.filter((c) => value.includes(c));
  const all = ordered.length === CATALOG_CAPABILITIES.length;
  const label = ordered.length === 0 ? 'None' : all ? 'Full access' : ordered.join(', ');
  const toggle = (c: CatalogCapability, on: boolean) =>
    onChange(on ? [...value, c] : value.filter((x) => x !== c));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className={cn('w-44 justify-between font-mono', ordered.length === 0 && 'text-muted-foreground')}>
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="text-xs">Capabilities</DropdownMenuLabel>
        {CATALOG_CAPABILITIES.map((c) => (
          <DropdownMenuCheckboxItem
            key={c}
            checked={value.includes(c)}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(ck) => toggle(c, ck === true)}
            className="font-mono text-sm"
          >
            {c}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); onChange(all ? [] : [...CATALOG_CAPABILITIES]); }}>
          {all ? 'Clear all' : 'Full access'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
