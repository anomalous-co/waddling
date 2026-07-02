import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';

/**
 * UX-lab route group: an ungated design forge for iterating on the new
 * waddling UI/UX with mock data. NOT part of the product surface — no auth
 * gate, no server session. Mirrors the providers the dashboard shell supplies
 * (theme comes from the root RootProvider) so components render true-to-life.
 *
 * Local-dev only: these routes are a forge, not a product surface, and the
 * deployed worker points the browser at the real control-api — so a public
 * /lab/* would render real org data through an unfinished UI. Gate it to a 404
 * in any built/deployed environment (NODE_ENV==='production'); `pnpm dev`
 * (NODE_ENV==='development') keeps the forge fully available.
 */
export default function UxLabLayout({ children }: { children: ReactNode }) {
  if (process.env.NODE_ENV === 'production') notFound();

  return (
    <TooltipProvider delayDuration={200}>
      {children}
      <Toaster />
    </TooltipProvider>
  );
}
