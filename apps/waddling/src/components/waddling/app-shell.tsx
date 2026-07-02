'use client';

import { type ReactNode, Fragment, createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Home,
  Bot,
  Database,
  Hash,
  LayoutGrid,
  Users,
  Settings,
  Building2,
  ChevronsUpDown,
  Sun,
  Moon,
  Monitor,
  User,
  Plug,
  ChevronRight,
  Search,
} from 'lucide-react';
import { useTheme } from 'fumadocs-ui/provider/base';
import { BrandMark } from '@/components/brand-mark';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
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
  useSidebar,
} from '@/components/ui/sidebar';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu';
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
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import {
  ConnectAgentProvider,
  useConnectAgent,
} from '@/components/waddling/connect-agent-dialog';
import { fetchCp } from '@/components/dashboard/fetch';
import { StatusDot } from '@/components/waddling/status-dot';
import { agentSemanticStatus } from '@/components/waddling/agent-status';
import type { AgentSummary, DatalakeSummary } from '@/lib/types';

// ── Breadcrumb title context ──────────────────────────────────────────────────

const BreadcrumbTitleContext = createContext<{
  leafTitle: string | null;
  setLeafTitle: (title: string | null) => void;
}>({ leafTitle: null, setLeafTitle: () => {} });

function BreadcrumbTitleProvider({ children }: { children: ReactNode }) {
  const [leafTitle, setLeafTitle] = useState<string | null>(null);
  return (
    <BreadcrumbTitleContext.Provider value={{ leafTitle, setLeafTitle }}>
      {children}
    </BreadcrumbTitleContext.Provider>
  );
}

/**
 * Call at the top level of a detail page to register the entity display name
 * as the leaf breadcrumb label. No-ops while `title` is undefined/null (entity
 * still loading). Clears the label on unmount so stale names never bleed
 * across navigations.
 */
export function useSetBreadcrumbTitle(title: string | null | undefined) {
  const { setLeafTitle } = useContext(BreadcrumbTitleContext);
  useEffect(() => {
    if (title == null) return;
    setLeafTitle(title);
    return () => setLeafTitle(null);
  }, [title, setLeafTitle]);
}

// ── Nav definition ────────────────────────────────────────────────────────────

const NAV_ITEMS = [
  { href: '/lab',            label: 'Home',       icon: Home },
  { href: '/lab/agents',     label: 'Agents',     icon: Bot },
  { href: '/lab/data',       label: 'Data',       icon: Database },
  { href: '/lab/quackboard', label: 'Quackboard', icon: LayoutGrid },
  { href: '/lab/team',       label: 'Team',       icon: Users },
  { href: '/lab/settings',   label: 'Settings',   icon: Settings },
] as const;

const SEGMENT_LABELS: Record<string, string> = {
  lab:        'Home',
  agents:     'Agents',
  connect:    'Connect agent',
  data:       'Data',
  quackboard: 'Quackboard',
  team:       'Team',
  settings:   'Settings',
};

// ── Static mock org / user ────────────────────────────────────────────────────

const MOCK_ORG = { id: 'org_01', name: 'Anomalous', slug: 'anomalous' };
const MOCK_USER = { name: 'M Bright', email: 'mirri@anomalous.computer' };

// ── Helpers ───────────────────────────────────────────────────────────────────

function isActive(pathname: string, href: string): boolean {
  return href === '/lab' ? pathname === '/lab' : pathname.startsWith(href);
}

// ── Breadcrumbs ───────────────────────────────────────────────────────────────

