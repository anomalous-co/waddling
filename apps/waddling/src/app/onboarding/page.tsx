import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getServerSession, getPaidStatus, listOrgs } from '@/lib/control-api-server';
import { OnboardingFlow } from '@/components/onboarding/onboarding-flow';
import { safeNextPath } from '@/lib/utils';

/**
 * Forced payment-onboarding step. Lives OUTSIDE the (dashboard) route group so the
 * dashboard paid-gate (which redirects here) cannot loop back onto it. Auth-only guard;
 * if the org has already paid, send them straight to the dashboard (loop safety).
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // A validated same-origin return target threaded through the MCP device-link funnel:
  // once onboarding is satisfied the user is sent back to `next` (the /link claim) rather
  // than the connect wizard, closing the loop the agent is polling on.
  const nextTarget = safeNextPath((await searchParams).next);

  const session = await getServerSession();
  if (!session) {
    const self = `/onboarding${nextTarget ? `?next=${encodeURIComponent(nextTarget)}` : ''}`;
    redirect(`/sign-in?next=${encodeURIComponent(self)}`);
  }

  // Already paid (incl. comped orgs and active trials)? The payment step is done — send an
  // MCP-funnel user back to their `next` (device-link claim); otherwise carry them into the
  // guided connect wizard. The wizard is non-blocking and resumes from backend state, so a
  // returning user just lands on whatever step they're up to (or its "you're set" finish).
  const status = await getPaidStatus();
  if (status.paid) redirect(nextTarget ?? '/onboarding/connect');

  const rawSession = session.session as Record<string, unknown>;
  let initialOrgId =
    typeof rawSession.activeOrganizationId === 'string'
      ? rawSession.activeOrganizationId
      : undefined;
  // Org creation happens HERE (the OnboardingFlow 'org' step), not at sign-up — so a
  // freshly-verified user arrives with no org and activeOrganizationId unset. For a user
  // who already has an org (returning, or just created one) fall back to the first
  // membership so the Subscribe button has a referenceId (credit-pack + the gate already
  // use the server-side membership fallback in resolveCaller).
  if (!initialOrgId && status.hasOrg) {
    const orgs = await listOrgs();
    initialOrgId = orgs[0]?.id;
  }

  // OnboardingFlow reads useSearchParams → needs a Suspense boundary in the app router.
  return (
    <Suspense fallback={null}>
      <OnboardingFlow hasOrg={status.hasOrg} initialOrgId={initialOrgId} />
    </Suspense>
  );
}
