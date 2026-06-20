'use client';

import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Check } from 'lucide-react';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import { StatusBadge } from '@/components/dashboard/status';
import { fetchCp } from '@/components/dashboard/fetch';

// ---------------------------------------------------------------------------
// Types (mirrors the shape returned by GET /api/cp/billing in billing.ts)
// ---------------------------------------------------------------------------

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

interface BillingData {
  plan: PlanInfo;
  entitlements: Record<string, unknown>;
  invoices: Invoice[];
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

// ---------------------------------------------------------------------------
// Static plan feature lists (upsell copy)
// ---------------------------------------------------------------------------

const PLAN_FEATURES: Record<string, string[]> = {
  free: [
    '1 data lake',
    '2 agents',
    'Audit & monitor (read-only)',
    'Static reader/writer roles',
    'Community support',
  ],
  pro: [
    'Up to 5 data lakes',
    '25 agents',
    'Full dynamic ACL (column/row/window rules)',
    'Instant revocation',
    'Internal MCP admin server',
    '90-day audit retention',
    'Email support',
  ],
  enterprise: [
    'Unlimited data lakes',
    'Unlimited agents',
    'Dedicated isolated gateways',
    'Encrypted lakes',
    'SSO/SAML',
    '1-year audit retention',
    'SLA + priority support',
  ],
};

// ---------------------------------------------------------------------------
// Sub-components (module scope — no nested component definitions)
// ---------------------------------------------------------------------------

function BillingSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

function EntitlementsCard({
  entitlements,
}: {
  entitlements: Record<string, unknown>;
}) {
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
              <EmptyDescription>
                Upgrade to unlock higher limits.
              </EmptyDescription>
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
                  <TableCell className="capitalize text-muted-foreground">
                    {key.replace(/_/g, ' ')}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {String(val)}
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
              <EmptyDescription>
                Invoices will appear here once you have a paid subscription.
              </EmptyDescription>
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
                  <TableCell className="text-muted-foreground">
                    {new Date(inv.date).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {(inv.amount / 100).toLocaleString('en-US', {
                      style: 'currency',
                      currency: inv.currency.toUpperCase(),
                    })}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={inv.status} />
                  </TableCell>
                  <TableCell>
                    {inv.url ? (
                      <a
                        href={inv.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-primary hover:underline"
                      >
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

function PlanComparisonCard({
  currentPlan,
  upgradeUrl,
}: {
  currentPlan: string;
  upgradeUrl: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Compare plans</CardTitle>
        <CardDescription>
          Upgrade to unlock more data lakes, agents, and ACL power.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 md:grid-cols-3">
          {(['free', 'pro', 'enterprise'] as const).map((name) => {
            const isCurrent = name === currentPlan;
            const isPro = name === 'pro';
            return (
              <div
                key={name}
                className={`flex flex-col gap-3 rounded-lg border p-4 ${
                  isPro
                    ? 'border-primary/50 ring-1 ring-primary/20'
                    : 'border-border'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold capitalize">{name}</span>
                  <Badge variant={isPro ? 'default' : 'outline'}>
                    {name === 'free'
                      ? '$0'
                      : name === 'pro'
                        ? '$99 / mo'
                        : 'Custom'}
                  </Badge>
                </div>
                <ul className="flex flex-col gap-1.5">
                  {PLAN_FEATURES[name]?.map((f) => (
                    <li
                      key={f}
                      className="flex items-center gap-2 text-xs text-muted-foreground"
                    >
                      <Check className="size-3 shrink-0 text-green-500" />
                      {f}
                    </li>
                  ))}
                </ul>
                {!isCurrent && isPro ? (
                  <Button
                    size="sm"
                    onClick={() => window.location.assign(upgradeUrl)}
                  >
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function BillingPage() {
  const [data, setData] = useState<BillingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetchCp<BillingData>('/api/cp/billing');
    if (!res.ok) {
      setError(res.error);
    } else {
      setData(res.data);
      setError(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <BillingSkeleton />;

  if (error)
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn't load billing</AlertTitle>
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

  const isFree = data.plan.name === 'free';
  const isPaidPlan = data.plan.name === 'pro' || data.plan.name === 'enterprise';

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="text-sm text-muted-foreground">
          Plan, entitlements, and payment history for your organization.
        </p>
      </div>

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
            {data.plan.cancelAtPeriodEnd
              ? ' — cancels at period end'
              : null}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {isFree ? (
              <Button onClick={() => window.location.assign(data.actions.upgrade)}>
                Upgrade to Pro — $99/mo
              </Button>
            ) : null}
            {isPaidPlan ? (
              <Button
                variant="outline"
                onClick={() => window.location.assign(data.actions.portal)}
              >
                Manage subscription
              </Button>
            ) : null}
            {isFree ? (
              <Button variant="outline" asChild>
                <a href="https://getwaddling.com/enterprise">
                  Contact sales — Enterprise
                </a>
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* Entitlements */}
      <EntitlementsCard entitlements={data.entitlements} />

      {/* Plan comparison (free upsell only) */}
      {isFree ? (
        <PlanComparisonCard
          currentPlan={data.plan.name}
          upgradeUrl={data.actions.upgrade}
        />
      ) : null}

      {/* Invoices */}
      <InvoicesCard invoices={data.invoices ?? []} />
    </div>
  );
}
