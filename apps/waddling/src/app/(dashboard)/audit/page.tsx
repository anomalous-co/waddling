'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import { StatusBadge } from '@/components/dashboard/status';
import { fetchCp } from '@/components/dashboard/fetch';
import type { AuditEventRow, AuditQuery, AgentSummary } from '@/lib/types';

// ── Event-type badge — these are not lifecycle words so we use Badge variants,
// not StatusBadge. Raw colours are intentionally avoided per the shadcn rules.
const EVENT_VARIANT: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  auth: 'secondary',
  authorize: 'secondary',
  query: 'outline',
  grant: 'default',
  revoke: 'destructive',
  kill: 'destructive',
  attach: 'secondary',
};

function EventBadge({ event }: { event: string }) {
  const variant = EVENT_VARIANT[event] ?? 'outline';
  return (
    <Badge variant={variant} className="font-mono">
      {event}
    </Badge>
  );
}

// ── Filter state ──────────────────────────────────────────────────────────────

// "all" is used as the Radix Select sentinel in place of empty string, which
// Radix Select rejects at runtime. It maps back to undefined in buildQuery.
const AGENT_ALL = 'all';
const DECISION_ALL = 'all';

type DecisionFilter = typeof DECISION_ALL | 'allow' | 'deny';

interface FilterState {
  agentId: string; // AGENT_ALL or a real agent id
  since: string;   // ISO string or ''
  decision: DecisionFilter;
  limit: number;
}

// Radix Select rejects empty-string values, so "All time" uses the sentinel
// '__all__' at the Select level and maps to '' (no filter) in the query.
const SINCE_ALL = '__all__';

type SinceSelectValue = typeof SINCE_ALL | '1h' | '6h' | '24h' | '7d';

const SINCE_OPTIONS: { label: string; value: SinceSelectValue }[] = [
  { label: 'All time', value: SINCE_ALL },
  { label: 'Last hour', value: '1h' },
  { label: 'Last 6 hours', value: '6h' },
  { label: 'Last 24 hours', value: '24h' },
  { label: 'Last 7 days', value: '7d' },
];

const SINCE_MS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

// Maps a Select sentinel value to an ISO string (or '' to mean "no filter").
// Computed fresh at apply time so stale timestamps never linger in state.
function sincePresetToIso(preset: SinceSelectValue): string {
  if (preset === SINCE_ALL) return '';
  const offsetMs = SINCE_MS[preset];
  if (!offsetMs) return '';
  return new Date(Date.now() - offsetMs).toISOString();
}

const LIMIT_OPTIONS = [25, 50, 100, 250, 500] as const;

// ── Skeleton ──────────────────────────────────────────────────────────────────

function AuditSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AuditPage() {
  const [events, setEvents] = useState<AuditEventRow[]>([]);
  const [total, setTotal] = useState(0);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const [sincePreset, setSincePreset] = useState<SinceSelectValue>('1h');

  const [filters, setFilters] = useState<FilterState>({
    agentId: AGENT_ALL,
    since: sincePresetToIso('1h'),
    decision: DECISION_ALL,
    limit: 100,
  });

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // One-time agent list fetch (not polled).
  useEffect(() => {
    let cancelled = false;
    void fetchCp<{ agents: AgentSummary[] }>('/api/cp/agents').then((res) => {
      if (cancelled) return;
      if (res.ok) setAgents(res.data.agents ?? []);
      setAgentsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const buildQuery = useCallback((f: FilterState): AuditQuery => ({
    agentId: f.agentId === AGENT_ALL ? undefined : f.agentId,
    since: f.since || undefined,
    decision: f.decision === DECISION_ALL ? undefined : f.decision,
    limit: f.limit,
  }), []);

  const load = useCallback(
    async (f?: FilterState) => {
      const q = buildQuery(f ?? filters);
      const params = new URLSearchParams();
      if (q.agentId) params.set('agentId', q.agentId);
      if (q.since) params.set('since', q.since);
      if (q.decision) params.set('decision', q.decision);
      params.set('limit', String(q.limit ?? 100));

      const res = await fetchCp<{ events: AuditEventRow[]; total: number }>(
        `/api/cp/audit?${params.toString()}`,
      );
      if (!res.ok) {
        setError(res.error);
      } else {
        setEvents(res.data.events ?? []);
        setTotal(res.data.total ?? 0);
        setError(null);
      }
      setLoading(false);
    },
    [buildQuery, filters],
  );

  // Initial load.
  useEffect(() => {
    void load();
  }, [load]);

  // Auto-refresh polling (5s).
  useEffect(() => {
    if (!autoRefresh) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    pollRef.current = setInterval(() => void load(), 5_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [autoRefresh, load]);

  const applyFilters = () => {
    // Recompute the "since" ISO at the moment the user clicks Apply so the
    // relative window is always fresh (avoids stale timestamps from mount).
    const fresh = { ...filters, since: sincePresetToIso(sincePreset) };
    setFilters(fresh);
    setLoading(true);
    void load(fresh);
  };

  const agentById = new Map(agents.map((a) => [a.id, a]));

  if (loading && events.length === 0) return <AuditSkeleton />;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit Log</h1>
        <p className="text-sm text-muted-foreground">
          Events emitted by gateways, agents, and the control plane.
        </p>
      </div>

      {/* Filter bar */}
      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {/* Agent */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="f-agent">Agent</Label>
              <Select
                value={filters.agentId}
                onValueChange={(v) =>
                  setFilters((f) => ({ ...f, agentId: v }))
                }
                disabled={agentsLoading}
              >
                <SelectTrigger id="f-agent" className="w-full">
                  <SelectValue placeholder="All agents" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AGENT_ALL}>All agents</SelectItem>
                  {agents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Since */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="f-since">Since</Label>
              <Select
                value={sincePreset}
                onValueChange={(v) => {
                  const preset = v as SinceSelectValue;
                  setSincePreset(preset);
                  // Compute the ISO string now so it reflects the actual apply
                  // time; it will be recomputed again in applyFilters/load.
                  setFilters((f) => ({
                    ...f,
                    since: sincePresetToIso(preset),
                  }));
                }}
              >
                <SelectTrigger id="f-since" className="w-full">
                  <SelectValue placeholder="All time" />
                </SelectTrigger>
                <SelectContent>
                  {SINCE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Decision */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="f-decision">Decision</Label>
              <Select
                value={filters.decision}
                onValueChange={(v) =>
                  setFilters((f) => ({
                    ...f,
                    decision: v as DecisionFilter,
                  }))
                }
              >
                <SelectTrigger id="f-decision" className="w-full">
                  <SelectValue placeholder="All decisions" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DECISION_ALL}>All decisions</SelectItem>
                  <SelectItem value="allow">Allow</SelectItem>
                  <SelectItem value="deny">Deny</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Limit */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="f-limit">Limit</Label>
              <Select
                value={String(filters.limit)}
                onValueChange={(v) =>
                  setFilters((f) => ({ ...f, limit: Number(v) }))
                }
              >
                <SelectTrigger id="f-limit" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LIMIT_OPTIONS.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <Button size="sm" onClick={applyFilters} disabled={loading}>
              Apply filters
            </Button>

            <div className="flex items-center gap-2">
              <Switch
                id="auto-refresh"
                checked={autoRefresh}
                onCheckedChange={setAutoRefresh}
                size="sm"
              />
              <Label htmlFor="auto-refresh" className="text-xs text-muted-foreground">
                Auto-refresh (5s)
              </Label>
            </div>

            {loading ? (
              <RefreshCw className="size-3.5 animate-spin text-muted-foreground" />
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* Events table */}
      <Card>
        <CardHeader>
          <CardTitle>Events</CardTitle>
          <CardDescription>
            {total.toLocaleString()} total — showing {events.length}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Failed to load audit events</AlertTitle>
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
          ) : events.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No audit events</EmptyTitle>
                <EmptyDescription>
                  Events appear here as agents connect and issue queries.
                  Try broadening your filters.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Data Lake</TableHead>
                  <TableHead>Decision</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Query</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((ev) => {
                  const agent = ev.agentId ? agentById.get(ev.agentId) : undefined;
                  return (
                    <TableRow key={ev.id}>
                      {/* Timestamp */}
                      <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(ev.ts).toLocaleString([], {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}
                      </TableCell>

                      {/* Source — neutral text, not raw colour */}
                      <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                        {ev.source}
                      </TableCell>

                      {/* Event type badge */}
                      <TableCell>
                        <EventBadge event={ev.event} />
                      </TableCell>

                      {/* Agent */}
                      <TableCell className="font-mono text-xs">
                        {agent ? (
                          <span>{agent.name}</span>
                        ) : ev.agentId ? (
                          <span className="text-muted-foreground">
                            {ev.agentId.slice(0, 8)}…
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>

                      {/* Data Lake */}
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {ev.datalakeId ? (
                          <span>{ev.datalakeId.slice(0, 8)}…</span>
                        ) : (
                          <span>—</span>
                        )}
                      </TableCell>

                      {/* Decision — StatusBadge (allow/deny are in the tone map) */}
                      <TableCell>
                        {ev.decision ? (
                          <StatusBadge status={ev.decision} />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>

                      {/* Reason */}
                      <TableCell className="text-xs text-muted-foreground max-w-[180px] truncate">
                        {ev.reason ?? '—'}
                      </TableCell>

                      {/* Query — truncated with tooltip for the full text */}
                      <TableCell className="max-w-[200px]">
                        {ev.query ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <code className="font-mono text-xs text-muted-foreground truncate block max-w-[200px] cursor-default">
                                {ev.query}
                              </code>
                            </TooltipTrigger>
                            <TooltipContent side="left" className="max-w-xs break-all">
                              <code className="font-mono text-xs">{ev.query}</code>
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
