'use client';

/**
 * Forced payment-onboarding step ("must pay to enter"). Rendered full-screen by
 * app/onboarding (OUTSIDE the dashboard route group, so the dashboard paid-gate cannot
 * loop back onto it). A small state machine: org → choose → confirming.
 *
 *  - org:        create the first org (when the user has none). Reuses the sign-up
 *                org form pattern; never routes to /dashboard.
 *  - choose:     subscribe (Pro) OR buy a credit pack. Both start a Stripe Checkout and
 *                return to ?step=confirming.
 *  - confirming: Stripe's success redirect lands here. Credits/subscription are granted
 *                ASYNCHRONOUSLY by the webhook, NOT the redirect — so poll the paid
 *                status until true, then enter the dashboard.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { fetchCp, cpPost } from '@/components/dashboard/fetch';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Field, FieldLabel, FieldGroup } from '@/components/ui/field';

type Step = 'org' | 'choose' | 'confirming';

interface Pack {
  id: string;
  label: string;
  usd: number;
}
interface BillingLite {
  creditPacks?: Pack[];
}

/** Map control-api error codes to onboarding-friendly copy. */
function billingMessage(code: string): string {
  if (code === 'billing_not_configured')
    return 'Credit packs are not configured for this deployment yet.';
  if (/forbidden|organization|authoriz|permission/i.test(code))
    return 'Ask an organization owner to set up billing for this org.';
  return code;
}

