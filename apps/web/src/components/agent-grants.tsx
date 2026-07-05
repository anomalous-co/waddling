"use client";

import { useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import {
  PlusIcon,
  Trash2Icon,
  BanIcon,
  CheckIcon,
  ShieldIcon,
} from "lucide-react";
import { fetcher, mutateJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  AgentGrants,
  AclRule,
  AclPrivilege,
  AclEffect,
  CreateAclInput,
} from "@/lib/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const PRIVILEGES: AclPrivilege[] = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "CREATE",
  "DROP",
  "ALTER",
  "USAGE",
  "EXECUTE",
];

/** A statement is a DENY if its leading keyword is DENY (case-insensitive). */
function isDeny(statement: string): boolean {
  return /^\s*deny\b/i.test(statement);
}

/** Render an ACL rule as literal SQL. Prefer the backend's verbatim string. */
function renderRule(rule: AclRule): string {
  if (rule.statement && rule.statement.trim()) return rule.statement.trim();
  const verb = rule.effect === "deny" ? "DENY" : "GRANT";
  const cols =
    rule.columns && rule.columns.length > 0
      ? ` (${rule.columns.join(", ")})`
      : "";
  const object = rule.table === "*" ? `${rule.schema}.*` : `${rule.schema}.${rule.table}`;
  const to = rule.agentId ? ` TO "agent:${rule.agentId}"` : "";
  return `${verb} ${rule.privilege}${cols} ON ${object}${to}`;
}

/** One monospace statement row; DENY gets the "blocked" treatment. */
function StatementRow({
  statement,
  action,
}: {
  statement: string;
  action?: React.ReactNode;
}) {
  const deny = isDeny(statement);
  return (
    <div
      data-effect={deny ? "deny" : "allow"}
      className={cn(
        "group flex items-start gap-3 rounded-md border-l-2 py-2 pr-2 pl-3 font-mono text-xs leading-relaxed",
        deny
          ? "border-l-destructive bg-destructive/5 text-destructive"
          : "border-l-emerald-500 bg-emerald-500/5 text-foreground dark:border-l-emerald-400",
      )}
    >
      {deny ? (
        <BanIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
      ) : (
        <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
      )}
      <code className="min-w-0 flex-1 break-all whitespace-pre-wrap">
        {statement}
      </code>
      {action}
    </div>
  );
}

