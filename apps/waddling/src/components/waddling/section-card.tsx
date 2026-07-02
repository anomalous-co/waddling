import type { ReactNode } from 'react';
import {
  Card,
  CardHeader,
  CardAction,
  CardContent,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface SectionCardProps {
  /** Card section title. */
  title: string;
  /**
   * Heading level for the title. Defaults to 2 — a SectionCard titles a major
   * region, so it must be a real heading (shadcn CardTitle is a `<div>` and is
   * invisible to screen-reader heading navigation). Use 3 when the page nests
   * sections under an existing h2.
   */
  headingLevel?: 2 | 3;
  /** Optional actions rendered in the top-right (links, buttons). */
  headerActions?: ReactNode;
  /** Card body content. */
  children: ReactNode;
  className?: string;
  /** Pass to CardContent — useful to opt out of padding for table sections. */
  contentClassName?: string;
}

/**
 * A titled card container for dashboard sections.
 * Use `headerActions` to put a "View all" link or filter control top-right.
 * The title renders as a real `<h2>`/`<h3>` (not shadcn's `<div>` CardTitle) so
 * sections participate in the document heading outline.
 */
export function SectionCard({
  title,
  headingLevel = 2,
  headerActions,
  children,
  className,
  contentClassName,
}: SectionCardProps) {
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  return (
    <Card className={cn('gap-3', className)}>
      <CardHeader>
        <Heading className="font-semibold leading-none">{title}</Heading>
        {headerActions && <CardAction>{headerActions}</CardAction>}
      </CardHeader>
      <CardContent className={contentClassName}>{children}</CardContent>
    </Card>
  );
}
