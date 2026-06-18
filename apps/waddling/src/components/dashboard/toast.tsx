'use client';

/**
 * Minimal toast notifications for the dashboard (dependency-free).
 *
 * The web app uses `sonner`; waddling keeps its dependency surface small, so
 * this is a tiny self-contained provider + `useToast()` hook styled to match
 * the dashboard's dark UI. Toasts auto-dismiss after a few seconds and stack in
 * the bottom-right. Mount <ToastProvider> once (in DashboardShell) and call
 * `const toast = useToast()` anywhere below it: `toast.success('Saved')`.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

type ToastVariant = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  message: string;
  variant: ToastVariant;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const variantClass: Record<ToastVariant, string> = {
  success: 'border-green-800 bg-green-900/80 text-green-200',
  error: 'border-red-800 bg-red-900/80 text-red-200',
  info: 'border-neutral-700 bg-neutral-800/90 text-neutral-200',
};

const variantGlyph: Record<ToastVariant, string> = {
  success: '✓',
  error: '✕',
  info: 'ℹ',
};

const DISMISS_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const remove = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (message: string, variant: ToastVariant) => {
      seq.current += 1;
      const id = seq.current;
      setToasts((ts) => [...ts, { id, message, variant }]);
      setTimeout(() => remove(id), DISMISS_MS);
    },
    [remove],
  );

  // Stable API (push is stable via useCallback) so consumers don't re-render
  // every time a toast is added/removed.
  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => push(m, 'success'),
      error: (m) => push(m, 'error'),
      info: (m) => push(m, 'info'),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={[
              'pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg backdrop-blur-sm',
              variantClass[t.variant],
            ].join(' ')}
          >
            <span className="mt-0.5 select-none font-mono text-xs opacity-80">
              {variantGlyph[t.variant]}
            </span>
            <span className="flex-1 break-words">{t.message}</span>
            <button
              onClick={() => remove(t.id)}
              aria-label="Dismiss"
              className="ml-1 select-none text-xs opacity-60 transition-opacity hover:opacity-100"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * Access the toast API. Safe to call when no provider is mounted (returns a
 * no-op) so components don't crash outside the dashboard shell.
 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  return ctx ?? NOOP;
}

const NOOP: ToastApi = {
  success: () => undefined,
  error: () => undefined,
  info: () => undefined,
};
