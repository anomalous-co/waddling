"use client";

import useSWR from "swr";
import { TriangleAlertIcon } from "lucide-react";
import { fetcher } from "@/lib/api";
import type { AnalyticsResult, InstanceInfo, TodoStats } from "@/lib/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

function StatRow({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function StatsCard({
  title,
  description,
  stats,
}: {
  title: string;
  description: string;
  stats: TodoStats | null;
}) {
  const pct =
    stats && stats.total > 0 ? Math.round((stats.done_count / stats.total) * 100) : 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {stats ? (
          <>
            <StatRow label="Total todos" value={stats.total} />
            <StatRow label="Completed" value={stats.done_count} />
            <StatRow label="Completion" value={`${pct}%`} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No data — peer unreachable.</p>
        )}
      </CardContent>
    </Card>
  );
}

export function AnalyticsCards({ info }: { info: InstanceInfo }) {
  // Poll so cross-instance changes show up without a manual refresh.
  const { data, isLoading } = useSWR<AnalyticsResult>("/api/analytics", fetcher, {
    refreshInterval: 2000,
  });

  if (isLoading || !data) {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Peer (quack):</span>
        {data.peer_connected ? (
          <Badge variant="secondary">connected</Badge>
        ) : (
          <Badge variant="outline">offline</Badge>
        )}
      </div>

      {!data.peer_connected ? (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>Peer offline</AlertTitle>
          <AlertDescription>
            The peer instance isn&apos;t reachable on quack port {info.peerQuackPort}.
            Start it and this will reconnect automatically.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <StatsCard
          title={`This instance (${info.instance})`}
          description="Local PGlite, read via DuckDB."
          stats={data.local}
        />
        <StatsCard
          title="Peer instance"
          description="Remote PGlite, read over the quack federation protocol."
          stats={data.peer}
        />
      </div>
    </div>
  );
}
