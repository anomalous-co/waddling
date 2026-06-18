"use client";

import { useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { PlayIcon, Trash2Icon, RefreshCwIcon } from "lucide-react";
import { fetcher, mutateJson } from "@/lib/api";
import type { QueryResult, SavedView } from "@/lib/types";
import { TodoPanel } from "@/components/todo-panel";
import { DataTable } from "@/components/data-table";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";

export function HomeView() {
  const { data: views, mutate } = useSWR<SavedView[]>("/api/views", fetcher);

  return (
    <div className="flex flex-col gap-8">
      <TodoPanel />

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">Custom data views</h2>
          <p className="text-sm text-muted-foreground">
            Saved queries pinned from the Editor. Each runs on demand.
          </p>
        </div>

        {!views || views.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No views yet</EmptyTitle>
              <EmptyDescription>
                Open the Editor, write a query, and choose “Pin as view”.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-4">
            {views.map((view) => (
              <SavedViewCard key={view.id} view={view} onDeleted={() => mutate()} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function SavedViewCard({ view, onDeleted }: { view: SavedView; onDeleted: () => void }) {
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function run() {
    setPending(true);
    setError(null);
    try {
      const data = await mutateJson<QueryResult>("/api/query", "POST", { sql: view.sql });
      setResult(data);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : "Query failed");
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    try {
      await mutateJson(`/api/views/${view.id}`, "DELETE");
      toast.success(`Removed "${view.name}"`);
      onDeleted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove view");
    }
  }

  const hasRun = result !== null || error !== null;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <CardTitle>{view.name}</CardTitle>
          <CardDescription className="font-mono text-xs">{view.sql}</CardDescription>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={run} disabled={pending}>
            {hasRun ? (
              <RefreshCwIcon data-icon="inline-start" />
            ) : (
              <PlayIcon data-icon="inline-start" />
            )}
            {pending ? "Running…" : hasRun ? "Refresh" : "Run"}
          </Button>
          <Button variant="ghost" size="icon" onClick={remove} aria-label="Delete view">
            <Trash2Icon />
          </Button>
        </div>
      </CardHeader>
      {hasRun ? (
        <CardContent>
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Query error</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : result && result.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No rows returned.</p>
          ) : result ? (
            <DataTable columns={result.columns} rows={result.rows} />
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}
