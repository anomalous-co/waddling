'use client';

/**
 * Billing settings — extracted from the former /dashboard/billing page so it renders as
 * the "Billing" tab of the unified settings page, plus the prepaid-credit balance +
 * top-up UI (control-api already returns `credit` + `creditPacks`).
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
import { toast } from 'sonner';

interface PlanInfo {
  name: 'free' | 'pro' | 'enterprise';
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
interface CreditPack {
  id: string;
  label: string;
  usd: number;
}
interface BillingData {
  plan: PlanInfo;
  entitlements: Record<string, unknown>;
  invoices: Invoice[];
  // Complimentary "free forever" org (company domain) — suppresses paywalls.
  comped?: boolean;
  // Prepaid credit balance + buyable packs (added in control-api billing.ts).
  credit: { balanceMicro: number; balanceUsd: number };
  creditPacks: CreditPack[];
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
  free: ['1 data lake', '2 agents', 'Audit & monitor (read-only)', 'Static reader/writer roles', 'Community support'],
  pro: ['Up to 5 data lakes', '25 agents', 'Full dynamic ACL (column/row/window rules)', 'Instant revocation', 'Internal MCP admin server', '90-day audit retention', 'Email support'],
  enterprise: ['Unlimited data lakes', 'Unlimited agents', 'Dedicated isolated gateways', 'Encrypted lakes', 'SSO/SAML', '1-year audit retention', 'SLA + priority support'],
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

function CreditsCard({
  balanceUsd,
  packs,
  onBuy,
  busy,
}: {
  balanceUsd: number;
  packs: CreditPack[];
  onBuy: (packId: string) => void;
  busy: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Credits</CardTitle>
        <CardDescription>Prepaid balance, drawn down as your agents run.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="text-3xl font-semibold tabular-nums">
          {balanceUsd.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}
        </div>
        {packs.length === 0 ? (
          <p className="text-sm text-muted-foreground">Credit packs aren&apos;t available yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {packs.map((p) => (
              <Button key={p.id} variant="outline" disabled={busy} onClick={() => onBuy(p.id)}>
                Add ${p.usd}
              </Button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

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
                  <TableCell className="capitalize text-muted-foreground">{key.replace(/_/g, ' ')}</TableCell>
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

function PlanComparisonCard({ currentPlan, onUpgrade }: { currentPlan: string; onUpgrade: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Compare plans</CardTitle>
        <CardDescription>Upgrade to unlock more data lakes, agents, and ACL power.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 md:grid-cols-3">
          {(['free', 'pro', 'enterprise'] as const).map((name) => {
            const isCurrent = name === currentPlan;
            const isPro = name === 'pro';
            return (
              <div
                key={name}
                className={`flex flex-col gap-3 rounded-lg border p-4 ${isPro ? 'border-primary/50 ring-1 ring-primary/20' : 'border-border'}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold capitalize">{name}</span>
                  <Badge variant={isPro ? 'default' : 'outline'}>
                    {name === 'free' ? '$0' : name === 'pro' ? '$99 / mo' : 'Custom'}
                  </Badge>
                </div>
                <ul className="flex flex-col gap-1.5">
                  {PLAN_FEATURES[name]?.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Check className="size-3 shrink-0 text-green-500" />
                      {f}
                    </li>
                  ))}
                </ul>
                {!isCurrent && isPro ? (
                  <Button size="sm" onClick={onUpgrade}>
                    Upgrade to Pro
                  </Button>
                ) : isCurrent ? (
                  <Badge variant="secondary" className="w-fit">
                    Current plan
                  </Badge>
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
  const [busy, setBusy] = useState(false);

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

  // Returned from a credit-pack Checkout — the webhook grants async, so reload shortly.
  useEffect(() => {
    if (params.get('topup') === 'success') {
      toast.success('Payment received — updating your balance…');
      const t = setTimeout(() => void load(), 2500);
      return () => clearTimeout(t);
    }
  }, [params, load]);

  const subscribe = useCallback(async () => {
    if (!orgId) {
      toast.error('No active organization to bill.');
      return;
    }
    // Conversion-funnel ping (best-effort, server-side, non-spoofable).
    await cpPost('/billing/checkout-intent', { toPlan: 'pro' }).catch(() => {});
    const origin = window.location.origin;
    const res = (await authClient.subscription.upgrade({
      plan: 'pro',
      referenceId: orgId,
      successUrl: `${origin}/dashboard/settings?tab=billing`,
      cancelUrl: `${origin}/dashboard/settings?tab=billing`,
    })) as unknown as { data?: { url?: string }; error?: { message?: string } };
    if (res?.error) {
      toast.error(res.error.message ?? 'Could not start checkout');
      return;
    }
    if (res?.data?.url) window.location.assign(res.data.url);
  }, [orgId]);

  const buyPack = useCallback(async (packId: string) => {
    setBusy(true);
    const res = await cpPost<{ url: string }>('/api/cp/billing/credit-pack', {
      packId,
      returnPath: '/dashboard/settings?tab=billing',
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error === 'billing_not_configured' ? 'Credit packs are not configured yet.' : res.error);
      return;
    }
    window.location.assign(res.data.url);
  }, []);

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
  const isFree = data.plan.name === 'free';
  const isPaidPlan = data.plan.name === 'pro' || data.plan.name === 'enterprise';

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

      {/* Current plan */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <CardTitle className="capitalize">{data.plan.name} plan</CardTitle>
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
              {isFree ? <Button onClick={() => void subscribe()}>Upgrade to Pro — $99/mo</Button> : null}
              {isPaidPlan ? (
                <Button variant="outline" onClick={() => window.location.assign(data.actions.portal)}>
                  Manage subscription
                </Button>
              ) : null}
              {isFree ? (
                <Button variant="outline" asChild>
                  <a href="https://getwaddling.com/enterprise">Contact sales — Enterprise</a>
                </Button>
              ) : null}
            </div>
          </CardContent>
        ) : null}
      </Card>

      {/* Prepaid credits + top-up (hidden for comped orgs) */}
      {!comped ? (
        <CreditsCard balanceUsd={data.credit?.balanceUsd ?? 0} packs={data.creditPacks ?? []} onBuy={(id) => void buyPack(id)} busy={busy} />
      ) : null}

      {/* Entitlements */}
      <EntitlementsCard entitlements={data.entitlements} />

      {/* Plan comparison (free upsell only; not for comped) */}
      {isFree && !comped ? <PlanComparisonCard currentPlan={data.plan.name} onUpgrade={() => void subscribe()} /> : null}

      {/* Invoices */}
      <InvoicesCard invoices={data.invoices ?? []} />
    </div>
  );
}
