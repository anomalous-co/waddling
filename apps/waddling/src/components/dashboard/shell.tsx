'use client';

import { type ReactNode, Fragment, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Building2,
  ChevronsUpDown,
  Database,
  Plus,
  Check,
  LogOut,
  Settings,
  CreditCard,
  Plug,
  LayoutDashboard,
  Bot,
  ShieldCheck,
  Radio,
  ScrollText,
  BarChart3,
  NotebookText,
  Table2,
  Sun,
  Moon,
  Monitor,
  User,
  Palette,
  Link2,
} from 'lucide-react';
import { useTheme } from 'fumadocs-ui/provider/base';
import { authClient } from '@/lib/auth-client';
import { DataLakeIcon } from '@/components/data-lake-icon';
import { BrandMark } from '@/components/brand-mark';
import { fetchCp } from '@/components/dashboard/fetch';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuGroup,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';

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

interface DatalakeSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
}

// Grouped primary nav. Billing + Settings live in the user menu; the onboarding
// flow is the header "Connect" action.
const NAV_GROUPS = [
  {
    label: 'Platform',
    items: [
      { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
      { href: '/dashboard/datalakes', label: 'Data Lakes', icon: DataLakeIcon },
      { href: '/dashboard/agents', label: 'Agents', icon: Bot },
      { href: '/dashboard/connected', label: 'Connected', icon: Link2 },
      { href: '/dashboard/acl', label: 'Access', icon: ShieldCheck },
    ],
  },
  {
    label: 'Operations',
    items: [
      { href: '/dashboard/sessions', label: 'Sessions', icon: Radio },
      { href: '/dashboard/audit', label: 'Audit', icon: ScrollText },
      { href: '/dashboard/usage', label: 'Usage', icon: BarChart3 },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { href: '/dashboard/notebooks', label: 'Notebooks', icon: NotebookText },
      { href: '/dashboard/views', label: 'Views', icon: Table2 },
    ],
  },
] as const;

const SEGMENT_LABELS: Record<string, string> = {
  dashboard: 'Overview',
  datalakes: 'Data Lakes',
  agents: 'Agents',
  connected: 'Connected agents',
  acl: 'Access',
  sessions: 'Sessions',
  audit: 'Audit',
  usage: 'Usage',
  notebooks: 'Notebooks',
  views: 'Views',
  billing: 'Billing',
  settings: 'Organization',
  account: 'Account',
  onboarding: 'Connect',
  new: 'New',
};

function isActive(pathname: string, href: string): boolean {
  return href === '/dashboard'
    ? pathname === '/dashboard'
    : pathname.startsWith(href);
}

function UserMenu({
  user,
  activeOrgId,
}: {
  user: UserInfo;
  activeOrgId?: string;
}) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [activeOrg, setActiveOrg] = useState<Org | null>(null);

  useEffect(() => {
    let cancelled = false;
    void authClient.organization.list().then((res) => {
      if (cancelled) return;
      const list = (res.data ?? []) as Org[];
      setOrgs(list);
      const found = activeOrgId
        ? list.find((o) => o.id === activeOrgId)
        : undefined;
      setActiveOrg(found ?? list[0] ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [activeOrgId]);

  const switchOrg = async (org: Org) => {
    await authClient.organization.setActive({ organizationId: org.id });
    window.location.assign('/dashboard');
  };

  const signOut = async () => {
    await authClient.signOut();
    router.push('/sign-in');
  };
  const initial = (user.name || user.email).charAt(0).toUpperCase();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent"
            >
              <Avatar className="size-8 rounded-md">
                {user.image ? (
                  <AvatarImage
                    src={user.image}
                    alt={user.name}
                    className="rounded-md"
                  />
                ) : null}
                <AvatarFallback className="rounded-md">{initial}</AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate font-semibold">{user.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {user.email}
                </span>
              </div>
              <ChevronsUpDown className="ml-auto text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            side="top"
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
          >
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span className="truncate font-medium">{user.name}</span>
              <span className="truncate text-xs font-normal text-muted-foreground">
                {user.email}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem asChild>
                <Link href="/dashboard/account">
                  <User data-icon="inline-start" />
                  Account
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Building2 data-icon="inline-start" />
                  Organization
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {orgs.map((org) => (
                    <DropdownMenuItem
                      key={org.id}
                      onClick={() => void switchOrg(org)}
                    >
                      <Building2 data-icon="inline-start" />
                      <span className="truncate">{org.name}</span>
                      {org.id === activeOrg?.id ? (
                        <Check data-icon="inline-end" className="ml-auto" />
                      ) : null}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link href="/dashboard/settings">
                      <Settings data-icon="inline-start" />
                      Organization settings
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/dashboard/settings?create=org">
                      <Plus data-icon="inline-start" />
                      Create organization
                    </Link>
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem asChild>
                <Link href="/dashboard/billing">
                  <CreditCard data-icon="inline-start" />
                  Billing
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Palette data-icon="inline-start" />
                  Theme
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    value={mounted ? (theme ?? 'system') : undefined}
                    onValueChange={setTheme}
                  >
                    <DropdownMenuRadioItem value="light">
                      <Sun data-icon="inline-start" />
                      Light
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="dark">
                      <Moon data-icon="inline-start" />
                      Dark
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="system">
                      <Monitor data-icon="inline-start" />
                      System
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void signOut()}>
              <LogOut data-icon="inline-start" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function AppSidebar({
  user,
  activeOrgId,
}: {
  user: UserInfo;
  activeOrgId?: string;
}) {
  const pathname = usePathname();
  return (
    <Sidebar
      collapsible="icon"
      className="top-(--header-height) !h-[calc(100svh-var(--header-height))] [--dl-gap:var(--sidebar)]"
    >
      <SidebarContent>
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild
                        isActive={isActive(pathname, item.href)}
                        tooltip={item.label}
                      >
                        <Link href={item.href}>
                          <Icon />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <UserMenu user={user} activeOrgId={activeOrgId} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function DatalakeSwitcher() {
  const router = useRouter();
  const [datalakes, setDatalakes] = useState<DatalakeSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    void fetchCp<{ datalakes: DatalakeSummary[] }>('/api/cp/datalakes').then(
      (res) => {
        if (!cancelled && res.ok) setDatalakes(res.data.datalakes ?? []);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Database data-icon="inline-start" />
          <span className="hidden max-w-32 truncate sm:inline">
            {datalakes.length
              ? `${datalakes.length} data lakes`
              : 'Data lakes'}
          </span>
          <ChevronsUpDown data-icon="inline-end" className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Data lakes</DropdownMenuLabel>
        <DropdownMenuGroup>
          {datalakes.map((dl) => (
            <DropdownMenuItem
              key={dl.id}
              onClick={() => router.push(`/dashboard/datalakes/${dl.id}`)}
            >
              <span
                className={cn(
                  'size-2 rounded-full',
                  dl.status === 'running' ? 'bg-green-500' : 'bg-muted-foreground',
                )}
              />
              <span className="truncate">{dl.name}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {dl.status}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/dashboard/datalakes/new">
            <Plus data-icon="inline-start" />
            New data lake
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Breadcrumbs({ pathname }: { pathname: string }) {
  const segments = pathname.split('/').filter(Boolean);
  const crumbs = segments.map((seg, i) => ({
    href: '/' + segments.slice(0, i + 1).join('/'),
    label: SEGMENT_LABELS[seg] ?? seg,
    last: i === segments.length - 1,
  }));

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((c) => (
          <Fragment key={c.href}>
            <BreadcrumbItem>
              {c.last ? (
                <BreadcrumbPage>{c.label}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild>
                  <Link href={c.href}>{c.label}</Link>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
            {c.last ? null : <BreadcrumbSeparator />}
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
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
  const pathname = usePathname();

  return (
    <TooltipProvider delayDuration={200}>
      <div className="[--header-height:calc(--spacing(14))]">
        <SidebarProvider className="flex flex-col">
          <header className="sticky top-0 z-50 flex h-(--header-height) shrink-0 items-center gap-2 border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60">
            <Link href="/dashboard" className="flex shrink-0 items-center">
              <BrandMark
                align="center"
              />
            </Link>
            <Separator orientation="vertical" className="mr-1 h-4 shrink-0" />
            <SidebarTrigger className="-ml-1 shrink-0" />
            <Separator orientation="vertical" className="mr-1 h-4 shrink-0" />
            <div className="min-w-0 flex-1 overflow-hidden">
              <Breadcrumbs pathname={pathname} />
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <DatalakeSwitcher />
              <Button asChild size="sm">
                <Link href="/dashboard/onboarding">
                  <Plug data-icon="inline-start" />
                  <span className="hidden sm:inline">Connect</span>
                </Link>
              </Button>
            </div>
          </header>
          <div className="flex flex-1">
            <AppSidebar user={user} activeOrgId={activeOrgId} />
            <SidebarInset className="min-w-0">
              <div className="flex min-w-0 flex-1 flex-col gap-4 p-6">
                {children}
              </div>
            </SidebarInset>
          </div>
        </SidebarProvider>
      </div>
      <Toaster />
    </TooltipProvider>
  );
}
