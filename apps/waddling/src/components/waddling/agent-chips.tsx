import type { AgentSummary } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Small domain chips shared across the Agents surfaces (roster, detail, access).
 * Extracted so a visual/semantic change lives in ONE place.
 */

const CHIP_BASE =
  'inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-xs';

/** ACL verb (read / write) chip — read = sky, write = amber. */
export function VerbChip({ verb }: { verb: 'read' | 'write' }) {
  return (
    <span
      className={cn(
        CHIP_BASE,
        // -700 in light mode for WCAG AA contrast on the 10% tint; -400 in dark.
        verb === 'read'
          ? 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400'
          : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
      )}
    >
      {verb}
    </span>
  );
}

/** birdshot decision (allow / deny) chip — emerald allow / red deny, AA -700 light shades. */
export function DecisionChip({ decision }: { decision: 'allow' | 'deny' }) {
  return (
    <span
      className={cn(
        CHIP_BASE,
        decision === 'allow'
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
          : 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
      )}
    >
      {decision}
    </span>
  );
}

/** Agent access-mode (autonomous / delegated) chip. */
export function ModeChip({ mode }: { mode: AgentSummary['mode'] }) {
  return (
    <span
      className={cn(
        CHIP_BASE,
        mode === 'delegated'
          ? 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-400'
          : 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400',
      )}
    >
      {mode}
    </span>
  );
}
