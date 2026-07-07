'use client';

/**
 * AccessManager — the one access-authoring surface, mounted identically on the
 * agent detail page (mode="detail": self-loading + inline Save) and in the
 * create-agent dialog (mode="create": controlled in-memory draft persisted by the
 * parent after the agent id exists).
 *
 * Two tabs over ONE canonical model (an ordered list of the key's own literal
 * statement strings, each carrying its row id once persisted):
 *   • Picker (default) — live schema browser × capability presets, allow/deny,
 *     columns, roles; per-node effective-state + provenance computed from `parsed`.
 *   • Grant SQL — the key's own editable statements + a read-only inherited region.
 *
 * Save diffs the draft against the loaded baseline by statement-string identity →
 * DELETE removed rows + POST added statements, batched, reduction-gated.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Boxes, UserCog, RefreshCw, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { fetchCp, cpPost, cpDelete } from '@/components/dashboard/fetch';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { EmptyState } from '@/components/waddling/empty-state';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { ObjectTree, type CatalogState, type NodeScope, type NodeOwnValue } from './object-tree';
import { RolesPanel, type RoleSummary } from './roles-panel';
import { GrantSqlTab } from './grant-sql-tab';
import {
  draftFromRows,
  draftFromSpec,
  diffDraft,
  authorBody,
  factFromParsed,
  heldRoles as heldRolesOf,
  type AclRow,
  type CatalogSchema,
  type DraftStatement,
  type GrantFact,
  type ResolvedStatement,
} from './access-draft';

export interface DatalakeOption {
  id: string;
  name: string;
}

/** The controlled draft the create dialog reads to persist. */
export interface CreateDraft {
  datalakeId: string;
  statements: DraftStatement[];
}

interface CatalogResponse {
  schemas: CatalogSchema[];
  fetchedAt: string | null;
  stale?: boolean;
}

interface TeamMember {
  role: 'owner' | 'admin' | 'member';
  isCurrentUser?: boolean;
}

export interface AccessManagerProps {
  mode: 'detail' | 'create';
  /** detail: the real agent id. create: undefined until the agent exists. */
  agentId?: string;
  /** create: the datalakes to choose from (detail fetches its own). */
  datalakes?: DatalakeOption[];
  /** create: initial draft + change sink so the parent can persist. */
  draft?: CreateDraft;
  onDraftChange?: (d: CreateDraft) => void;
  /** When true (create dialog with a fixed height) the body fills + scrolls
   * internally; when false (detail page) it flows and the page scrolls. */
  fill?: boolean;
}

/** The subject placeholder used for own-grant SQL before the agent id exists. */
const NEW_SUBJECT = 'new';

// ── Access-request proposals (?propose= deep link) ────────────────────────────
// The `waddling_request_access` MCP tool sends a human here with a base64url
// `?propose=` payload of the grants an agent wants. We decode it and overlay the
// requested grants into the draft as PENDING additions so the operator reviews +
// Saves. Coarse caps map to the same granular privileges the Picker presets use.

interface ProposedGrant {
  datalakeId?: string;
  schema: string;
  table: string;
  caps: string[];
}

const CAP_PRIVILEGES: Record<string, string[]> = {
  read: ['SELECT'],
  write: ['INSERT', 'UPDATE', 'DELETE'],
  create: ['CREATE'],
  drop: ['DROP'],
  alter: ['ALTER'],
  // `detach` has no granular privilege in this vocab — ignored in the overlay.
};

function capsToPrivileges(caps: string[]): string[] {
  const out = new Set<string>();
  for (const cap of caps) for (const priv of CAP_PRIVILEGES[cap] ?? []) out.add(priv);
  return [...out];
}

/** Decode the base64url `?propose=` payload. Malformed → null (ignored silently). */
function decodeProposal(param: string): ProposedGrant[] | null {
  try {
    const b64 = param.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const obj = JSON.parse(new TextDecoder().decode(bytes)) as { grants?: unknown };
    const grants = Array.isArray(obj.grants) ? obj.grants : [];
    return grants
      .filter(
        (g): g is ProposedGrant =>
          !!g && typeof (g as ProposedGrant).schema === 'string' &&
          typeof (g as ProposedGrant).table === 'string' && Array.isArray((g as ProposedGrant).caps),
      )
      .map((g) => ({
        datalakeId: typeof g.datalakeId === 'string' ? g.datalakeId : undefined,
        schema: g.schema,
        table: g.table,
        caps: g.caps.filter((c): c is string => typeof c === 'string'),
      }));
  } catch {
    return null;
  }
}

