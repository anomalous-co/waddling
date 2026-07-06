'use client';

/**
 * Manage subscription — in-app modal (no hosted Stripe portal redirect).
 *
 * Drives plan switches and cancellation for an existing subscriber. The card is
 * already on file, so upgrades are a server-side subscription-item swap (no Elements):
 * POST /api/cp/billing/subscription-change prorates against the saved card (or just
 * changes the plan during a trial). Cancel sets cancel_at_period_end. Both reconcile
 * via the plugin's webhook, so we poll billing until the change lands before closing.
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
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

type Tier = 'pro' | 'max' | 'scale';

const LABEL: Record<Tier, string> = { pro: 'Pro', max: 'Max', scale: 'Scale' };
const PRICE: Record<Tier, string> = { pro: '$29 / mo', max: '$99 / mo', scale: '$299 / mo' };
const HIGHER: Record<Tier, Tier[]> = { pro: ['max', 'scale'], max: ['scale'], scale: [] };

function mapError(code: string): string {
  if (code === 'already_on_plan') return 'You are already on that plan.';
  if (code === 'no_subscription') return 'No active subscription to change.';
  if (code === 'forbidden') return 'Only an organization owner or admin can manage billing.';
  if (code === 'billing_not_configured') return 'Billing is not configured for this deployment yet.';
  return 'Something went wrong. Please try again.';
}

/** Poll billing until the plan reconciles to `target` (webhook is async). */
async function waitForPlan(target: Tier, attempts = 12, delayMs = 1500): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    const res = await fetchCp<{ plan: { name: string } }>('/api/cp/billing');
    if (res.ok && res.data.plan.name === target) return;
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

export function ManageSubscriptionDialog({
  open,
  plan,
  status,
  periodEnd,
  onClose,
  onChanged,
}: {
  open: boolean;
  plan: Tier;
  status: string;
  periodEnd?: string;
  onClose: () => void;
  onChanged: (message: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const higher = HIGHER[plan] ?? [];
  const trialing = status === 'trialing';

  const changePlan = async (target: Tier) => {
    setBusy(target);
    setError(null);
    const res = await cpPost<{ ok: boolean }>('/api/cp/billing/subscription-change', { plan: target });
    if (!res.ok) {
      setError(mapError(res.error));
      setBusy(null);
      return;
    }
    await waitForPlan(target);
    setBusy(null);
    onChanged(`You're now on ${LABEL[target]}.`);
  };

  const cancelSub = async () => {
    setBusy('cancel');
    setError(null);
    const res = await cpPost<{ ok: boolean }>('/api/cp/billing/subscription-cancel', {});
    if (!res.ok) {
      setError(mapError(res.error));
      setBusy(null);
      return;
    }
    setBusy(null);
    onChanged('Your subscription will cancel at the end of the current period.');
  };

  const anyBusy = busy !== null;

  return (
    <Dialog open={open} onOpenChange={(o) => (!o && !anyBusy ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Manage subscription</DialogTitle>
          <DialogDescription>
            On {LABEL[plan]} ({PRICE[plan]}){status ? ` · ${status}` : ''}
            {periodEnd ? ` · renews ${new Date(periodEnd).toLocaleDateString()}` : ''}.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Could not update</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {higher.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">
                {trialing
                  ? 'Switch tiers now — no charge until your trial ends.'
                  : 'Upgrade now — you’ll be charged a prorated amount for the rest of this period.'}
              </p>
              {higher.map((target) => (
                <Button
                  key={target}
                  disabled={anyBusy}
                  onClick={() => void changePlan(target)}
                  className="w-full justify-between"
                >
                  <span>Upgrade to {LABEL[target]}</span>
                  {busy === target ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <span className="text-xs opacity-80">{PRICE[target]}</span>
                  )}
                </Button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">You&apos;re on the top self-serve tier.</p>
          )}

          <div className="border-t pt-3">
            <Button
              variant="ghost"
              disabled={anyBusy}
              onClick={() => void cancelSub()}
              className="w-full text-destructive hover:text-destructive"
            >
              {busy === 'cancel' ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
              Cancel subscription
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
