'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Card,
  CardHeader,
  Badge,
  Button,
  Spinner,
  ErrorState,
  SectionTitle,
  Table,
  Td,
} from '@/components/dashboard/ui';
import { fetchCp, cpPost } from '@/components/dashboard/fetch';
import { siteUrl } from '@/lib/site';

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

interface BillingData {
  plan: PlanInfo;
  portalUrl?: string;
  invoices: Invoice[];
}

const PLAN_FEATURES: Record<string, string[]> = {
  free: [
    '1 endpoint',
    '2 agents',
    'Audit & monitor only (read-only)',
    'Static reader/writer roles',
    'Community support',
  ],
  pro: [
    'Up to 5 endpoints',
    '25 agents',
    'Full dynamic ACL (column/row/window rules)',
    'Instant revocation',
    'Internal MCP admin server',
    '90-day audit retention',
    'Email support',
  ],
  enterprise: [
    'Unlimited endpoints',
    'Unlimited agents',
    'Dedicated isolated gateways',
    'Encrypted lakes',
    'SSO/SAML',
    '1-year audit retention',
    'SLA',
    'Priority support',
  ],
};

function PlanCard({ plan }: { plan: PlanInfo }) {
  const features = PLAN_FEATURES[plan.name] ?? [];
  const statusVariant =
    plan.status === 'active'
      ? 'text-green-400'
      : plan.status === 'past_due'
        ? 'text-red-400'
        : 'text-neutral-400';

  return (
    <Card>
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-neutral-100 capitalize">
              {plan.name}
            </h3>
            {plan.name === 'pro' && (
              <Badge variant="blue">$99 / seat / month</Badge>
            )}
            {plan.name === 'free' && (
              <Badge variant="neutral">$0</Badge>
            )}
            {plan.name === 'enterprise' && (
              <Badge variant="neutral">Custom pricing</Badge>
            )}
          </div>
          <p className={`text-xs mt-1 ${statusVariant}`}>
            Status: {plan.status}
            {plan.currentPeriodEnd &&
              ` — renews ${new Date(plan.currentPeriodEnd).toLocaleDateString()}`}
            {plan.cancelAtPeriodEnd && ' (cancels at period end)'}
          </p>
        </div>
      </div>
      <ul className="space-y-1.5">
        {features.map((f) => (
          <li key={f} className="flex items-center gap-2 text-sm text-neutral-300">
            <span className="text-green-400 text-xs">✓</span>
            {f}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function BillingPage() {
  const [data, setData] = useState<BillingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);

  const load = useCallback(async () => {
    const res = await fetchCp<BillingData>('/api/cp/billing');
    if (!res.ok) {
      setError(res.error);
    } else {
      setData(res.data);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const goToCheckout = async (planName: string) => {
    setCheckoutLoading(true);
    const res = await cpPost<{ url: string }>('/api/cp/billing/checkout', {
      plan: planName,
    });
    setCheckoutLoading(false);
    if (res.ok) {
      window.location.href = res.data.url;
    }
  };

  const goToPortal = async () => {
    setPortalLoading(true);
    const res = await cpPost<{ url: string }>('/api/cp/billing/portal', {});
    setPortalLoading(false);
    if (res.ok) {
      window.location.href = res.data.url;
    }
  };

  if (loading)
    return (
      <div className="flex justify-center py-24">
        <Spinner size="lg" />
      </div>
    );
  if (error) return <ErrorState message={error} retry={() => { setLoading(true); void load(); }} />;
  if (!data) return null;

  const isPro = data.plan.name === 'pro';
  const isEnterprise = data.plan.name === 'enterprise';
  const isFree = data.plan.name === 'free';

  return (
    <div className="space-y-4">
      <SectionTitle>Billing</SectionTitle>

      {/* Current plan */}
      <div>
        <h2 className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-3">
          Current plan
        </h2>
        <PlanCard plan={data.plan} />
      </div>

      {/* Actions */}
      <Card>
        <CardHeader title="Plan management" />
        <div className="flex flex-wrap gap-3">
          {isFree && (
            <Button
              variant="primary"
              onClick={() => void goToCheckout('pro')}
              loading={checkoutLoading}
            >
              Upgrade to Pro — $99/mo
            </Button>
          )}
          {(isPro || isEnterprise) && (
            <Button
              variant="secondary"
              onClick={() => void goToPortal()}
              loading={portalLoading}
            >
              Manage subscription
            </Button>
          )}
          {isFree && (
            <a
              href={siteUrl('/enterprise')}
              className="inline-flex items-center px-3.5 py-1.5 text-sm rounded border border-neutral-600 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 transition-colors"
            >
              Contact sales — Enterprise
            </a>
          )}
        </div>
      </Card>

      {/* Plan comparison (for free tier upsell) */}
      {isFree && (
        <div className="grid md:grid-cols-3 gap-4">
          {(['free', 'pro', 'enterprise'] as const).map((name) => (
            <Card
              key={name}
              className={name === 'pro' ? 'border-blue-700 ring-1 ring-blue-700/30' : ''}
            >
              <CardHeader
                title={name.charAt(0).toUpperCase() + name.slice(1)}
                subtitle={
                  name === 'free'
                    ? '$0'
                    : name === 'pro'
                      ? '$99/mo'
                      : 'Custom'
                }
              />
              <ul className="space-y-1.5">
                {PLAN_FEATURES[name]?.map((f) => (
                  <li
                    key={f}
                    className="flex items-center gap-2 text-xs text-neutral-400"
                  >
                    <span className="text-green-400">✓</span>
                    {f}
                  </li>
                ))}
              </ul>
              {name === 'pro' && (
                <div className="mt-4">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void goToCheckout('pro')}
                    loading={checkoutLoading}
                  >
                    Upgrade now
                  </Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Invoices */}
      {data.invoices.length > 0 && (
        <Card>
          <CardHeader title="Invoices" />
          <Table headers={['Date', 'Amount', 'Status', '']}>
            {data.invoices.map((inv) => (
              <tr key={inv.id}>
                <Td>{new Date(inv.date).toLocaleDateString()}</Td>
                <Td mono>
                  {(inv.amount / 100).toLocaleString('en-US', {
                    style: 'currency',
                    currency: inv.currency.toUpperCase(),
                  })}
                </Td>
                <Td>
                  <Badge
                    variant={
                      inv.status === 'paid'
                        ? 'green'
                        : inv.status === 'open'
                          ? 'yellow'
                          : 'neutral'
                    }
                  >
                    {inv.status}
                  </Badge>
                </Td>
                <Td>
                  {inv.url && (
                    <a
                      href={inv.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-blue-400 hover:underline"
                    >
                      View →
                    </a>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </div>
  );
}
