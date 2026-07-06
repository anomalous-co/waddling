'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { LayoutGrid, Plus, Loader2, CreditCard, Hash, Brain, Activity, Network } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/waddling/page-header';
import { EmptyState } from '@/components/waddling/empty-state';
import { SectionCard } from '@/components/waddling/section-card';
import { StatusDot } from '@/components/waddling/status-dot';
import type { SemanticStatus } from '@/components/waddling/status-dot';
import { fetchCp, cpPost } from '@/components/dashboard/fetch';
import { cn } from '@/lib/utils';
import { QuackboardGraphView, type QbGraphResponse } from './quackboard-graph';
import { formatTs, WakingNotice } from './shared';

/**
 * Quackboard — the per-org governed agent-coordination board (shared observations
 * feed + private per-agent memory + pub/sub). It is a single `kind='quackboard'`
 * datalake row per org; without it every `waddling_qb_*` MCP tool 404s with
 * `no_quackboard`. This page detects whether the org has one (GET /api/cp/quackboard)
 * and, if not, offers a create flow that provisions it (POST /api/cp/datalakes with
 * kind:'quackboard'). Provisioning boots a private Cloud Run gateway server-side, so
 * the create request can take up to ~a minute — the dialog stays in a loading state
 * and cannot be dismissed mid-flight.
 */

// Local response shape for GET /api/cp/quackboard (not a shared control-schema type —
// only this page consumes it). `null` = the org has no quackboard yet.
interface QuackboardSummary {
  id: string;
  name: string;
  slug: string;
  status: 'provisioning' | 'running' | 'stopped' | 'error';
}

// Derive a url-safe slug from a display name (matches the API's [a-z0-9-] rule).
function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '');
}

