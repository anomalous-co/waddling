import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { DashboardShell } from '@/components/dashboard/shell';
import type { ReactNode } from 'react';

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    const url = '/sign-in?next=/dashboard';
    redirect(url);
  }

  // Better Auth organization plugin stores the active org id on the session.
  // The field is `session.session.activeOrganizationId` (plugin-injected).
  // We read it here (server-side, authoritative) and pass it to the shell
  // so the client org switcher shows the correct active org immediately.
  // If the field doesn't exist in this better-auth version, activeOrgId is
  // undefined — the switcher falls back to the first org from the list API.
  const rawSession = session.session as Record<string, unknown>;
  const activeOrgId =
    typeof rawSession.activeOrganizationId === 'string'
      ? rawSession.activeOrganizationId
      : undefined;

  return (
    <DashboardShell
      user={{
        id: session.user.id,
        name: session.user.name ?? session.user.email,
        email: session.user.email,
        image: session.user.image ?? undefined,
      }}
      activeOrgId={activeOrgId}
    >
      {children}
    </DashboardShell>
  );
}
