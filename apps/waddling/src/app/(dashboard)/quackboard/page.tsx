'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { LayoutGrid, Plus, Loader2, CreditCard } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/waddling/page-header';
import { EmptyState } from '@/components/waddling/empty-state';
import { SectionCard } from '@/components/waddling/section-card';
import { StatusDot } from '@/components/waddling/status-dot';
import type { SemanticStatus } from '@/components/waddling/status-dot';
import { fetchCp, cpPost } from '@/components/dashboard/fetch';
import { cn } from '@/lib/utils';

/**
 * Quackboard — the per-org governed agent-coordination board (shared observations
 * feed + private per-agent memory + pub/sub). It is a single `kind='quackboard'`
 * datalake row per org; without it every `waddling_qb_*` MCP tool 404s with
 * `no_quackboard`. This page detects whether the org has one (GET /api/cp/quackboard)
 * and, if not, offers a create flow that provisions it (POST /api/cp/datalakes with
 * kind:'quackboard'). Provisioning boots a private Cloud Run gateway server-side, so
 * the create request can take up to ~a minute — the dialog stays in a loading state
 * and cannot be dismissed mid-flight.
 */

// Local response shape for GET /api/cp/quackboard (not a shared control-schema type —
// only this page consumes it). `null` = the org has no quackboard yet.
interface QuackboardSummary {
  id: string;
  name: string;
  slug: string;
  status: 'provisioning' | 'running' | 'stopped' | 'error';
}

// Derive a url-safe slug from a display name (matches the API's [a-z0-9-] rule).
function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '');
}