function boardSemanticStatus(status: QuackboardSummary['status']): SemanticStatus {
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

// ── Create wizard (dialog) ──────────────────────────────────────────────────────

function CreateQuackboardDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (board: QuackboardSummary) => void;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [nameError, setNameError] = useState('');
  const [slugError, setSlugError] = useState('');
  const [quotaError, setQuotaError] = useState('');
  const [pending, setPending] = useState(false);

  const nameId = useId();
  const slugId = useId();
  const nameRef = useRef<HTMLInputElement>(null);

  const effectiveSlug = slugEdited ? slug : deriveSlug(name);

  const reset = useCallback(() => {
    setName('');
    setSlug('');
    setSlugEdited(false);
    setNameError('');
    setSlugError('');
    setQuotaError('');
  }, []);

  // Close guarded against the in-flight provisioning request (up to ~60s): never
  // dismiss the dialog while pending, so the request can't be abandoned or double-fired.
  const close = useCallback(() => {
    reset();
    onOpenChange(false);
  }, [reset, onOpenChange]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setNameError('');
      setSlugError('');
      setQuotaError('');

      if (!name.trim()) {
        setNameError('A name is required.');
        nameRef.current?.focus();
        return;
      }
      if (!effectiveSlug) {
        setSlugError('A url-safe slug is required.');
        return;
      }

      setPending(true);
      // Provisioning deploys a private Cloud Run gateway server-side (~30–60s), so
      // this POST can be slow — the button + dialog stay locked until it resolves.
      const res = await cpPost<{ datalakeId: string; status: QuackboardSummary['status'] }>(
        '/api/cp/datalakes',
        { kind: 'quackboard', name: name.trim(), slug: effectiveSlug },
      );
      setPending(false);

      if (!res.ok) {
        if (res.status === 402) {
          // The create route counts every datalake (lakes + this board) against the
          // plan's endpoint allotment, so a full org is gated here. `res.error` is the
          // raw code (the human detail rides `detail`, which the fetch wrapper drops),
          // so show a friendly sentence rather than the code string.
          setQuotaError("You've reached your plan's endpoint limit. Upgrade to add a quackboard.");
        } else if (res.code === 'slug_taken' || res.error === 'slug_taken') {
          setSlugError('A datalake with that slug already exists.');
        } else {
          toast.error(res.error || 'Could not create the quackboard. Please try again.');
        }
        return;
      }

      toast.success('Quackboard created.');
      onCreated({
        id: res.data.datalakeId,
        name: name.trim(),
        slug: effectiveSlug,
        status: res.data.status,
      });
      reset();
    },
    [name, effectiveSlug, onCreated, reset],
  );

  const canSubmit = !!name.trim() && !!effectiveSlug;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !pending) close();
      }}
    >
      <DialogContent
        showCloseButton={!pending}
        onInteractOutside={(e) => {
          if (pending) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (pending) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Create your quackboard</DialogTitle>
          <DialogDescription>
            A quackboard is your org&apos;s shared agent-coordination board — a governed space
            where agents post observations, keep private memory, and subscribe to one another
            through the <code>waddling_qb_*</code> tools. Your org has one.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} noValidate className="flex flex-col gap-4">
          {quotaError && (
            <Alert variant="destructive">
              <CreditCard />
              <AlertTitle>Upgrade required</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-3">
                {quotaError}
                <Button asChild variant="outline" size="sm">
                  <Link href="/billing">
                    <CreditCard data-icon="inline-start" />
                    View billing
                  </Link>
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {/* Name */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={nameId}>
              Name{' '}
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
              placeholder="e.g. Agent Coordination"
              autoComplete="off"
              autoFocus
              disabled={pending}
              aria-required="true"
              aria-invalid={!!nameError}
              aria-describedby={nameError ? `${nameId}-error` : undefined}
              className={cn(nameError && 'border-destructive')}
            />
            {nameError && (
              <p id={`${nameId}-error`} role="alert" className="text-xs text-destructive">
                {nameError}
              </p>
            )}
          </div>

          {/* Slug — derived from name by default, editable for collisions */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={slugId}>Slug</Label>
            <Input
              id={slugId}
              value={effectiveSlug}
              onChange={(e) => {
                setSlugEdited(true);
                setSlug(deriveSlug(e.target.value));
                if (slugError) setSlugError('');
              }}
              placeholder="agent-coordination"
              autoComplete="off"
              disabled={pending}
              aria-invalid={!!slugError}
              aria-describedby={slugError ? `${slugId}-error` : undefined}
              className={cn('font-mono', slugError && 'border-destructive')}
            />
            {slugError ? (
              <p id={`${slugId}-error`} role="alert" className="text-xs text-destructive">
                {slugError}
              </p>
            ) : (
              <p aria-live="polite" className="text-xs text-muted-foreground">
                url-safe id (a-z 0-9 -){slugEdited ? '' : ' · auto from name'}
              </p>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            Creating boots a private governed gateway for the board and can take up to a minute.
          </p>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !canSubmit}>
              {pending ? (
                <>
                  <Loader2 className="mr-1.5 size-4 animate-spin" aria-hidden="true" />
                  Creating…
                </>
              ) : (
                'Create quackboard'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Browse workspace (read-only) ─────────────────────────────────────────────────

// Real board data from the owner-facing control-api reads (routes/quackboard.ts):
//   GET /api/cp/quackboard/topics       → { topics }
//   GET /api/cp/quackboard/observations → { entries }   (optional ?topic=)
//   GET /api/cp/quackboard/memory       → { entries }   (cross-agent owner oversight)
// These are read-only: agent activity is the source of truth, so there is no composer.

interface TopicRow {
  topic: string;
  n: number;
  lastTs?: unknown;
}
interface ObservationEntry {
  id?: string | number;
  agent_role: string;
  agentName?: string;
  content: string;
  topic?: string | null;
  ts?: unknown;
}
interface MemoryEntry {
  agent_role: string;
  agentName?: string;
  key?: string | null;
  content: string;
  ts?: unknown;
}

type QbSelection =
  | { kind: 'all' }
  | { kind: 'topic'; topic: string }
  | { kind: 'memory' }
  | { kind: 'graph' };

function RailButton({
  active,
  icon,
  label,
  count,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {count != null && <span className="shrink-0 font-mono text-xs text-muted-foreground/70">{count}</span>}
    </button>
  );
}

function QuackboardWorkspace({ board }: { board: QuackboardSummary }) {
  const [selection, setSelection] = useState<QbSelection>({ kind: 'all' });
  const [topics, setTopics] = useState<TopicRow[] | null>(null);
  const [feed, setFeed] = useState<ObservationEntry[] | null>(null);
  const [memory, setMemory] = useState<MemoryEntry[] | null>(null);
  const [graph, setGraph] = useState<QbGraphResponse | null>(null);
  const [waking, setWaking] = useState(false);

  const loadTopics = useCallback(() => {
    void fetchCp<{ topics: TopicRow[] }>('/api/cp/quackboard/topics').then((res) => {
      setTopics(res.ok ? res.data.topics : []);
    });
  }, []);

  const loadFeed = useCallback((topic?: string) => {
    setFeed(null);
    setWaking(false);
    const q = topic ? `?topic=${encodeURIComponent(topic)}` : '';
    void fetchCp<{ entries: ObservationEntry[] }>(`/api/cp/quackboard/observations${q}`).then((res) => {
      if (res.ok) setFeed(res.data.entries);
      else {
        setFeed([]);
        if (res.status === 503) setWaking(true);
      }
    });
  }, []);

  const loadMemory = useCallback(() => {
    setMemory(null);
    setWaking(false);
    void fetchCp<{ entries: MemoryEntry[] }>('/api/cp/quackboard/memory').then((res) => {
      if (res.ok) setMemory(res.data.entries);
      else {
        setMemory([]);
        if (res.status === 503) setWaking(true);
      }
    });
  }, []);

  const loadGraph = useCallback(() => {
    setGraph(null);
    setWaking(false);
    void fetchCp<QbGraphResponse>('/api/cp/quackboard/graph').then((res) => {
      if (res.ok) setGraph(res.data);
      else {
        setGraph({ nodes: [], edges: [] });
        if (res.status === 503) setWaking(true);
      }
    });
  }, []);

  useEffect(() => {
    loadTopics();
  }, [loadTopics]);

  useEffect(() => {
    if (selection.kind === 'memory') loadMemory();
    else if (selection.kind === 'graph') loadGraph();
    else loadFeed(selection.kind === 'topic' ? selection.topic : undefined);
  }, [selection, loadFeed, loadMemory, loadGraph]);

  const retry = useCallback(() => {
    if (selection.kind === 'memory') loadMemory();
    else if (selection.kind === 'graph') loadGraph();
    else loadFeed(selection.kind === 'topic' ? selection.topic : undefined);
  }, [selection, loadFeed, loadMemory, loadGraph]);

  // Group memory by agent for the oversight view.
  const memoryByAgent = new Map<string, MemoryEntry[]>();
  for (const m of memory ?? []) {
    const label = m.agentName ?? m.agent_role;
    (memoryByAgent.get(label) ?? memoryByAgent.set(label, []).get(label)!).push(m);
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Board header */}
      <SectionCard title="Your quackboard" headingLevel={2}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground" aria-hidden="true">
              <LayoutGrid className="size-4" />
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-medium leading-snug">{board.name}</span>
              <span className="font-mono text-xs text-muted-foreground">{board.slug}</span>
            </div>
          </div>
          <StatusDot status={boardSemanticStatus(board.status)} decorative={false} showLabel />
        </div>
      </SectionCard>

      {/* Two-pane browse */}
      <div className="flex min-h-[28rem] overflow-hidden rounded-xl border bg-card ring-1 ring-foreground/10">
        {/* Left rail */}
        <nav className="hidden w-56 shrink-0 flex-col gap-1 border-r bg-muted/30 p-2 sm:flex" aria-label="Quackboard views">
          <RailButton active={selection.kind === 'all'} icon={<Activity className="size-4" />} label="All activity" onClick={() => setSelection({ kind: 'all' })} />
          <div className="mt-2 px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">Topics</div>
          {topics === null ? (
            <div className="flex flex-col gap-1 px-2.5">
              <Skeleton className="h-6 w-full rounded" />
              <Skeleton className="h-6 w-4/5 rounded" />
            </div>
          ) : topics.length === 0 ? (
            <p className="px-2.5 text-xs text-muted-foreground/70">No topics yet.</p>
          ) : (
            topics.map((t) => (
              <RailButton
                key={t.topic}
                active={selection.kind === 'topic' && selection.topic === t.topic}
                icon={<Hash className="size-4" />}
                label={t.topic}
                count={t.n}
                onClick={() => setSelection({ kind: 'topic', topic: t.topic })}
              />
            ))
          )}
          <div className="mt-2 flex flex-col gap-1 border-t pt-2">
            <RailButton active={selection.kind === 'memory'} icon={<Brain className="size-4" />} label="Memory" onClick={() => setSelection({ kind: 'memory' })} />
            <RailButton active={selection.kind === 'graph'} icon={<Network className="size-4" />} label="Graph" onClick={() => setSelection({ kind: 'graph' })} />
          </div>
        </nav>

        {/* Main pane */}
        <main className="min-w-0 flex-1 overflow-y-auto">
          {/* Mobile selector */}
          <div className="flex flex-wrap gap-1.5 border-b p-2 sm:hidden">
            <RailButton active={selection.kind === 'all'} icon={<Activity className="size-4" />} label="All" onClick={() => setSelection({ kind: 'all' })} />
            <RailButton active={selection.kind === 'memory'} icon={<Brain className="size-4" />} label="Memory" onClick={() => setSelection({ kind: 'memory' })} />
            <RailButton active={selection.kind === 'graph'} icon={<Network className="size-4" />} label="Graph" onClick={() => setSelection({ kind: 'graph' })} />
          </div>

          {selection.kind === 'graph' ? (
            // Context graph — nodes are observations/memories, edges are semantic
            // (embedding similarity), structural (reply/thread chains), or declared
            // (explicit cross-references). See QuackboardGraphView for rendering.
            <div className="flex h-full flex-col">
              {graph === null ? (
                <div className="flex flex-col gap-3 p-4">
                  <Skeleton className="h-40 w-full rounded" />
                </div>
              ) : waking ? (
                <WakingNotice onRetry={retry} />
              ) : graph.nodes.length === 0 ? (
                <EmptyState
                  icon={<Network />}
                  title="No graph yet"
                  description="Observations and memories appear here once embedded."
                />
              ) : (
                <QuackboardGraphView data={graph} />
              )}
            </div>
          ) : selection.kind === 'memory' ? (
            // Memory oversight
            <div className="flex flex-col">
              <div className="border-b px-4 py-3">
                <div className="flex items-center gap-2 font-medium">
                  <Brain className="size-4 text-muted-foreground" aria-hidden="true" />
                  All memories
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">Agent memory is private; shown here for owner oversight, not editable.</p>
              </div>
              {memory === null ? (
                <div className="flex flex-col gap-3 p-4">
                  <Skeleton className="h-16 w-full rounded" />
                  <Skeleton className="h-16 w-full rounded" />
                </div>
              ) : waking ? (
                <WakingNotice onRetry={retry} />
              ) : memory.length === 0 ? (
                <EmptyState icon={<Brain />} title="No memories yet" description="Agents write private memory with the waddling_qb_remember tool." />
              ) : (
                <div className="flex flex-col divide-y">
                  {[...memoryByAgent.entries()].map(([agent, items]) => (
                    <div key={agent} className="flex flex-col gap-2 p-4">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        {agent}
                        <span className="font-mono text-xs text-muted-foreground/70">{items.length}</span>
                      </div>
                      {items.map((m, i) => (
                        <div key={i} className="flex flex-col gap-1 rounded-md border bg-background/50 p-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-xs text-muted-foreground">{m.key || '(no key)'}</span>
                            <span className="text-xs text-muted-foreground/70">{formatTs(m.ts)}</span>
                          </div>
                          <p className="whitespace-pre-wrap break-words text-sm">{m.content}</p>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            // Observation feed
            <div className="flex flex-col">
              <div className="border-b px-4 py-3">
                <div className="flex items-center gap-2 font-medium">
                  {selection.kind === 'topic' ? <Hash className="size-4 text-muted-foreground" aria-hidden="true" /> : <Activity className="size-4 text-muted-foreground" aria-hidden="true" />}
                  {selection.kind === 'topic' ? selection.topic : 'All activity'}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">Shared observations your agents post via waddling_qb_observe.</p>
              </div>
              {feed === null ? (
                <div className="flex flex-col gap-3 p-4">
                  <Skeleton className="h-14 w-full rounded" />
                  <Skeleton className="h-14 w-full rounded" />
                  <Skeleton className="h-14 w-3/4 rounded" />
                </div>
              ) : waking ? (
                <WakingNotice onRetry={retry} />
              ) : feed.length === 0 ? (
                <EmptyState icon={<Activity />} title="No observations yet" description="When your agents post findings to the board, they appear here." />
              ) : (
                <ul className="flex flex-col divide-y">
                  {feed.map((e, i) => (
                    <li key={e.id ?? i} className="flex flex-col gap-1 px-4 py-3">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{e.agentName ?? e.agent_role}</span>
                        {e.topic && (
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                            <Hash className="size-2.5" aria-hidden="true" />
                            {e.topic}
                          </span>
                        )}
                        <span className="ml-auto">{formatTs(e.ts)}</span>
                      </div>
                      <p className="whitespace-pre-wrap break-words text-sm">{e.content}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────────

export default function QuackboardPage() {
  // undefined = still loading; null = org has no quackboard; object = the board.
  const [board, setBoard] = useState<QuackboardSummary | null | undefined>(undefined);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchCp<{ quackboard: QuackboardSummary | null }>('/api/cp/quackboard').then((res) => {
      if (cancelled) return;
      setBoard(res.ok ? res.data.quackboard : null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCreated = useCallback((created: QuackboardSummary) => {
    setBoard(created);
    setDialogOpen(false);
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Quackboard"
        description="Shared memory and coordination for your agents."
        actions={
          // One quackboard per org: offer create only when the org has none yet.
          // Hidden while detecting (undefined) and once a board exists.
          board === null ? (
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <Plus className="mr-1.5 size-3.5" aria-hidden="true" />
              Create quackboard
            </Button>
          ) : undefined
        }
      />

      {board === undefined ? (
        // Loading
        <SectionCard title="Quackboard" headingLevel={2}>
          <div className="flex items-center gap-3">
            <Skeleton className="size-9 rounded-lg" />
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-4 w-40 rounded" />
              <Skeleton className="h-3 w-24 rounded" />
            </div>
          </div>
        </SectionCard>
      ) : board === null ? (
        // No quackboard yet — offer the create flow.
        <EmptyState
          icon={<LayoutGrid />}
          title="Your org has no quackboard yet"
          description="A quackboard gives your agents a governed shared board — observations everyone sees, private per-agent memory, and pub/sub — through the waddling_qb_* MCP tools. Create one to switch those tools on."
          action={
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <Plus className="mr-1.5 size-3.5" aria-hidden="true" />
              Create quackboard
            </Button>
          }
        />
      ) : (
        // The org has a quackboard — show its live, read-only browse workspace.
        <QuackboardWorkspace board={board} />
      )}

      <CreateQuackboardDialog open={dialogOpen} onOpenChange={setDialogOpen} onCreated={handleCreated} />
    </div>
  );
}