export function AccessManager({ mode, agentId, datalakes: datalakesProp, draft, onDraftChange, fill }: AccessManagerProps) {
  const subjectAgentId = agentId ?? NEW_SUBJECT;

  // ?propose= deep link (agent access request) — decoded once, overlaid on load.
  const searchParams = useSearchParams();
  const proposeParam = searchParams.get('propose');
  const proposal = useMemo(
    () => (mode === 'detail' && proposeParam ? decodeProposal(proposeParam) : null),
    [mode, proposeParam],
  );
  const proposalApplied = useRef(false);

  const [datalakes, setDatalakes] = useState<DatalakeOption[]>(datalakesProp ?? []);
  const [datalakeId, setDatalakeId] = useState<string>(draft?.datalakeId ?? datalakesProp?.[0]?.id ?? '');

  const [baseline, setBaseline] = useState<DraftStatement[]>([]);
  const [own, setOwn] = useState<DraftStatement[]>(draft?.statements ?? []);
  const [resolved, setResolved] = useState<ResolvedStatement[]>([]);
  const [catalog, setCatalog] = useState<CatalogState>({ kind: 'loading' });
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [extraSchemas, setExtraSchemas] = useState<string[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(mode === 'detail');
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pickerSection, setPickerSection] = useState<'objects' | 'roles'>('objects');

  // ── one-time: datalakes (detail) + admin flag ───────────────────────────────
  useEffect(() => {
    if (mode === 'detail') {
      void fetchCp<{ datalakes: DatalakeOption[] }>('/api/cp/datalakes').then((res) => {
        const list = res.ok ? res.data.datalakes.map((d) => ({ id: d.id, name: d.name })) : [];
        setDatalakes(list);
        setDatalakeId((cur) => cur || list[0]?.id || '');
      });
    }
    void fetchCp<{ members: TeamMember[] }>('/api/cp/team').then((res) => {
      if (!res.ok) return;
      const me = res.data.members.find((m) => m.isCurrentUser);
      setIsAdmin(!!me && me.role !== 'member');
    });
  }, [mode]);

  // ── mirror the draft to the create parent ───────────────────────────────────
  useEffect(() => {
    if (mode === 'create') onDraftChange?.({ datalakeId, statements: own });
  }, [mode, datalakeId, own, onDraftChange]);

  // ── load catalog (both modes) + grants/acl (detail) per datalake ────────────
  const loadCatalog = useCallback(async (id: string, refresh = false) => {
    if (!id) return;
    const path = `/api/cp/datalakes/${encodeURIComponent(id)}/catalog`;
    const res = refresh
      ? await fetchCp<CatalogResponse>(`${path}/refresh`, { method: 'POST', body: '{}' })
      : await fetchCp<CatalogResponse>(path);
    if (!res.ok) {
      setCatalog({ kind: 'error', message: res.error });
      return;
    }
    if (res.data.fetchedAt === null) {
      setCatalog({ kind: 'provisioning' });
      return;
    }
    setCatalog({ kind: 'ready', schemas: res.data.schemas, fetchedAt: res.data.fetchedAt, stale: res.data.stale });
  }, []);

  const loadGrants = useCallback(
    async (id: string) => {
      if (mode !== 'detail' || !id || !agentId) return;
      const dl = encodeURIComponent(id);
      const [aclRes, grantsRes] = await Promise.all([
        fetchCp<{ statements: AclRow[] }>(`/api/cp/acl?datalakeId=${dl}&agentId=${encodeURIComponent(agentId)}`),
        fetchCp<{ statements: ResolvedStatement[] }>(
          `/api/cp/agents/${encodeURIComponent(agentId)}/grants?datalakeId=${dl}`,
        ),
      ]);
      const rows = aclRes.ok ? draftFromRows(aclRes.data.statements) : [];
      setBaseline(rows);
      setOwn(rows.map((r) => ({ ...r })));
      setResolved(grantsRes.ok ? grantsRes.data.statements : []);
    },
    [mode, agentId],
  );

  // Create mode has no per-lake load, so switching lakes must reset the draft
  // itself (a grant on lake A must not carry over to lake B).
  const prevLake = useRef(datalakeId);
  useEffect(() => {
    if (mode === 'create' && prevLake.current && prevLake.current !== datalakeId) {
      setOwn([]);
    }
    prevLake.current = datalakeId;
  }, [mode, datalakeId]);

  useEffect(() => {
    if (!datalakeId) return;
    let cancelled = false;
    setLoading(true);
    setCatalog({ kind: 'loading' });
    setExtraSchemas([]);
    void Promise.all([
      loadCatalog(datalakeId),
      loadGrants(datalakeId),
      fetchCp<{ roles: RoleSummary[] }>(`/api/cp/roles?datalakeId=${encodeURIComponent(datalakeId)}`).then((res) => {
        if (!cancelled) setRoles(res.ok ? res.data.roles : []);
      }),
    ]).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [datalakeId, loadCatalog, loadGrants]);

  // Point the editor at the proposal's datalake before overlaying its grants.
  useEffect(() => {
    if (!proposal || proposalApplied.current) return;
    const wantLake = proposal.find((g) => g.datalakeId)?.datalakeId;
    if (wantLake && wantLake !== datalakeId && datalakes.some((d) => d.id === wantLake)) {
      setDatalakeId(wantLake);
    }
  }, [proposal, datalakes, datalakeId]);

  // Overlay the requested grants onto the loaded draft as PENDING additions — once,
  // after baseline load, for grants targeting the currently-selected datalake.
  useEffect(() => {
    if (!proposal || proposalApplied.current || loading || !agentId || !datalakeId) return;
    const forLake = proposal.filter((g) => !g.datalakeId || g.datalakeId === datalakeId);
    // If every grant names a different lake, wait for the datalake switch above.
    if (forLake.length === 0) return;
    const additions: DraftStatement[] = [];
    for (const g of forLake) {
      const privileges = capsToPrivileges(g.caps);
      if (privileges.length === 0) continue;
      const object = g.table === '*' ? { schema: g.schema, allTables: true as const } : { schema: g.schema, table: g.table };
      additions.push(draftFromSpec({ kind: 'object', effect: 'allow', privileges, object, grantee: { kind: 'agent', agentId } }));
    }
    proposalApplied.current = true;
    if (additions.length === 0) return;
    setOwn((prev) => {
      const seen = new Set(prev.map((s) => s.sql));
      const fresh = additions.filter((a) => !seen.has(a.sql));
      if (fresh.length === 0) return prev;
      queueMicrotask(() =>
        toast.info(`${fresh.length} requested grant${fresh.length > 1 ? 's' : ''} added as pending — review and Save.`),
      );
      return [...prev, ...fresh];
    });
  }, [proposal, loading, agentId, datalakeId]);

  const refresh = async () => {
    setRefreshing(true);
    await loadCatalog(datalakeId, true);
    setRefreshing(false);
  };

  // ── facts + inherited (the trust computation) ────────────────────────────────
  const facts: GrantFact[] = useMemo(() => {
    const ownFacts = own
      .map((s) => (s.parsed ? factFromParsed(s.parsed, null) : null))
      .filter((f): f is GrantFact => f !== null);
    const inheritedFacts = resolved
      .filter((s) => s.inherited !== null && s.parsed)
      .map((s) => factFromParsed(s.parsed as NonNullable<typeof s.parsed>, s.inherited))
      .filter((f): f is GrantFact => f !== null);
    return [...ownFacts, ...inheritedFacts];
  }, [own, resolved]);

  const inherited = useMemo(() => resolved.filter((s) => s.inherited !== null), [resolved]);
  const held = useMemo(() => heldRolesOf([...own.map((s) => ({ ...s, inherited: null }))] as ResolvedStatement[]), [own]);

  // ── draft mutation (object-tree ⇄ draft) ────────────────────────────────────
  const scopeMatches = (parsed: DraftStatement['parsed'], scope: NodeScope): boolean => {
    if (!parsed || parsed.kind !== 'object' || parsed.grantee.kind !== 'subject' || !parsed.object) return false;
    const o = parsed.object;
    if ('allTables' in scope) return 'allTables' in o && o.schema === scope.schema;
    return 'table' in o && o.schema === scope.schema && o.table === scope.table;
  };

  const readNode = useCallback(
    (scope: NodeScope): NodeOwnValue | null => {
      const row = own.find((s) => scopeMatches(s.parsed, scope));
      if (!row || !row.parsed) return null;
      return {
        privileges: row.parsed.privileges as NodeOwnValue['privileges'],
        columns: row.parsed.columns,
        effect: row.parsed.effect,
      };
    },
    [own],
  );

  const writeNode = useCallback(
    (scope: NodeScope, value: NodeOwnValue | null) => {
      setOwn((prev) => {
        const rest = prev.filter((s) => !scopeMatches(s.parsed, scope));
        if (!value || value.privileges.length === 0) return rest;
        const object = 'allTables' in scope ? { schema: scope.schema, allTables: true as const } : { schema: scope.schema, table: scope.table };
        const stmt = draftFromSpec({
          kind: 'object',
          effect: value.effect,
          privileges: value.privileges,
          columns: value.columns,
          object,
          grantee: { kind: 'agent', agentId: subjectAgentId },
        });
        return [...rest, stmt];
      });
    },
    [subjectAgentId],
  );

  const addRole = useCallback(
    (role: string) => {
      setOwn((prev) => {
        if (prev.some((s) => s.parsed?.kind === 'membership' && s.parsed.role === role)) return prev;
        return [...prev, draftFromSpec({ kind: 'membership', role, grantee: { kind: 'agent', agentId: subjectAgentId } })];
      });
    },
    [subjectAgentId],
  );
  const removeRole = useCallback((role: string) => {
    setOwn((prev) => prev.filter((s) => !(s.parsed?.kind === 'membership' && s.parsed.role === role)));
  }, []);

  const removeStatement = useCallback((sql: string) => {
    setOwn((prev) => prev.filter((s) => s.sql !== sql));
  }, []);
  const addRaw = useCallback((statements: string[]) => {
    setOwn((prev) => [...prev, ...statements.map((sql) => ({ sql, parsed: null }))]);
  }, []);

  // ── diff + save (detail) ────────────────────────────────────────────────────
  const diff = useMemo(() => diffDraft(baseline, own), [baseline, own]);
  const changeCount = diff.added.length + diff.removed.length;

  const applyDiff = useCallback(async () => {
    setSaving(true);
    let failed = 0;
    for (const r of diff.removed) {
      if (!(await cpDelete(`/api/cp/acl/${encodeURIComponent(r.id)}`)).ok) failed++;
    }
    for (const s of diff.added) {
      const res = await cpPost('/api/cp/acl', authorBody(s, datalakeId, { subjectAgentId }));
      if (!res.ok) failed++;
    }
    setSaving(false);
    if (failed) toast.error(`${failed} change${failed > 1 ? 's' : ''} failed`);
    else toast.success(`Access updated (${changeCount} change${changeCount > 1 ? 's' : ''})`);
    await loadGrants(datalakeId);
    // Re-baseline from the reloaded rows.
    const dl = encodeURIComponent(datalakeId);
    const aclRes = await fetchCp<{ statements: AclRow[] }>(
      `/api/cp/acl?datalakeId=${dl}&agentId=${encodeURIComponent(agentId ?? '')}`,
    );
    const rows = aclRes.ok ? draftFromRows(aclRes.data.statements) : [];
    setBaseline(rows);
    setOwn(rows.map((r) => ({ ...r })));
  }, [diff, datalakeId, subjectAgentId, changeCount, loadGrants, agentId]);

  const onSaveClick = () => {
    if (changeCount === 0) return;
    if (diff.removed.length > 0) {
      setConfirmOpen(true);
      return;
    }
    void applyDiff();
  };

  // ── datalake selector ───────────────────────────────────────────────────────
  const datalakeSelect =
    datalakes.length > 1 ? (
      <div className="flex items-center gap-2">
        <Label className="text-xs text-muted-foreground">Data lake</Label>
        <Select value={datalakeId} onValueChange={setDatalakeId}>
          <SelectTrigger size="sm" className="w-52">
            <SelectValue placeholder="Select a lake" />
          </SelectTrigger>
          <SelectContent>
            {datalakes.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    ) : null;

  if (mode === 'detail' && datalakes.length === 0 && !loading) {
    return (
      <EmptyState
        icon={<ShieldCheck aria-hidden="true" />}
        title="No data lakes yet"
        description="Create a data lake before you can grant this key access to tables."
      />
    );
  }

  const picker = (
    <div className="flex flex-col gap-3">
      {/* Objects | Roles sub-nav */}
      <div className="inline-flex w-fit rounded-md border p-0.5">
        {(['objects', 'roles'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setPickerSection(s)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded px-3 py-1 text-sm capitalize transition-colors',
              pickerSection === s ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {s === 'objects' ? <Boxes className="size-3.5" /> : <UserCog className="size-3.5" />}
            {s}
          </button>
        ))}
      </div>

      {pickerSection === 'objects' ? (
        <ObjectTree
          catalog={catalog}
          facts={facts}
          readNode={readNode}
          writeNode={writeNode}
          onRefresh={refresh}
          refreshing={refreshing}
          extraSchemas={extraSchemas}
          onAddExtraSchema={(name) => setExtraSchemas((prev) => (prev.includes(name) ? prev : [...prev, name]))}
        />
      ) : (
        <RolesPanel roles={roles} heldRoles={held} isAdmin={isAdmin} onAddRole={addRole} onRemoveRole={removeRole} />
      )}
    </div>
  );

  const scrollCls = fill ? 'h-full min-h-0 pr-2' : 'max-h-[70vh] pr-2';

  return (
    <div className={cn('flex flex-col gap-3', fill && 'min-h-0 flex-1')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {datalakeSelect ?? <span />}
        {mode === 'detail' ? (
          <div className="flex items-center gap-3">
            {changeCount > 0 && (
              <span className="text-xs text-muted-foreground">
                {diff.added.length > 0 && `+${diff.added.length}`} {diff.removed.length > 0 && `−${diff.removed.length}`}{' '}
                pending
              </span>
            )}
            <Button size="sm" onClick={onSaveClick} disabled={saving || changeCount === 0}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {saving ? 'Saving…' : changeCount ? `Save ${changeCount} change${changeCount > 1 ? 's' : ''}` : 'Saved'}
            </Button>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">
            {own.length > 0 ? `${own.length} grant${own.length > 1 ? 's' : ''} to create` : 'No initial access (add it later)'}
          </span>
        )}
      </div>

      <Tabs defaultValue="picker" className={cn('flex flex-col gap-3', fill && 'min-h-0 flex-1')}>
        <TabsList variant="line">
          <TabsTrigger value="picker">Picker</TabsTrigger>
          <TabsTrigger value="sql">Grant SQL</TabsTrigger>
        </TabsList>

        <TabsContent value="picker" className={cn(fill && 'min-h-0 flex-1')}>
          <ScrollArea type="auto" className={scrollCls}>
            {picker}
          </ScrollArea>
        </TabsContent>

        <TabsContent value="sql" className={cn(fill && 'min-h-0 flex-1')}>
          <ScrollArea type="auto" className={scrollCls}>
            <GrantSqlTab own={own} inherited={inherited} onRemove={removeStatement} onAddRaw={addRaw} />
          </ScrollArea>
        </TabsContent>
      </Tabs>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove access?</AlertDialogTitle>
            <AlertDialogDescription>
              This save removes {diff.removed.length} statement{diff.removed.length > 1 ? 's' : ''} from this key
              {diff.added.length ? ` (and adds ${diff.added.length})` : ''}. Removing access takes effect immediately
              and can interrupt anything the key is doing. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                void applyDiff();
              }}
            >
              Yes, apply {changeCount} change{changeCount > 1 ? 's' : ''}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
