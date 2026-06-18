import type { ReactNode } from 'react';
import Link from 'next/link';
import { MarketingNav } from '@/components/marketing-nav';

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans">
      <MarketingNav />
      {children}
      <footer className="border-t border-zinc-800 px-6 py-10 mt-20">
        <div className="mx-auto max-w-6xl flex flex-col sm:flex-row items-start justify-between gap-8">
          <div>
            <div className="font-mono font-bold text-zinc-50 mb-1">waddling</div>
            <div className="text-xs text-zinc-500 font-mono">dynamic ACLs for AI agents on your lakehouse</div>
          </div>
          <div className="flex flex-wrap gap-x-10 gap-y-8 text-sm font-mono text-zinc-400">
            <div className="flex flex-col gap-2">
              <span className="text-zinc-600 text-xs uppercase tracking-widest">product</span>
              <Link href="/docs" className="hover:text-zinc-50 transition-colors">docs</Link>
              <Link href="/blog" className="hover:text-zinc-50 transition-colors">blog</Link>
              <Link href="/pricing" className="hover:text-zinc-50 transition-colors">pricing</Link>
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-zinc-600 text-xs uppercase tracking-widest">company</span>
              <Link href="/enterprise" className="hover:text-zinc-50 transition-colors">enterprise</Link>
              <a href="mailto:hello@getwaddling.com" className="hover:text-zinc-50 transition-colors">contact</a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
