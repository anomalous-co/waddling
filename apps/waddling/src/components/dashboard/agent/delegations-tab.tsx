'use client';

/**
 * Agents ▸ Delegations — the org-wide, cross-principal view of every delegated
 * scope (the old /connected data, folded into the Agents surface). Owner/admin
 * only: the server gates `/api/cp/delegations?scope=org` with a 403, and this
 * tab shows an "Admins only" state on that 403 rather than leaking existence.
 */
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ShieldAlert } from 'lucide-react';
import {
  Table, TableHeader, TableRow, TableHead, TableBody, TableCell,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { StatusBadge } from '@/components/dashboard/status';
import { fetchCp } from '@/components/dashboard/fetch';
import type { DatalakeSummary } from '@/lib/types';

interface DelegationRow {
  id: string;
  agentId?: string;
  clientId?: string;
  agentName?: string;
  datalakeId?: string;
  schemaName: string;
  tableName: string;
  capability: string;
  expiresAt?: string;
}

function principalLabel(d: DelegationRow): string {
  if (d.agentName) return d.agentName;
  if (d.agentId) return `agent:${d.agentId.slice(0, 8)}…`;
  if (d.clientId) return `claude:${d.clientId.slice(0, 10)}…`;
  return '—';
}

function principalKind(d: DelegationRow): string {
  if (d.agentId) return 'autonomous';
  if (d.clientId) return 'delegated';
  return '—';
}

export function DelegationsTab() {
  const [rows, setRows] = useState<DelegationRow[]>([]);
  const [lakeNames, setLakeNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    const [delRes, lakesRes] = await Promise.all([
      fetchCp<{ delegations: DelegationRow[] }>('/api/cp/delegations?scope=org'),
      fetchCp<{ datalakes: DatalakeSummary[] }>('/api/cp/datalakes'),
    ]);
    if (!delRes.ok) {
      if (delRes.status === 403) setForbidden(true);
      else setError(delRes.error);
      setLoading(false);
      return;
    }
    setRows(delRes.data.delegations ?? []);
    if (lakesRes.ok) {
      const map: Record<string, string> = {};
      for (const l of lakesRes.data.datalakes ?? []) map[l.id] = l.name;
      setLakeNames(map);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-3/4" />
      </div>
    );
  }

  if (forbidden) {
    return (
      <Empty className="py-10">
        <EmptyHeader>
          <ShieldAlert className="size-5 text-muted-foreground" />
          <EmptyTitle>Admins only</EmptyTitle>
          <EmptyDescription>
            Viewing every delegation across the org is restricted to owners and admins.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw data-icon="inline-start" /> Retry
        </Button>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <Empty className="py-10">
        <EmptyHeader>
          <EmptyTitle>No delegations yet</EmptyTitle>
          <EmptyDescription>
            When an agent or OAuth client is granted a slice of a user&apos;s access, it appears here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Principal</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Scope</TableHead>
          <TableHead>Capability</TableHead>
          <TableHead>Expires</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((d) => (
          <TableRow key={d.id}>
            <TableCell className="font-medium">{principalLabel(d)}</TableCell>
            <TableCell><StatusBadge status={principalKind(d)} /></TableCell>
            <TableCell className="font-mono text-xs">
              {(d.datalakeId ? (lakeNames[d.datalakeId] ?? d.datalakeId.slice(0, 8)) : 'all lakes')}
              .{d.schemaName}.{d.tableName}
            </TableCell>
            <TableCell><Badge variant="secondary">{d.capability}</Badge></TableCell>
            <TableCell className="tabular-nums text-xs text-muted-foreground">
              {d.expiresAt ? new Date(d.expiresAt).toLocaleDateString() : '—'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
