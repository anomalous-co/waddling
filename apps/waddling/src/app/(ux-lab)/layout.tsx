import type { ReactNode } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';

/**
 * UX-lab route group: an ungated design forge for iterating on the new
 * waddling UI/UX with mock data. NOT part of the product surface — no auth
 * gate, no server session. Mirrors the providers the dashboard shell supplies
 * (theme comes from the root RootProvider) so components render true-to-life.
 */
export default function UxLabLayout({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={200}>
      {children}
      <Toaster />
    </TooltipProvider>
  );
}
