'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Plus, RefreshCw, Copy, Check, TriangleAlert, Ellipsis } from 'lucide-react';
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldError,
} from '@/components/ui/field';
import { StatusBadge } from '@/components/dashboard/status';
import { fetchCp, cpPost } from '@/components/dashboard/fetch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScopePicker, type GrantRow } from '@/components/dashboard/scope-picker';
import { AgentAccess } from '@/components/dashboard/agent-access';
import { toast } from 'sonner';
import type { AgentSummary } from '@/lib/types';

// ── helpers ──────────────────────────────────────────────────────────────────

function relativeTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── skeleton ─────────────────────────────────────────────────────────────────

function AgentsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-9 w-32" />
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-64" />
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

// ── create-agent dialog ───────────────────────────────────────────────────────

interface CreateAgentForm {
  name: string;
  description: string;
  defaultRole: string;
}

interface CreateAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (agent: AgentSummary, key: string) => void;
  datalakes: { id: string; name: string }[];
}

function CreateAgentDialog({ open, onOpenChange, onCreated, datalakes }: CreateAgentDialogProps) {
  const [form, setForm] = useState<CreateAgentForm>({
    name: '',
    description: '',
    defaultRole: 'reader',
  });
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Reset form when dialog opens.
  useEffect(() => {
    if (open) {
      setForm({ name: '', description: '', defaultRole: 'reader' });
      setGrants([]);
      setFieldError(null);
    }
  }, [open]);

  const submit = async () => {
    if (!form.name.trim()) {
      setFieldError('Name is required');
      return;
    }
    setSubmitting(true);
    setFieldError(null);
    // Create the agent AND its initial scope in one action (composite POST).
    const res = await cpPost<{ agent: AgentSummary; key?: string; agentId?: string; apiKey?: string }>(
      '/api/cp/agents',
      { ...form, grants },
    );
    setSubmitting(false);
    if (!res.ok) {
      setFieldError(res.error);
      return;
    }
    const key = res.data.key ?? res.data.apiKey ?? '';
    onCreated(res.data.agent, key);
    // Keep dialog open only if we have a key to reveal (parent handles transition).
    onOpenChange(false);
    const scopeMsg = grants.length ? ` with ${grants.length} grant${grants.length > 1 ? 's' : ''}` : '';
    toast.success(`Agent "${res.data.agent.name}" created${scopeMsg}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>Create the agent and grant its initial access in one step.</DialogDescription>
        </DialogHeader>

        <FieldGroup className="py-1">
          <Field>
            <FieldLabel htmlFor="agent-name">Name</FieldLabel>
            <Input
              id="agent-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="llm-analyst"
              autoFocus
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="agent-desc">Description</FieldLabel>
            <Input
              id="agent-desc"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Optional"
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="agent-role">Default role</FieldLabel>
            <Select
              value={form.defaultRole}
              onValueChange={(v) => setForm({ ...form, defaultRole: v })}
            >
              <SelectTrigger id="agent-role" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="reader">reader</SelectItem>
                <SelectItem value="analyst">analyst</SelectItem>
                <SelectItem value="writer">writer</SelectItem>
                <SelectItem value="admin">admin</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel>Initial access (optional)</FieldLabel>
            {datalakes.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No data lakes yet — create one first, then you can scope this agent.
              </p>
            ) : (
              <ScopePicker datalakes={datalakes} grants={grants} onChange={setGrants} />
            )}
          </Field>

          {fieldError ? (
            <FieldError>{fieldError}</FieldError>
          ) : null}
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={submitting}>
            {submitting ? 'Creating…' : 'Create agent'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── reveal-key dialog ─────────────────────────────────────────────────────────

interface RevealKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentName: string;
  apiKey: string;
}

function RevealKeyDialog({ open, onOpenChange, agentName, apiKey }: RevealKeyDialogProps) {
  const [copied, setCopied] = useState(false);

  const copyKey = async () => {
    await navigator.clipboard.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>API key created</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Alert>
            <TriangleAlert />
            <AlertTitle>Shown once — store it now</AlertTitle>
            <AlertDescription>
              This key for <span className="font-medium text-foreground">{agentName}</span> will
              not be shown again. Copy it to a secure location before closing this dialog.
            </AlertDescription>
          </Alert>

          <div className="flex flex-col gap-1.5">
            <Label>API key</Label>
            <div className="flex gap-2">
              <code className="flex-1 min-w-0 overflow-x-auto rounded-lg border border-input bg-muted px-3 py-2 font-mono text-xs leading-relaxed break-all">
                {apiKey}
              </code>
              <Button
                variant="outline"
                size="icon"
                onClick={() => void copyKey()}
                aria-label="Copy API key"
              >
                {copied ? (
                  <Check />
                ) : (
                  <Copy />
                )}
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>
            Done — I have saved the key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [datalakes, setDatalakes] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [revealKey, setRevealKey] = useState<{ name: string; key: string } | null>(null);
  const [editAccessAgent, setEditAccessAgent] = useState<AgentSummary | null>(null);

  const load = useCallback(async () => {
    const [agentsRes, lakesRes] = await Promise.all([
      fetchCp<{ agents: AgentSummary[] }>('/api/cp/agents'),
      fetchCp<{ datalakes: { id: string; name: string }[] }>('/api/cp/datalakes'),
    ]);
    if (!agentsRes.ok) {
      setError(agentsRes.error);
    } else {
      setAgents(agentsRes.data.agents);
      setError(null);
    }
    if (lakesRes.ok) setDatalakes(lakesRes.data.datalakes.map((d) => ({ id: d.id, name: d.name })));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreated = useCallback((agent: AgentSummary, key: string) => {
    setAgents((prev) => [...prev, agent]);
    if (key) {
      setRevealKey({ name: agent.name, key });
    }
  }, []);

  if (loading) return <AgentsSkeleton />;

  if (error)
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn't load agents</AlertTitle>
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
    <>
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
            <p className="text-sm text-muted-foreground">
              Machine principals that connect to your governed data lakes.
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus data-icon="inline-start" />
            New agent
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Machine principals</CardTitle>
            <CardDescription>
              Agents authenticate via API keys and receive governed access to data lakes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {agents.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No agents yet</EmptyTitle>
                  <EmptyDescription>
                    Create an agent to give a model or automated system governed access to your data lakes.
                  </EmptyDescription>
                </EmptyHeader>
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus data-icon="inline-start" />
                  Create first agent
                </Button>
              </Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Default role</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last seen</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {agents.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell>
                        <Link
                          href={`/agents/${a.id}`}
                          className="text-primary hover:underline"
                        >
                          {a.name}
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {a.defaultRole}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {a.mode}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={a.status} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {a.lastSeenAt ? relativeTime(a.lastSeenAt) : '—'}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" className="size-7">
                              <Ellipsis className="size-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setEditAccessAgent(a)}>
                              Edit access
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <CreateAgentDialog
        datalakes={datalakes}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
      />

      {revealKey ? (
        <RevealKeyDialog
          open={!!revealKey}
          onOpenChange={(open) => {
            if (!open) setRevealKey(null);
          }}
          agentName={revealKey.name}
          apiKey={revealKey.key}
        />
      ) : null}

      <Dialog
        open={!!editAccessAgent}
        onOpenChange={(open) => {
          if (!open) setEditAccessAgent(null);
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Edit access &mdash; {editAccessAgent?.name}
            </DialogTitle>
          </DialogHeader>
          {editAccessAgent ? (
            <AgentAccess agentId={editAccessAgent.id} />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
