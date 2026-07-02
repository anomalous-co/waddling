'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { CreditCard, Clock, Bot, Database, ShieldCheck } from 'lucide-react';
import { fetchCp, cpPost } from '@/components/dashboard/fetch';
import type { UsageRollup } from '@/lib/types';
import type { UsageSeries } from '@/lab/fixtures/usage';
import type { TeamOrgInfo } from '@/lab/fixtures/team';
import type { BillingInfo } from '@/lab/fixtures/billing';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
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
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { DetailLayout } from '@/components/waddling/detail-layout';
import { SectionCard } from '@/components/waddling/section-card';
import { StatPill } from '@/components/waddling/stat-pill';
import { CopyButton } from '@/components/waddling/copy-button';
import { formatRelative } from '@/components/waddling/agent-status';

// Current user — kept consistent with the shell's mock user.
const CURRENT_USER = { name: 'M Bright', email: 'mirri@anomalous.computer' };

function fmtCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ── Organization section ────────────────────────────────────────────────────

function OrganizationSection({ org }: { org: TeamOrgInfo | null }) {
  const [name, setName] = useState('');
  const [renameOpen, setRenameOpen] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const renameId = useId();
  const confirmId = useId();

  useEffect(() => {
    if (org) setName(org.name);
  }, [org]);

  if (!org) {
    return <Skeleton className="h-40 rounded-xl" />;
  }

  const slugUrl = `${org.slug}.getwaddling.com`;

  return (
    <div className="flex flex-col gap-6">
      <SectionCard
        title="Organization"
        headingLevel={2}
        headerActions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setDraftName(name);
              setRenameOpen(true);
            }}
          >
            Rename
          </Button>
        }
      >
        <dl className="grid grid-cols-1 gap-5 sm:grid-cols-3">
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs font-medium text-muted-foreground">Name</dt>
            <dd className="font-medium">{name}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs font-medium text-muted-foreground">Workspace URL</dt>
            <dd className="flex items-center gap-1">
              <code className="font-mono text-sm">{slugUrl}</code>
              <CopyButton text={slugUrl} label="Copy workspace URL" size="icon" className="size-6" />
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs font-medium text-muted-foreground">Created</dt>
            <dd className="text-sm">{formatRelative(org.createdAt)}</dd>
          </div>
        </dl>
      </SectionCard>

      {/* Danger zone */}
      <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-5">
        <h3 className="text-sm font-semibold text-destructive">Danger zone</h3>
        <div className="mt-3 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <p className="text-sm text-muted-foreground">
            Permanently delete <span className="font-medium text-foreground">{name}</span>,
            its data lakes, agents, and all credits. This cannot be undone.
          </p>
          <Button
            variant="outline"
            className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => {
              setConfirmText('');
              setDeleteOpen(true);
            }}
          >
            Delete organization
          </Button>
        </div>
      </div>

      {/* Rename dialog */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename organization</DialogTitle>
            <DialogDescription>
              This changes the display name across waddling. The workspace URL is unaffected.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={renameId}>Organization name</Label>
            <Input
              id={renameId}
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!draftName.trim() || draftName.trim() === name}
              onClick={() => {
                setName(draftName.trim());
                setRenameOpen(false);
                toast.success('Organization renamed.');
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete org — type-to-confirm */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the organization and everything in it. This action
              cannot be undone. Type{' '}
              <span className="font-mono font-semibold text-foreground">{name}</span> to confirm.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={confirmId} className="sr-only">
              Type the organization name to confirm
            </Label>
            <Input
              id={confirmId}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={name}
              autoComplete="off"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={confirmText !== name}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setDeleteOpen(false);
                toast.success('Organization scheduled for deletion.');
              }}
            >
              Delete organization
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Usage section ───────────────────────────────────────────────────────────

interface UsageResponse {
  rollup: UsageRollup;
  series: UsageSeries[];
  creditBalance: number;
}

