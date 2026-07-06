'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  Plug,
  Check,
  Bot,
  ChevronRight,
  AlertCircle,
  Database,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { fetchCp, cpPost } from '@/components/dashboard/fetch';
import type { DatalakeSummary, AgentSummary, AclRuleInput } from '@/lib/types';
import { SectionCard } from '@/components/waddling/section-card';
import { StatusDot } from '@/components/waddling/status-dot';
import { Stepper } from '@/components/waddling/stepper';
import { RadioSegments } from '@/components/waddling/radio-segments';
import { KeyReveal } from '@/components/waddling/key-reveal';
import { CodeBlock } from '@/components/waddling/code-block';
// Catalog view models (local; no fixtures). The real catalog comes from the
// separate owner/admin-only GET /api/cp/datalakes/:id/catalog endpoint —
// /api/cp/datalakes/:id itself does NOT carry a catalog.
interface CatColumn {
  name: string;
  type: string;
}
interface CatTable {
  table: string;
  columnCount: number;
  columns?: CatColumn[];
}
interface CatSchema {
  schema: string;
  tables: CatTable[];
}
/** Raw shape returned by GET /api/cp/datalakes/:id/catalog. */
interface CatalogRow {
  name: string;
  tables: { name: string; columns: { name: string; type: string }[] }[];
}
import type { SemanticStatus } from '@/components/waddling/status-dot';

// ── Types ─────────────────────────────────────────────────────────────────────

type WizardStep = 'configure' | 'connect';
type AccessMode = 'read-only' | 'read-write';

const STEPS = [{ label: 'Configure' }, { label: 'Connect' }];

/** Optional defaults so a trigger can preselect the lake (e.g. lake detail page). */
export interface ConnectAgentOptions {
  lakeId?: string;
}

// ── Snippet builders ──────────────────────────────────────────────────────────

// Remote MCP over Streamable HTTP — no local install. Works as-is in Claude
// Code (.mcp.json) and any host that supports `type: "http"` servers.
function mcpConfig(agentKey: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        waddling: {
          type: 'http',
          url: 'https://api.getwaddling.com/mcp',
          headers: { Authorization: `Bearer ${agentKey}` },
        },
      },
    },
    null,
    2,
  );
}

const EXTENSION_SQL = [
  'SET allow_unsigned_extensions = true;',
  "INSTALL birdshot FROM 'https://ext.getwaddling.com';",
  'LOAD birdshot;',
].join('\n');

