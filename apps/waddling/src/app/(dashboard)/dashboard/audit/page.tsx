'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Card,
  CardHeader,
  Badge,
  statusVariant,
  Button,
  Spinner,
  ErrorState,
  EmptyState,
  SectionTitle,
  Table,
  Td,
  Input,
  Label,
  Select,
} from '@/components/dashboard/ui';
import { fetchCp } from '@/components/dashboard/fetch';
import type { AuditEventRow, AuditQuery } from '@/lib/types';

const SOURCE_COLORS: Record<string, string> = {
  gateway: 'text-blue-300',
  'control-plane': 'text-purple-300',
  'mcp-external': 'text-green-300',
  'mcp-internal': 'text-yellow-300',
};

const EVENT_BADGES: Record<string, string> = {
  auth: 'bg-blue-900/40 text-blue-300 border-blue-800',
  authorize: 'bg-purple-900/40 text-purple-300 border-purple-800',
  query: 'bg-neutral-800 text-neutral-300 border-neutral-700',
  grant: 'bg-green-900/40 text-green-300 border-green-800',
  revoke: 'bg-red-900/40 text-red-300 border-red-800',
  kill: 'bg-red-900/60 text-red-200 border-red-700',
  attach: 'bg-yellow-900/40 text-yellow-300 border-yellow-800',
};

interface FilterState {
  agentId: string;
  since: string;
  decision: '' | 'allow' | 'deny';
  limit: number;
}

function EventBadge({ event }: { event: string }) {
  const cls = EVENT_BADGES[event] ?? 'bg-neutral-800 text-neutral-400 border-neutral-700';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono border ${cls}`}>
      {event}
    </span>
  );
}

export default function AuditPage() {
  const [events, setEvents] = useState<AuditEventRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [filters, setFilters] = useState<FilterState>({
    agentId: '',
    since: '',
    decision: '',
    limit: 100,
  });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const buildQuery = useCallback(
    (f: FilterState): AuditQuery => ({
      agentId: f.agentId || undefined,
      since: f.since || undefined,
      decision: f.decision || undefined,
      limit: f.limit,
    }),
    [],
  );

  const load = useCallback(
    async (f?: FilterState) => {
      const q = buildQuery(f ?? filters);
      const params = new URLSearchParams();
      if (q.agentId) params.set('agentId', q.agentId);
      if (q.since) params.set('since', q.since);
      if (q.decision) params.set('decision', q.decision);
      params.set('limit', String(q.limit));

      const res = await fetchCp<{ events: AuditEventRow[]; total: number }>(
        `/api/cp/audit?${params.toString()}`,
      );
      if (!res.ok) {
        setError(res.error);
      } else {
        setEvents(res.data.events);
        setTotal(res.data.total);
        setError(null);
      }
      setLoading(false);
    },
    [buildQuery, filters],
  );

  // Initial load
  useEffect(() => {
    void load();
  }, [load]);

  // Auto-refresh
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
    setLoading(true);
    void load(filters);
  };

  if (loading && events.length === 0)
    return (
      <div className="flex justify-center py-24">
        <Spinner size="lg" />
      </div>
    );

  return (
    <div className="space-y-4">
      <SectionTitle>Audit Log</SectionTitle>

      {/* Filters */}
      <Card>
        <CardHeader title="Filters" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <Label htmlFor="f-agent">Agent ID</Label>
            <Input
              id="f-agent"
              value={filters.agentId}
              onChange={(e) =>
                setFilters((f) => ({ ...f, agentId: e.target.value }))
              }
              placeholder="All agents"
            />
          </div>
          <div>
            <Label htmlFor="f-since">Since (ISO date)</Label>
            <Input
              id="f-since"
              value={filters.since}
              onChange={(e) =>
                setFilters((f) => ({ ...f, since: e.target.value }))
              }
              placeholder="2025-01-01T00:00:00Z"
            />
          </div>
          <div>
            <Label htmlFor="f-decision">Decision</Label>
            <Select
              id="f-decision"
              value={filters.decision}
              onChange={(e) =>
                setFilters((f) => ({
                  ...f,
                  decision: e.target.value as FilterState['decision'],
                }))
              }
            >
              <option value="">All</option>
              <option value="allow">allow</option>
              <option value="deny">deny</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="f-limit">Limit</Label>
            <Input
              id="f-limit"
              type="number"
              value={filters.limit}
              onChange={(e) =>
                setFilters((f) => ({ ...f, limit: Number(e.target.value) }))
              }
            />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button variant="primary" size="sm" onClick={applyFilters}>
            Apply filters
          </Button>
          <button
            className={[
              'text-xs transition-colors cursor-pointer',
              autoRefresh
                ? 'text-green-400 hover:text-green-300'
                : 'text-neutral-500 hover:text-neutral-300',
            ].join(' ')}
            onClick={() => setAutoRefresh(!autoRefresh)}
          >
            {autoRefresh ? '● Auto-refresh on' : '○ Auto-refresh off'}
          </button>
          {loading && <Spinner size="sm" />}
        </div>
      </Card>

      {/* Events table */}
      <Card>
        <CardHeader
          title="Events"
          subtitle={`${total.toLocaleString()} total — showing ${events.length}`}
        />
        {error && <ErrorState message={error} retry={applyFilters} />}
        {!error && events.length === 0 ? (
          <EmptyState
            title="No audit events"
            description="Events appear here as agents connect and issue queries."
          />
        ) : (
          <Table
            headers={['Time', 'Source', 'Event', 'Agent', 'Decision', 'Query', 'Reason']}
          >
            {events.map((ev) => (
              <tr key={ev.id}>
                <Td>
                  <span className="font-mono text-xs text-neutral-500">
                    {new Date(ev.ts).toLocaleTimeString()}
                  </span>
                </Td>
                <Td>
                  <span
                    className={`text-xs font-mono ${SOURCE_COLORS[ev.source] ?? 'text-neutral-400'}`}
                  >
                    {ev.source}
                  </span>
                </Td>
                <Td>
                  <EventBadge event={ev.event} />
                </Td>
                <Td mono>{ev.agentId ?? '—'}</Td>
                <Td>
                  {ev.decision ? (
                    <Badge variant={statusVariant(ev.decision)}>
                      {ev.decision}
                    </Badge>
                  ) : (
                    <span className="text-neutral-600">—</span>
                  )}
                </Td>
                <Td>
                  {ev.query ? (
                    <code className="font-mono text-xs text-neutral-400 truncate max-w-[200px] block">
                      {ev.query}
                    </code>
                  ) : (
                    <span className="text-neutral-600">—</span>
                  )}
                </Td>
                <Td>
                  <span className="text-xs text-neutral-500">
                    {ev.reason ?? '—'}
                  </span>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
