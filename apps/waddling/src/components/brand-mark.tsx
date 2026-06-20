import { cn } from '@/lib/utils';
import { DataLakeIcon } from '@/components/data-lake-icon';

// The waddling brand lockup: the data-lake mark + the "waddling" wordmark in
// Coiny. Both the mark and the text inherit currentColor, so set the color on
// the wrapper (or a parent). Override sizing per surface with iconClassName /
// textClassName.
//
// align="baseline" (default) bottom-aligns the wordmark to the mark for the big
// standalone logo (marketing/login). align="center" vertically centers the two
// for tight inline rows like the dashboard navbar, where bottom-alignment leaves
// the icon hanging below the text.
export function BrandMark({
  className,
  iconClassName,
  textClassName,
  align = 'baseline',
}: {
  className?: string;
  iconClassName?: string;
  textClassName?: string;
  align?: 'baseline' | 'center';
}) {
  return (
    <span
      className={cn(
        'inline-flex gap-2',
        align === 'center' ? 'items-center' : 'items-end',
        className,
      )}
    >
      <DataLakeIcon className={cn('size-9 shrink-0', iconClassName)} aria-hidden />
      <span
        className={cn(
          'font-coiny text-xl leading-none tracking-tight',
          // Nudge the wordmark up off the icon's baseline a touch — Coiny's
          // descender otherwise makes it sit too low against the mark. Only
          // when bottom-aligned; centered rows don't need it.
          align === 'baseline' && 'mb-1',
          textClassName,
        )}
      >
        waddling
      </span>
    </span>
  );
}