function duckdbSnippet(agentKey: string): string {
  return `${EXTENSION_SQL}\nATTACH 'quack:<your-gateway-endpoint>?token=${agentKey}' AS lake;`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function lakeSemanticStatus(status: DatalakeSummary['status']): SemanticStatus {
  switch (status) {
    case 'running':
      return 'active';
    case 'provisioning':
      return 'provisioning';
    case 'error':
      return 'error';
    case 'stopped':
      return 'suspended';
  }
}

// ── Configure step (identify + target + scope, one view) ──────────────────────

interface ConfigureResult {
  agent: AgentSummary;
  key: string;
  lakeId: string;
  lakeName: string;
  mode: AccessMode;
  grantedTables: string[];
}

interface ConfigureStepProps {
  lakes: DatalakeSummary[];
  lakesLoading: boolean;
  initialLakeId?: string;
  onComplete: (result: ConfigureResult) => void;
}

/**
 * One screen: name + describe the agent, choose its access mode, pick a data
 * lake, and — inline, as soon as a lake is chosen — scope which of that lake's
 * tables it may read/write. Submitting creates the agent AND grants the chosen
 * tables in a single action.
 */
function ConfigureStep({
  lakes,
  lakesLoading,
  initialLakeId,
  onComplete,
}: ConfigureStepProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedLakeId, setSelectedLakeId] = useState(initialLakeId ?? '');
  const [mode, setMode] = useState<AccessMode>('read-only');
  const [pending, setPending] = useState(false);
  const [nameError, setNameError] = useState('');
  const [lakeError, setLakeError] = useState('');

  const [catalog, setCatalog] = useState<CatSchema[] | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [readSelected, setReadSelected] = useState<Set<string>>(new Set());
  const [writeSelected, setWriteSelected] = useState<Set<string>>(new Set());

  const nameId = useId();
  const descId = useId();
  const modeId = useId();
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!selectedLakeId) {
      setCatalog(null);
      setCatalogError('');
      return;
    }
    setReadSelected(new Set());
    setWriteSelected(new Set());
    setCatalog(null);
    setCatalogError('');
    setCatalogLoading(true);
    let cancelled = false;
    void fetchCp<{ schemas: CatalogRow[] }>(
      `/api/cp/datalakes/${selectedLakeId}/catalog`,
    ).then((res) => {
      if (cancelled) return;
      setCatalogLoading(false);
      if (res.ok) {
        setCatalog(
          (res.data.schemas ?? []).map((s) => ({
            schema: s.name,
            tables: (s.tables ?? []).map((t) => ({
              table: t.name,
              columnCount: t.columns?.length ?? 0,
              columns: (t.columns ?? []).map((col) => ({ name: col.name, type: col.type })),
            })),
          })),
        );
      } else {
        // Catalog is owner/admin-only and may be empty/unreachable — degrade, never crash.
        setCatalog([]);
        setCatalogError(
          'Could not load this lake’s catalog — you can still create the agent and grant access later.',
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selectedLakeId]);

  const toggleRead = useCallback((key: string) => {
    setReadSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
        setWriteSelected((w) => {
          const wn = new Set(w);
          wn.delete(key);
          return wn;
        });
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const toggleWrite = useCallback((key: string) => {
    setWriteSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        setReadSelected((r) => new Set([...r, key]));
      }
      return next;
    });
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setNameError('');
      setLakeError('');

      let hasError = false;
      if (!name.trim()) {
        setNameError('Agent name is required.');
        hasError = true;
      }
      if (!selectedLakeId) {
        setLakeError('Please choose a data lake.');
        hasError = true;
      }
      if (hasError) {
        if (!name.trim()) nameRef.current?.focus();
        return;
      }

      setPending(true);

      const created = await cpPost<{ agent: AgentSummary; key: string }>(
        '/api/cp/agents',
        { name: name.trim(), description: description.trim(), mode },
      );
      if (!created.ok) {
        setPending(false);
        toast.error(created.error ?? 'Failed to create agent. Please try again.');
        return;
      }
      const { agent, key } = created.data;
      if (!key) {
        setPending(false);
        toast.error('Server did not return an API key. Please try again.');
        return;
      }

      // The control-api ACL schema accepts `capability` (and keys on it for write
      // grants) but @/lib/types' AclRuleInput predates that field — extend locally
      // so a write grant isn't silently compiled as read-only.
      const rules: Array<AclRuleInput & { capability: 'read' | 'write' }> = [];
      for (const tableKey of readSelected) {
        const [schema, table] = tableKey.split('.');
        if (schema && table)
          rules.push({
            datalakeId: selectedLakeId,
            agentId: agent.id,
            schema,
            table,
            capability: 'read',
            verb: 'read',
            effect: 'allow',
          });
      }
      if (mode === 'read-write') {
        for (const tableKey of writeSelected) {
          const [schema, table] = tableKey.split('.');
          if (schema && table)
            rules.push({
              datalakeId: selectedLakeId,
              agentId: agent.id,
              schema,
              table,
              capability: 'write',
              verb: 'write',
              effect: 'allow',
            });
        }
      }

      let grantedTables = [...readSelected];
      if (rules.length > 0) {
        const results = await Promise.all(
          rules.map((rule) => cpPost<{ rule: { id: string } }>('/api/cp/acl', rule)),
        );
        const failed = results.filter((r) => !r.ok).length;
        if (failed > 0) {
          grantedTables = [];
          toast.warning(
            `${agent.name} was created, but ${failed} grant(s) failed. Scope access from the agent’s page.`,
          );
        }
      }

      setPending(false);
      const lake = lakes.find((l) => l.id === selectedLakeId);
      onComplete({
        agent,
        key,
        lakeId: selectedLakeId,
        lakeName: lake?.name ?? selectedLakeId,
        mode,
        grantedTables,
      });
    },
    [name, description, selectedLakeId, mode, readSelected, writeSelected, lakes, onComplete],
  );

  const tableCount =
    catalog?.reduce((acc, s) => acc + s.tables.length, 0) ?? 0;

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      noValidate
      className="flex flex-col gap-6"
    >
      <SectionCard title="Name your agent" headingLevel={2}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={nameId}>
              Agent name{' '}
              <span aria-hidden="true" className="text-destructive">
                *
              </span>
            </Label>
            <Input
              ref={nameRef}
              id={nameId}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) setNameError('');
              }}
              placeholder="e.g. analytics-etl"
              autoComplete="off"
              aria-required="true"
              aria-describedby={nameError ? `${nameId}-error` : undefined}
              aria-invalid={!!nameError}
              className={cn(nameError && 'border-destructive')}
            />
            {nameError && (
              <p id={`${nameId}-error`} role="alert" className="text-xs text-destructive">
                {nameError}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={descId}>
              Description{' '}
              <span className="text-xs font-normal text-muted-foreground">
                (optional)
              </span>
            </Label>
            <Input
              id={descId}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What will this agent do?"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span id={modeId} className="text-sm font-medium leading-none">
              Access mode
            </span>
            <RadioSegments
              value={mode}
              onChange={setMode}
              ariaLabelledby={modeId}
              options={[
                { value: 'read-only', label: 'Read only' },
                { value: 'read-write', label: 'Read + write' },
              ]}
            />
            <p className="text-xs text-muted-foreground">
              {mode === 'read-only'
                ? 'The agent may query tables you grant read access to.'
                : 'The agent may query tables you grant read access to, and also modify those you grant write access to.'}
            </p>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Choose a data lake & scope access" headingLevel={2}>
        <div className="flex flex-col gap-4">
          {lakesLoading ? (
            <div className="space-y-2">
              {[0, 1].map((i) => (
                <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
              ))}
            </div>
          ) : lakes.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              <Database className="size-4 shrink-0" aria-hidden="true" />
              <span>
                No data lakes yet.{' '}
                <Link href="/lab/data" className="underline hover:text-foreground">
                  Create one first
                </Link>
                .
              </span>
            </div>
          ) : (
            <fieldset className="border-0 p-0">
              <legend className="sr-only">Select a data lake</legend>
              <div className="flex flex-col gap-2">
                {lakeError && (
                  <p role="alert" className="text-xs text-destructive">
                    {lakeError}
                  </p>
                )}
                {lakes.map((lake) => {
                  const id = `lake-radio-${lake.id}`;
                  return (
                    <label
                      key={lake.id}
                      htmlFor={id}
                      className={cn(
                        'flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50',
                        'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2',
                        selectedLakeId === lake.id
                          ? 'border-primary bg-primary/5'
                          : 'border-border',
                      )}
                    >
                      <input
                        type="radio"
                        id={id}
                        name="lake"
                        value={lake.id}
                        checked={selectedLakeId === lake.id}
                        onChange={() => {
                          setSelectedLakeId(lake.id);
                          if (lakeError) setLakeError('');
                        }}
                        aria-label={lake.name}
                        aria-describedby={
                          lake.status === 'provisioning' ? `${id}-note` : undefined
                        }
                        className="sr-only"
                      />
                      <StatusDot
                        status={lakeSemanticStatus(lake.status)}
                        decorative
                      />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">{lake.name}</p>
                        {lake.status === 'provisioning' && (
                          <p id={`${id}-note`} className="text-xs text-amber-500">
                            Still provisioning — you can connect now; queries will
                            work once the lake is ready.
                          </p>
                        )}
                        {lake.schemas && lake.schemas.length > 0 && (
                          <p className="text-xs text-muted-foreground">
                            {lake.schemas.join(', ')}
                          </p>
                        )}
                      </div>
                      {selectedLakeId === lake.id && (
                        <Check
                          className="size-4 shrink-0 text-primary"
                          aria-hidden="true"
                        />
                      )}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          )}

          {selectedLakeId && (
            <div className="flex flex-col gap-3 border-t pt-4">
              <div className="flex flex-col gap-1">
                <h3 className="text-sm font-semibold leading-none">
                  Grant table access
                </h3>
                <p className="text-xs text-muted-foreground">
                  Pick the tables this agent may use. Nothing is granted by
                  default — least privilege. You can also skip and scope later.
                </p>
              </div>

              {catalogError && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-muted-foreground">
                  <AlertCircle
                    className="mt-0.5 size-4 shrink-0 text-amber-500"
                    aria-hidden="true"
                  />
                  {catalogError}
                </div>
              )}

              {catalogLoading && (
                <div className="space-y-3">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="h-10 animate-pulse rounded bg-muted" />
                  ))}
                </div>
              )}

              {catalog && tableCount === 0 && !catalogLoading && (
                <p className="text-sm text-muted-foreground">
                  This lake has no tables yet — grant access once data is loaded.
                </p>
              )}

              {catalog && tableCount > 0 && (
                <div className="flex flex-col gap-4">
                  <div
                    className={cn(
                      'grid items-center gap-4 px-3 text-xs font-medium text-muted-foreground',
                      mode === 'read-write'
                        ? 'grid-cols-[1fr_4rem_4rem]'
                        : 'grid-cols-[1fr_4rem]',
                    )}
                  >
                    <span>Table</span>
                    <span className="text-center">Read</span>
                    {mode === 'read-write' && (
                      <span className="text-center">Write</span>
                    )}
                  </div>

                  {catalog.map((schemaBlock) => (
                    <fieldset
                      key={schemaBlock.schema}
                      className="flex flex-col gap-1 border-0 p-0"
                    >
                      <legend className="px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        {schemaBlock.schema}
                      </legend>
                      {schemaBlock.tables.map((t) => {
                        const key = `${schemaBlock.schema}.${t.table}`;
                        const readChecked = readSelected.has(key);
                        const writeChecked = writeSelected.has(key);
                        const readId = `read-${key}`;
                        const writeId = `write-${key}`;
                        return (
                          <div
                            key={key}
                            className={cn(
                              'grid items-center gap-4 rounded-md px-3 py-2.5 transition-colors',
                              readChecked ? 'bg-primary/5' : 'hover:bg-muted/50',
                              mode === 'read-write'
                                ? 'grid-cols-[1fr_4rem_4rem]'
                                : 'grid-cols-[1fr_4rem]',
                            )}
                          >
                            <div className="min-w-0">
                              <p className="truncate font-mono text-sm font-medium">
                                {t.table}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {t.columnCount} columns
                              </p>
                            </div>
                            <div className="flex justify-center">
                              <Checkbox
                                id={readId}
                                checked={readChecked}
                                onCheckedChange={() => toggleRead(key)}
                                aria-label={`Grant read on ${schemaBlock.schema}.${t.table}`}
                              />
                            </div>
                            {mode === 'read-write' && (
                              <div className="flex justify-center">
                                <Checkbox
                                  id={writeId}
                                  checked={writeChecked}
                                  onCheckedChange={() => toggleWrite(key)}
                                  aria-label={`Grant write on ${schemaBlock.schema}.${t.table}`}
                                />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </fieldset>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </SectionCard>

      <div className="sticky bottom-0 -mx-1 flex items-center justify-end gap-3 border-t bg-background/95 px-1 py-3 backdrop-blur">
        <p className="mr-auto text-xs text-muted-foreground" aria-live="polite">
          {readSelected.size > 0
            ? `${readSelected.size} table${readSelected.size === 1 ? '' : 's'} selected`
            : selectedLakeId
              ? 'No tables selected — the agent will connect unscoped.'
              : ''}
        </p>
        <Button type="submit" disabled={pending || lakesLoading}>
          {pending ? (
            'Creating…'
          ) : (
            <>
              Create &amp; connect
              <ChevronRight className="ml-1.5 size-4" aria-hidden="true" />
            </>
          )}
        </Button>
      </div>
    </form>
  );
}

// ── Connect step (key + snippets + granted recap) ─────────────────────────────

interface ConnectStepProps {
  agent: AgentSummary;
  agentKey: string;
  lakeName: string;
  grantedTables: string[];
  onReset: () => void;
  onViewAgent: () => void;
}

function ConnectStep({
  agent,
  agentKey,
  lakeName,
  grantedTables,
  onReset,
  onViewAgent,
}: ConnectStepProps) {
  const isScoped = grantedTables.length > 0;
  return (
    <div className="flex flex-col gap-6">
      <SectionCard title="Agent created" headingLevel={2}>
        <div className="flex items-start gap-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-emerald-500/10">
            <Check className="size-5 text-emerald-500" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-semibold leading-tight">
              <span className="font-mono">{agent.name}</span> is connected to{' '}
              <span>{lakeName}</span>
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {isScoped
                ? `Scoped to ${grantedTables.length} table${grantedTables.length === 1 ? '' : 's'}. Copy its key below and connect it.`
                : 'No tables granted yet — copy its key below, then scope access from the agent’s page so it can query.'}
            </p>
            {isScoped && (
              <ul className="mt-3 flex flex-wrap gap-2">
                {grantedTables.map((t) => (
                  <li
                    key={t}
                    className="rounded-md border bg-muted px-2.5 py-1 font-mono text-xs"
                  >
                    {t}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Your agent API key" headingLevel={2}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            This key authenticates{' '}
            <span className="font-mono font-semibold text-foreground">
              {agent.name}
            </span>{' '}
            to the waddling gateway. It was generated for you — copy it now.
          </p>
          <KeyReveal value={agentKey} />
        </div>
      </SectionCard>

      <SectionCard title="Connect your agent" headingLevel={2}>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Choose how your agent connects. Paste the config into your agent
            environment and run it — waddling handles the rest.
          </p>
          <Tabs defaultValue="mcp">
            <TabsList>
              <TabsTrigger value="mcp">MCP (recommended)</TabsTrigger>
              <TabsTrigger value="duckdb">Raw DuckDB</TabsTrigger>
            </TabsList>
            <TabsContent value="mcp" className="mt-4 flex flex-col gap-3">
              <h3 className="text-sm font-medium text-muted-foreground">
                MCP server config
              </h3>
              <CodeBlock
                code={mcpConfig(agentKey)}
                label="mcp.json"
                copyLabel="Copy MCP config"
              />
              <p className="text-xs text-muted-foreground">
                Add this to your MCP client config (e.g. Claude Desktop, Cursor).
                The agent will be able to call{' '}
                <code className="rounded bg-muted px-1 py-0.5 font-mono">
                  waddling_query
                </code>{' '}
                and other tools once connected.
              </p>
            </TabsContent>
            <TabsContent value="duckdb" className="mt-4 flex flex-col gap-3">
              <h3 className="text-sm font-medium text-muted-foreground">
                Raw DuckDB (v1.5.3)
              </h3>
              <CodeBlock
                code={duckdbSnippet(agentKey)}
                label="connect.sql"
                copyLabel="Copy DuckDB SQL"
              />
              <p className="text-xs text-muted-foreground">
                Run this in your agent&apos;s DuckDB session to load the birdshot
                extension and attach to the governed lake gateway.
              </p>
            </TabsContent>
          </Tabs>
        </div>
      </SectionCard>

      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={onReset}>
          <Bot className="mr-1.5 size-4" aria-hidden="true" />
          Connect another
        </Button>
        <Button onClick={onViewAgent}>
          <Plug className="mr-1.5 size-4" aria-hidden="true" />
          View agent
        </Button>
      </div>
    </div>
  );
}

// ── Dialog body ───────────────────────────────────────────────────────────────

function ConnectWizard({
  initialLakeId,
  onViewAgent,
}: {
  initialLakeId?: string;
  onViewAgent: () => void;
}) {
  const [step, setStep] = useState<WizardStep>('configure');
  const [result, setResult] = useState<ConfigureResult | null>(null);
  const [lakes, setLakes] = useState<DatalakeSummary[]>([]);
  const [lakesLoading, setLakesLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void fetchCp<{ datalakes: DatalakeSummary[] }>('/api/cp/datalakes').then(
      (res) => {
        if (cancelled) return;
        setLakesLoading(false);
        if (res.ok) setLakes(res.data.datalakes);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const handleConfigured = useCallback((r: ConfigureResult) => {
    setResult(r);
    setStep('connect');
  }, []);

  const handleReset = useCallback(() => {
    setResult(null);
    setStep('configure');
  }, []);

  const stepperCurrent = step === 'configure' ? 0 : 1;

  return (
    <div className="flex flex-col gap-6">
      <Stepper steps={STEPS} current={stepperCurrent} />
      {step === 'configure' && (
        <ConfigureStep
          lakes={lakes}
          lakesLoading={lakesLoading}
          initialLakeId={initialLakeId}
          onComplete={handleConfigured}
        />
      )}
      {step === 'connect' && result && (
        <ConnectStep
          agent={result.agent}
          agentKey={result.key}
          lakeName={result.lakeName}
          grantedTables={result.grantedTables}
          onReset={handleReset}
          onViewAgent={onViewAgent}
        />
      )}
    </div>
  );
}

// ── Context + provider ────────────────────────────────────────────────────────

interface ConnectAgentContextValue {
  openConnect: (options?: ConnectAgentOptions) => void;
}

const ConnectAgentContext = createContext<ConnectAgentContextValue | null>(null);

/**
 * Mount once (in the app shell). Exposes `openConnect()` to any descendant via
 * `useConnectAgent()`, and renders the single Connect-agent modal. The whole
 * onboarding conversion path lives here so it overlays the current screen
 * instead of navigating away — the user never loses context.
 */
export function ConnectAgentProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ConnectAgentOptions>({});
  // Remount the wizard each time the modal opens so step/state always resets.
  const [instanceKey, setInstanceKey] = useState(0);

  const openConnect = useCallback((opts?: ConnectAgentOptions) => {
    setOptions(opts ?? {});
    setInstanceKey((k) => k + 1);
    setOpen(true);
  }, []);

  const handleViewAgent = useCallback(() => {
    setOpen(false);
    router.push('/lab/agents');
  }, [router]);

  const value = useMemo<ConnectAgentContextValue>(
    () => ({ openConnect }),
    [openConnect],
  );

  return (
    <ConnectAgentContext.Provider value={value}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Connect an agent</DialogTitle>
            <DialogDescription>
              Give any AI agent governed DuckDB access to your data lake in two
              steps.
            </DialogDescription>
          </DialogHeader>
          <ConnectWizard
            key={instanceKey}
            initialLakeId={options.lakeId}
            onViewAgent={handleViewAgent}
          />
        </DialogContent>
      </Dialog>
    </ConnectAgentContext.Provider>
  );
}

export function useConnectAgent(): ConnectAgentContextValue {
  const ctx = useContext(ConnectAgentContext);
  if (!ctx) {
    throw new Error('useConnectAgent must be used within a ConnectAgentProvider');
  }
  return ctx;
}
