'use client';

import { useEffect, useState, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import { SectionHeader } from '@/components/dashboard/agent/kit';
import { fetchCp } from '@/components/dashboard/fetch';

interface ApiKeyRow {
  id: string;
  name?: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface AgentDetailShape {
  id: string;
  apiKeys?: ApiKeyRow[];
}

export function KeysSection({ agentId }: { agentId: string }) {
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetchCp<{ agent: AgentDetailShape; apiKeys?: ApiKeyRow[] }>(
      `/api/cp/agents/${agentId}`,
    );
    if (!res.ok) {
      setError(res.error);
    } else {
      // Support both envelope shapes: top-level apiKeys or agent.apiKeys
      const apiKeys =
        (res.data as { apiKeys?: ApiKeyRow[] }).apiKeys ??
        res.data.agent?.apiKeys ??
        [];
      setKeys(apiKeys);
      setError(null);
    }
    setLoading(false);
  }, [agentId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return (
      <div className="flex flex-col gap-3 py-2">
        <SectionHeader title="Keys" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col gap-2 py-2">
        <SectionHeader title="Keys" />
        <div className="flex items-center gap-2 text-sm text-destructive">
          {error}
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            <RefreshCw className="size-3.5" /> Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 py-2">
      <SectionHeader title="Keys" />

      {!keys || keys.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No API keys</EmptyTitle>
            <EmptyDescription>This agent has no active API keys.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Prefix</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last used</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((k) => (
              <TableRow key={k.id}>
                <TableCell className="font-mono text-xs">
                  {k.prefix}&hellip;
                </TableCell>
                <TableCell className="tabular-nums text-muted-foreground">
                  {new Date(k.createdAt).toLocaleDateString()}
                </TableCell>
                <TableCell className="tabular-nums text-muted-foreground">
                  {k.lastUsedAt
                    ? new Date(k.lastUsedAt).toLocaleString()
                    : 'Never'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <p className="text-xs text-muted-foreground">
        Per-key rotation is coming soon — for now, manage keys by recreating the agent.
      </p>
    </div>
  );
}
