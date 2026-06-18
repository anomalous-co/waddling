'use client';

import { type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes } from 'react';
import Link from 'next/link';

// ── Button ─────────────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  loading?: boolean;
  children: ReactNode;
}

const variantClass: Record<ButtonVariant, string> = {
  primary:
    'bg-[#2563eb] hover:bg-[#1d4ed8] text-white border-transparent disabled:opacity-50',
  secondary:
    'bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border-neutral-600 disabled:opacity-50',
  danger:
    'bg-[#b91c1c] hover:bg-[#dc2626] text-white border-transparent disabled:opacity-50',
  ghost:
    'bg-transparent hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 border-transparent disabled:opacity-50',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  children,
  disabled,
  className = '',
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={[
        'inline-flex items-center justify-center gap-2 rounded border font-medium transition-colors cursor-pointer select-none',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-1.5 text-sm',
        variantClass[variant],
        className,
      ].join(' ')}
    >
      {loading && <Spinner size="sm" />}
      {children}
    </button>
  );
}

// ── Card ───────────────────────────────────────────────────────────────────

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={[
        'rounded-lg border border-neutral-800 bg-neutral-900 p-4',
        className,
      ].join(' ')}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-4">
      <div>
        <h2 className="text-sm font-semibold text-neutral-100">{title}</h2>
        {subtitle && (
          <p className="text-xs text-neutral-500 mt-0.5">{subtitle}</p>
        )}
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </div>
  );
}

// ── Badge ──────────────────────────────────────────────────────────────────

type BadgeVariant = 'green' | 'red' | 'yellow' | 'blue' | 'neutral';

const badgeClass: Record<BadgeVariant, string> = {
  green: 'bg-green-900/60 text-green-300 border-green-800',
  red: 'bg-red-900/60 text-red-300 border-red-800',
  yellow: 'bg-yellow-900/60 text-yellow-300 border-yellow-800',
  blue: 'bg-blue-900/60 text-blue-300 border-blue-800',
  neutral: 'bg-neutral-800 text-neutral-400 border-neutral-700',
};

export function Badge({
  variant = 'neutral',
  children,
}: {
  variant?: BadgeVariant;
  children: ReactNode;
}) {
  return (
    <span
      className={[
        'inline-flex items-center px-2 py-0.5 rounded text-xs font-mono border',
        badgeClass[variant],
      ].join(' ')}
    >
      {children}
    </span>
  );
}

// Status → badge variant helper
export function statusVariant(
  status: string,
): BadgeVariant {
  switch (status) {
    case 'running':
    case 'active':
    case 'allow':
      return 'green';
    case 'error':
    case 'revoked':
    case 'killed':
    case 'deny':
      return 'red';
    case 'provisioning':
    case 'suspended':
      return 'yellow';
    case 'stopped':
    case 'expired':
      return 'neutral';
    default:
      return 'neutral';
  }
}

// ── Table ──────────────────────────────────────────────────────────────────

export function Table({
  headers,
  children,
}: {
  headers: string[];
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-800">
            {headers.map((h) => (
              <th
                key={h}
                className="text-left text-xs font-medium text-neutral-500 uppercase tracking-wider py-2 px-3 whitespace-nowrap"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-800/60">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({
  children,
  mono,
  className = '',
}: {
  children: ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <td
      className={[
        'py-2 px-3 text-neutral-300',
        mono ? 'font-mono text-xs' : 'text-sm',
        className,
      ].join(' ')}
    >
      {children}
    </td>
  );
}

// ── Input / Label ──────────────────────────────────────────────────────────

export function Input({
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={[
        'block w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500',
        className,
      ].join(' ')}
    />
  );
}

export function Select({
  className = '',
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className={[
        'block w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500',
        className,
      ].join(' ')}
    >
      {children}
    </select>
  );
}

export function Label({
  children,
  htmlFor,
}: {
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="block text-xs font-medium text-neutral-400 mb-1"
    >
      {children}
    </label>
  );
}

// ── Spinner ────────────────────────────────────────────────────────────────

export function Spinner({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const sz = size === 'sm' ? 'w-3 h-3' : size === 'lg' ? 'w-8 h-8' : 'w-5 h-5';
  return (
    <svg
      className={[sz, 'animate-spin text-neutral-400'].join(' ')}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}

// ── EmptyState ─────────────────────────────────────────────────────────────

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
      <div className="text-neutral-600 text-4xl select-none">&#9634;</div>
      <p className="text-sm font-medium text-neutral-400">{title}</p>
      {description && (
        <p className="text-xs text-neutral-600 max-w-xs">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

// ── ErrorState ─────────────────────────────────────────────────────────────

export function ErrorState({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-12 gap-3">
      <p className="text-sm text-red-400">{message}</p>
      {retry && (
        <Button variant="ghost" size="sm" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}

// ── CopyButton ─────────────────────────────────────────────────────────────

import { useState } from 'react';

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      onClick={copy}
      title="Copy to clipboard"
      className="ml-1 text-xs text-neutral-500 hover:text-neutral-200 transition-colors cursor-pointer"
    >
      {copied ? '✓' : '⎘'}
    </button>
  );
}

// ── CodeBlock ──────────────────────────────────────────────────────────────

export function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative rounded border border-neutral-700 bg-neutral-950 p-3 group">
      <code className="font-mono text-xs text-green-300 whitespace-pre-wrap break-all">
        {code}
      </code>
      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <CopyButton text={code} />
      </div>
    </div>
  );
}

// ── Modal ──────────────────────────────────────────────────────────────────

export function Modal({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-md rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-neutral-100">{title}</h3>
          <button
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-200 transition-colors text-lg leading-none"
          >
            &times;
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── UpgradeBanner ──────────────────────────────────────────────────────────

export function UpgradeBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-yellow-800 bg-yellow-900/20 px-4 py-3 flex items-center gap-3">
      <span className="text-yellow-400 text-lg">&#9888;</span>
      <div className="flex-1">
        <p className="text-sm text-yellow-300">{message}</p>
      </div>
      <Link
        href="/dashboard/billing"
        className="text-xs text-yellow-300 underline underline-offset-2 hover:text-yellow-100 whitespace-nowrap"
      >
        Upgrade plan
      </Link>
    </div>
  );
}

// ── SectionTitle ───────────────────────────────────────────────────────────

export function SectionTitle({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between mb-4">
      <h1 className="text-base font-semibold text-neutral-100">{children}</h1>
      {action && <div>{action}</div>}
    </div>
  );
}
