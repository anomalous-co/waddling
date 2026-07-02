'use client';

import { useRef } from 'react';
import { cn } from '@/lib/utils';

export interface RadioSegmentOption<T extends string> {
  value: T;
  label: string;
}

/**
 * An accessible segmented radio control.
 *
 * Implements the WAI-ARIA radiogroup keyboard contract correctly: a single tab
 * stop (roving tabindex — only the checked option is in the tab order), and
 * Arrow/Home/End move the selection between options. Hand-rolled
 * `role="radio"` buttons without this are a spec violation (screen readers
 * announce radios, so users expect arrow keys).
 *
 * Visual styling matches the inline segmented controls it replaces, so swapping
 * it in is a pure a11y upgrade with no visual change.
 */
export function RadioSegments<T extends string>({
  value,
  onChange,
  options,
  ariaLabelledby,
  ariaLabel,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly RadioSegmentOption<T>[];
  /** id of an external label element (preferred). */
  ariaLabelledby?: string;
  /** Fallback inline label when there's no visible label element. */
  ariaLabel?: string;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  function focusIndex(i: number) {
    onChange(options[i].value);
    refs.current[i]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-labelledby={ariaLabelledby}
      aria-label={ariaLabel}
      className={cn('flex w-fit rounded-lg border p-0.5', className)}
    >
      {options.map((opt, i) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            // Roving tabindex: only the checked option is a tab stop.
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(opt.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                focusIndex((activeIndex + 1) % options.length);
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                focusIndex((activeIndex - 1 + options.length) % options.length);
              } else if (e.key === 'Home') {
                e.preventDefault();
                focusIndex(0);
              } else if (e.key === 'End') {
                e.preventDefault();
                focusIndex(options.length - 1);
              }
            }}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              selected
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
