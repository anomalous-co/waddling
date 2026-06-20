'use client';

import { useEffect, useRef, useState } from 'react';
import type { DuckSpec } from './types';

interface DuckFieldProps {
  spec: DuckSpec;
  className?: string;
}

// Thin React wrapper around the imperative engine, optimized for fast loads:
//   1. The engine (and Three.js) is code-split — dynamically imported only once a
//      scene nears the viewport, so it stays out of the initial JS bundle.
//   2. The scene is lazy-mounted: no WebGL context / STL fetch happens until the
//      container scrolls within ~one screen of view.
// The spec is captured on mount; to swap layouts, give the element a new `key`.
export function DuckField({ spec, className }: DuckFieldProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  // Flip `near` true the first time the container approaches the viewport.
  // A scroll + getBoundingClientRect check rather than IntersectionObserver: it
  // behaves identically for our purposes and fires reliably in every environment.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const MARGIN = 400; // start loading ~half a screen early to avoid pop-in
    let done = false;
    const check = () => {
      if (done) return;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      if (r.top < vh + MARGIN && r.bottom > -MARGIN) {
        done = true;
        cleanup();
        setNear(true);
      }
    };
    const cleanup = () => {
      window.removeEventListener('scroll', check, true);
      window.removeEventListener('resize', check);
    };
    window.addEventListener('scroll', check, { passive: true, capture: true });
    window.addEventListener('resize', check);
    check(); // catch scenes already in view on mount
    return cleanup;
  }, []);

  // Once near, load the engine chunk and mount the scene.
  useEffect(() => {
    if (!near) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    import('./engine').then(({ mountDuckField }) => {
      const el = containerRef.current;
      if (cancelled || !el) return;
      cleanup = mountDuckField(el, spec);
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near]);

  return <div ref={containerRef} className={className} style={{ width: '100%', height: '100%' }} />;
}
