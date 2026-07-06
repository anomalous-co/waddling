'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ThemeToggle } from '@/components/theme-toggle';
import { BrandMark } from '@/components/brand-mark';
import { appUrl } from '@/lib/site';
import { useFunnel } from '@/lib/funnel';

const LINKS = [
  { href: '/docs', label: 'docs' },
  { href: '/blog', label: 'blog' },
  { href: '/pricing', label: 'pricing' },
];

export function MarketingNav() {
  const [open, setOpen] = useState(false);
  const { signupCtaClicked } = useFunnel();

  return (
    <nav className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-sm">
      <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
        <Link href="/" className="flex items-end gap-2">
          <BrandMark className="text-zinc-50" />
          <span className="text-xs font-mono text-zinc-500 border border-zinc-700 rounded px-1.5 py-0.5">beta</span>
        </Link>

        {/* Desktop nav */}
        <div className="hidden md:flex items-center gap-6 text-sm font-mono">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-zinc-400 hover:text-zinc-50 transition-colors"
            >
              {link.label}
            </Link>
          ))}
          <ThemeToggle className="text-zinc-400 hover:text-zinc-50 hover:bg-zinc-800" />
          <Link
            href={appUrl('/dashboard')}
            onClick={() => signupCtaClicked({ cta_location: 'nav', cta_text: 'sign in' })}
            className="bg-zinc-100 text-zinc-900 px-3 py-1.5 rounded font-mono text-sm hover:bg-zinc-50 transition-colors"
          >
            sign in
          </Link>
        </div>

        {/* Mobile controls */}
        <div className="flex items-center gap-2 md:hidden">
          <ThemeToggle className="text-zinc-400 hover:text-zinc-50 hover:bg-zinc-800" />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            className="inline-flex h-8 w-8 items-center justify-center rounded text-zinc-400 hover:text-zinc-50 hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            {open ? <CloseIcon /> : <MenuIcon />}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {open && (
        <div className="md:hidden border-t border-zinc-800 mx-auto max-w-6xl px-6 py-4 flex flex-col gap-4 text-sm font-mono">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className="text-zinc-400 hover:text-zinc-50 transition-colors"
            >
              {link.label}
            </Link>
          ))}
          <Link
            href={appUrl('/dashboard')}
            onClick={() => {
              signupCtaClicked({ cta_location: 'nav_mobile', cta_text: 'sign in' });
              setOpen(false);
            }}
            className="bg-zinc-100 text-zinc-900 px-3 py-1.5 rounded font-mono text-sm hover:bg-zinc-50 transition-colors text-center"
          >
            sign in
          </Link>
        </div>
      )}
    </nav>
  );
}

function MenuIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 6h18M3 12h18M3 18h18" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
