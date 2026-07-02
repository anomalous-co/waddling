'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plug, Bot, Radio } from 'lucide-react';
import { fetchCp } from '@/components/dashboard/fetch';
import type {
  AgentSummary,
  DatalakeSummary,
  SessionSummary,
} from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useConnectAgent } from '@/components/waddling/connect-agent-dialog';
import { GoldenPathCard } from '@/components/waddling/golden-path-card';
import { StatusDot } from '@/components/waddling/status-dot';
import { SectionCard } from '@/components/waddling/section-card';
import { EmptyState } from '@/components/waddling/empty-state';
import {
  agentSemanticStatus,
  formatRelative,
} from '@/components/waddling/agent-status';

// ── Live sessions section ─────────────────────────────────────────────────────

interface LiveSessionsData {
  sessions: SessionSummary[];
  agentById: Map<string, AgentSummary>;
  datalakeById: Map<string, DatalakeSummary>;
}

function LiveSessionsCard() {
  const [data, setData] = useState<LiveSessionsData | null>(null);

  useEffect(() => {
    let cancelled = false;
    // SessionSummary carries only ids — resolve agent/lake display names from
    // the agents + datalakes lists. (The real /api/cp/sessions has no
    // denormalised names, and no `lastQuery` at all — see "Last query" below.)
    void Promise.all([
      fetchCp<{ sessions: SessionSummary[] }>('/api/cp/sessions?status=active'),
      fetchCp<{ agents: AgentSummary[] }>('/api/cp/agents'),
      fetchCp<{ datalakes: DatalakeSummary[] }>('/api/cp/datalakes'),
    ]).then(([sessRes, agentRes, lakeRes]) => {
      if (cancelled) return;
      if (!sessRes.ok) {
        setData({ sessions: [], agentById: new Map(), datalakeById: new Map() });
        return;
      }
      const agents = agentRes.ok ? agentRes.data.agents : [];
      const datalakes = lakeRes.ok ? lakeRes.data.datalakes : [];
      setData({
        sessions: sessRes.data.sessions,
        agentById: new Map(agents.map((a) => [a.id, a])),
        datalakeById: new Map(datalakes.map((d) => [d.id, d])),
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const sessions = data?.sessions ?? null;

  return (
    <SectionCard
      title="Live sessions"
      contentClassName="p-0"
      headerActions={
        sessions && sessions.length > 0 ? (
          <Button variant="ghost" size="sm" asChild>
            <Link href="/sessions">View all</Link>
          </Button>
        ) : undefined
      }
    >
      {sessions === null ? (
        <div className="flex flex-col gap-2 p-4">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : sessions.length === 0 ? (
        <div className="p-4">
          <EmptyState
            icon={<Radio />}
            title="No live sessions"
            description="Sessions appear here when an agent connects to a data lake."
          />
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Lake</TableHead>
              <TableHead className="hidden md:table-cell">Last query</TableHead>
              <TableHead className="text-right">Started</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.map((s) => {
              const agent = data?.agentById.get(s.agentId);
              const lake = data?.datalakeById.get(s.datalakeId);
              return (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">
                    {agent?.name ?? `${s.agentId.slice(0, 8)}…`}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {lake?.name ?? `${s.datalakeId.slice(0, 8)}…`}
                  </TableCell>
                  {/* SessionSummary has no `lastQuery` — always renders '—'. */}
                  <TableCell className="hidden max-w-xs truncate text-muted-foreground md:table-cell">
                    {'—'}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {formatRelative(s.startedAt)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}

// ── Your agents section ───────────────────────────────────────────────────────

function YourAgentsCard() {
  const { openConnect } = useConnectAgent();
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchCp<{ agents: AgentSummary[] }>('/api/cp/agents').then((res) => {
      if (!cancelled && res.ok) setAgents(res.data.agents);
      else if (!cancelled) setAgents([]);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Show top 5 agents on the overview
  const preview = agents?.slice(0, 5);

  return (
    <SectionCard
      title="Your agents"
      headerActions={
        <Button variant="ghost" size="sm" asChild>
          <Link href="/agents">Manage</Link>
        </Button>
      }
    >
      {agents === null ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : agents.length === 0 ? (
        <EmptyState
          icon={<Bot />}
          title="No agents yet"
          description="Create your first agent to start querying your data lakes."
          action={
            <Button size="sm" onClick={() => openConnect()}>
              <Plug className="mr-1.5 size-3.5" aria-hidden="true" />
              Connect an agent
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col divide-y divide-border">
          {preview?.map((agent) => {
            const semantic = agentSemanticStatus(agent);
            return (
              <Link
                key={agent.id}
                href={`/agents/${agent.id}`}
                className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <StatusDot status={semantic} decorative />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{agent.name}</p>
                  {agent.description && (
                    <p className="truncate text-xs text-muted-foreground">
                      {agent.description}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusDot status={semantic} showLabel className="text-xs" />
                  {agent.lastSeenAt && (
                    <span className="hidden text-xs text-muted-foreground sm:inline">
                      {formatRelative(agent.lastSeenAt)}
                    </span>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

// ── Home page ─────────────────────────────────────────────────────────────────

/**
 * Home / Overview — the golden-path launchpad.
 * Above the fold: hero CTA, live sessions table, agent roster preview.
 */
export default function OverviewPage() {
  const { openConnect } = useConnectAgent();
  return (
    <div className="flex flex-col gap-6">
      {/* Hero */}
      <GoldenPathCard
        icon={<Plug />}
        headingLevel={1}
        title="Connect an agent"
        body="Give any AI agent governed DuckDB access to your data lakes in minutes — table-level ACLs, live session monitoring, full audit trail."
        action={
          <Button onClick={() => openConnect()}>
            <Plug className="mr-1.5 size-4" aria-hidden="true" />
            Get started
          </Button>
        }
      />

      {/* Live sessions */}
      <LiveSessionsCard />

      {/* Agent roster preview */}
      <YourAgentsCard />
    </div>
  );
}
