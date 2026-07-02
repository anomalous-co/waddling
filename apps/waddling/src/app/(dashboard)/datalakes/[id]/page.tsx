'use client';

import { useEffect, useState, useCallback, use } from 'react';
import Link from 'next/link';
import {
  Database,
  ChevronLeft,
  Plug,
  ChevronRight,
  ChevronDown,
  Search,
  MapPin,
  Table2,
  HardDrive,
  Bot,
  Clock,
} from 'lucide-react';
import { fetchCp, cpPost } from '@/components/dashboard/fetch';
import { cpUrl } from '@/lib/control-api';
import type { AgentSummary, DatalakeDetail, GatewayRuntimeState } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useConnectAgent } from '@/components/waddling/connect-agent-dialog';
import { useBreadcrumbLabel } from '@/components/dashboard/breadcrumb-context';
import { DetailLayout } from '@/components/waddling/detail-layout';
import { SectionCard } from '@/components/waddling/section-card';
import { StatusDot } from '@/components/waddling/status-dot';
import { EmptyState } from '@/components/waddling/empty-state';
import { CodeBlock } from '@/components/waddling/code-block';
import { CopyButton } from '@/components/waddling/copy-button';
import { VerbChip } from '@/components/waddling/agent-chips';
import { formatRelative } from '@/components/waddling/agent-status';
import type { SemanticStatus } from '@/components/waddling/status-dot';
import { formatBytes, formatRows } from '@/lib/format';
import { cn } from '@/lib/utils';
import type {
  LakeVM,
  CatalogSchemaVM,
  AclRuleVM,
  WorkspaceVM,
} from './types';

// ── Real /api/cp/* response shapes (subset of fields this page reads) ───────────
// These mirror the control-api routes; everything is mapped into the ./types view
// models at the fetch boundary so the section components never see a raw field.

interface DatalakeGetResponse {
  datalake: DatalakeDetail;
}

interface CatalogColumnRow {
  name: string;
  type: string;
}
interface CatalogTableRow {
  name: string;
  columns: CatalogColumnRow[];
}
interface CatalogSchemaRow {
  name: string;
  tables: CatalogTableRow[];
}
interface CatalogGetResponse {
  schemas: CatalogSchemaRow[];
}

interface AclRuleRowRaw {
  id: string;
  datalakeId: string;
  agentId?: string;
  schemaName: string;
  tableName: string;
  verb: 'read' | 'write';
}
interface AclGetResponse {
  rules: AclRuleRowRaw[];
}

interface WorkspaceRowRaw {
  workspaceId: string;
  datalakeId: string;
  agentId: string;
  agentName?: string;
  lastSessionAt: string | null;
}
interface WorkspacesGetResponse {
  workspaces: WorkspaceRowRaw[];
}

interface AgentsGetResponse {
  agents: AgentSummary[];
}

// ── Adapters (real shape → view model) ──────────────────────────────────────────

/**
 * Map a lake's lifecycle status to a SemanticStatus for StatusDot.
 * 'running' → active; 'stopped' → suspended; others pass through.
 */
