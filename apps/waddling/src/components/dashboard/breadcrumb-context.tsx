'use client';

/**
 * Breadcrumb label overrides — lets a page teach the top-navbar breadcrumb a
 * human label for a dynamic path segment (e.g. an agent id → the agent name),
 * so the navbar shows "Agents › analyst" instead of "Agents › agt_9f2c…".
 *
 * The shell renders the breadcrumb in the header; pages register an override
 * with `useBreadcrumbLabel(segment, label)` and it is cleaned up on unmount.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

type Overrides = Record<string, string>;

interface BreadcrumbCtx {
  overrides: Overrides;
  set: (segment: string, label: string) => void;
  clear: (segment: string) => void;
}

const Ctx = createContext<BreadcrumbCtx | null>(null);

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [overrides, setOverrides] = useState<Overrides>({});

  const set = useCallback((segment: string, label: string) => {
    setOverrides((prev) => (prev[segment] === label ? prev : { ...prev, [segment]: label }));
  }, []);

  const clear = useCallback((segment: string) => {
    setOverrides((prev) => {
      if (!(segment in prev)) return prev;
      const next = { ...prev };
      delete next[segment];
      return next;
    });
  }, []);

  const value = useMemo(() => ({ overrides, set, clear }), [overrides, set, clear]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Read the current overrides (used by the shell's Breadcrumbs). */
export function useBreadcrumbOverrides(): Overrides {
  return useContext(Ctx)?.overrides ?? {};
}

/**
 * Register a human label for a dynamic path segment. Pass the raw segment (e.g.
 * the agent id from the URL) and its display label (e.g. the agent name). No-op
 * until both are known; auto-clears on unmount or when they change.
 */
export function useBreadcrumbLabel(segment: string | undefined, label: string | undefined) {
  const ctx = useContext(Ctx);
  // Depend on the STABLE set/clear callbacks, not the ctx object — the provider
  // recreates ctx whenever `overrides` changes, so depending on ctx here would
  // re-run the effect every update and its cleanup↔set would thrash forever
  // (React #185 "maximum update depth exceeded").
  const set = ctx?.set;
  const clear = ctx?.clear;
  useEffect(() => {
    if (!set || !clear || !segment || !label) return;
    set(segment, label);
    return () => clear(segment);
  }, [set, clear, segment, label]);
}
