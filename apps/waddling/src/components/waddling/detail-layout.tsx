'use client';

import { type ReactNode, Suspense, useId } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { StatusDot } from '@/components/waddling/status-dot';
import type { SemanticStatus } from '@/components/waddling/status-dot';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DetailSection {
  /** URL-safe identifier used in the `?section=` query param. */
  id: string;
  /** Label shown in the sub-rail and mobile select. */
  label: string;
  /** Optional count badge shown beside the label. */
  badge?: number | string;
  /** The section's rendered content. */
  content: ReactNode;
}

export interface DetailLayoutProps {
  /**
   * Entity title — rendered as the page's single h1. DetailLayout owns the h1;
   * the host page must NOT also render a PageHeader.
   */
  title: string;
  /** Optional semantic status dot shown beside the title. */
  status?: SemanticStatus;
  /** Small chips or text rendered below the title (region, table count, etc.). */
  meta?: ReactNode;
  /** Right-aligned action buttons in the header band. */
  actions?: ReactNode;
  /** Ordered sections to populate the sub-rail. */
  sections: DetailSection[];
  /**
   * ID of the section shown when `?section=` is absent. Defaults to
   * `sections[0].id`. The default section is omitted from the URL (clean URL).
   */
  defaultSection?: string;
}

// ── Sub-rail item ─────────────────────────────────────────────────────────────

function RailItem({
  section,
  isActive,
  panelId,
}: {
  section: DetailSection;
  isActive: boolean;
  panelId: string;
}) {
  return (
    <Link
      href={`?section=${section.id}`}
      scroll={false}
      aria-current={isActive ? 'page' : undefined}
      aria-controls={panelId}
      className={cn(
        'flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-colors',
        isActive
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <span>{section.label}</span>
      {section.badge !== undefined && (
        <span
          className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-border px-1.5 font-mono text-xs text-muted-foreground tabular-nums"
          aria-label={`${section.badge} ${section.badge === 1 ? 'item' : 'items'}`}
        >
          {section.badge}
        </span>
      )}
    </Link>
  );
}

// ── Inner component (reads useSearchParams — must be inside Suspense) ─────────

function DetailLayoutInner({
  title,
  status,
  meta,
  actions,
  sections,
  defaultSection,
}: DetailLayoutProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const panelId = useId();

  if (sections.length === 0) return null;

  const defaultId = defaultSection ?? sections[0].id;
  const rawSection = searchParams.get('section');
  // If the URL section doesn't match any known section, fall back to default.
  const activeSectionId =
    rawSection && sections.some((s) => s.id === rawSection) ? rawSection : defaultId;
  const activeSection = sections.find((s) => s.id === activeSectionId) ?? sections[0];

  return (
    <div className="flex flex-col gap-6">
      {/* ── Header band ─────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="font-heading text-2xl font-semibold leading-tight tracking-tight">
              {title}
            </h1>
            {status && <StatusDot status={status} />}
          </div>
          {meta && (
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              {meta}
            </div>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        )}
      </div>

      {/* ── Two-column body: sub-rail + content ─────────────────────────── */}
      <div className="flex gap-8">
        {/* Sub-rail — hidden on small screens */}
        <nav
          aria-label="Page sections"
          className="hidden w-44 shrink-0 flex-col gap-0.5 sm:flex"
        >
          {sections.map((section) => (
            <RailItem
              key={section.id}
              section={section}
              isActive={section.id === activeSection.id}
              panelId={`${panelId}-panel`}
            />
          ))}
        </nav>

        {/* Content area — includes mobile picker on small screens */}
        <div className="min-w-0 flex-1">
          {/* Mobile section picker */}
          <div className="mb-4 sm:hidden">
            <label htmlFor={`${panelId}-select`} className="sr-only">
              Select section
            </label>
            <select
              id={`${panelId}-select`}
              value={activeSection.id}
              onChange={(e) => {
                const id = e.target.value;
                const params = new URLSearchParams(searchParams.toString());
                if (id === defaultId) {
                  params.delete('section');
                } else {
                  params.set('section', id);
                }
                const qs = params.toString();
                router.push(qs ? `?${qs}` : '?', { scroll: false });
              }}
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                  {s.badge !== undefined ? ` (${s.badge})` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Active section content */}
          <div
            id={`${panelId}-panel`}
            role="region"
            aria-label={activeSection.label}
          >
            {activeSection.content}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Loading skeleton (shown while Suspense resolves) ──────────────────────────

function DetailLayoutSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48 rounded-lg" />
        <Skeleton className="h-4 w-64 rounded-lg" />
      </div>
      <div className="flex gap-8">
        <div className="hidden w-44 shrink-0 flex-col gap-1 sm:flex">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-9 rounded-lg" />
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </div>
    </div>
  );
}

// ── Public export ─────────────────────────────────────────────────────────────

/**
 * Generic detail-page scaffold: header (h1 + status + meta + actions) and a
 * left section sub-rail (URL-driven via `?section=`).
 *
 * Design for reuse: not lake-specific — hosts the Lake detail now and will host
 * the Agent detail in the next loop. Pass a new `sections[]` to adapt it to any
 * single-entity detail page.
 *
 * A11y:
 * - Owns the page's single h1 (title).
 * - Sub-rail is a `<nav aria-label="Page sections">` with `aria-current` on the
 *   active section link.
 * - Active section panel is `role="region"` with `aria-label` matching the label.
 * - Mobile fallback is a labelled `<select>`.
 * - Uses `<Suspense>` to wrap the `useSearchParams()` read (Next.js requirement).
 */
export function DetailLayout(props: DetailLayoutProps) {
  return (
    <Suspense fallback={<DetailLayoutSkeleton />}>
      <DetailLayoutInner {...props} />
    </Suspense>
  );
}
