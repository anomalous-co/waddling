import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Small helpers shared between page.tsx and the colocated graph view. Kept in
 * their own module (rather than exported from page.tsx) because Next.js route
 * files may only export the framework-recognized names (default, metadata,
 * generateStaticParams, ...) — any other export trips the typed-routes check.
 */

// DuckDB TIMESTAMP normalizes to a naive string ("2026-07-05 17:53:52[.sss]"); treat it as UTC
// and render relative. Falls back to the raw value if it can't be parsed.
export function formatTs(ts: unknown): string {
  if (ts == null || ts === '') return '';
  const s = String(ts).trim();
  const base = s.includes('T') ? s : s.replace(' ', 'T');
  const hasTz = base.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(base);
  const d = new Date(hasTz ? base : `${base}Z`);
  if (Number.isNaN(d.getTime())) return s;
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function WakingNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">The quackboard gateway is waking up.</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw className="mr-1.5 size-3.5" aria-hidden="true" />
        Retry
      </Button>
    </div>
  );
}
