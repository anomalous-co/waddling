'use client';

/**
 * Embedded subscription upgrade — Stripe Payment Element in a dialog.
 *
 * Flow: on open, POST /api/cp/billing/subscription-checkout creates an unconfirmed
 * Stripe subscription and returns a client secret. Trials are now LOCAL (no Stripe
 * subscription, no card at signup), so checkout returns a PaymentIntent (type:'payment')
 * for a real charged subscription — this dialog is the free/trial → paid conversion. We
 * mount <Elements> with that secret and confirm it in-page — no redirect to hosted
 * Checkout. On success the plugin's webhook writes the `subscription` row asynchronously,
 * so we poll GET /api/cp/billing until the entitlements land before declaring success.
 *
 * A type:'setup' (SetupIntent) fallback is retained harmlessly in case the server ever
 * hands one back. Cancel / plan-switch live in the manage-subscription dialog.
 */
import { useCallback, useEffect, useState } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import type { Appearance } from '@stripe/stripe-js';
import { Loader2 } from 'lucide-react';
import { getStripe } from '@/lib/stripe';
import { fetchCp, cpPost } from '@/components/dashboard/fetch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';

type UpgradePlan = 'pro' | 'max' | 'scale';

const PLAN_LABEL: Record<UpgradePlan, string> = { pro: 'Pro', max: 'Max', scale: 'Scale' };
const PLAN_PRICE: Record<UpgradePlan, string> = {
  pro: '$29 / mo',
  max: '$99 / mo',
  scale: '$299 / mo',
};

const stripePromise = getStripe();

interface IntentInfo {
  type: 'payment' | 'setup';
  clientSecret: string;
}

/** Poll billing until the subscription reconciles active/trialing (webhook is async). */
async function waitForActiveSubscription(attempts = 15, delayMs = 2000): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    const res = await fetchCp<{ subscription: { status: string | null } | null }>('/api/cp/billing');
    const status = res.ok ? res.data.subscription?.status : null;
    if (status === 'active' || status === 'trialing') return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

function CheckoutForm({
  intent,
  plan,
  onConfirmed,
}: {
  intent: IntentInfo;
  plan: UpgradePlan;
  onConfirmed: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!stripe || !elements) return;
      setSubmitting(true);
      setError(null);

      const returnUrl = `${window.location.origin}/settings?tab=billing&sub=success`;
      const confirmParams = { return_url: returnUrl };
      // Elements was mounted WITH the client secret, so confirm* infers it. redirect:
      // 'if_required' keeps most card flows in-page; SCA cards bounce to return_url.
      const result =
        intent.type === 'setup'
          ? await stripe.confirmSetup({ elements, confirmParams, redirect: 'if_required' })
          : await stripe.confirmPayment({ elements, confirmParams, redirect: 'if_required' });

      if (result.error) {
        setError(result.error.message ?? 'Payment could not be completed.');
        setSubmitting(false);
        return;
      }
      // Inline success (no redirect). Wait for the webhook to grant entitlements.
      setConfirming(true);
      await waitForActiveSubscription();
      onConfirmed();
    },
    [stripe, elements, intent.type, onConfirmed],
  );

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4">
      <PaymentElement />
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Payment failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" disabled={!stripe || submitting} className="w-full">
        {submitting ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
        {confirming
          ? 'Activating…'
          : intent.type === 'setup'
            ? `Start ${PLAN_LABEL[plan]} trial`
            : `Subscribe — ${PLAN_PRICE[plan]}`}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        {intent.type === 'setup'
          ? 'Your card is saved and charged only when the trial ends. Cancel anytime.'
          : 'Secured by Stripe. Cancel anytime from Manage subscription.'}
      </p>
    </form>
  );
}

export function UpgradeDialog({
  plan,
  onClose,
  onSuccess,
}: {
  /** The plan to subscribe to, or null when closed. */
  plan: UpgradePlan | null;
  onClose: () => void;
  onSuccess: (plan: UpgradePlan) => void;
}) {
  const [intent, setIntent] = useState<IntentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Create the (unconfirmed) subscription when the dialog opens for a plan.
  useEffect(() => {
    if (!plan) {
      setIntent(null);
      setError(null);
      return;
    }
    let active = true;
    setIntent(null);
    setError(null);
    void (async () => {
      const res = await cpPost<IntentInfo>('/api/cp/billing/subscription-checkout', { plan });
      if (!active) return;
      if (!res.ok) {
        setError(
          res.error === 'already_subscribed'
            ? 'This organization already has an active subscription.'
            : res.error === 'billing_not_configured'
              ? 'Billing is not configured for this deployment yet.'
              : res.error === 'forbidden'
                ? 'Only an organization owner or admin can manage billing.'
                : 'Could not start checkout. Please try again.',
        );
        return;
      }
      setIntent(res.data);
    })();
    return () => {
      active = false;
    };
  }, [plan]);

  const appearance: Appearance = {
    theme:
      typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
        ? 'night'
        : 'stripe',
  };

  return (
    <Dialog open={plan !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Upgrade to {plan ? PLAN_LABEL[plan] : ''}</DialogTitle>
          <DialogDescription>
            Enter your payment details to activate your subscription.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Checkout could not start</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : !intent ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
            Preparing checkout…
          </div>
        ) : (
          <Elements stripe={stripePromise} options={{ clientSecret: intent.clientSecret, appearance }}>
            <CheckoutForm intent={intent} plan={plan!} onConfirmed={() => onSuccess(plan!)} />
          </Elements>
        )}
      </DialogContent>
    </Dialog>
  );
}