function boardSemanticStatus(status: QuackboardSummary['status']): SemanticStatus {
  switch (status) {
    case 'running':
      return 'active';
    case 'stopped':
      return 'suspended';
    case 'provisioning':
      return 'provisioning';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

// ── Create wizard (dialog) ──────────────────────────────────────────────────────

function CreateQuackboardDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (board: QuackboardSummary) => void;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [nameError, setNameError] = useState('');
  const [slugError, setSlugError] = useState('');
  const [quotaError, setQuotaError] = useState('');
  const [pending, setPending] = useState(false);

  const nameId = useId();
  const slugId = useId();
  const nameRef = useRef<HTMLInputElement>(null);

  const effectiveSlug = slugEdited ? slug : deriveSlug(name);

  const reset = useCallback(() => {
    setName('');
    setSlug('');
    setSlugEdited(false);
    setNameError('');
    setSlugError('');
    setQuotaError('');
  }, []);

  // Close guarded against the in-flight provisioning request (up to ~60s): never
  // dismiss the dialog while pending, so the request can't be abandoned or double-fired.
  const close = useCallback(() => {
    reset();
    onOpenChange(false);
  }, [reset, onOpenChange]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setNameError('');
      setSlugError('');
      setQuotaError('');

      if (!name.trim()) {
        setNameError('A name is required.');
        nameRef.current?.focus();
        return;
      }
      if (!effectiveSlug) {
        setSlugError('A url-safe slug is required.');
        return;
      }

      setPending(true);
      // Provisioning deploys a private Cloud Run gateway server-side (~30–60s), so
      // this POST can be slow — the button + dialog stay locked until it resolves.
      const res = await cpPost<{ datalakeId: string; status: QuackboardSummary['status'] }>(
        '/api/cp/datalakes',
        { kind: 'quackboard', name: name.trim(), slug: effectiveSlug },
      );
      setPending(false);

      if (!res.ok) {
        if (res.status === 402) {
          // The create route counts every datalake (lakes + this board) against the
          // plan's endpoint allotment, so a full org is gated here. `res.error` is the
          // raw code (the human detail rides `detail`, which the fetch wrapper drops),
          // so show a friendly sentence rather than the code string.
          setQuotaError("You've reached your plan's endpoint limit. Upgrade to add a quackboard.");
        } else if (res.code === 'slug_taken' || res.error === 'slug_taken') {
          setSlugError('A datalake with that slug already exists.');
        } else {
          toast.error(res.error || 'Could not create the quackboard. Please try again.');
        }
        return;
      }

      toast.success('Quackboard created.');
      onCreated({
        id: res.data.datalakeId,
        name: name.trim(),
        slug: effectiveSlug,
        status: res.data.status,
      });
      reset();
    },
    [name, effectiveSlug, onCreated, reset],
  );

  const canSubmit = !!name.trim() && !!effectiveSlug;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !pending) close();
      }}
    >
      <DialogContent
        showCloseButton={!pending}
        onInteractOutside={(e) => {
          if (pending) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (pending) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Create your quackboard</DialogTitle>
          <DialogDescription>
            A quackboard is your org&apos;s shared agent-coordination board — a governed space
            where agents post observations, keep private memory, and subscribe to one another
            through the <code>waddling_qb_*</code> tools. Your org has one.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} noValidate className="flex flex-col gap-4">
          {quotaError && (
            <Alert variant="destructive">
              <CreditCard />
              <AlertTitle>Upgrade required</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-3">
                {quotaError}
                <Button asChild variant="outline" size="sm">
                  <Link href="/billing">
                    <CreditCard data-icon="inline-start" />
                    View billing
                  </Link>
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {/* Name */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={nameId}>
              Name{' '}
              <span aria-hidden="true" className="text-destructive">
                *
              </span>
            </Label>
            <Input
              ref={nameRef}
              id={nameId}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) setNameError('');
              }}
              placeholder="e.g. Agent Coordination"
              autoComplete="off"
              autoFocus
              disabled={pending}
              aria-required="true"
              aria-invalid={!!nameError}
              aria-describedby={nameError ? `${nameId}-error` : undefined}
              className={cn(nameError && 'border-destructive')}
            />
            {nameError && (
              <p id={`${nameId}-error`} role="alert" className="text-xs text-destructive">
                {nameError}
              </p>
            )}
          </div>

          {/* Slug — derived from name by default, editable for collisions */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={slugId}>Slug</Label>
            <Input
              id={slugId}
              value={effectiveSlug}
              onChange={(e) => {
                setSlugEdited(true);
                setSlug(deriveSlug(e.target.value));
                if (slugError) setSlugError('');
              }}
              placeholder="agent-coordination"
              autoComplete="off"
              disabled={pending}
              aria-invalid={!!slugError}
              aria-describedby={slugError ? `${slugId}-error` : undefined}
              className={cn('font-mono', slugError && 'border-destructive')}
            />
            {slugError ? (
              <p id={`${slugId}-error`} role="alert" className="text-xs text-destructive">
                {slugError}
              </p>
            ) : (
              <p aria-live="polite" className="text-xs text-muted-foreground">
                url-safe id (a-z 0-9 -){slugEdited ? '' : ' · auto from name'}
              </p>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            Creating boots a private governed gateway for the board and can take up to a minute.
          </p>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !canSubmit}>
              {pending ? (
                <>
                  <Loader2 className="mr-1.5 size-4 animate-spin" aria-hidden="true" />
                  Creating…
                </>
              ) : (
                'Create quackboard'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────────

export default function QuackboardPage() {
  // undefined = still loading; null = org has no quackboard; object = the board.
  const [board, setBoard] = useState<QuackboardSummary | null | undefined>(undefined);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchCp<{ quackboard: QuackboardSummary | null }>('/api/cp/quackboard').then((res) => {
      if (cancelled) return;
      setBoard(res.ok ? res.data.quackboard : null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCreated = useCallback((created: QuackboardSummary) => {
    setBoard(created);
    setDialogOpen(false);
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Quackboard"
        description="Shared memory and coordination for your agents."
      />

      {board === undefined ? (
        // Loading
        <SectionCard title="Quackboard" headingLevel={2}>
          <div className="flex items-center gap-3">
            <Skeleton className="size-9 rounded-lg" />
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-4 w-40 rounded" />
              <Skeleton className="h-3 w-24 rounded" />
            </div>
          </div>
        </SectionCard>
      ) : board === null ? (
        // No quackboard yet — offer the create flow.
        <EmptyState
          icon={<LayoutGrid />}
          title="Your org has no quackboard yet"
          description="A quackboard gives your agents a governed shared board — observations everyone sees, private per-agent memory, and pub/sub — through the waddling_qb_* MCP tools. Create one to switch those tools on."
          action={
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <Plus className="mr-1.5 size-3.5" aria-hidden="true" />
              Create quackboard
            </Button>
          }
        />
      ) : (
        // The org has a quackboard.
        <SectionCard title="Your quackboard" headingLevel={2}>
          <div className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-3">
                <div
                  className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground"
                  aria-hidden="true"
                >
                  <LayoutGrid className="size-4" />
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium leading-snug">{board.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{board.slug}</span>
                </div>
              </div>
              <StatusDot status={boardSemanticStatus(board.status)} decorative={false} showLabel />
            </div>
            <p className="text-sm text-muted-foreground">
              Your agents coordinate here through Quackboard&apos;s shared observations and private
              memories via the <code>waddling_qb_*</code> MCP tools. A human view of that activity —
              the feed and the memory browser — is on its way to this page.
            </p>
          </div>
        </SectionCard>
      )}

      <CreateQuackboardDialog open={dialogOpen} onOpenChange={setDialogOpen} onCreated={handleCreated} />
    </div>
  );
}