function lakeSemanticStatus(status: DatalakeDetail['status']): SemanticStatus {
  switch (status) {
    case 'running':
      return 'active';
    case 'stopped':
      return 'suspended';
    case 'provisioning':
      return 'provisioning';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

// Map the gateway runtime state to the SemanticStatus the Connect chip shows.
function runtimeSemanticStatus(state: GatewayRuntimeState): SemanticStatus {
  switch (state) {
    case 'running':
      return 'active';
    case 'asleep':
      return 'idle';
    case 'provisioning':
      return 'provisioning';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

// The agent-facing quack host is derived from the lake slug (the API returns no
// gateway endpoint object). Per-tenant data-plane ingress over HTTPS:443, so the
// port is omitted. The scheme (quack:) is added by the snippet/CopyButton callers.
function gatewayHostFor(slug: string): string {
  return `gw-${slug}.getwaddling.com`;
}

function mapCatalog(schemas: CatalogSchemaRow[]): CatalogSchemaVM[] {
  return schemas.map((s) => ({
    schema: s.name,
    tables: s.tables.map((t) => ({
      table: t.name,
      columnCount: t.columns.length,
      columns: t.columns.map((col) => ({ name: col.name, type: col.type })),
      // The cached catalog snapshot carries names + types only, never row counts.
      rowEstimate: undefined,
    })),
  }));
}

function mapAclRules(rules: AclRuleRowRaw[]): AclRuleVM[] {
  return rules.map((r) => ({
    id: r.id,
    datalakeId: r.datalakeId,
    agentId: r.agentId,
    schema: r.schemaName,
    table: r.tableName,
    verb: r.verb,
  }));
}

function mapWorkspaces(rows: WorkspaceRowRaw[]): WorkspaceVM[] {
  return rows.map((r) => ({
    id: r.workspaceId,
    agentId: r.agentId,
    agentName: r.agentName ?? r.agentId,
    datalakeId: r.datalakeId,
    lastActiveAt: r.lastSessionAt,
    // The control plane stores no workspace size or scratch-table inventory
    // (that data lives in the data plane); render gracefully without them.
    sizeBytes: undefined,
    scratchTables: [],
  }));
}

// ── Connect section ───────────────────────────────────────────────────────────

function ConnectSection({ lake }: { lake: LakeVM }) {
  const endpointUrl = lake.gateway?.endpointUrl ?? '<endpoint-not-yet-assigned>';
  const gatewayStatus: SemanticStatus = lake.gateway?.status ?? 'idle';
  const region = lake.gateway?.region ?? lake.region;

  const attachSnippet = [
    '-- Install the birdshot DuckDB extension (once per DuckDB instance)',
    'SET allow_unsigned_extensions = true;',
    "INSTALL birdshot FROM 'https://ext.getwaddling.com';",
    'LOAD birdshot;',
    '',
    '-- Attach the governed gateway',
    '-- Replace <agent-key> with your agent API key (created on /agents)',
    `ATTACH 'quack:${endpointUrl}?token=<agent-key>' AS lake;`,
  ].join('\n');

  return (
    <div className="flex flex-col gap-6">
      <SectionCard title="Gateway endpoint" headingLevel={2}>
        <div className="flex flex-col gap-5">
          <p className="text-sm text-muted-foreground">
            Agents connect by ATTACHing to this endpoint via the{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">quack:</code>{' '}
            protocol. The birdshot extension enforces per-agent table-level ACLs at
            connection time — no SQL reaches the lake without an explicit grant.
          </p>

          {/* Endpoint URL */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Endpoint URL
            </span>
            <div className="flex items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2.5">
              <code className="flex-1 truncate font-mono text-sm text-foreground">
                {endpointUrl}
              </code>
              <CopyButton text={endpointUrl} label="Copy endpoint URL" size="icon" className="size-7 shrink-0" />
            </div>
          </div>

          {/* Region + status chips */}
          <dl className="flex flex-wrap gap-6">
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs font-medium text-muted-foreground">Region</dt>
              <dd className="flex items-center gap-1 text-sm">
                <MapPin className="size-3.5 text-muted-foreground" aria-hidden="true" />
                {region}
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs font-medium text-muted-foreground">Status</dt>
              <dd>
                <StatusDot status={gatewayStatus} />
              </dd>
            </div>
          </dl>
        </div>
      </SectionCard>

      <SectionCard title="Connection snippet" headingLevel={2}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Paste into any DuckDB v1.5.3+ session. Replace{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              &lt;agent-key&gt;
            </code>{' '}
            with the key shown when you created the agent.
          </p>
          <CodeBlock
            code={attachSnippet}
            label="DuckDB SQL"
            copyLabel="Copy connection snippet"
          />
        </div>
      </SectionCard>

      {/* Forward path: from "how to connect" → "who can see what". */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="text-muted-foreground">Next:</span>
        <Link
          href="?section=access"
          scroll={false}
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          review which agents can access this lake →
        </Link>
      </div>
    </div>
  );
}

// ── Catalog section ───────────────────────────────────────────────────────────

function CatalogSection({ lake }: { lake: LakeVM }) {
  const [search, setSearch] = useState('');
  const [expandedTable, setExpandedTable] = useState<string | null>(null);

  const catalog = lake.catalog;

  if (catalog.length === 0) {
    return (
      <EmptyState
        icon={<Database />}
        title="Catalog not available"
        description="The catalog is populated once the lake's gateway has run its first snapshot. Only org owners and admins can browse it."
      />
    );
  }

  const query = search.trim().toLowerCase();
  const filtered = catalog
    .map((schema) => ({
      ...schema,
      tables: schema.tables.filter((t) =>
        query === '' || t.table.toLowerCase().includes(query),
      ),
    }))
    .filter((s) => s.tables.length > 0);

  const totalTables = catalog.reduce((n, s) => n + s.tables.length, 0);

  return (
    <div className="flex flex-col gap-4">
      {/* Search */}
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          id="catalog-search"
          type="search"
          placeholder="Search tables…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search tables in catalog"
          className="pl-9"
        />
      </div>

      {/* Summary */}
      <p className="text-xs text-muted-foreground">
        {catalog.length} schema{catalog.length !== 1 ? 's' : ''} ·{' '}
        {totalTables} table{totalTables !== 1 ? 's' : ''}
        {query ? ` · ${filtered.reduce((n, s) => n + s.tables.length, 0)} matching` : ''}
      </p>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Search />}
          title="No tables match"
          description={`No tables found matching "${search}".`}
        />
      ) : (
        filtered.map((schema) => (
          <SectionCard
            key={schema.schema}
            title={schema.schema}
            headingLevel={2}
            contentClassName="p-0"
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Table</TableHead>
                  <TableHead className="text-right">Columns</TableHead>
                  <TableHead className="text-right">~Rows</TableHead>
                  <TableHead className="w-10" aria-label="Expand" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {schema.tables.map((tbl) => {
                  const key = `${schema.schema}.${tbl.table}`;
                  const isExpanded = expandedTable === key;
                  const hasColumns = tbl.columns && tbl.columns.length > 0;
                  return [
                    <TableRow
                      key={key}
                      className={cn(
                        hasColumns && 'cursor-pointer select-none hover:bg-muted/50',
                      )}
                      onClick={() => {
                        if (!hasColumns) return;
                        setExpandedTable(isExpanded ? null : key);
                      }}
                    >
                      <TableCell className="font-mono text-sm font-medium">
                        {tbl.table}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {tbl.columnCount}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {tbl.rowEstimate !== undefined ? formatRows(tbl.rowEstimate) : '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        {hasColumns && (
                          <button
                            type="button"
                            aria-expanded={isExpanded}
                            aria-controls={`${key}-columns`}
                            aria-label={`${isExpanded ? 'Hide' : 'Show'} columns of ${tbl.table}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedTable(isExpanded ? null : key);
                            }}
                            className="ml-auto flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {isExpanded ? (
                              <ChevronDown className="size-4" aria-hidden="true" />
                            ) : (
                              <ChevronRight className="size-4" aria-hidden="true" />
                            )}
                          </button>
                        )}
                      </TableCell>
                    </TableRow>,
                    isExpanded && hasColumns ? (
                      <TableRow key={`${key}-expanded`} className="bg-muted/30 hover:bg-muted/30">
                        <TableCell colSpan={4} className="p-0">
                          <div
                            id={`${key}-columns`}
                            role="region"
                            aria-label={`Columns of ${tbl.table}`}
                          >
                            <Table>
                              <TableHeader>
                                <TableRow className="border-t border-border/50">
                                  <TableHead className="pl-8 text-xs">Column</TableHead>
                                  <TableHead className="text-xs">Type</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {tbl.columns!.map((col) => (
                                  <TableRow key={col.name} className="border-0">
                                    <TableCell className="pl-8 font-mono text-xs">
                                      {col.name}
                                    </TableCell>
                                    <TableCell className="font-mono text-xs text-muted-foreground">
                                      {col.type}
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : null,
                  ];
                })}
              </TableBody>
            </Table>
          </SectionCard>
        ))
      )}
    </div>
  );
}

// ── Access section ────────────────────────────────────────────────────────────

function AccessSection({
  lake,
  rules,
  agents,
}: {
  lake: LakeVM;
  rules: AclRuleVM[];
  agents: AgentSummary[];
}) {
  const lakeRules = rules.filter((r) => r.datalakeId === lake.id);
  const agentMap = new Map(agents.map((a) => [a.id, a.name]));

  // Group rules by agentId
  const byAgent = new Map<string, AclRuleVM[]>();
  for (const rule of lakeRules) {
    const key = rule.agentId ?? '__org__';
    const existing = byAgent.get(key) ?? [];
    existing.push(rule);
    byAgent.set(key, existing);
  }

  if (lakeRules.length === 0) {
    return (
      <EmptyState
        icon={<Bot />}
        title="No agents have access"
        description="Grant an agent access to this lake to see it here."
        action={
          <Button size="sm" asChild>
            <Link href="/agents">
              <Bot className="mr-1.5 size-3.5" aria-hidden="true" />
              Manage agents
            </Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {byAgent.size} agent{byAgent.size !== 1 ? 's' : ''} have access to this lake.{' '}
        <Link href="/agents" className="text-foreground underline-offset-4 hover:underline">
          Manage in Agents
        </Link>
      </p>

      <SectionCard title="Agent access" headingLevel={2} contentClassName="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Schema</TableHead>
              <TableHead>Table</TableHead>
              <TableHead>Verb</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lakeRules.map((rule) => {
              const agentName = rule.agentId
                ? (agentMap.get(rule.agentId) ?? rule.agentId)
                : '(org-wide)';
              return (
                <TableRow key={rule.id}>
                  <TableCell className="font-mono text-xs font-medium">
                    {agentName}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {rule.schema}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {rule.table}
                  </TableCell>
                  <TableCell>
                    <VerbChip verb={rule.verb} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </SectionCard>
    </div>
  );
}

// ── Workspaces section ────────────────────────────────────────────────────────

function WorkspacesSection({
  lake,
  workspaces,
}: {
  lake: LakeVM;
  workspaces: WorkspaceVM[];
}) {
  const [expandedWs, setExpandedWs] = useState<string | null>(null);
  const lakeWorkspaces = workspaces.filter((w) => w.datalakeId === lake.id);

  if (lakeWorkspaces.length === 0) {
    return (
      <EmptyState
        icon={<HardDrive />}
        title="No workspaces yet"
        description="A workspace is a private governed DuckDB scratch database created for an agent when it first connects to this lake."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Each workspace is a per-agent durable DuckDB scratch database — private, governed, and
        attached to this lake. Agents write intermediate results here without affecting lake data.{' '}
        Workspace contents are read live from the lake's gateway, enforced by birdshot; the control
        plane only manages workspace metadata, not the scratch data itself.
      </p>

      <SectionCard title="Agent workspaces" headingLevel={2} contentClassName="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead className="hidden sm:table-cell">Size</TableHead>
              <TableHead className="text-right">Last active</TableHead>
              <TableHead className="w-10" aria-label="Expand" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {lakeWorkspaces.map((ws) => {
              const isExpanded = expandedWs === ws.id;
              return [
                <TableRow
                  key={ws.id}
                  className="cursor-pointer select-none hover:bg-muted/50"
                  onClick={() => setExpandedWs(isExpanded ? null : ws.id)}
                >
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div
                        className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted"
                        aria-hidden="true"
                      >
                        <Bot className="size-3.5 text-muted-foreground" />
                      </div>
                      <span className="font-mono text-sm font-medium">{ws.agentName}</span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {ws.sizeBytes !== undefined ? formatBytes(ws.sizeBytes) : '—'}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    <span className="flex items-center justify-end gap-1">
                      <Clock className="size-3 shrink-0" aria-hidden="true" />
                      {ws.lastActiveAt ? formatRelative(ws.lastActiveAt) : '—'}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      aria-controls={`${ws.id}-tables`}
                      aria-label={`${isExpanded ? 'Hide' : 'Show'} materialized tables of ${ws.agentName}'s workspace`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpandedWs(isExpanded ? null : ws.id);
                      }}
                      className="ml-auto flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {isExpanded ? (
                        <ChevronDown className="size-4" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="size-4" aria-hidden="true" />
                      )}
                    </button>
                  </TableCell>
                </TableRow>,
                isExpanded ? (
                  <TableRow key={`${ws.id}-expanded`} className="bg-muted/30 hover:bg-muted/30">
                    <TableCell colSpan={4} className="p-0">
                      <div
                        id={`${ws.id}-tables`}
                        role="region"
                        aria-label={`Materialized tables in ${ws.agentName}'s workspace`}
                      >
                        {ws.scratchTables.length === 0 ? (
                          <p className="px-8 py-3 text-sm text-muted-foreground">
                            No materialized tables to show — scratch-table details live in the data
                            plane, not the control plane.
                          </p>
                        ) : (
                          <Table>
                            <TableHeader>
                              <TableRow className="border-t border-border/50">
                                <TableHead className="pl-8 text-xs">Table</TableHead>
                                <TableHead className="text-right text-xs">~Rows</TableHead>
                                <TableHead className="text-right text-xs">Size</TableHead>
                                <TableHead className="text-right text-xs">Last write</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {ws.scratchTables.map((tbl) => (
                                <TableRow key={tbl.name} className="border-0">
                                  <TableCell className="pl-8 font-mono text-xs">
                                    {tbl.name}
                                  </TableCell>
                                  <TableCell className="text-right font-mono text-xs text-muted-foreground">
                                    {formatRows(tbl.rowCount)}
                                  </TableCell>
                                  <TableCell className="text-right font-mono text-xs text-muted-foreground">
                                    {formatBytes(tbl.sizeBytes)}
                                  </TableCell>
                                  <TableCell className="text-right text-xs text-muted-foreground">
                                    {formatRelative(tbl.lastWriteAt)}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ) : null,
              ];
            })}
          </TableBody>
        </Table>
      </SectionCard>
    </div>
  );
}

// ── Query section ─────────────────────────────────────────────────────────────

// Real /api/cp/sessions/:id/query result + structured error shapes.
interface QueryOk {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
}
interface QueryErr {
  error: string;
  reason?: string;
  table?: string;
}

type QueryState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'error'; message: string; denial?: { table?: string; reason: string } }
  | { phase: 'success'; columns: string[]; rows: unknown[][]; rowCount: number; elapsedMs: number };

function QuerySection({ lake, agents }: { lake: LakeVM; agents: AgentSummary[] }) {
  const endpointUrl = lake.gateway?.endpointUrl ?? '(endpoint not assigned)';

  const [agentId, setAgentId] = useState<string>(() => agents[0]?.id ?? '');
  // A session is per (agent, lake). Cache it across runs; invalidate when the
  // selected agent changes or when the workspace goes cold (needs_configure).
  const [sessionId, setSessionId] = useState<string | null>(null);

  const [sql, setSql] = useState<string>(() => {
    const s = lake.catalog[0];
    if (!s) return '-- No tables in catalog yet\n-- SELECT * FROM <schema>.<table> LIMIT 100;';
    const t = s.tables[0];
    if (!t) return `-- SELECT * FROM ${s.schema}.<table> LIMIT 100;`;
    return `SELECT *\nFROM ${s.schema}.${t.table}\nLIMIT 100;`;
  });

  const [qstate, setQstate] = useState<QueryState>({ phase: 'idle' });

  async function runQuery() {
    if (qstate.phase === 'loading') return;
    if (!agentId) {
      setQstate({ phase: 'error', message: 'Select an agent to run governed queries as.' });
      return;
    }
    setQstate({ phase: 'loading' });

    // Ensure a session for the selected agent (run-as). The dashboard user has no
    // agent-less query path — POST /api/cp/sessions requires an agentId.
    let sid = sessionId;
    if (!sid) {
      const cres = await cpPost<{ sessionId: string }>('/api/cp/sessions', {
        datalakeId: lake.id,
        agentId,
      });
      if (!cres.ok) {
        setQstate({ phase: 'error', message: cres.error });
        return;
      }
      sid = cres.data.sessionId;
      setSessionId(sid);
    }

    // Raw fetch (not fetchCp) so the structured denial `reason`/`table` survive —
    // fetchCp collapses the body to its `error` field.
    const started = Date.now();
    let status: number;
    let body: QueryOk | QueryErr;
    try {
      const res = await fetch(cpUrl(`/api/cp/sessions/${sid}/query`), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql }),
      });
      status = res.status;
      body = (await res.json().catch(() => ({ error: 'invalid_response' }))) as QueryOk | QueryErr;
    } catch (e) {
      setQstate({ phase: 'error', message: e instanceof Error ? e.message : 'Network error' });
      return;
    }
    const elapsedMs = Date.now() - started;

    if (status === 200 && !('error' in body)) {
      const okb = body;
      setQstate({
        phase: 'success',
        columns: okb.columns ?? [],
        rows: okb.rows ?? [],
        rowCount: okb.rowCount ?? (okb.rows?.length ?? 0),
        elapsedMs,
      });
      return;
    }

    const errb = (('error' in body) ? body : { error: `HTTP ${status}` }) as QueryErr;
    // Cold/expired session → drop it so the next run re-establishes one.
    if (status === 409 && (errb.error === 'needs_configure' || errb.error === 'session_not_active')) {
      setSessionId(null);
      setQstate({
        phase: 'error',
        message: errb.reason ?? 'Your workspace went cold — run the query again to reconnect.',
      });
      return;
    }
    if (status === 403 && errb.error === 'authorization_denied') {
      setQstate({
        phase: 'error',
        message: errb.error,
        denial: {
          table: errb.table,
          reason: errb.reason ?? 'birdshot denied this statement for the selected agent.',
        },
      });
      return;
    }
    setQstate({ phase: 'error', message: errb.reason ?? errb.error ?? `HTTP ${status}` });
  }

  return (
    <div className="flex flex-col gap-6">
      <SectionCard title="SQL editor" headingLevel={2}>
        <div className="flex flex-col gap-4">
          {/* Endpoint note */}
          <p className="text-sm text-muted-foreground">
            Runs governed SQL against this lake's gateway — enforced by birdshot ACLs for the
            selected agent.{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              {endpointUrl}
            </code>
          </p>

          {/* Run-as agent picker */}
          {agents.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Create an agent to run governed queries.{' '}
              <Link href="/agents" className="text-foreground underline-offset-4 hover:underline">
                Manage agents
              </Link>
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="run-as-agent" className="text-xs font-medium text-muted-foreground">
                Run as agent
              </label>
              <select
                id="run-as-agent"
                value={agentId}
                onChange={(e) => {
                  setAgentId(e.target.value);
                  // Switching agents invalidates the cached (agent, lake) session.
                  setSessionId(null);
                }}
                className="h-9 w-full max-w-xs rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Editor */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="sql-editor" className="sr-only">
              SQL query
            </label>
            <Textarea
              id="sql-editor"
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void runQuery();
                }
              }}
              rows={8}
              spellCheck={false}
              aria-label="SQL query"
              className="resize-y bg-muted/30 font-mono"
            />
          </div>

          {/* Run button */}
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              onClick={() => void runQuery()}
              disabled={qstate.phase === 'loading' || agents.length === 0}
              aria-label="Run SQL query"
            >
              {qstate.phase === 'loading' ? 'Running…' : 'Run'}
            </Button>
            <span className="text-xs text-muted-foreground">⌘/Ctrl+Enter to run</span>
          </div>
        </div>
      </SectionCard>

      {/* Results area */}
      <div aria-live="polite">
        {qstate.phase === 'idle' && (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Run a query to see results.
          </p>
        )}
        {qstate.phase === 'loading' && (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-10 rounded-lg" />
            <Skeleton className="h-8 rounded-lg" />
            <Skeleton className="h-8 rounded-lg" />
            <Skeleton className="h-8 rounded-lg" />
          </div>
        )}
        {qstate.phase === 'error' && (
          <div
            role="alert"
            className={cn(
              'rounded-lg border p-4',
              qstate.denial
                ? 'border-amber-500/40 bg-amber-500/5'
                : 'border-destructive/40 bg-destructive/5',
            )}
          >
            <p
              className={cn(
                'text-sm font-medium',
                qstate.denial
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-destructive',
              )}
            >
              {qstate.denial ? 'Access denied by birdshot' : 'Query error'}
            </p>
            {qstate.denial ? (
              <dl className="mt-2 flex flex-col gap-1 text-sm">
                {qstate.denial.table ? (
                  <div className="flex gap-2">
                    <dt className="font-medium text-muted-foreground">Table</dt>
                    <dd className="font-mono">{qstate.denial.table}</dd>
                  </div>
                ) : null}
                <div className="flex gap-2">
                  <dt className="font-medium text-muted-foreground">Reason</dt>
                  <dd>{qstate.denial.reason}</dd>
                </div>
              </dl>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">{qstate.message}</p>
            )}
          </div>
        )}
        {qstate.phase === 'success' && (
          <SectionCard title="Results" headingLevel={2} contentClassName="p-0">
            {qstate.rows.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                Query returned no rows.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    {qstate.columns.map((col) => (
                      <TableHead key={col}>{col}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {qstate.rows.map((row, i) => (
                    <TableRow key={i}>
                      {row.map((cell, j) => (
                        <TableCell key={j} className="font-mono text-xs">
                          {cell === null || cell === undefined ? (
                            <span className="text-muted-foreground">NULL</span>
                          ) : (
                            String(cell)
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <p className="border-t px-4 py-2 text-xs text-muted-foreground">
              {qstate.rowCount} row{qstate.rowCount !== 1 ? 's' : ''} · {qstate.elapsedMs} ms
            </p>
          </SectionCard>
        )}
      </div>
    </div>
  );
}

// ── Page skeleton ─────────────────────────────────────────────────────────────

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48 rounded-lg" />
        <Skeleton className="h-4 w-64 rounded-lg" />
      </div>
      <div className="flex gap-8">
        <div className="hidden w-44 flex-col gap-1 sm:flex">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-9 rounded-lg" />
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

/**
 * Lake detail page — one screen, five sections via DetailLayout sub-rail:
 *   Connect (default), Query, Catalog, Access, Workspaces.
 *
 * Fetches lake detail, catalog, ACL rules, workspaces, and agents in parallel,
 * mapping each real /api/cp/* response into the ./types view models. The catalog
 * is a separate owner/admin-only endpoint (degrades to empty on 403); the SQL
 * editor runs through the real session flow (connect → /sessions/:id/query).
 */
export default function DatalakeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { openConnect } = useConnectAgent();

  const [lake, setLake] = useState<LakeVM | null>(null);
  useBreadcrumbLabel(id, lake?.name);
  const [rules, setRules] = useState<AclRuleVM[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceVM[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;

    void Promise.all([
      fetchCp<DatalakeGetResponse>(`/api/cp/datalakes/${id}`),
      fetchCp<CatalogGetResponse>(`/api/cp/datalakes/${id}/catalog`),
      fetchCp<AclGetResponse>('/api/cp/acl'),
      fetchCp<WorkspacesGetResponse>('/api/cp/workspaces'),
      fetchCp<AgentsGetResponse>('/api/cp/agents'),
    ]).then(([lakeRes, catalogRes, aclRes, wsRes, agentsRes]) => {
      if (cancelled) return;
      if (!lakeRes.ok) {
        setNotFound(true);
        return;
      }
      const dl = lakeRes.data.datalake;
      // Catalog is a separate owner/admin-only endpoint — 403/unreachable degrades
      // to an empty catalog (Catalog section + Query default SQL handle it).
      const catalog = catalogRes.ok ? mapCatalog(catalogRes.data.schemas) : [];
      const runtimeState = dl.runtime?.state;
      setLake({
        id: dl.id,
        name: dl.name,
        slug: dl.slug,
        status: dl.status,
        region: dl.region,
        catalog,
        gateway: {
          endpointUrl: gatewayHostFor(dl.slug),
          region: dl.region,
          status: runtimeState ? runtimeSemanticStatus(runtimeState) : lakeSemanticStatus(dl.status),
        },
        // sizeBytes intentionally absent — the API returns no lake size.
      });
      if (aclRes.ok) setRules(mapAclRules(aclRes.data.rules));
      if (wsRes.ok) setWorkspaces(mapWorkspaces(wsRes.data.workspaces));
      if (agentsRes.ok) setAgents(agentsRes.data.agents);
    });

    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    return load();
  }, [load]);

  if (notFound) {
    return (
      <div className="flex flex-col gap-6">
        <EmptyState
          icon={<Database />}
          title="Lake not found"
          description={`No data lake with id "${id}" exists.`}
          action={
            <Button variant="outline" size="sm" asChild>
              <Link href="/datalakes">
                <ChevronLeft className="mr-1 size-3.5" aria-hidden="true" />
                Back to Data
              </Link>
            </Button>
          }
        />
      </div>
    );
  }

  if (!lake) {
    return <PageSkeleton />;
  }

  const semantic = lakeSemanticStatus(lake.status);
  const tableCount = lake.catalog.reduce((n, s) => n + s.tables.length, 0);
  // Badge counts the AGENTS with access (matching the "N agents have access"
  // copy), not the raw number of grant rows.
  const lakeAgentCount = new Set(
    rules.filter((r) => r.datalakeId === lake.id).map((r) => r.agentId),
  ).size;
  const lakeWorkspacesCount = workspaces.filter((w) => w.datalakeId === lake.id).length;

  const sections = [
    {
      id: 'connect',
      label: 'Connect',
      content: <ConnectSection lake={lake} />,
    },
    {
      id: 'query',
      label: 'Query',
      content: <QuerySection lake={lake} agents={agents} />,
    },
    {
      id: 'catalog',
      label: 'Catalog',
      badge: tableCount,
      content: <CatalogSection lake={lake} />,
    },
    {
      id: 'access',
      label: 'Access',
      badge: lakeAgentCount,
      content: <AccessSection lake={lake} rules={rules} agents={agents} />,
    },
    {
      id: 'workspaces',
      label: 'Workspaces',
      badge: lakeWorkspacesCount,
      content: <WorkspacesSection lake={lake} workspaces={workspaces} />,
    },
  ];

  return (
    <DetailLayout
      title={lake.name}
      status={semantic}
      meta={
        <>
          <span className="flex items-center gap-1">
            <MapPin className="size-3.5" aria-hidden="true" />
            {lake.region}
          </span>
          <span className="flex items-center gap-1">
            <Table2 className="size-3.5" aria-hidden="true" />
            {tableCount} table{tableCount !== 1 ? 's' : ''}
          </span>
          {(lake.sizeBytes ?? 0) > 0 && (
            <span className="flex items-center gap-1">
              <HardDrive className="size-3.5" aria-hidden="true" />
              {formatBytes(lake.sizeBytes ?? 0)}
            </span>
          )}
          <Link
            href="/datalakes"
            className="ml-auto flex items-center gap-1 text-xs hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
            aria-label="Back to Data lakes"
          >
            <ChevronLeft className="size-3.5" aria-hidden="true" />
            Data
          </Link>
        </>
      }
      actions={
        <Button size="sm" onClick={() => openConnect({ lakeId: lake.id })}>
          <Plug className="mr-1.5 size-3.5" aria-hidden="true" />
          Connect an agent
        </Button>
      }
      sections={sections}
      defaultSection="connect"
    />
  );
}