function LabBreadcrumbs({ pathname }: { pathname: string }) {
  const { leafTitle } = useContext(BreadcrumbTitleContext);
  const segments = pathname.split('/').filter(Boolean);
  const crumbs = segments.map((seg, i) => ({
    href: '/' + segments.slice(0, i + 1).join('/'),
    label: SEGMENT_LABELS[seg] ?? seg,
    last: i === segments.length - 1,
  }));

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((c, idx) => (
          <Fragment key={c.href}>
            {idx > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem>
              {c.last ? (
                <BreadcrumbPage>{leafTitle ?? c.label}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild>
                  <Link href={c.href}>{c.label}</Link>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

// ── Theme sub-menu ────────────────────────────────────────────────────────────

function ThemeSubMenu() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Monitor className="mr-2 size-4" aria-hidden="true" />
        Theme
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup
          value={mounted ? (theme ?? 'system') : undefined}
          onValueChange={setTheme}
        >
          <DropdownMenuRadioItem value="light">
            <Sun className="mr-2 size-4" aria-hidden="true" />
            Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon className="mr-2 size-4" aria-hidden="true" />
            Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor className="mr-2 size-4" aria-hidden="true" />
            System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

// ── User avatar menu ──────────────────────────────────────────────────────────

function UserAvatarMenu() {
  const initial = MOCK_USER.name.charAt(0).toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="User menu"
          className="flex shrink-0 items-center rounded-md outline-none ring-offset-background transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:ring-2 data-[state=open]:ring-ring"
        >
          <Avatar className="size-7 rounded-md after:rounded-md">
            <AvatarFallback className="rounded-md text-xs">
              {initial}
            </AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" sideOffset={8} className="min-w-52">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="truncate font-medium">{MOCK_USER.name}</span>
          <span className="truncate text-xs font-normal text-muted-foreground">
            {MOCK_USER.email}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <Link href="/lab/settings">
              <User className="mr-2 size-4" aria-hidden="true" />
              Account
            </Link>
          </DropdownMenuItem>
          <ThemeSubMenu />
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Org switcher ──────────────────────────────────────────────────────────────

function OrgSwitcher() {
  const { state } = useSidebar();
  const collapsed = state === 'collapsed';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Switch organization"
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none ring-offset-background transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring',
            collapsed && 'justify-center px-0',
          )}
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-foreground text-xs font-bold text-background">
            A
          </span>
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1 truncate font-medium">
                {MOCK_ORG.name}
              </span>
              <ChevronsUpDown
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Organizations
        </DropdownMenuLabel>
        <DropdownMenuItem disabled>
          <Building2 className="mr-2 size-4" aria-hidden="true" />
          {MOCK_ORG.name}
          <span className="ml-auto text-xs text-muted-foreground">Active</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function LabSidebar({ pathname }: { pathname: string }) {
  return (
    <Sidebar collapsible="icon">
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
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
                        <Icon aria-hidden="true" />
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

      <SidebarFooter className="gap-2 pb-3">
        <OrgSwitcher />
        <div className="flex items-center justify-between px-1">
          <SidebarTrigger
            className="size-7 shrink-0"
            aria-label="Toggle sidebar"
          />
          <UserAvatarMenu />
        </div>
      </SidebarFooter>

      {/* Rail is a redundant toggle (the footer SidebarTrigger already toggles);
          keep it as a mouse affordance but out of the tab order to avoid two
          sequential "Toggle sidebar" stops. */}
      <SidebarRail tabIndex={-1} />
    </Sidebar>
  );
}

// ── Command palette ───────────────────────────────────────────────────────────

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
  const [lakes, setLakes] = useState<DatalakeSummary[] | null>(null);
  const [qbGroups, setQbGroups] = useState<{ id: string; name: string; topicIds: string[] }[] | null>(null);
  const [qbTopics, setQbTopics] = useState<{ id: string; projectGroupId: string; name: string }[] | null>(null);
  // Tracks whether the first fetch has been initiated; prevents duplicate requests
  // across multiple opens without blocking the effect on the state values.
  const dataLoadedRef = useRef(false);

  // Fetch agents + lakes lazily when the palette first opens; cache in component
  // state so reopening is instant. Guards against setting state after unmount.
  useEffect(() => {
    if (!open || dataLoadedRef.current) return;
    let cancelled = false;

    async function load() {
      const [agentsRes, lakesRes, qbRes] = await Promise.all([
        fetchCp<{ agents: AgentSummary[] }>('/api/cp/agents'),
        fetchCp<{ datalakes: DatalakeSummary[] }>('/api/cp/datalakes'),
        fetchCp<{
          groups: { id: string; name: string; topicIds: string[] }[];
          topics: { id: string; projectGroupId: string; name: string }[];
        }>('/api/cp/quackboard/groups'),
      ]);
      if (cancelled) return;
      dataLoadedRef.current = true;
      if (agentsRes.ok) setAgents(agentsRes.data.agents);
      if (lakesRes.ok) setLakes(lakesRes.data.datalakes);
      if (qbRes.ok) {
        setQbGroups(qbRes.data.groups);
        setQbTopics(qbRes.data.topics);
      }
    }

    load();
    return () => { cancelled = true; };
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
                  value={agent.name + ' ' + (agent.description ?? '')}
                  onSelect={() => run('/lab/agents/' + agent.id)}
                >
                  <StatusDot
                    status={agentSemanticStatus(agent)}
                    decorative
                    className="mr-2"
                  />
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
                  value={lake.name + ' ' + lake.slug}
                  onSelect={() => run('/lab/data/' + lake.id)}
                >
                  <Database className="mr-2 size-4" aria-hidden="true" />
                  <span>{lake.name}</span>
                  <span className="ml-2 truncate text-xs text-muted-foreground">
                    {lake.slug}
                  </span>
                  <CommandShortcut>
                    <ChevronRight className="size-3 opacity-40" aria-hidden="true" />
                  </CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {qbTopics && qbTopics.length > 0 && (
            <CommandGroup heading="Quackboard">
              {qbTopics.map((topic) => {
                const groupName = qbGroups?.find((g) => g.id === topic.projectGroupId)?.name;
                return (
                  <CommandItem
                    key={topic.id}
                    value={'# ' + topic.name + ' ' + (groupName ?? '')}
                    onSelect={() => run('/lab/quackboard?topic=' + topic.id)}
                  >
                    <Hash className="mr-2 size-4" aria-hidden="true" />
                    <span>{topic.name}</span>
                    {groupName && (
                      <span className="ml-2 truncate text-xs text-muted-foreground">
                        {groupName}
                      </span>
                    )}
                    <CommandShortcut>
                      <ChevronRight className="size-3 opacity-40" aria-hidden="true" />
                    </CommandShortcut>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}

          <CommandGroup heading="Navigation">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <CommandItem key={item.href} onSelect={() => run(item.href)}>
                  <Icon className="mr-2 size-4" aria-hidden="true" />
                  {item.label}
                  <CommandShortcut>
                    <ChevronRight className="size-3 opacity-40" aria-hidden="true" />
                  </CommandShortcut>
                </CommandItem>
              );
            })}
          </CommandGroup>

          <CommandGroup heading="Actions">
            <CommandItem
              onSelect={() => {
                onOpenChange(false);
                openConnect();
              }}
            >
              <Plug className="mr-2 size-4" aria-hidden="true" />
              Connect an agent
            </CommandItem>
            <CommandItem onSelect={() => run('/lab/team')}>
              <Users className="mr-2 size-4" aria-hidden="true" />
              Invite a teammate
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

// ── Header ────────────────────────────────────────────────────────────────────

function ShellHeader({
  pathname,
  onOpenCommand,
}: {
  pathname: string;
  onOpenCommand: () => void;
}) {
  const { openConnect } = useConnectAgent();
  return (
    <header className="sticky top-0 z-50 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <Link
        href="/lab"
        className="flex shrink-0 items-center rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="waddling home"
      >
        <BrandMark align="center" iconClassName="size-7" textClassName="text-lg" />
      </Link>

      <div className="w-px shrink-0 self-stretch bg-border" aria-hidden="true" />

      <div className="min-w-0 flex-1 overflow-hidden">
        <LabBreadcrumbs pathname={pathname} />
      </div>

      <button
        type="button"
        onClick={onOpenCommand}
        aria-label="Open command palette (⌘K)"
        className="flex h-8 items-center gap-2 rounded-lg border bg-muted/50 px-3 text-xs text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Search className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="hidden sm:inline">Search…</span>
        <kbd
          className="pointer-events-none ml-1 hidden h-5 items-center gap-0.5 rounded border bg-background px-1.5 font-mono text-[10px] font-medium sm:flex"
          aria-hidden="true"
        >
          <span className="text-[10px]">⌘K</span>
        </kbd>
      </button>

      <Button size="sm" onClick={() => openConnect()}>
        <Plug className="mr-1.5 size-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">Connect agent</span>
        <span className="sm:hidden">Connect</span>
      </Button>
    </header>
  );
}

// ── App shell ─────────────────────────────────────────────────────────────────

interface AppShellProps {
  children: ReactNode;
}

/**
 * The new waddling app shell for the UX lab.
 * Provides: collapsible left sidebar nav, sticky header with breadcrumb + ⌘K
 * command palette, org switcher, theme toggle, user avatar menu.
 *
 * Do not import DashboardShell — this is a clean redesign.
 */
export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const [cmdOpen, setCmdOpen] = useState(false);

  // ⌘K / Ctrl+K keyboard shortcut. The root fumadocs RootProvider also binds
  // ⌘K (its docs search dialog); without intercepting, BOTH open ("two search
  // bars"). We listen in the CAPTURE phase and stopImmediatePropagation so the
  // app shell owns ⌘K wherever it is mounted, while docs/marketing (no shell)
  // keep fumadocs search.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setCmdOpen((v) => !v);
      }
    }
    document.addEventListener('keydown', handleKey, { capture: true });
    return () =>
      document.removeEventListener('keydown', handleKey, { capture: true });
  }, []);

  return (
    <ConnectAgentProvider>
    <SidebarProvider>
      {/* Skip link: first focusable element so keyboard users bypass the ~12
          nav/header stops and jump straight to page content. */}
      <a
        href="#main-content"
        className="sr-only z-50 rounded-md bg-background px-3 py-2 text-sm font-medium ring-2 ring-ring focus:not-sr-only focus:absolute focus:left-2 focus:top-2"
      >
        Skip to main content
      </a>
      <LabSidebar pathname={pathname} />
      <SidebarInset className="min-w-0">
        <BreadcrumbTitleProvider>
          <ShellHeader
            pathname={pathname}
            onOpenCommand={() => setCmdOpen(true)}
          />
          {/* Not a <main>: shadcn SidebarInset already renders the page's single
              <main> landmark. This is the skip-link target + scroll region. */}
          <div
            id="main-content"
            tabIndex={-1}
            className="flex min-h-0 flex-1 flex-col gap-6 p-6 outline-none"
          >
            {children}
          </div>
        </BreadcrumbTitleProvider>
      </SidebarInset>
      <CommandPalette open={cmdOpen} onOpenChange={setCmdOpen} />
    </SidebarProvider>
    </ConnectAgentProvider>
  );
}
