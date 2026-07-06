'use client';

/**
 * Billing settings — extracted from the former /dashboard/billing page so it renders as
 * the "Billing" tab of the unified settings page.
 *
 * Model: flat monthly base fee (Free/Pro/Max/Scale) that includes an envelope of storage
 * + compute-hours, then metered overage on top. The `credit` balance the API returns is the
 * remaining included-compute envelope for the month (read-only) — NOT a prepaid top-up
 * balance. New orgs start on a local 7-day, no-card trial that grants full Pro access; the
 * conversion path is "add a card to keep Pro".
 *
 * Loads its own data on mount. Because Radix <TabsContent> unmounts inactive tabs, this
 * fetch (and the `upgrade_viewed` PostHog event GET /api/cp/billing fires for free orgs)
 * runs ONLY when the Billing tab is opened — not on every settings visit.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { RefreshCw, Check } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { StatusBadge } from '@/components/dashboard/status';
import { fetchCp, cpPost } from '@/components/dashboard/fetch';
import { authClient } from '@/lib/auth-client';
import { stripeConfigured } from '@/lib/stripe';
import { UpgradeDialog } from '@/components/dashboard/settings/upgrade-dialog';
import { ManageSubscriptionDialog } from '@/components/dashboard/settings/manage-subscription-dialog';
import { toast } from 'sonner';

interface PlanInfo {
  name: 'free' | 'pro' | 'max' | 'scale';
  status: 'active' | 'past_due' | 'canceled' | 'trialing';
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
}
interface Invoice {
  id: string;
  amount: number;
  currency: string;
  status: string;
  date: string;
  url?: string;
}
interface BillingActions {
  upgrade: string;
  portal: string;
  cancel: string;
  list: string;
}
interface BillingData {
  plan: PlanInfo;
  entitlements: Record<string, unknown>;
  invoices: Invoice[];
  // Local 7-day no-card trial (grants full Pro access). `endsAt` is null off-trial.
  trial?: { endsAt: string | null; active: boolean };
  // Complimentary "free forever" org (company domain) — suppresses paywalls.
  comped?: boolean;
  // Remaining included-compute envelope for the month (drawn down per-second as agents
  // run). Read-only — the prepaid top-up product is retired.
  credit: { balanceMicro: number; balanceUsd: number };
  subscription: {
    plan: string | null;
    status: string | null;
    subscriptionId: string | null;
    periodStart: string | null;
    periodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  actions: BillingActions;
}

const PLAN_FEATURES: Record<string, string[]> = {
  free: [
    '1 seat',
    '1 data lake',
    '5 GB storage included',
    '5 compute-hours / mo included',
    'Full dynamic ACLs',
    '7-day audit retention',
  ],
  pro: [
    '3 seats',
    '2 data lakes',
    '50 GB storage included',
    '25 compute-hours / mo included',
    'Full dynamic ACLs',
    '30-day audit retention',
  ],
  max: [
    '10 seats',
    '10 data lakes',
    '500 GB storage included',
    '75 compute-hours / mo included',
    'Full dynamic ACLs',
    'Internal MCP admin server',
    '90-day audit retention',
  ],
  scale: [
    'Unlimited seats',
    'Unlimited data lakes',
    '2 TB storage included',
    '200 compute-hours / mo included',
    'Full dynamic ACLs',
    'Internal MCP admin server',
    '365-day audit retention',
  ],
};

// Per-plan monthly price label for the comparison grid + CTAs.
const PLAN_PRICE: Record<string, string> = {
  free: '$0',
  pro: '$29 / mo',
  max: '$99 / mo',
  scale: '$299 / mo',
};

function BillingSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

// Duckling (baseline size) compute price — used to express the remaining envelope in hours.
const DUCKLING_PRICE_PER_HR = 0.55;

function IncludedComputeCard({ balanceUsd }: { balanceUsd: number }) {
  const hours = balanceUsd / DUCKLING_PRICE_PER_HR;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Included compute</CardTitle>
        <CardDescription>
          Your plan&apos;s included compute envelope for this month, drawn down as your agents run.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="text-3xl font-semibold tabular-nums">
          {balanceUsd.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}
          <span className="ml-2 text-base font-normal text-muted-foreground">of compute included this month</span>
        </div>
        <div className="text-sm text-muted-foreground tabular-nums">
          ≈ {hours.toLocaleString('en-US', { maximumFractionDigits: 1 })} Duckling-hours remaining
        </div>
        <p className="text-xs text-muted-foreground">
          Usage is metered: $0.55 / compute-hour (Duckling) scaling up the size ladder, storage $0.04 / GB over your
          included cap.
        </p>
      </CardContent>
    </Card>
  );
}

// Human labels for the (camelCase) entitlement keys the API returns.
const ENTITLEMENT_LABELS: Record<string, string> = {
  seats: 'Seats',
  lakes: 'Data lakes',
  storageGb: 'Storage (GB)',
  includedComputeHours: 'Included compute (hrs)',
  dynamicAcl: 'Dynamic ACLs',
  adminMcp: 'Internal MCP admin server',
  auditRetentionDays: 'Audit retention (days)',
};

function EntitlementsCard({ entitlements }: { entitlements: Record<string, unknown> }) {
  const entries = Object.entries(entitlements);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Entitlements</CardTitle>
        <CardDescription>Active limits for your current plan</CardDescription>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No entitlements configured</EmptyTitle>
              <EmptyDescription>Upgrade to unlock higher limits.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Feature</TableHead>
                <TableHead>Limit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map(([key, val]) => (
                <TableRow key={key}>
                  <TableCell className="text-muted-foreground">
                    {ENTITLEMENT_LABELS[key] ?? key.replace(/_/g, ' ')}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{String(val)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function InvoicesCard({ invoices }: { invoices: Invoice[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Invoices</CardTitle>
        <CardDescription>Billing history for your organization</CardDescription>
      </CardHeader>
      <CardContent>
        {invoices.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No invoices yet</EmptyTitle>
              <EmptyDescription>Invoices will appear here once you have a paid subscription.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((inv) => (
                <TableRow key={inv.id}>
                  <TableCell className="text-muted-foreground">{new Date(inv.date).toLocaleDateString()}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {(inv.amount / 100).toLocaleString('en-US', { style: 'currency', currency: inv.currency.toUpperCase() })}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={inv.status} />
                  </TableCell>
                  <TableCell>
                    {inv.url ? (
                      <a href={inv.url} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">
                        View
                      </a>
                    ) : null}
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

const PLAN_LABEL: Record<'free' | 'pro' | 'max' | 'scale', string> = {
  free: 'Free',
  pro: 'Pro',
  max: 'Max',
  scale: 'Scale',
};

function PlanComparisonCard({
  currentPlan,
  onUpgrade,
}: {
  currentPlan: string;
  onUpgrade: (plan: 'pro' | 'max' | 'scale') => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Compare plans</CardTitle>
        <CardDescription>Upgrade to unlock more seats, data lakes, storage, and included compute.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {(['free', 'pro', 'max', 'scale'] as const).map((name) => {
            const isCurrent = name === currentPlan;
            const isPro = name === 'pro';
            const isSelfServePaid = name === 'pro' || name === 'max' || name === 'scale';
            return (
              <div
                key={name}
                className={`flex flex-col gap-3 rounded-lg border p-4 ${isPro ? 'border-primary/50 ring-1 ring-primary/20' : 'border-border'}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{PLAN_LABEL[name]}</span>
                  <Badge variant={isPro ? 'default' : 'outline'}>{PLAN_PRICE[name]}</Badge>
                </div>
                <ul className="flex flex-col gap-1.5">
                  {PLAN_FEATURES[name]?.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Check className="size-3 shrink-0 text-green-500" />
                      {f}
                    </li>
                  ))}
                </ul>
                {isCurrent ? (
                  <Badge variant="secondary" className="w-fit">
                    Current plan
                  </Badge>
                ) : isSelfServePaid ? (
                  <Button size="sm" onClick={() => onUpgrade(name)}>
                    Upgrade to {PLAN_LABEL[name]}
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

export function BillingTab() {
  const params = useSearchParams();
  const [data, setData] = useState<BillingData | null>(null);
  const [orgId, setOrgId] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // The plan whose embedded-checkout dialog is open (null = closed).
  const [upgradePlan, setUpgradePlan] = useState<'pro' | 'max' | 'scale' | null>(null);
  // Manage-subscription modal (existing subscribers: switch tier / cancel).
  const [manageOpen, setManageOpen] = useState(false);

  const load = useCallback(async () => {
    const res = await fetchCp<BillingData>('/api/cp/billing');
    if (!res.ok) setError(res.error);
    else {
      setData(res.data);
      setError(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    // Resolve the active org id for the subscription referenceId. activeOrganizationId
    // may be unset (signup doesn't setActive), so fall back to the first membership.
    void authClient.getSession().then((res) => {
      const s = res.data?.session as { activeOrganizationId?: string } | undefined;
      if (s?.activeOrganizationId) {
        setOrgId(s.activeOrganizationId);
        return;
      }
      void authClient.organization.list().then((r) => {
        const first = (r.data as Array<{ id: string }> | undefined)?.[0];
        if (first) setOrgId(first.id);
      });
    });
  }, [load]);

  // Returned from an SCA redirect (return_url). The webhook flips the subscription
  // active asynchronously — and SCA is where webhook timing is least predictable — so
  // poll billing until it lands rather than a single reload.
  useEffect(() => {
    if (params.get('sub') !== 'success') return;
    let active = true;
    toast.success('Payment received — activating your subscription…');
    void (async () => {
      for (let i = 0; i < 15 && active; i += 1) {
        const res = await fetchCp<BillingData>('/api/cp/billing');
        if (!active) return;
        if (res.ok) {
          setData(res.data);
          const status = res.data.subscription?.status;
          if (status === 'active' || status === 'trialing') return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    return () => {
      active = false;
    };
  }, [params]);

  /**
   * Hosted-Checkout fallback (Better Auth plugin). Used only when Stripe.js isn't
   * configured for this deployment (no publishable key) — otherwise the embedded
   * Elements dialog handles the free→paid conversion.
   */
  const subscribeHosted = useCallback(async (plan: 'pro' | 'max' | 'scale' = 'pro') => {
    if (!orgId) {
      toast.error('No active organization to bill.');
      return;
    }
    await cpPost('/billing/checkout-intent', { toPlan: plan }).catch(() => {});
    const origin = window.location.origin;
    const res = (await authClient.subscription.upgrade({
      plan,
      referenceId: orgId,
      // Org-scoped customer (matches the embedded flow) — one Stripe customer per org.
      customerType: 'organization',
      successUrl: `${origin}/settings?tab=billing`,
      cancelUrl: `${origin}/settings?tab=billing`,
    })) as unknown as { data?: { url?: string }; error?: { message?: string } };
    if (res?.error) {
      toast.error(res.error.message ?? 'Could not start checkout');
      return;
    }
    if (res?.data?.url) window.location.assign(res.data.url);
  }, [orgId]);

  /** Start an upgrade: embedded Elements dialog when configured, else hosted redirect. */
  const startUpgrade = useCallback((plan: 'pro' | 'max' | 'scale') => {
    if (!orgId) {
      toast.error('No active organization to bill.');
      return;
    }
    // Fire the funnel ping either way (best-effort, server-side, non-spoofable).
    void cpPost('/billing/checkout-intent', { toPlan: plan }).catch(() => {});
    if (stripeConfigured) setUpgradePlan(plan);
    else void subscribeHosted(plan);
  }, [orgId, subscribeHosted]);

  if (loading) return <BillingSkeleton />;

  if (error)
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load billing</AlertTitle>
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

  if (!data) return null;

  const comped = !!data.comped;
  const trialActive = !!data.trial?.active;
  // Whole days left in the local no-card trial (rounded up), for the banner readout.
  const trialDaysLeft = data.trial?.endsAt
    ? Math.max(0, Math.ceil((new Date(data.trial.endsAt).getTime() - Date.now()) / 86_400_000))
    : 0;
  // Gate "Manage subscription" on the authoritative signal: a real Stripe subscription.
  // This is null on Free AND during a local no-card trial (which grants Pro entitlements
  // with no Stripe sub), so trial orgs correctly see the convert CTA, not manage/cancel.
  const isSubscribed = !!data.subscription;

  return (
    <div className="flex flex-col gap-6">
      {/* Complimentary banner — comped orgs are free forever; no paywalls. */}
      {comped ? (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <CardTitle>Complimentary</CardTitle>
              <Badge>Free forever</Badge>
            </div>
            <CardDescription>
              Your team has complimentary access — no subscription or credits required.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {/* Trial banner — local 7-day no-card trial that grants full Pro access. No card was
          collected at signup, so this is the conversion surface. */}
      {trialActive && !comped ? (
        <Card className="border-primary/50 ring-1 ring-primary/20">
          <CardHeader>
            <div className="flex items-center gap-3">
              <CardTitle>Free trial — {trialDaysLeft} {trialDaysLeft === 1 ? 'day' : 'days'} left</CardTitle>
              <Badge>Full Pro access</Badge>
            </div>
            <CardDescription>
              You have full Pro access during your trial. Add a card before it ends to keep Pro without
              interruption.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => startUpgrade('pro')}>Add a card to keep Pro</Button>
          </CardContent>
        </Card>
      ) : null}

      {/* Current plan */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <CardTitle>{PLAN_LABEL[data.plan.name]} plan</CardTitle>
            <StatusBadge status={data.plan.status} />
          </div>
          <CardDescription>
            {data.plan.currentPeriodEnd
              ? `Current period ends ${new Date(data.plan.currentPeriodEnd).toLocaleDateString()}`
              : 'No billing period active'}
            {data.plan.cancelAtPeriodEnd ? ' — cancels at period end' : null}
          </CardDescription>
        </CardHeader>
        {!comped ? (
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {/* No Stripe subscription yet (Free or on a local trial) → embedded Payment
                  Element (Elements dialog). On trial the primary "Add a card to keep Pro"
                  CTA lives in the banner above; here we offer the fuller ladder. */}
              {!isSubscribed ? (
                <>
                  <Button onClick={() => startUpgrade('pro')}>Upgrade to Pro — $29/mo</Button>
                  <Button variant="outline" onClick={() => startUpgrade('max')}>
                    Upgrade to Max — $99/mo
                  </Button>
                  <Button variant="outline" onClick={() => startUpgrade('scale')}>
                    Upgrade to Scale — $299/mo
                  </Button>
                </>
              ) : (
                /* Existing subscriber: manage subscription in-app — switch plan / cancel. */
                <Button onClick={() => setManageOpen(true)}>Manage subscription</Button>
              )}
            </div>
          </CardContent>
        ) : null}
      </Card>

      {/* Included-compute envelope (read-only; hidden for comped orgs) */}
      {!comped ? <IncludedComputeCard balanceUsd={data.credit?.balanceUsd ?? 0} /> : null}

      {/* Entitlements */}
      <EntitlementsCard entitlements={data.entitlements} />

      {/* Plan comparison (upsell for orgs without a subscription; not for comped) */}
      {!isSubscribed && !comped ? (
        <PlanComparisonCard currentPlan={data.plan.name} onUpgrade={startUpgrade} />
      ) : null}

      {/* Invoices */}
      <InvoicesCard invoices={data.invoices ?? []} />

      {/* Embedded Stripe Elements upgrade (free→paid). */}
      <UpgradeDialog
        plan={upgradePlan}
        onClose={() => setUpgradePlan(null)}
        onSuccess={(plan) => {
          setUpgradePlan(null);
          toast.success(`You're now on ${PLAN_LABEL[plan]}.`);
          void load();
        }}
      />

      {/* Manage subscription (existing subscribers): in-app switch/cancel, no hosted portal. */}
      {isSubscribed ? (
        <ManageSubscriptionDialog
          open={manageOpen}
          plan={data.plan.name as 'pro' | 'max' | 'scale'}
          status={data.plan.status}
          periodEnd={data.plan.currentPeriodEnd}
          onClose={() => setManageOpen(false)}
          onChanged={(message) => {
            setManageOpen(false);
            toast.success(message);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}
