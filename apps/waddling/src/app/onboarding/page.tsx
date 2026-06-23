import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getServerSession, getPaidStatus, listOrgs } from '@/lib/control-api-server';
import { OnboardingFlow } from '@/components/onboarding/onboarding-flow';

/**
 * Forced payment-onboarding step. Lives OUTSIDE the (dashboard) route group so the
 * dashboard paid-gate (which redirects here) cannot loop back onto it. Auth-only guard;
 * if the org has already paid, send them straight to the dashboard (loop safety).
 */
export default async function OnboardingPage() {
  const session = await getServerSession();
  if (!session) redirect('/sign-in?next=/onboarding');

  // Already paid (incl. comped orgs)? The payment step is done — carry them into the
  // guided connect wizard rather than skipping onboarding entirely. The wizard is
  // non-blocking and resumes from backend state, so a returning user just lands on
  // whatever step they're up to (or its "you're set" finish).
  const status = await getPaidStatus();
  if (status.paid) redirect('/onboarding/connect');

  const rawSession = session.session as Record<string, unknown>;
  let initialOrgId =
    typeof rawSession.activeOrganizationId === 'string'
      ? rawSession.activeOrganizationId
      : undefined;
  // Signup creates the org but does NOT setActive, so activeOrganizationId is often
  // unset on the billing step. Fall back to the first membership so the Subscribe
  // button has a referenceId (credit-pack + the gate already use the server-side
  // membership fallback in resolveCaller).
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
