import { cn } from '@/lib/utils';
import { DataLakeIcon } from '@/components/data-lake-icon';

// The waddling brand lockup: the data-lake mark + the "waddling" wordmark in
// Coiny, baseline (bottom) aligned. Both the mark and the text inherit
// currentColor, so set the color on the wrapper (or a parent). Override sizing
// per surface with iconClassName / textClassName.
export function BrandMark({
  className,
  iconClassName,
  textClassName,
}: {
  className?: string;
  iconClassName?: string;
  textClassName?: string;
}) {
  return (
    <span className={cn('inline-flex items-end gap-2', className)}>
      <DataLakeIcon className={cn('size-9 shrink-0', iconClassName)} aria-hidden />
      <span
        className={cn(
          // Nudge the wordmark up off the icon's baseline a touch — Coiny's
          // descender otherwise makes it sit too low against the mark.
          'mb-1 font-coiny text-xl leading-none tracking-tight',
          textClassName,
        )}
      >
        waddling
      </span>
    </span>
  );
}
