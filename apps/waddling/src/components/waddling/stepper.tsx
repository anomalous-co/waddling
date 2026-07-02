'use client';

import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface StepDefinition {
  /** Short human-readable label rendered below the step circle. */
  label: string;
}

interface StepperProps {
  /** Ordered step definitions. */
  steps: StepDefinition[];
  /**
   * 0-based index of the current (in-progress) step.
   * Steps with index < current are shown as complete.
   * Pass `steps.length` to mark every step complete (e.g. the done state).
   */
  current: number;
  className?: string;
}

/**
 * Horizontal step progress indicator for multi-step wizards.
 *
 * A11y:
 * - Renders as a `<nav aria-label="Progress">` containing an `<ol>`.
 * - The current step's circle element carries `aria-current="step"`.
 * - Completed steps show a check icon with sr-only "Completed" text.
 * - NOT a tablist — this is a progress display; navigation is driven by form
 *   actions inside each step, not by clicking the stepper directly.
 *
 * Connector lines fill from left to right as steps are completed; the colour
 * is determined by the adjacent step states (primary when complete, border
 * when not yet reached).
 */
export function Stepper({ steps, current, className }: StepperProps) {
  return (
    <nav aria-label="Progress" className={className}>
      <ol className="flex w-full items-start" role="list">
        {steps.map((step, idx) => {
          const state: 'complete' | 'current' | 'upcoming' =
            idx < current
              ? 'complete'
              : idx === current
                ? 'current'
                : 'upcoming';

          const isFirst = idx === 0;
          const isLast = idx === steps.length - 1;

          // A connector to the LEFT of this circle is "filled" if the previous
          // step is complete (i.e. idx - 1 < current, equivalent to idx <= current).
          const leftFilled = !isFirst && idx <= current;
          // A connector to the RIGHT of this circle is "filled" if THIS step is
          // complete (i.e. idx < current).
          const rightFilled = !isLast && idx < current;

          return (
            <li
              key={step.label}
              aria-current={state === 'current' ? 'step' : undefined}
              className="flex flex-1 flex-col items-center"
            >
              {/* Row: left-connector + circle + right-connector */}
              <div className="flex w-full items-center">
                {/* Left connector (invisible spacer for the first step) */}
                <div
                  aria-hidden="true"
                  className={cn(
                    'h-0.5 flex-1 transition-colors',
                    isFirst ? 'invisible' : leftFilled ? 'bg-primary' : 'bg-border',
                  )}
                />

                {/* Step circle */}
                <div
                  className={cn(
                    'relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold transition-colors',
                    state === 'complete' &&
                      'border-primary bg-primary text-primary-foreground',
                    state === 'current' &&
                      'border-primary bg-background text-primary ring-4 ring-primary/10',
                    state === 'upcoming' &&
                      'border-muted-foreground/30 bg-background text-muted-foreground',
                  )}
                >
                  {state === 'complete' ? (
                    <>
                      <Check className="size-4" aria-hidden="true" />
                      <span className="sr-only">Completed</span>
                    </>
                  ) : (
                    <>
                      <span aria-hidden="true">{idx + 1}</span>
                      {state === 'current' && (
                        <span className="sr-only"> (current)</span>
                      )}
                    </>
                  )}
                </div>

                {/* Right connector (invisible spacer for the last step) */}
                <div
                  aria-hidden="true"
                  className={cn(
                    'h-0.5 flex-1 transition-colors',
                    isLast ? 'invisible' : rightFilled ? 'bg-primary' : 'bg-border',
                  )}
                />
              </div>

              {/* Step label */}
              <span
                className={cn(
                  'mt-2 text-center text-xs font-medium',
                  state === 'complete' && 'text-primary',
                  state === 'current' && 'text-foreground',
                  state === 'upcoming' && 'text-muted-foreground',
                )}
              >
                {step.label}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
