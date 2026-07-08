/**
 * /link — device-code claim page (FUNNEL / Stream B, self-contained).
 *
 * Server component. The onboarding agent shows the human this URL with ?code=…
 * prefilled. This is the endpoint of the MCP signup funnel: an agent that boots
 * unlinked hands its human this link, so we MUST guarantee the human ends up with
 * an account AND an onboarded org before the agent can claim a key. Flow:
 *   - no session         → /sign-in?next=/link?code=…  (sign-in/sign-up carry `next`)
 *   - signed in, no org  → /onboarding?next=/link?code=…  (create org + start trial,
 *                          then onboarding forwards BACK here to claim)
 *   - signed in, has org → render the claim form (pick org, name the agent)
 *
 * Does NOT import or edit any dashboard files — the user's orgs come from the
 * control-api auth plane (Better Auth organization/list). Styling mirrors the
 * sign-in page.
 */
import { redirect } from 'next/navigation';
import { getServerSession, listOrgs } from '@/lib/control-api-server';
import { ClaimForm } from './claim-form';

export default async function LinkPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code = '' } = await searchParams;
  const self = `/link${code ? `?code=${encodeURIComponent(code)}` : ''}`;

  // Session + org list come from the control-api auth plane (inbound cookie
  // forwarded); this render plane holds no DB binding of its own.
  const session = await getServerSession();

  if (!session?.user) {
    redirect(`/sign-in?next=${encodeURIComponent(self)}`);
  }

  // No org yet → route through the SAME onboarding gate every new customer hits (org
  // creation + 7-day trial), threading this page as the return target so onboarding
  // forwards the human back here to finish connecting their agent. Previously this
  // dead-ended at the dashboard, letting an MCP user skip onboarding entirely.
  const orgs = await listOrgs();
  if (orgs.length === 0) {
    redirect(`/onboarding?next=${encodeURIComponent(self)}`);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="text-center">
          <span className="font-mono text-xl font-bold text-primary">waddling</span>
          <p className="mt-1 text-sm text-muted-foreground">Connect your agent</p>
        </div>

        <ClaimForm initialCode={code} orgs={orgs} />

        <p className="text-center text-xs text-muted-foreground">
          Signed in as {session.user.email}
        </p>
      </div>
    </div>
  );
}
