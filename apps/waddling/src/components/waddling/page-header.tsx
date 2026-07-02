import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface PageHeaderProps {
  /** Main page title. */
  title: string;
  /** Optional subtitle / description shown below the title. */
  description?: string;
  /** Optional slot for breadcrumb rendered above the title. */
  breadcrumb?: ReactNode;
  /** Optional slot for action buttons rendered in the top-right. */
  actions?: ReactNode;
  className?: string;
}

/**
 * Standard page header with title, optional description, breadcrumb, and actions.
 * Used at the top of every route page under the app shell.
 */
export function PageHeader({
  title,
  description,
  breadcrumb,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {breadcrumb && (
        <div className="text-sm text-muted-foreground">{breadcrumb}</div>
      )}
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl font-semibold leading-tight tracking-tight">
            {title}
          </h1>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        )}
      </div>
    </div>
  );
}
