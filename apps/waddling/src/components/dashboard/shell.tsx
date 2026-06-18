'use client';

import { type ReactNode, useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';
import { ToastProvider } from '@/components/dashboard/toast';
import { ThemeToggle } from '@/components/theme-toggle';

interface UserInfo {
  id: string;
  name: string;
  email: string;
  image?: string;
}

interface Org {
  id: string;
  name: string;
  slug: string;
}

const NAV = [
  { href: '/dashboard', label: 'Overview', icon: '◈' },
  { href: '/dashboard/endpoints', label: 'Endpoints', icon: '⬡' },
  { href: '/dashboard/agents', label: 'Agents', icon: '⬟' },
  { href: '/dashboard/acl', label: 'ACL Rules', icon: '⬗' },
  { href: '/dashboard/notebooks', label: 'Notebooks', icon: '◧' },
  { href: '/dashboard/views', label: 'Views', icon: '◫' },
  { href: '/dashboard/audit', label: 'Audit Log', icon: '◎' },
  { href: '/dashboard/usage', label: 'Usage', icon: '◑' },
  { href: '/dashboard/billing', label: 'Billing', icon: '◇' },
  { href: '/dashboard/settings', label: 'Settings', icon: '◉' },
] as const;

function OrgSwitcher({ initialActiveOrgId }: { initialActiveOrgId?: string }) {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [activeOrg, setActiveOrg] = useState<Org | null>(null);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Load org list once the switcher is opened
  const loadOrgs = () => {
    if (loaded) return;
    setLoaded(true);
    void authClient.organization
      .list()
      .then((res) => {
        const list = (res.data ?? []) as Org[];
        setOrgs(list);
        // Find the active org by the id passed from the server session
        if (initialActiveOrgId) {
          const found = list.find((o) => o.id === initialActiveOrgId);
          if (found) setActiveOrg(found);
        } else if (list.length > 0) {
          // fallback: first org
          setActiveOrg(list[0] ?? null);
        }
      });
  };

  const switchOrg = async (org: Org) => {
    await authClient.organization.setActive({ organizationId: org.id });
    setOpen(false);
    // Hard navigate so all server components + client useEffect fetches
    // re-execute with the new active org. router.refresh() only re-runs
    // server components but preserves client state, leaving stale data.
    window.location.assign('/dashboard');
  };

  // Load orgs on first render so activeOrg label is shown immediately
  useEffect(() => {
    loadOrgs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative">
      <button
        onClick={() => {
          loadOrgs();
          setOpen(!open);
        }}
        className="w-full flex items-center gap-2 px-3 py-2 rounded border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 transition-colors text-left"
      >
        <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
        <span className="text-sm text-neutral-200 truncate flex-1">
          {activeOrg?.name ?? 'Select org'}
        </span>
        <span className="text-neutral-500 text-xs">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 rounded border border-neutral-700 bg-neutral-800 shadow-lg z-20">
          {orgs.map((org) => (
            <button
              key={org.id}
              onClick={() => void switchOrg(org)}
              className={[
                'w-full text-left px-3 py-2 text-sm hover:bg-neutral-700 transition-colors',
                org.id === activeOrg?.id
                  ? 'text-neutral-100 font-medium'
                  : 'text-neutral-400',
              ].join(' ')}
            >
              {org.name}
            </button>
          ))}
          <div className="border-t border-neutral-700 px-3 py-2">
            <button
              onClick={() => {
                setOpen(false);
                window.location.assign('/dashboard/settings?create=org');
              }}
              className="text-xs text-blue-400 hover:text-blue-300 cursor-pointer"
            >
              + Create new org
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function NavItem({
  href,
  label,
  icon,
}: {
  href: string;
  label: string;
  icon: string;
}) {
  const pathname = usePathname();
  const active =
    href === '/dashboard'
      ? pathname === '/dashboard'
      : pathname.startsWith(href);

  return (
    <Link
      href={href}
      className={[
        'flex items-center gap-2.5 px-3 py-2 rounded text-sm transition-colors',
        active
          ? 'bg-neutral-800 text-neutral-100'
          : 'text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800/50',
      ].join(' ')}
    >
      <span className="w-4 text-center opacity-70">{icon}</span>
      {label}
    </Link>
  );
}

export function DashboardShell({
  user,
  activeOrgId,
  children,
}: {
  user: UserInfo;
  activeOrgId?: string;
  children: ReactNode;
}) {
  const router = useRouter();

  const signOut = async () => {
    await authClient.signOut();
    router.push('/sign-in');
  };

  return (
    <ToastProvider>
    <div className="flex min-h-screen bg-neutral-950 text-neutral-100">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 flex flex-col border-r border-neutral-800 bg-neutral-950">
        {/* Logo */}
        <div className="px-4 py-4 border-b border-neutral-800">
          <Link href="/dashboard" className="flex items-center gap-2">
            <span className="text-blue-400 font-mono font-bold text-base">
              waddling
            </span>
          </Link>
        </div>

        {/* Org switcher */}
        <div className="px-3 pt-3 pb-2">
          <OrgSwitcher initialActiveOrgId={activeOrgId} />
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-2 space-y-0.5 overflow-y-auto">
          {NAV.map((item) => (
            <NavItem key={item.href} {...item} />
          ))}
        </nav>

        {/* User footer */}
        <div className="border-t border-neutral-800 px-3 py-3">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-neutral-700 flex items-center justify-center text-xs font-medium text-neutral-300 flex-shrink-0">
              {user.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-neutral-300 truncate">
                {user.name}
              </p>
              <p className="text-xs text-neutral-600 truncate">{user.email}</p>
            </div>
            <ThemeToggle className="text-neutral-600 hover:text-neutral-300 hover:bg-neutral-800" />
            <button
              onClick={() => void signOut()}
              title="Sign out"
              className="text-neutral-600 hover:text-neutral-300 transition-colors text-xs cursor-pointer"
            >
              ⏻
            </button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-6">{children}</div>
      </main>
    </div>
    </ToastProvider>
  );
}
