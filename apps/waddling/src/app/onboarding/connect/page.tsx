import { redirect } from 'next/navigation';
import { getServerSession, getPaidStatus } from '@/lib/control-api-server';
import { ConnectWizard } from '@/components/onboarding/connect-wizard';

/**
 * Guided "aha" onboarding — connect → install MCP → first governed query, one concept
 * at a time. A full-page flow OUTSIDE the (dashboard) route group (no dashboard shell),
 * reached right after the payment step. Non-blocking and resumable from backend state.
 *
 * Gated on paid (not just auth): an org reaches the connect wizard only after it has
 * paid, so the lake it provisions here belongs to a real, billable org.
 */
export default async function ConnectOnboardingPage() {
  const session = await getServerSession();
  if (!session) redirect('/sign-in?next=/onboarding/connect');

  const status = await getPaidStatus();
  if (!status.hasOrg) redirect('/onboarding?step=org');
  if (!status.paid) redirect('/onboarding?step=billing');

  return (
    <div className="min-h-screen bg-background px-4 py-10 sm:py-16">
      <ConnectWizard />
    </div>
  );
}
