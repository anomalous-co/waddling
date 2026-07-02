import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { CopyButton } from '@/components/waddling/copy-button';
import { cn } from '@/lib/utils';

interface KeyRevealProps {
  /**
   * The secret value to display. Treated as sensitive:
   * - Never logged (no console output from this component)
   * - Rendered in a monospace `<output>` element that is user-selectable
   * - spellCheck disabled
   */
  value: string;
  /**
   * Warning content shown below the key. Defaults to the standard
   * "shown once" warning. Pass `null` to suppress entirely (not recommended).
   */
  warning?: ReactNode;
  className?: string;
}

const DEFAULT_WARNING = (
  <span>
    <strong className="font-semibold text-foreground">Copy it now</strong> — you
    won&apos;t see it again. Store it in your secrets manager before leaving this
    page.
  </span>
);

/**
 * A reveal-once secret display component.
 *
 * Use for API keys that are generated server-side, shown exactly once at
 * creation, and never retrievable again. Provides a CopyButton so users
 * can capture the value without reading the raw text.
 *
 * A11y:
 * - The key is wrapped in `<output>` (implicitly role="status") so it reads
 *   cleanly in a screen-reader context without announcing on mount.
 * - The CopyButton's aria-live region announces "Copied" on success.
 * - spellCheck={false} prevents autocorrect from mangling the value.
 */
export function KeyReveal({ value, warning = DEFAULT_WARNING, className }: KeyRevealProps) {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {/* Key display */}
      <div className="relative flex items-center rounded-lg border bg-muted/50 px-4 py-3">
        <output
          // eslint-disable-next-line react/no-unknown-property -- spellCheck is valid on output
          spellCheck={false}
          className="flex-1 select-all overflow-x-auto font-mono text-sm text-foreground"
          aria-label="Agent API key"
        >
          {value}
        </output>
        <CopyButton text={value} label="Copy agent API key" className="ml-2 shrink-0" />
      </div>

      {/* Warning */}
      {warning !== null && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0 text-amber-500"
            aria-hidden="true"
          />
          <p className="text-sm text-muted-foreground">{warning}</p>
        </div>
      )}
    </div>
  );
}