export function OnboardingFlow({
  hasOrg,
  initialOrgId,
}: {
  hasOrg: boolean;
  initialOrgId?: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const stepParam = params.get('step');
  const initialStep: Step =
    stepParam === 'confirming' ? 'confirming' : !hasOrg || stepParam === 'org' ? 'org' : 'choose';

  const [step, setStep] = useState<Step>(initialStep);
  const [orgId, setOrgId] = useState<string | undefined>(initialOrgId);
  const [orgName, setOrgName] = useState('');
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the purchasable credit packs when the choose step is shown.
  useEffect(() => {
    if (step !== 'choose') return;
    let active = true;
    void (async () => {
      const res = await fetchCp<BillingLite>('/api/cp/billing');
      if (!active) return;
      setPacks(res.ok ? res.data.creditPacks ?? [] : []);
    })();
    return () => {
      active = false;
    };
  }, [step]);

  const createOrg = async (e: FormEvent) => {
    e.preventDefault();
    if (!orgName.trim()) {
      setError('Organization name is required');
      return;
    }
    setLoading(true);
    setError(null);
    const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const res = await authClient.organization.create({ name: orgName, slug });
    if (res.error) {
      setLoading(false);
      setError(res.error.message ?? 'Failed to create organization');
      return;
    }
    const newId = res.data?.id;
    if (newId) {
      await authClient.organization.setActive({ organizationId: newId }).catch(() => {});
      setOrgId(newId);
    }
    // Complimentary orgs (company-domain owner) are paid the moment the org exists —
    // skip the pay step entirely.
    const statusRes = await fetchCp<{ paid: boolean }>('/api/cp/billing/status');
    setLoading(false);
    if (statusRes.ok && statusRes.data.paid) {
      router.replace('/onboarding/connect');
      return;
    }
    setStep('choose');
  };

  const buyPack = async (packId: string) => {
    setLoading(true);
    setError(null);
    const res = await cpPost<{ url: string }>('/api/cp/billing/credit-pack', {
      packId,
      returnPath: '/onboarding?step=confirming',
    });
    if (!res.ok) {
      setLoading(false);
      setError(billingMessage(res.error));
      return;
    }
    window.location.assign(res.data.url);
  };

  const subscribe = async (plan: 'pro') => {
    if (!orgId) {
      setError('No active organization to bill.');
      return;
    }
    setLoading(true);
    setError(null);
    const origin = window.location.origin;
    try {
      const res = (await authClient.subscription.upgrade({
        plan,
        referenceId: orgId,
        successUrl: `${origin}/onboarding?step=confirming`,
        cancelUrl: `${origin}/onboarding?step=choose`,
      })) as unknown as { data?: { url?: string }; error?: { message?: string } };
      if (res?.error) {
        setLoading(false);
        setError(billingMessage(res.error.message ?? 'subscription'));
        return;
      }
      // Some plugin versions auto-redirect; others return a url to follow.
      if (res?.data?.url) window.location.assign(res.data.url);
    } catch (e) {
      setLoading(false);
      setError(e instanceof Error ? e.message : 'Could not start checkout');
    }
  };

  // Confirming: poll the paid status (webhook grants asynchronously). ~2s × 15 = 30s.
  // `pollKey` lets "Check again" restart the loop after a timeout.
  const [timedOut, setTimedOut] = useState(false);
  const [pollKey, setPollKey] = useState(0);
  const checkPaid = useCallback(async () => {
    const res = await fetchCp<{ paid: boolean }>('/api/cp/billing/status');
    return res.ok && res.data.paid;
  }, []);
  useEffect(() => {
    if (step !== 'confirming') return;
    let active = true;
    let attempts = 0;
    setTimedOut(false);
    const tick = async () => {
      if (!active) return;
      attempts += 1;
      if (await checkPaid()) {
        // Paid → straight into the guided connect wizard (the "aha" flow), not a bare dashboard.
        router.replace('/onboarding/connect');
        return;
      }
      if (attempts >= 15) {
        setTimedOut(true);
        return;
      }
      setTimeout(() => void tick(), 2000);
    };
    void tick();
    return () => {
      active = false;
    };
  }, [step, pollKey, checkPaid, router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="flex w-full max-w-lg flex-col gap-6">
        <div className="text-center">
          <span className="font-mono text-xl font-bold text-primary">waddling</span>
          <p className="mt-1 text-sm text-muted-foreground">Set up billing to get started</p>
        </div>

        {step === 'org' && (
          <Card>
            <CardHeader>
              <CardTitle>Create your organization</CardTitle>
              <CardDescription>
                Organizations group your data lakes, agents, and team. You&apos;ll set up billing
                next.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={(e) => void createOrg(e)}>
                <FieldGroup className="gap-4">
                  <Field>
                    <FieldLabel htmlFor="org-name">Organization name</FieldLabel>
                    <Input
                      id="org-name"
                      value={orgName}
                      onChange={(e) => setOrgName(e.target.value)}
                      required
                      placeholder="Acme Corp"
                    />
                  </Field>
                  {error ? (
                    <Alert variant="destructive">
                      <AlertTitle>Could not create organization</AlertTitle>
                      <AlertDescription>{error}</AlertDescription>
                    </Alert>
                  ) : null}
                  <Button type="submit" disabled={loading} className="w-full">
                    {loading ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
                    Continue to billing
                  </Button>
                </FieldGroup>
              </form>
            </CardContent>
          </Card>
        )}

        {step === 'choose' && (
          <>
            {error ? (
              <Alert variant="destructive">
                <AlertTitle>Checkout could not start</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle>Subscribe</CardTitle>
                <CardDescription>
                  A monthly plan with included usage and higher limits.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  className="w-full"
                  disabled={loading}
                  onClick={() => void subscribe('pro')}
                >
                  {loading ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
                  Subscribe to Pro
                </Button>
                <p className="mt-3 text-center text-xs text-muted-foreground">
                  Need Enterprise?{' '}
                  <a href="mailto:sales@getwaddling.com" className="text-primary hover:underline">
                    Contact sales
                  </a>
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Or buy credits</CardTitle>
                <CardDescription>
                  Prepaid, pay-as-you-go. Credits are drawn down as your agents run.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {packs === null ? (
                  <div className="flex justify-center py-4">
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                  </div>
                ) : packs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Credit packs aren&apos;t available yet — use a subscription above.
                  </p>
                ) : (
                  <div className="grid grid-cols-3 gap-3">
                    {packs.map((p) => (
                      <Button
                        key={p.id}
                        variant="outline"
                        disabled={loading}
                        onClick={() => void buyPack(p.id)}
                      >
                        ${p.usd}
                      </Button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}

        {step === 'confirming' && (
          <Card>
            <CardHeader>
              <CardTitle>Confirming your payment…</CardTitle>
              <CardDescription>
                This takes a few seconds while we process your payment.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {timedOut ? (
                <div className="flex flex-col gap-3">
                  <Alert>
                    <AlertTitle>Taking longer than expected</AlertTitle>
                    <AlertDescription>
                      If you completed payment, it should arrive shortly. You can check again, or
                      contact{' '}
                      <a href="mailto:support@getwaddling.com" className="text-primary hover:underline">
                        support
                      </a>
                      .
                    </AlertDescription>
                  </Alert>
                  <Button onClick={() => setPollKey((k) => k + 1)}>Check again</Button>
                </div>
              ) : (
                <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" />
                  Waiting for confirmation…
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
