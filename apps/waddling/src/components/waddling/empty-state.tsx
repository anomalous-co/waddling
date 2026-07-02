import type { ReactNode } from 'react';
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from '@/components/ui/empty';

interface EmptyStateProps {
  /** Lucide icon or illustration. */
  icon?: ReactNode;
  /** Short title. */
  title: string;
  /** Explanatory sentence. */
  description?: string;
  /** Optional CTA button or link. */
  action?: ReactNode;
}

/**
 * A consistent empty state component built on top of the shadcn `empty` primitive.
 * Used in section cards and page bodies when there is no data to display.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <Empty>
      <EmptyHeader>
        {icon && <EmptyMedia variant="icon">{icon}</EmptyMedia>}
        <EmptyTitle>{title}</EmptyTitle>
        {description && (
          <EmptyDescription>{description}</EmptyDescription>
        )}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}
