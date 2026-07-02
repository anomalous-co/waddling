import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface GoldenPathCardProps {
  /** Lucide icon or any element rendered prominently above the title. */
  icon: ReactNode;
  /** Short punchy title. */
  title: string;
  /** One-line value proposition. */
  body: string;
  /** Primary CTA button element. */
  action: ReactNode;
  /**
   * Heading level for the title. Defaults to 2. Pass 1 when this hero is the
   * page's primary heading (e.g. the Home launchpad has no other h1).
   */
  headingLevel?: 1 | 2;
  className?: string;
}

/**
 * A prominent hero CTA card — the single most important launchpad action on a page.
 * Used on the Home/Overview page to surface the "Connect an agent" golden path.
 */
export function GoldenPathCard({
  icon,
  title,
  body,
  action,
  headingLevel = 2,
  className,
}: GoldenPathCardProps) {
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  return (
    <div
      className={cn(
        'relative flex flex-col gap-4 overflow-hidden rounded-xl border bg-card p-6 text-card-foreground ring-1 ring-foreground/10',
        // Subtle gradient accent on the top edge
        'before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-foreground/20 before:to-transparent',
        className,
      )}
    >
      <div
        className="flex size-10 items-center justify-center rounded-lg bg-muted text-foreground [&_svg]:size-5"
        aria-hidden="true"
      >
        {icon}
      </div>
      <div className="flex flex-col gap-1">
        <Heading className="font-heading text-base font-semibold leading-snug">
          {title}
        </Heading>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
      <div>{action}</div>
    </div>
  );
}
