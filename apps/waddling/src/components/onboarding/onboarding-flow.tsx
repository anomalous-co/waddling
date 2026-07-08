'use client';

/**
 * Forced payment-onboarding step ("must pay to enter"). Rendered full-screen by
 * app/onboarding (OUTSIDE the dashboard route group, so the dashboard paid-gate cannot
 * loop back onto it). A small state machine: org → choose → confirming.
 *
 *  - org:        create the first org (when the user has none). Reuses the sign-up
 *                org form pattern; never routes to /dashboard.
 *  - choose:     subscribe to a plan. Starts a Stripe Checkout and returns to
 *                ?step=confirming.
 *  - confirming: Stripe's success redirect lands here. The subscription is granted
 *                ASYNCHRONOUSLY by the webhook, NOT the redirect — so poll the paid
 *                status until true, then enter the dashboard.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { safeNextPath } from '@/lib/utils';
import { fetchCp } from '@/components/dashboard/fetch';
import { BrandMark } from '@/components/brand-mark';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Field, FieldLabel, FieldGroup } from '@/components/ui/field';

type Step = 'org' | 'choose' | 'confirming';

/** Map control-api error codes to onboarding-friendly copy. */
function billingMessage(code: string): string {
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

  // Validated same-origin return target from the MCP device-link funnel. When set, a
  // completed onboarding forwards HERE (the /link claim) instead of the connect wizard —
  // the wizard mints a competing agent key + re-teaches what the device-link already does,
  // so an MCP user who came to connect a specific agent goes straight back to finish that.
  const nextTarget = safeNextPath(params.get('next'));
  const nextParam = nextTarget ? `&next=${encodeURIComponent(nextTarget)}` : '';
  const afterOnboarding = nextTarget ?? '/onboarding/connect';

  const [step, setStep] = useState<Step>(initialStep);
  const [orgId, setOrgId] = useState<string | undefined>(initialOrgId);
  const [orgName, setOrgName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      // The no-card trial (set at org-create) makes billing/status.paid true immediately,
      // so a fresh org lands here — forward to the funnel target or the connect wizard.
      router.replace(afterOnboarding);
      return;
    }
    setStep('choose');
  };

  const subscribe = async (plan: 'pro' | 'max' | 'scale') => {
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
        // Org-scoped customer (matches the embedded billing flow), so an org has one
        // Stripe customer across hosted + embedded checkout — no duplicate subscriptions.
        customerType: 'organization',
        successUrl: `${origin}/onboarding?step=confirming${nextParam}`,
        cancelUrl: `${origin}/onboarding?step=choose${nextParam}`,
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
        // Paid → the funnel target (MCP device-link claim) if present, else straight into
        // the guided connect wizard (the "aha" flow), not a bare dashboard.
        router.replace(afterOnboarding);
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
          <BrandMark />
          <p className="mt-1 text-sm text-muted-foreground">
            Start your 7-day free trial — no credit card required
          </p>
        </div>

        {step === 'org' && (
          <Card>
            <CardHeader>
              <CardTitle>Create your organization</CardTitle>
              <CardDescription>
                Organizations group your data lakes, agents, and team. Your 7-day free trial
                starts right away — full Pro access, no card required.
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
                    Start free trial
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

            <Card className="border-emerald-500/50">
              <CardHeader>
                <CardTitle>Choose your plan</CardTitle>
                <CardDescription>
                  Pro — $29/mo: 3 users, 2 data lakes, 50 GB storage, 25 included compute-hours,
                  and dynamic per-agent access control. Flat base + metered usage; cancel anytime.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  className="w-full"
                  disabled={loading}
                  onClick={() => void subscribe('pro')}
                >
                  {loading ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
                  Continue on Pro — $29/mo
                </Button>
                <p className="mt-3 text-center text-xs text-muted-foreground">
                  Need more?{' '}
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => void subscribe('max')}
                    className="text-primary hover:underline disabled:opacity-50"
                  >
                    Max ($99/mo)
                  </button>
                  {' · '}
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => void subscribe('scale')}
                    className="text-primary hover:underline disabled:opacity-50"
                  >
                    Scale ($299/mo)
                  </button>
                  {' · '}
                  <a href="mailto:sales@getwaddling.com" className="text-primary hover:underline">
                    Contact sales
                  </a>
                </p>
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