function UsageSection({ usage }: { usage: UsageResponse | null }) {
  if (!usage) {
    return <Skeleton className="h-64 rounded-xl" />;
  }

  const totalHours = usage.series.reduce((s, d) => s + d.sessionHours, 0);
  const maxHours = Math.max(...usage.series.map((d) => d.sessionHours), 0.1);
  const dayLabel = (iso: string) =>
    new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' });

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatPill label="Session-hours (7d)" value={totalHours.toFixed(1)} icon={<Clock />} />
        <StatPill label="Queries (7d)" value={usage.rollup.queries.toLocaleString()} icon={<Database />} />
        <StatPill label="Active sessions" value={String(usage.rollup.activeSessions)} icon={<Bot />} />
        <StatPill label="Credit balance" value={fmtCents(usage.creditBalance)} icon={<CreditCard />} />
      </div>

      <SectionCard title="Session-hours per day" headingLevel={2}>
        <div className="flex flex-col gap-4">
          {/* Visual bar chart — decorative; the table below is the accessible source.
              Bar heights are in px (against the fixed 112px track) so they don't
              collapse the way %-heights do without a definite-height parent. */}
          <div className="flex h-32 items-end gap-2" aria-hidden="true">
            {usage.series.map((d) => (
              <div
                key={d.date}
                className="flex h-full flex-1 flex-col items-center justify-end gap-1"
              >
                <div
                  className="w-full rounded-t bg-primary/70"
                  style={{ height: `${Math.max(4, (d.sessionHours / maxHours) * 112)}px` }}
                />
                <span className="text-[10px] text-muted-foreground">{dayLabel(d.date)}</span>
              </div>
            ))}
          </div>

          {/* Accessible equivalent — the chart is not the only representation. */}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Day</TableHead>
                <TableHead scope="col" className="text-right">Session-hours</TableHead>
                <TableHead scope="col" className="text-right">Queries</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usage.series.map((d) => (
                <TableRow key={d.date}>
                  <TableCell>{dayLabel(d.date)}</TableCell>
                  <TableCell className="text-right tabular-nums">{d.sessionHours.toFixed(1)}</TableCell>
                  <TableCell className="text-right tabular-nums">{d.queries.toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
    </div>
  );
}

// ── Billing section ─────────────────────────────────────────────────────────

function BillingSection({
  billing,
  onTopUp,
}: {
  billing: BillingInfo | null;
  onTopUp: (newBalanceCents: number) => void;
}) {
  const [balanceCents, setBalanceCents] = useState<number | null>(null);
  const [buyOpen, setBuyOpen] = useState(false);
  const [amount, setAmount] = useState('25');
  const [amountError, setAmountError] = useState('');
  const [pending, setPending] = useState(false);
  const amountId = useId();

  useEffect(() => {
    if (billing) setBalanceCents(billing.creditBalanceCents);
  }, [billing]);

  const handleBuy = useCallback(async () => {
    const dollars = Number(amount);
    if (!Number.isFinite(dollars) || dollars < 10) {
      setAmountError('Minimum top-up is $10.');
      return;
    }
    setAmountError('');
    setPending(true);
    const res = await cpPost<{ creditBalanceCents: number }>('/api/cp/billing', {
      amountCents: Math.round(dollars * 100),
    });
    setPending(false);
    if (!res.ok) {
      toast.error('Top-up failed. Please try again.');
      return;
    }
    setBalanceCents(res.data.creditBalanceCents);
    onTopUp(res.data.creditBalanceCents);
    setBuyOpen(false);
    toast.success(`Added $${dollars.toFixed(2)} in credits.`);
  }, [amount, onTopUp]);

  if (!billing || balanceCents === null) {
    return <Skeleton className="h-64 rounded-xl" />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {/* Credit balance — the prominent card */}
        <div className="rounded-xl border bg-card p-5 ring-1 ring-foreground/10 sm:col-span-1">
          <h2 className="text-xs font-medium text-muted-foreground">Credit balance</h2>
          <p className="mt-1 font-heading text-3xl font-semibold tabular-nums">
            {fmtCents(balanceCents)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            of {fmtCents(billing.monthlyAllotmentCents)} / mo · renews{' '}
            {new Date(billing.renewsAt + 'T00:00:00').toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
            })}
          </p>
          <Button className="mt-4 w-full" size="sm" onClick={() => setBuyOpen(true)}>
            <CreditCard className="mr-1.5 size-4" aria-hidden="true" />
            Buy credits
          </Button>
        </div>

        <SectionCard title="Plan & rate" headingLevel={2} className="sm:col-span-2">
          <dl className="grid grid-cols-2 gap-5">
            <div className="flex flex-col gap-1">
              <dt className="text-xs font-medium text-muted-foreground">Plan</dt>
              <dd>
                <Badge variant="secondary">{billing.plan}</Badge>
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs font-medium text-muted-foreground">Usage rate</dt>
              <dd className="text-sm font-medium tabular-nums">
                {fmtCents(billing.ratePerSessionHourCents)} / session-hour
              </dd>
            </div>
            <div className="col-span-2 text-xs text-muted-foreground">
              Usage is metered per second against your prepaid credits. Top up any time;
              unused monthly credits reset at renewal.
            </div>
          </dl>
        </SectionCard>
      </div>

      <SectionCard title="Invoices" headingLevel={2} contentClassName="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Date</TableHead>
              <TableHead scope="col" className="text-right">Amount</TableHead>
              <TableHead scope="col">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {billing.invoices.map((inv) => (
              <TableRow key={inv.id}>
                <TableCell>{new Date(inv.date + 'T00:00:00').toLocaleDateString()}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtCents(inv.amountCents)}</TableCell>
                <TableCell>
                  <Badge variant={inv.status === 'paid' ? 'secondary' : 'outline'}>
                    {inv.status}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SectionCard>

      {/* Buy credits dialog — MOCK amount only; no card entry. */}
      <Dialog open={buyOpen} onOpenChange={setBuyOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Buy credits</DialogTitle>
            <DialogDescription>
              Add prepaid credits to your balance. Minimum $10. You won&apos;t be charged in
              this demo.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={amountId}>Amount (USD)</Label>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">$</span>
              <Input
                id={amountId}
                type="number"
                min={10}
                step={5}
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  if (amountError) setAmountError('');
                }}
                aria-invalid={!!amountError}
                aria-describedby={amountError ? `${amountId}-error` : undefined}
                className={cn(amountError && 'border-destructive')}
              />
            </div>
            {amountError && (
              <p id={`${amountId}-error`} role="alert" className="text-xs text-destructive">
                {amountError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBuyOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={pending || !!amountError}
              onClick={() => void handleBuy()}
            >
              {pending ? 'Adding…' : 'Add credits'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Account section ─────────────────────────────────────────────────────────

function AccountSection() {
  const initial = CURRENT_USER.name.charAt(0).toUpperCase();
  return (
    <div className="flex flex-col gap-6">
      <SectionCard title="Profile" headingLevel={2}>
        <div className="flex items-center gap-4">
          <Avatar className="size-12 rounded-lg">
            <AvatarFallback className="rounded-lg text-base">{initial}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="font-medium">{CURRENT_USER.name}</p>
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              {CURRENT_USER.email}
              <Badge variant="secondary" className="gap-1">
                <ShieldCheck className="size-3" aria-hidden="true" />
                Verified
              </Badge>
            </p>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Preferences" headingLevel={2}>
        <p className="text-sm text-muted-foreground">
          Theme (light / dark / system) is set from the avatar menu in the sidebar.
        </p>
      </SectionCard>

      <div>
        <Button variant="outline" onClick={() => toast.success('Signed out (demo).')}>
          Sign out
        </Button>
      </div>
    </div>
  );
}

// ── Settings page ────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [org, setOrg] = useState<TeamOrgInfo | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [billing, setBilling] = useState<BillingInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchCp<{ org: TeamOrgInfo }>('/api/cp/team').then((res) => {
      if (!cancelled && res.ok) setOrg(res.data.org);
    });
    void fetchCp<UsageResponse>('/api/cp/usage').then((res) => {
      if (!cancelled && res.ok) setUsage(res.data);
    });
    void fetchCp<BillingInfo>('/api/cp/billing').then((res) => {
      if (!cancelled && res.ok) setBilling(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleTopUp = useCallback((newBalanceCents: number) => {
    // Keep the Usage section's credit pill in sync after a top-up.
    setUsage((prev) => (prev ? { ...prev, creditBalance: newBalanceCents } : prev));
  }, []);

  const sections = [
    { id: 'organization', label: 'Organization', content: <OrganizationSection org={org} /> },
    { id: 'usage', label: 'Usage', content: <UsageSection usage={usage} /> },
    {
      id: 'billing',
      label: 'Billing',
      content: <BillingSection billing={billing} onTopUp={handleTopUp} />,
    },
    { id: 'account', label: 'Account', content: <AccountSection /> },
  ];

  return (
    <DetailLayout
      title="Settings"
      meta={
        <span className="text-sm text-muted-foreground">
          {org ? `${org.name} · ${billing?.plan ?? ''} plan` : 'Loading…'}
        </span>
      }
      sections={sections}
    />
  );
}
