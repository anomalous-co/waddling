/**
 * /link — device-code claim page (FUNNEL / Stream B, self-contained).
 *
 * Server component. The onboarding agent shows the human this URL with ?code=…
 * prefilled. Flow:
 *   - no session         → redirect to /sign-in?next=/link?code=… (existing auth)
 *   - signed in, has org → render the claim form (pick org, name the agent)
 *   - signed in, no org  → prompt to create an org first
 *
 * Does NOT import or edit any dashboard files — the user's orgs come from the
 * control-api auth plane (Better Auth organization/list). Styling mirrors the
 * sign-in page.
 */
import { redirect } from 'next/navigation';
import { getServerSession, listOrgs } from '@/lib/control-api-server';
import { Button } from '@/components/ui/button';
import { ClaimForm } from './claim-form';

export default async function LinkPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code = '' } = await searchParams;
  // Session + org list come from the control-api auth plane (inbound cookie
  // forwarded); this render plane holds no DB binding of its own.
  const session = await getServerSession();

  if (!session?.user) {
    const next = `/link${code ? `?code=${encodeURIComponent(code)}` : ''}`;
    redirect(`/sign-in?next=${encodeURIComponent(next)}`);
  }

  const orgs = await listOrgs();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="text-center">
          <span className="font-mono text-xl font-bold text-primary">waddling</span>
          <p className="mt-1 text-sm text-muted-foreground">Connect your agent</p>
        </div>

        {orgs.length === 0 ? (
          <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-6">
            <div className="flex flex-col gap-1.5">
              <h1 className="text-base font-semibold">Create an organization first</h1>
              <p className="text-sm text-muted-foreground">
                Agents connect to an organization. Create one, then return to this link.
              </p>
            </div>
            <Button asChild className="w-fit">
              <a href="/dashboard">Go to dashboard</a>
            </Button>
          </div>
        ) : (
          <ClaimForm initialCode={code} orgs={orgs} />
        )}

        <p className="text-center text-xs text-muted-foreground">
          Signed in as {session.user.email}
        </p>
      </div>
    </div>
  );
}
