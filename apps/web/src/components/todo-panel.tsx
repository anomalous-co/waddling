"use client";

import { useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { fetcher, mutateJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Todo } from "@/lib/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Field, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";

export function TodoPanel() {
  const { data: todos, isLoading, mutate } = useSWR<Todo[]>("/api/todos", fetcher);
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function addTodo(e: React.FormEvent) {
    e.preventDefault();
    const value = title.trim();
    if (!value) return;
    setSubmitting(true);
    try {
      await mutateJson<Todo>("/api/todos", "POST", { title: value });
      setTitle("");
      await mutate();
      toast.success("Todo added");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add todo");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleDone(todo: Todo) {
    try {
      await mutateJson<Todo>(`/api/todos/${todo.id}`, "PATCH", { done: !todo.done });
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update todo");
    }
  }

  async function removeTodo(todo: Todo) {
    try {
      await mutateJson(`/api/todos/${todo.id}`, "DELETE");
      await mutate();
      toast.success("Todo deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete todo");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Todos</CardTitle>
        <CardDescription>
          Written straight to this instance&apos;s PGlite store. The peer reads
          these over quack.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <form onSubmit={addTodo}>
          <FieldGroup>
            <Field orientation="horizontal">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="What needs doing?"
                aria-label="New todo title"
                disabled={submitting}
              />
              <Button type="submit" disabled={submitting || !title.trim()}>
                <PlusIcon data-icon="inline-start" />
                Add
              </Button>
            </Field>
          </FieldGroup>
        </form>

        {isLoading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : !todos || todos.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No todos yet</EmptyTitle>
              <EmptyDescription>Add one above to get started.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">Done</TableHead>
                <TableHead className="w-12">ID</TableHead>
                <TableHead>Title</TableHead>
                <TableHead className="w-12 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {todos.map((todo) => (
                <TableRow key={todo.id}>
                  <TableCell>
                    <Checkbox
                      checked={todo.done}
                      onCheckedChange={() => toggleDone(todo)}
                      aria-label={`Mark "${todo.title}" as ${todo.done ? "not done" : "done"}`}
                    />
                  </TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">
                    {todo.id}
                  </TableCell>
                  <TableCell>
                    <span className={cn(todo.done && "text-muted-foreground line-through")}>
                      {todo.title}
                    </span>
                    {todo.done ? (
                      <Badge variant="secondary" className="ml-2">
                        done
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeTodo(todo)}
                      aria-label={`Delete "${todo.title}"`}
                    >
                      <Trash2Icon />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
