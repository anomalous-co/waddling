import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * Shared status pill used across every dashboard table/detail view so the same
 * lifecycle word always reads the same colour. Status colour is genuinely
 * semantic here (running/allow = good, deny/error = bad, provisioning = pending),
 * so this is the one sanctioned place that reaches past the neutral Badge
 * variants into green/amber tints — keep colour decisions in THIS file only.
 */
type Tone = 'success' | 'danger' | 'warning' | 'muted' | 'info' | 'sleep';

const TONE_CLASS: Record<Tone, string> = {
  success:
    'border-transparent bg-green-700 text-green-50 dark:bg-green-500/15 dark:text-green-400',
  danger:
    'border-transparent bg-red-500/15 text-red-700 dark:text-red-400',
  warning:
    'border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-500',
  info: 'border-transparent bg-blue-500/15 text-blue-700 dark:text-blue-400',
  muted: 'border-transparent bg-muted text-muted-foreground',
  // Scale-to-zero "asleep": a cooler slate that reads as dormant-but-fine,
  // visually apart from neutral muted and from amber provisioning / red error.
  sleep:
    'border-transparent bg-slate-500/15 text-slate-600 dark:text-slate-400',
};

const STATUS_TONE: Record<string, Tone> = {
  // good / live
  running: 'success',
  active: 'success',
  allow: 'success',
  ready: 'success',
  ok: 'success',
  claimed: 'success',
  // bad / terminal
  error: 'danger',
  deny: 'danger',
  revoked: 'danger',
  killed: 'danger',
  failed: 'danger',
  // pending / transitional
  provisioning: 'warning',
  pending: 'warning',
  suspended: 'warning',
  superseded: 'warning',
  // neutral / inactive
  stopped: 'muted',
  expired: 'muted',
  idle: 'muted',
  // scale-to-zero gateway: warm on demand, not an error — distinct slate tint
  asleep: 'sleep',
  unconfigured: 'muted',
  delegated: 'info',
  autonomous: 'info',
};

export function toneFor(status: string): Tone {
  return STATUS_TONE[status?.toLowerCase()] ?? 'muted';
}

export function StatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  return (
    <Badge className={cn('font-medium capitalize', TONE_CLASS[toneFor(status)], className)}>
      {status}
    </Badge>
  );
}

/** A small status dot (for dense rows where a full pill is too heavy). */
export function StatusDot({ status, className }: { status: string; className?: string }) {
  const tone = toneFor(status);
  const dot: Record<Tone, string> = {
    success: 'bg-green-500',
    danger: 'bg-red-500',
    warning: 'bg-amber-500',
    info: 'bg-blue-500',
    muted: 'bg-muted-foreground',
    sleep: 'bg-slate-400',
  };
  return <span className={cn('inline-block size-2 rounded-full', dot[tone], className)} />;
}