export function AgentGrants({
  agentId,
  datalakeId,
}: {
  agentId: string;
  datalakeId?: string;
}) {
  // Surface 1 — verbatim, key-level, read-only. Works from agentId alone.
  const grantsKey = `/api/cp/agents/${encodeURIComponent(agentId)}/grants`;
  const {
    data: grants,
    error: grantsError,
    isLoading: grantsLoading,
    mutate: mutateGrants,
  } = useSWR<AgentGrants>(grantsKey, fetcher);

  // Surface 2 — editable rules with ids. Requires datalakeId.
  const aclKey = datalakeId
    ? `/api/cp/acl?datalakeId=${encodeURIComponent(datalakeId)}&agentId=${encodeURIComponent(agentId)}`
    : null;
  const {
    data: rules,
    error: rulesError,
    isLoading: rulesLoading,
    mutate: mutateRules,
  } = useSWR<AclRule[]>(aclKey, fetcher);

  async function refresh() {
    await Promise.all([mutateGrants(), aclKey ? mutateRules() : Promise.resolve()]);
  }

  async function removeRule(rule: AclRule) {
    try {
      await mutateJson(`/api/cp/acl/${encodeURIComponent(rule.id)}`, "DELETE");
      await refresh();
      toast.success("Rule removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove rule");
    }
  }

  const statements = grants?.statements ?? [];

  return (
    <div className="flex flex-col gap-6">
      {/* ── Verbatim grants (headline) ─────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldIcon className="size-4" />
            Grant SQL
          </CardTitle>
          <CardDescription>
            The literal GRANT / DENY statements this key resolves to, verbatim —
            including role-inherited access. This is exactly what the gateway
            enforces.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {grantsLoading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-3/4" />
            </div>
          ) : grantsError ? (
            <Alert variant="destructive">
              <BanIcon />
              <AlertTitle>Couldn&apos;t load grants</AlertTitle>
              <AlertDescription>
                {grantsError instanceof Error
                  ? grantsError.message
                  : "Unknown error"}
              </AlertDescription>
            </Alert>
          ) : statements.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No grants</EmptyTitle>
                <EmptyDescription>
                  This key has no access. Add a grant below to give it access to
                  a table.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex flex-col gap-1.5">
              {statements.map((s, i) => (
                <StatementRow key={`${i}-${s}`} statement={s} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Editable rules ─────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <CardTitle>ACL rules</CardTitle>
            <CardDescription>
              Author individual grants and denies for this key. Each rule can be
              removed independently.
            </CardDescription>
          </div>
          <AddRuleDialog
            agentId={agentId}
            datalakeId={datalakeId}
            onAdded={refresh}
          />
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {!datalakeId ? (
            <Alert>
              <ShieldIcon />
              <AlertTitle>Pick a datalake to author rules</AlertTitle>
              <AlertDescription>
                Authoring and removing rules needs a datalake context. Open this
                page with{" "}
                <code className="font-mono">?datalakeId=…</code> to enable
                editing. The verbatim grants above are shown regardless.
              </AlertDescription>
            </Alert>
          ) : rulesLoading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : rulesError ? (
            <Alert variant="destructive">
              <BanIcon />
              <AlertTitle>Couldn&apos;t load rules</AlertTitle>
              <AlertDescription>
                {rulesError instanceof Error
                  ? rulesError.message
                  : "Unknown error"}
              </AlertDescription>
            </Alert>
          ) : !rules || rules.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No rules yet</EmptyTitle>
                <EmptyDescription>
                  Use &ldquo;Add rule&rdquo; to grant or deny access.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex flex-col gap-1.5">
              {rules.map((rule) => (
                <StatementRow
                  key={rule.id}
                  statement={renderRule(rule)}
                  action={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 opacity-60 transition-opacity group-hover:opacity-100"
                      onClick={() => removeRule(rule)}
                      aria-label="Remove rule"
                    >
                      <Trash2Icon />
                    </Button>
                  }
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AddRuleDialog({
  agentId,
  datalakeId,
  onAdded,
}: {
  agentId: string;
  datalakeId?: string;
  onAdded: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [effect, setEffect] = useState<AclEffect>("allow");
  const [selected, setSelected] = useState<Set<AclPrivilege>>(
    () => new Set<AclPrivilege>(["SELECT"]),
  );
  const [schema, setSchema] = useState("");
  const [allTables, setAllTables] = useState(false);
  const [table, setTable] = useState("");
  const [columns, setColumns] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function togglePrivilege(p: AclPrivilege) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  function reset() {
    setEffect("allow");
    setSelected(new Set<AclPrivilege>(["SELECT"]));
    setSchema("");
    setAllTables(false);
    setTable("");
    setColumns("");
  }

  const tableValue = allTables ? "*" : table.trim();
  const canSubmit =
    !!datalakeId &&
    selected.size > 0 &&
    schema.trim().length > 0 &&
    tableValue.length > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!datalakeId || !canSubmit) return;
    setSubmitting(true);
    const cols = columns
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    try {
      // The POST body takes a single privilege; author one rule per selection.
      for (const privilege of selected) {
        const body: CreateAclInput = {
          datalakeId,
          agentId,
          privilege,
          schema: schema.trim(),
          table: tableValue,
          effect,
          ...(cols.length > 0 ? { columns: cols } : {}),
        };
        await mutateJson<AclRule>("/api/cp/acl", "POST", body);
      }
      await onAdded();
      toast.success(
        `${effect === "deny" ? "Deny" : "Grant"} added (${selected.size} privilege${selected.size > 1 ? "s" : ""})`,
      );
      reset();
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add rule");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={!datalakeId}>
          <PlusIcon data-icon="inline-start" />
          Add rule
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add grant or deny</DialogTitle>
          <DialogDescription>
            Author a rule for <code className="font-mono">agent:{agentId}</code>.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="acl-effect">Effect</Label>
            <Select
              value={effect}
              onValueChange={(v) => setEffect(v as AclEffect)}
            >
              <SelectTrigger id="acl-effect" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="allow">GRANT (allow)</SelectItem>
                <SelectItem value="deny">DENY (block)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <Label>Privileges</Label>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {PRIVILEGES.map((p) => (
                <label
                  key={p}
                  className="flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-xs font-medium select-none has-[:checked]:border-primary has-[:checked]:bg-primary/5"
                >
                  <Checkbox
                    checked={selected.has(p)}
                    onCheckedChange={() => togglePrivilege(p)}
                    aria-label={p}
                  />
                  {p}
                </label>
              ))}
            </div>
          </div>

          <Separator />

          <div className="flex flex-col gap-2">
            <Label htmlFor="acl-schema">Schema</Label>
            <Input
              id="acl-schema"
              value={schema}
              onChange={(e) => setSchema(e.target.value)}
              placeholder="sales"
              autoComplete="off"
            />
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="acl-table">Table</Label>
              <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground select-none">
                <Checkbox
                  checked={allTables}
                  onCheckedChange={(v) => setAllTables(v === true)}
                  aria-label="All tables in schema"
                />
                All tables in schema
              </label>
            </div>
            <Input
              id="acl-table"
              value={allTables ? "*" : table}
              onChange={(e) => setTable(e.target.value)}
              placeholder="orders"
              autoComplete="off"
              disabled={allTables}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="acl-columns">Columns (optional)</Label>
            <Input
              id="acl-columns"
              value={columns}
              onChange={(e) => setColumns(e.target.value)}
              placeholder="email, region  (comma-separated; blank = all)"
              autoComplete="off"
            />
          </div>

          <DialogFooter showCloseButton>
            <Button type="submit" disabled={submitting || !canSubmit}>
              {submitting ? "Adding…" : "Add rule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
