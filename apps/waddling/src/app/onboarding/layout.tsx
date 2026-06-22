import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/control-api-server';
import type { ReactNode } from 'react';

/**
 * Onboarding shell — deliberately OUTSIDE the (dashboard) route group so the dashboard
 * paid-gate (which redirects here) can never loop back onto this page. Only gates on
 * authentication; the "must pay" decision is what this flow exists to satisfy.
 */
export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession();
  if (!session) redirect('/sign-in?next=/onboarding');
  return <>{children}</>;
}
