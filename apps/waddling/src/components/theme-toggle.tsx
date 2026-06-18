'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'fumadocs-ui/provider/base';

/**
 * Sun/moon theme switch. Flips between the light and dark themes (the site
 * ships dark by default — see RootProvider in app/layout.tsx). Colors are
 * inherited from `className` so it blends into whatever bar hosts it; pass
 * the same text-color utilities used by its neighbors.
 *
 * Renders an inert placeholder until mounted so the server markup (which has
 * no resolved theme) matches the first client paint and avoids a hydration
 * mismatch on the icon.
 */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const isLight = resolvedTheme === 'light';
  const base =
    'inline-flex h-8 w-8 items-center justify-center rounded transition-colors cursor-pointer';

  if (!mounted) {
    return (
      <span
        aria-hidden
        className={[base, className].join(' ')}
        style={{ visibility: 'hidden' }}
      >
        <MoonIcon />
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setTheme(isLight ? 'dark' : 'light')}
      aria-label={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
      title={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
      className={[base, className].join(' ')}
    >
      {isLight ? <MoonIcon /> : <SunIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
