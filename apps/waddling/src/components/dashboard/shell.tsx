'use client';

import {
  type ReactNode,
  Fragment,
  useEffect,
  useState,
  useRef,
  useCallback,
} from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Building2,
  Database,
  Plus,
  Check,
  LogOut,
  Settings,
  CreditCard,
  Plug,
  Home,
  Bot,
  LayoutGrid,
  Users,
  Search,
  ChevronRight,
  Sun,
  Moon,
  Monitor,
  User,
  Palette,
} from 'lucide-react';
import { useTheme } from 'fumadocs-ui/provider/base';
import { authClient } from '@/lib/auth-client';
import { DataLakeIcon } from '@/components/data-lake-icon';
import { BrandMark } from '@/components/brand-mark';
import { fetchCp } from '@/components/dashboard/fetch';
import { BreadcrumbProvider, useBreadcrumbOverrides } from '@/components/dashboard/breadcrumb-context';
import {
  ConnectAgentProvider,
  useConnectAgent,
} from '@/components/waddling/connect-agent-dialog';
import { StatusDot } from '@/components/waddling/status-dot';
import { agentSemanticStatus } from '@/components/waddling/agent-status';
import {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
} from '@/components/ui/command';
import type { AgentSummary, DatalakeSummary as DatalakeSummaryType } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
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

// Primary nav — the redesigned simplified surface (Home/Agents/Data/Quackboard/
// Team/Settings). Billing + Account live in the user menu; "Connect" is the header
// action (opens the connect-agent modal). Operational surfaces (sessions/audit/
// usage/acl/connected/notebooks/views) remain reachable by URL but are folded out
// of the sidebar per the new information architecture.
const NAV_ITEMS = [
  { href: '/dashboard',  label: 'Home',       icon: Home },
  { href: '/agents',     label: 'Agents',     icon: Bot },
  { href: '/datalakes',  label: 'Data',       icon: DataLakeIcon },
  { href: '/quackboard', label: 'Quackboard', icon: LayoutGrid },
  { href: '/team',       label: 'Team',       icon: Users },
  { href: '/settings',   label: 'Settings',   icon: Settings },
] as const;

const SEGMENT_LABELS: Record<string, string> = {
  dashboard: 'Home',
  datalakes: 'Data',
  quackboard: 'Quackboard',
  agents: 'Agents',
  connected: 'Connected agents',
  acl: 'Access',
  sessions: 'Sessions',
  audit: 'Audit',
  usage: 'Usage',
  notebooks: 'Notebooks',
  views: 'Views',
  billing: 'Billing',
  team: 'Team',
  settings: 'Settings',
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="User menu"
          className="flex shrink-0 items-center rounded-md outline-none ring-offset-background transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:ring-2 data-[state=open]:ring-ring"
        >
          <Avatar className="size-8 rounded-md after:rounded-md">
            {user.image ? (
              <AvatarImage
                src={user.image}
                alt={user.name}
                className="rounded-md"
              />
            ) : null}
            <AvatarFallback className="rounded-md">{initial}</AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom" sideOffset={8} className="min-w-56">
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span className="truncate font-medium">{user.name}</span>
              <span className="truncate text-xs font-normal text-muted-foreground">
                {user.email}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem asChild>
                <Link href="/settings?tab=account">
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
                    <Link href="/settings?tab=organization">
                      <Settings data-icon="inline-start" />
                      Organization settings
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/settings?tab=organization&create=org">
                      <Plus data-icon="inline-start" />
                      Create organization
                    </Link>
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem asChild>
                <Link href="/settings?tab=billing">
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
  );
}

