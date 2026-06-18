/**
 * /link — device-code claim page (FUNNEL / Stream B, self-contained).
 *
 * Server component. The onboarding agent shows the human this URL with ?code=…
 * prefilled. Flow:
 *   - no session         → redirect to /sign-in?next=/link?code=… (existing auth)
 *   - signed in, has org → render the claim form (pick org, name the agent)
 *   - signed in, no org  → prompt to create an org first
 *
 * Does NOT import or edit any dashboard files — orgs are read directly from the
 * Better-Auth `member`/`organization` tables. Styling mirrors the sign-in page.
 */
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { query } from '@/lib/db';
import { ClaimForm } from './claim-form';

interface OrgOption {
  id: string;
  name: string;
}

export default async function LinkPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code = '' } = await searchParams;
  const session = await auth.api.getSession({ headers: await headers() });

  if (!session?.user) {
    const next = `/link${code ? `?code=${encodeURIComponent(code)}` : ''}`;
    redirect(`/sign-in?next=${encodeURIComponent(next)}`);
  }

  // Read the user's orgs straight from Better Auth's tables (no dashboard dep).
  let orgs: OrgOption[] = [];
  try {
    const res = await query<{ id: string; name: string }>(
      `SELECT o.id, o.name
         FROM "organization" o
         JOIN "member" m ON m."organizationId" = o.id
        WHERE m."userId" = $1
        ORDER BY o.name ASC`,
      [session.user.id],
    );
    orgs = res.rows;
  } catch {
    orgs = [];
  }

  return (
    <div className="min-h-screen bg-neutral-950 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <span className="font-mono font-bold text-xl text-blue-400">waddling</span>
          <p className="text-neutral-500 text-sm mt-1">Connect your agent</p>
        </div>

        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-6">
          {orgs.length === 0 ? (
            <div className="space-y-3">
              <h1 className="text-base font-semibold text-neutral-100">
                Create an organization first
              </h1>
              <p className="text-sm text-neutral-400">
                Agents connect to an organization. Create one, then return to this
                link.
              </p>
              <a
                href="/dashboard"
                className="inline-flex items-center justify-center rounded border border-blue-500 bg-[#2563eb] px-3.5 py-1.5 text-sm font-medium text-white hover:bg-[#3b82f6]"
              >
                Go to dashboard
              </a>
            </div>
          ) : (
            <ClaimForm initialCode={code} orgs={orgs} />
          )}
        </div>

        <p className="text-center text-xs text-neutral-600 mt-4">
          Signed in as {session.user.email}
        </p>
      </div>
    </div>
  );
}
