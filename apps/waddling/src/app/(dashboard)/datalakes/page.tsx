'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Plus, RefreshCw } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import { StatusBadge } from '@/components/dashboard/status';
import { fetchCp } from '@/components/dashboard/fetch';
import type { DatalakeSummary } from '@/lib/types';

function DatalakesSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-9 w-36" />
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-72" />
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function DatalakesPage() {
  const [datalakes, setDatalakes] = useState<DatalakeSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetchCp<{ datalakes: DatalakeSummary[] }>(
      '/api/cp/datalakes',
    );
    if (!res.ok) {
      setError(res.error);
    } else {
      setDatalakes(res.data.datalakes);
      setError(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <DatalakesSkeleton />;

  if (error)
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn't load data lakes</AlertTitle>
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
    );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Data Lakes</h1>
          <p className="text-sm text-muted-foreground">
            Governed DuckDB data lakes your agents query through waddling.
          </p>
        </div>
        <Button asChild>
          <Link href="/datalakes/new">
            <Plus data-icon="inline-start" />
            New data lake
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Data lakes</CardTitle>
          <CardDescription>
            Each data lake is a governed DuckLake your agents attach to. Compute
            scales to zero and warms on demand.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {datalakes.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No data lakes yet</EmptyTitle>
                <EmptyDescription>
                  Connect your object storage and waddling provisions a governed
                  gateway in front of it.
                </EmptyDescription>
              </EmptyHeader>
              <Button asChild>
                <Link href="/datalakes/new">
                  <Plus data-icon="inline-start" />
                  Create your first data lake
                </Link>
              </Button>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Slug</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {datalakes.map((dl) => (
                  <TableRow key={dl.id}>
                    <TableCell>
                      <Link
                        href={`/datalakes/${dl.id}`}
                        className="text-primary hover:underline"
                      >
                        {dl.name}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {dl.slug}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={dl.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
