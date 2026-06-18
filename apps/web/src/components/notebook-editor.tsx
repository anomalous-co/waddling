"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { PlayIcon, PlusIcon, Trash2Icon, SaveIcon, PinIcon } from "lucide-react";
import { fetcher, mutateJson } from "@/lib/api";
import type {
  Notebook,
  NotebookCell,
  NotebookSummary,
  QueryResult,
} from "@/lib/types";
import { MonacoSql } from "@/components/monaco-sql";
import { DataTable } from "@/components/data-table";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const STARTER_SQL = "SELECT * FROM main.todos";

function newCell(sql = STARTER_SQL): NotebookCell {
  return { id: crypto.randomUUID(), sql };
}

interface CellState {
  result?: QueryResult;
  error?: string;
  pending?: boolean;
}

export function NotebookEditor() {
  const { data: notebooks, mutate: mutateList } = useSWR<NotebookSummary[]>(
    "/api/notebooks",
    fetcher,
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [cells, setCells] = useState<NotebookCell[]>([]);
  const [cellState, setCellState] = useState<Record<string, CellState>>({});
  const [saving, setSaving] = useState(false);
  const [pinTarget, setPinTarget] = useState<NotebookCell | null>(null);

  // Load the selected notebook's cells.
  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    fetcher<Notebook>(`/api/notebooks/${selectedId}`)
      .then((nb) => {
        if (!active) return;
        setName(nb.name);
        setCells(nb.cells.length ? nb.cells : [newCell()]);
        setCellState({});
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : "Failed to load"));
    return () => {
      active = false;
    };
  }, [selectedId]);

  async function createNotebook() {
    try {
      const nb = await mutateJson<Notebook>("/api/notebooks", "POST", {
        name: `Notebook ${(notebooks?.length ?? 0) + 1}`,
        cells: [newCell()],
      });
      await mutateList();
      setSelectedId(nb.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create notebook");
    }
  }

  function patchCell(id: string, patch: Partial<NotebookCell>) {
    setCells((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  function setState(id: string, patch: CellState) {
    setCellState((s) => ({ ...s, [id]: { ...s[id], ...patch } }));
  }

  async function runCell(cell: NotebookCell) {
    setState(cell.id, { pending: true, error: undefined });
    try {
      const result = await mutateJson<QueryResult>("/api/query", "POST", { sql: cell.sql });
      setState(cell.id, { result, error: undefined, pending: false });
    } catch (err) {
      setState(cell.id, {
        result: undefined,
        error: err instanceof Error ? err.message : "Query failed",
        pending: false,
      });
    }
  }

  function addCell() {
    setCells((cs) => [...cs, newCell("")]);
  }

  function deleteCell(id: string) {
    setCells((cs) => cs.filter((c) => c.id !== id));
    setCellState((s) => {
      const next = { ...s };
      delete next[id];
      return next;
    });
  }

  async function save() {
    if (!selectedId) return;
    setSaving(true);
    try {
      await mutateJson<Notebook>(`/api/notebooks/${selectedId}`, "PUT", { name, cells });
      await mutateList();
      toast.success("Notebook saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function pinAsView(viewName: string) {
    if (!pinTarget) return;
    try {
      await mutateJson("/api/views", "POST", { name: viewName, sql: pinTarget.sql });
      toast.success(`Pinned "${viewName}" to Home`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to pin view");
    } finally {
      setPinTarget(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={selectedId ?? undefined} onValueChange={setSelectedId}>
          <SelectTrigger className="w-64">
            <SelectValue placeholder="Select a notebook…" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {(notebooks ?? []).map((nb) => (
                <SelectItem key={nb.id} value={nb.id}>
                  {nb.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={createNotebook}>
          <PlusIcon data-icon="inline-start" />
          New notebook
        </Button>
      </div>

      {!selectedId ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No notebook open</EmptyTitle>
            <EmptyDescription>
              Create a notebook or pick one above to start writing queries.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-5">
          {/* Notebook name + save */}
          <div className="flex items-center gap-3">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Notebook name"
              className="max-w-sm text-base font-medium"
            />
            <Button onClick={save} disabled={saving}>
              <SaveIcon data-icon="inline-start" />
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>

          {/* Cells */}
          {cells.map((cell, i) => {
            const st = cellState[cell.id] ?? {};
            return (
              <Card key={cell.id}>
                <CardHeader className="flex-row items-center justify-between gap-2">
                  <CardTitle className="text-sm text-muted-foreground">
                    Cell {i + 1}
                  </CardTitle>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setPinTarget(cell)}
                      disabled={!cell.sql.trim()}
                    >
                      <PinIcon data-icon="inline-start" />
                      Pin as view
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => deleteCell(cell.id)}
                      aria-label="Delete cell"
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <MonacoSql value={cell.sql} onChange={(sql) => patchCell(cell.id, { sql })} />
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      onClick={() => runCell(cell)}
                      disabled={st.pending || !cell.sql.trim()}
                    >
                      <PlayIcon data-icon="inline-start" />
                      {st.pending ? "Running…" : "Run"}
                    </Button>
                  </div>

                  {st.error ? (
                    <Alert variant="destructive">
                      <AlertTitle>Query error</AlertTitle>
                      <AlertDescription>{st.error}</AlertDescription>
                    </Alert>
                  ) : null}

                  {st.result ? (
                    st.result.rows.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No rows returned.</p>
                    ) : (
                      <DataTable columns={st.result.columns} rows={st.result.rows} />
                    )
                  ) : null}
                </CardContent>
              </Card>
            );
          })}

          <Separator />
          <Button variant="outline" className="self-start" onClick={addCell}>
            <PlusIcon data-icon="inline-start" />
            Add cell
          </Button>
        </div>
      )}

      {/* Pin-as-view dialog */}
      <PinDialog
        cell={pinTarget}
        onCancel={() => setPinTarget(null)}
        onConfirm={pinAsView}
      />
    </div>
  );
}

function PinDialog({
  cell,
  onCancel,
  onConfirm,
}: {
  cell: NotebookCell | null;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState("");

  useEffect(() => {
    if (cell) setName(cell.title ?? "");
  }, [cell]);

  return (
    <Dialog open={cell !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pin as Home view</DialogTitle>
          <DialogDescription>
            Save this query as a named data view on the Home tab.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="View name"
          aria-label="View name"
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) onConfirm(name.trim());
          }}
        />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button disabled={!name.trim()} onClick={() => onConfirm(name.trim())}>
            Pin view
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
