'use client';

import type { ReactNode } from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

interface StatPillProps {
  /** Short descriptive label, e.g. "Active agents". */
  label: string;
  /** Formatted value to display, e.g. "3" or "$43.20". */
  value: string;
  /** Optional numeric trend delta (positive = up, negative = down, 0 = flat). */
  delta?: number;
  /** Optional lucide icon rendered before the value. */
  icon?: ReactNode;
  className?: string;
}

/**
 * A compact metric pill: label + value + optional trend indicator.
 * Used in the Home overview stat row.
 */
export function StatPill({
  label,
  value,
  delta,
  icon,
  className,
}: StatPillProps) {
  const hasDelta = delta !== undefined;
  const isUp = hasDelta && delta > 0;
  const isDown = hasDelta && delta < 0;

  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-xl border bg-card px-4 py-3 text-card-foreground ring-1 ring-foreground/10',
        className,
      )}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-baseline gap-2">
        {icon && (
          <span className="text-muted-foreground [&_svg]:size-4" aria-hidden="true">
            {icon}
          </span>
        )}
        <span className="font-heading text-2xl font-semibold leading-none tracking-tight">
          {value}
        </span>
        {hasDelta && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 text-xs font-medium',
              isUp && 'text-emerald-500',
              isDown && 'text-destructive',
              !isUp && !isDown && 'text-muted-foreground',
            )}
            aria-label={`${delta > 0 ? '+' : ''}${delta} vs last period`}
          >
            {isUp ? (
              <TrendingUp className="size-3" aria-hidden="true" />
            ) : isDown ? (
              <TrendingDown className="size-3" aria-hidden="true" />
            ) : (
              <Minus className="size-3" aria-hidden="true" />
            )}
            {Math.abs(delta)}
          </span>
        )}
      </div>
    </div>
  );
}
