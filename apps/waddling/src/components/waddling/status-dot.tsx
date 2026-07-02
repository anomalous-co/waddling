'use client';

import { cn } from '@/lib/utils';

/**
 * Semantic status values used across waddling UI surfaces.
 * Intentionally decoupled from the raw DB enum so StatusDot can describe
 * derived states (e.g. "idle" for a stale-lastSeenAt active agent).
 */
export type SemanticStatus =
  | 'active'
  | 'idle'
  | 'suspended'
  | 'provisioning'
  | 'error';

// Fixed semantic palette: a status colour means the same thing in light and dark
// mode (green = active everywhere), so these are intentionally fixed Tailwind
// values rather than theme tokens — but kept on ONE strategy across all states
// (no token/fixed mix) so cohesion holds across themes.
const STATUS_CONFIG: Record<
  SemanticStatus,
  { dot: string; label: string }
> = {
  active:       { dot: 'bg-emerald-500',            label: 'Active' },
  idle:         { dot: 'bg-amber-400',              label: 'Idle' },
  suspended:    { dot: 'bg-zinc-400 dark:bg-zinc-500', label: 'Suspended' },
  provisioning: { dot: 'bg-sky-400 animate-pulse',  label: 'Provisioning' },
  error:        { dot: 'bg-red-500',                label: 'Error' },
};

interface StatusDotProps {
  /** Semantic status to display. */
  status: SemanticStatus;
  /** Show the status label beside the dot (default true). */
  showLabel?: boolean;
  /**
   * Purely decorative (e.g. a leading dot next to a name that already shows the
   * status elsewhere in the row). Hidden from the accessibility tree so the
   * status is announced exactly once. Overrides showLabel.
   */
  decorative?: boolean;
  className?: string;
}

/**
 * A colored semantic-status dot with an accessible label.
 *
 * A11y: when `decorative`, the whole node is `aria-hidden`. When the label is
 * shown, the visible text is the accessible name (no role/aria-label, so it is
 * announced once). When the label is hidden but not decorative, the node is
 * `role="img"` with an `aria-label` (a static badge, NOT a live region).
 */
export function StatusDot({
  status,
  showLabel = true,
  decorative = false,
  className,
}: StatusDotProps) {
  const { dot, label } = STATUS_CONFIG[status];
  const a11y = decorative
    ? { 'aria-hidden': true as const }
    : showLabel
      ? {}
      : { role: 'img', 'aria-label': label };
  return (
    <span
      {...a11y}
      className={cn('inline-flex items-center gap-1.5', className)}
    >
      <span
        className={cn('size-2 shrink-0 rounded-full', dot)}
        aria-hidden="true"
      />
      {showLabel && !decorative && (
        <span className="text-xs text-muted-foreground">{label}</span>
      )}
    </span>
  );
}
