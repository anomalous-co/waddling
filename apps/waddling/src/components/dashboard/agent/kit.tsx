'use client';

/**
 * Agents-surface shared kit — the ONE visual frame + state vocabulary every
 * agent page builds on, so the whole surface reads as a single tool.
 *
 * The frame is lifted verbatim from the ACL editor (access-editor-dialog.tsx +
 * access-editor.tsx): a rounded `bg-background/40` "workspace" panel holding a
 * left section-rail + a scrolling content area. `WorkspacePanel` is that frame,
 * un-modal'd for use on a page.
 *
 * The state vocabulary keeps two devices distinct (never blur them):
 *   - lifecycle STATUS  → StatusBadge / StatusDot (components/dashboard/status.tsx)
 *   - configuration FLAG → NoAccessFlag / NoAccessBanner (HERE) — derived
 *     "active but 0 grants", an amber OUTLINE chip, visually apart from the
 *     solid-amber `suspended` status pill. It is the linchpin of create→grant.
 */
import { useState, type ComponentType } from 'react';
import { TriangleAlert, PanelLeftClose, PanelLeft, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

// ── AgentSection contract ───────────────────────────────────────────────────
// A drop-in capability module: self-contained, fetches its own data, owns its
// loading/empty state. The prop contract is `{ agentId }` and nothing more —
// adding a new capability (Memory, Activity, …) means writing one of these and
// pushing it onto the page's section list. Zero shell changes.
export interface AgentSection {
  /** Stable id — rail key + url anchor. */
  id: string;
  label: string;
  icon?: LucideIcon;
  /** Count shown on the rail item; null/undefined = no badge. Resolved by the page. */
  badge?: number | null;
  /**
   * When true, the section fills the content area as a bounded flex child (no
   * outer ScrollArea) so it can own its internal scrolling — e.g. the Access
   * editor, which has its own scroll region. Default false: wrapped in a
   * ScrollArea so ordinary section content scrolls.
   */
  fill?: boolean;
  Component: ComponentType<{ agentId: string }>;
}

// ── NoAccess: the derived configuration flag ────────────────────────────────
/** Derived: an active agent with zero grants can authenticate but every query is denied. */
export function needsAccess(status: string, grantCount: number): boolean {
  return status === 'active' && grantCount === 0;
}

/** Amber OUTLINE chip — deliberately NOT a solid status pill (keeps it apart from `suspended`). */
export function NoAccessFlag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border border-amber-500/50 px-1.5 py-0.5',
        'text-xs font-medium text-amber-700 dark:text-amber-500',
        className,
      )}
    >
      <TriangleAlert className="size-3" />
      No access
    </span>
  );
}

/**
 * Full-width detail-page escalation of the flag — drives the funnel. The grant
 * CTA is passed in as `action` (a node, not a callback) so this stays a pure
 * presentational client component.
 */
export function NoAccessBanner({ action }: { action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
      <span className="flex items-center gap-2 text-sm text-amber-800 dark:text-amber-400">
        <TriangleAlert className="size-4 shrink-0" />
        This agent has no access — it can authenticate, but every query is denied.
      </span>
      {action}
    </div>
  );
}

// ── WorkspacePanel: the rounded panel + left rail + content (the canonical frame)
/**
 * The "rounded area with the left sidebar rail." Renders the section rail on the
 * left and the active section's Component on the right, inside the soft inset
 * panel. Active section is internal state (uncontrolled) by default.
 *
 * Classes are intentionally identical to the ACL editor's frame so the surface
 * is visually continuous:
 *   panel  : rounded-lg border bg-background/40 p-3
 *   rail   : w-44 shrink-0 border-r pr-2 ; item rounded-md px-2 py-1.5,
 *            active bg-muted font-medium, badge bg-primary/15 text-primary
 *   content: ScrollArea min-h-0 flex-1 pl-3 pr-2
 */
export function WorkspacePanel({
  sections,
  agentId,
  className,
  activeId: controlledId,
  onSelect,
}: {
  sections: AgentSection[];
  agentId: string;
  className?: string;
  /** Controlled active section id (optional). Falls back to internal state. */
  activeId?: string;
  onSelect?: (id: string) => void;
}) {
  const [internalId, setInternalId] = useState(sections[0]?.id ?? '');
  const activeId = controlledId ?? internalId;
  const setActive = (id: string) => {
    setInternalId(id);
    onSelect?.(id);
  };
  const [railOpen, setRailOpen] = useState(true);
  const active = sections.find((s) => s.id === activeId) ?? sections[0];

  return (
    <div className={cn('h-full overflow-hidden rounded-lg border bg-background/40 p-3', className)}>
      <div className="flex h-full min-h-0">
        {railOpen ? (
          <nav className="flex w-44 shrink-0 flex-col gap-0.5 border-r pr-2">
            <div className="flex items-center justify-between px-1 pb-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Sections
              </span>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-6"
                onClick={() => setRailOpen(false)}
                aria-label="Collapse sections"
              >
                <PanelLeftClose className="size-3.5" />
              </Button>
            </div>
            {sections.map((s) => {
              const Icon = s.icon;
              const isActive = s.id === active?.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setActive(s.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                    isActive
                      ? 'bg-muted font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                  )}
                >
                  {Icon ? <Icon className="size-4 shrink-0" /> : null}
                  <span className="flex-1 truncate">{s.label}</span>
                  {s.badge != null && s.badge > 0 ? (
                    <span className="rounded bg-primary/15 px-1.5 text-xs text-primary">{s.badge}</span>
                  ) : null}
                </button>
              );
            })}
          </nav>
        ) : (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="mr-2 size-7 self-start"
            onClick={() => setRailOpen(true)}
            aria-label="Open sections"
          >
            <PanelLeft className="size-4" />
          </Button>
        )}

        {active?.fill ? (
          // Section owns its own scrolling (e.g. the Access editor) — give it a
          // bounded flex area instead of wrapping in a ScrollArea.
          <div className="flex min-h-0 flex-1 flex-col pl-3 pr-2">
            {active ? <active.Component agentId={agentId} /> : null}
          </div>
        ) : (
          <ScrollArea type="auto" className="min-h-0 flex-1 pl-3 pr-2">
            {active ? <active.Component agentId={agentId} /> : null}
          </ScrollArea>
        )}
      </div>
    </div>
  );
}

/** Standard section content header (matches the ACL editor's `Resource/Capabilities` row). */
export function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b pb-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </span>
      {action}
    </div>
  );
}
