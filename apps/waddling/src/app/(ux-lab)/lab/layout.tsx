import type { ReactNode } from 'react';
import { AppShell } from '@/components/waddling/app-shell';

/**
 * Layout for all /lab/* routes.
 * Wraps content in the new AppShell (sidebar + header + ⌘K palette).
 * Parent (ux-lab)/layout.tsx supplies TooltipProvider + Toaster; we don't
 * duplicate those here.
 */
export default function LabLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