function AppSidebar() {
  const pathname = usePathname();
  const { state } = useSidebar();
  const collapsed = state === 'collapsed';
  return (
    <Sidebar
      collapsible="icon"
      className="top-(--header-height) !h-[calc(100svh-var(--header-height))] [--dl-gap:var(--sidebar)]"
    >
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => {
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
      </SidebarContent>
      <SidebarFooter className={cn('flex', collapsed ? 'items-center' : 'items-start')}>
        <SidebarTrigger className="shrink-0" />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}


function Breadcrumbs({ pathname }: { pathname: string }) {
  const overrides = useBreadcrumbOverrides();
  const segments = pathname.split('/').filter(Boolean);
  const crumbs = segments.map((seg, i) => ({
    href: '/' + segments.slice(0, i + 1).join('/'),
    label: overrides[seg] ?? SEGMENT_LABELS[seg] ?? seg,
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

// ── Command palette (⌘K) ──────────────────────────────────────────────────────

function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const router = useRouter();
  const { openConnect } = useConnectAgent();
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [lakes, setLakes] = useState<DatalakeSummaryType[] | null>(null);
  const dataLoadedRef = useRef(false);

  useEffect(() => {
    if (!open || dataLoadedRef.current) return;
    let cancelled = false;
    async function load() {
      const [agentsRes, lakesRes] = await Promise.all([
        fetchCp<{ agents: AgentSummary[] }>('/api/cp/agents'),
        fetchCp<{ datalakes: DatalakeSummaryType[] }>('/api/cp/datalakes'),
      ]);
      if (cancelled) return;
      dataLoadedRef.current = true;
      if (agentsRes.ok) setAgents(agentsRes.data.agents);
      if (lakesRes.ok) setLakes(lakesRes.data.datalakes);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const run = useCallback(
    (href: string) => {
      onOpenChange(false);
      router.push(href);
    },
    [router, onOpenChange],
  );

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <Command>
      <CommandInput placeholder="Search agents, lakes, actions…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {agents && agents.length > 0 && (
          <CommandGroup heading="Agents">
            {agents.map((agent) => (
              <CommandItem
                key={agent.id}
                value={'agent ' + agent.name + ' ' + (agent.description ?? '')}
                onSelect={() => run('/agents/' + agent.id)}
              >
                <StatusDot status={agentSemanticStatus(agent)} decorative className="mr-2" />
                <span>{agent.name}</span>
                {agent.description && (
                  <span className="ml-2 truncate text-xs text-muted-foreground">
                    {agent.description}
                  </span>
                )}
                <CommandShortcut>
                  <ChevronRight className="size-3 opacity-40" aria-hidden="true" />
                </CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {lakes && lakes.length > 0 && (
          <CommandGroup heading="Data lakes">
            {lakes.map((lake) => (
              <CommandItem
                key={lake.id}
                value={'lake ' + lake.name + ' ' + lake.slug}
                onSelect={() => run('/datalakes/' + lake.id)}
              >
                <Database className="mr-2 size-4" aria-hidden="true" />
                <span>{lake.name}</span>
                <span className="ml-2 truncate text-xs text-muted-foreground">{lake.slug}</span>
                <CommandShortcut>
                  <ChevronRight className="size-3 opacity-40" aria-hidden="true" />
                </CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandGroup heading="Navigation">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <CommandItem
                key={item.href}
                value={'go ' + item.label}
                onSelect={() => run(item.href)}
              >
                <Icon className="mr-2 size-4" aria-hidden="true" />
                {item.label}
              </CommandItem>
            );
          })}
        </CommandGroup>

        <CommandGroup heading="Actions">
          <CommandItem
            value="connect an agent"
            onSelect={() => {
              onOpenChange(false);
              openConnect();
            }}
          >
            <Plug className="mr-2 size-4" aria-hidden="true" />
            Connect an agent
          </CommandItem>
        </CommandGroup>
      </CommandList>
      </Command>
    </CommandDialog>
  );
}

// ── Header connect button (inside ConnectAgentProvider) ───────────────────────

function ConnectButton() {
  const { openConnect } = useConnectAgent();
  return (
    <Button size="sm" onClick={() => openConnect()}>
      <Plug data-icon="inline-start" />
      <span className="hidden sm:inline">Connect</span>
    </Button>
  );
}

function DashboardShellInner({
  user,
  activeOrgId,
  children,
}: {
  user: UserInfo;
  activeOrgId?: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [cmdOpen, setCmdOpen] = useState(false);

  // ⌘K / Ctrl+K toggles the palette. Capture phase + stopImmediatePropagation so
  // the app shell owns ⌘K wherever it is mounted (the root fumadocs provider also
  // binds ⌘K for docs search).
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setCmdOpen((v) => !v);
      }
    }
    document.addEventListener('keydown', handleKey, { capture: true });
    return () => document.removeEventListener('keydown', handleKey, { capture: true });
  }, []);

  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <header className="sticky top-0 z-50 flex h-(--header-height) shrink-0 items-center gap-2 border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <Link href="/dashboard" className="flex shrink-0 items-center">
            <BrandMark align="center" />
          </Link>
          <div className="w-px shrink-0 self-stretch bg-border" aria-hidden="true" />
          <div className="min-w-0 flex-1 overflow-hidden">
            <Breadcrumbs pathname={pathname} />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => setCmdOpen(true)}
              aria-label="Open command palette (⌘K)"
              className="flex h-8 items-center gap-2 rounded-lg border bg-muted/50 px-3 text-xs text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Search className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="hidden sm:inline">Search…</span>
              <kbd
                className="pointer-events-none ml-1 hidden h-5 items-center gap-0.5 rounded border bg-background px-1.5 font-mono text-[10px] font-medium sm:flex"
                aria-hidden="true"
              >
                ⌘K
              </kbd>
            </button>
            <ConnectButton />
            <UserMenu user={user} activeOrgId={activeOrgId} />
          </div>
        </header>
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset className="min-w-0">
            <div className="flex min-w-0 flex-1 flex-col gap-4 p-6">{children}</div>
          </SidebarInset>
        </div>
      </SidebarProvider>
      <CommandPalette open={cmdOpen} onOpenChange={setCmdOpen} />
    </div>
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
  return (
    <TooltipProvider delayDuration={200}>
      <BreadcrumbProvider>
        <ConnectAgentProvider>
          <DashboardShellInner user={user} activeOrgId={activeOrgId}>
            {children}
          </DashboardShellInner>
        </ConnectAgentProvider>
      </BreadcrumbProvider>
      <Toaster />
    </TooltipProvider>
  );
}
