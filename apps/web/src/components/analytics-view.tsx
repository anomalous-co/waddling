"use client";

import { RadarIcon } from "lucide-react";
import type { InstanceInfo } from "@/lib/types";
import { AnalyticsCards } from "@/components/analytics-cards";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Badge } from "@/components/ui/badge";

export function AnalyticsView({ info }: { info: InstanceInfo }) {
  return (
    <div className="flex flex-col gap-8">
      <AnalyticsCards info={info} />

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle>Peer activity</CardTitle>
            <Badge variant="outline">coming soon</Badge>
          </div>
          <CardDescription>
            Queries that peers have executed against this instance’s DuckDB.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <RadarIcon />
              </EmptyMedia>
              <EmptyTitle>Awaiting the birdshot extension</EmptyTitle>
              <EmptyDescription>
                Capturing peer queries at the quack boundary requires a custom DuckDB
                extension (<span className="font-mono">birdshot</span>) — the
                authorization hook can enforce access but cannot record. This panel will
                stream the peer query log once birdshot lands.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    </div>
  );
}
