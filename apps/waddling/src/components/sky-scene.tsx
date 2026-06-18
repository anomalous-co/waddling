'use client';

import { useEffect, useRef } from 'react';
import { useTheme } from 'fumadocs-ui/provider/base';

/**
 * ASCII sky backdrop: puffy clouds drifting slowly across the band, with a
 * field of faintly twinkling stars at night (dark mode). Pure backdrop — sits
 * behind the call-to-action, kept dim so the foreground text stays legible.
 *
 * Same machinery as the lake scene but deliberately separate: zero assets,
 * a coarse cell grid drawn as run-batched monospace text on a transparent 2D
 * canvas, capped at 30fps, paused offscreen, static under reduced motion. The
 * canvas background is cleared (not filled), so the page colour shows through.
 */

const FONT = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const CELL_H = 14;
const TAU = Math.PI * 2;

// palette[0] is never drawn; clouds + stars are intentionally low-contrast.
// Mirrors the lake's convention — zinc family at night (its star is #3f3f46),
// deepened warm-stone on paper (its light star is the "subtle warm gray"
// #a8a29e) so shapes read against the #fafaf9 light page without shouting.
const PALETTE_DARK = [
  '', //          0  empty
  '#3f3f46', //   1  cloud body (zinc-700)
  '#52525b', //   2  cloud highlight (zinc-600)
  '#3f3f46', //   3  dim star (zinc-700 — matches the lake's star)
  '#71717a', //   4  bright star (zinc-500)
];
const PALETTE_LIGHT = [
  '', //          0  empty
  '#a8a29e', //   1  cloud body (stone-400 — subtle warm gray)
  '#78716c', //   2  cloud highlight (stone-500)
  '#a8a29e', //   3  (no stars by day — kept for slot parity)
  '#78716c', //   4
];

// cloud sprites, drawn in cloud colours; ' ' is transparent. The digit map
// picks body (1) vs. highlight (2) so the tops read a touch brighter. Each is a
// fixed-width box with the bottom widest and the body centred above it, so the
// shape stays intact at every size (no ragged rows on wide screens).
const CLOUD_S = ['  .-.  ', ' (   ) ', '(_____)'];
const CLOUD_S_C = ['  222  ', ' 1   1 ', '1111111'];

const CLOUD_M = ['   .-~-.   ', ' (       ) ', '(_________)'];
const CLOUD_M_C = ['   22222   ', ' 1       1 ', '11111111111'];

const CLOUD_L = ['    .-~~~~~-.    ', '  (           )  ', '(_______________)'];
const CLOUD_L_C = ['    222222222    ', '  1           1  ', '11111111111111111'];

interface Cloud {
  art: string[];
  map: string[];
  fy: number; // row position as fraction of sky height
  speed: number; // cols traversed per second (slow)
  phase: number; // starting x offset as fraction of span
}
const CLOUDS: Cloud[] = [
  { art: CLOUD_L, map: CLOUD_L_C, fy: 0.12, speed: 1.1, phase: 0.0 },
  { art: CLOUD_S, map: CLOUD_S_C, fy: 0.34, speed: 1.8, phase: 0.55 },
  { art: CLOUD_M, map: CLOUD_M_C, fy: 0.55, speed: 1.4, phase: 0.28 },
  { art: CLOUD_S, map: CLOUD_S_C, fy: 0.7, speed: 2.2, phase: 0.78 },
  { art: CLOUD_M, map: CLOUD_M_C, fy: 0.22, speed: 1.0, phase: 0.85 },
];

const hash = (x: number, y: number) => {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
};

export function SkyScene({ className = '' }: { className?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const isLight = resolvedTheme === 'light';
    const palette = isLight ? PALETTE_LIGHT : PALETTE_DARK;
    const showStars = !isLight; // stars only at night

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let cols = 0;
    let rows = 0;
    let cellW = 7.2;
    let offsetX = 0;
    let cssW = 0;
    let cssH = 0;
    let charBuf: string[] = [];
    let colorBuf = new Uint8Array(0);
    let stars: { x: number; y: number; s: number }[] = [];

    const resize = () => {
      cssW = wrap.clientWidth;
      cssH = wrap.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = FONT;
      ctx.textBaseline = 'top';
      cellW = ctx.measureText('M').width || 7.2;
      cols = Math.max(20, Math.floor(cssW / cellW));
      rows = Math.max(8, Math.floor(cssH / CELL_H));
      offsetX = (cssW - cols * cellW) / 2;
      charBuf = new Array(cols * rows).fill(' ');
      colorBuf = new Uint8Array(cols * rows);
      stars = [];
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          if (hash(x, y) > 0.985) stars.push({ x, y, s: hash(y, x) });
        }
      }
    };

    const render = (t: number) => {
      colorBuf.fill(0);
      const W = cols;
      const H = rows;
      const ts = t / 1000;
      const p = ts * (TAU / 12); // slow phase for star twinkle

      const put = (x: number, y: number, ch: string, col: number) => {
        if (x >= 0 && x < W && y >= 0 && y < H) {
          const i = y * W + x;
          charBuf[i] = ch;
          colorBuf[i] = col;
        }
      };

      // stars first — clouds draw over them
      if (showStars) {
        for (const st of stars) {
          const tw = Math.sin(p * 2 + st.s * 31);
          if (tw < -0.1) continue; // briefly winks out
          put(st.x, st.y, st.s > 0.6 ? '✦' : st.s > 0.3 ? '·' : '.', tw > 0.7 ? 4 : 3);
        }
      }

      // drifting clouds — wrap across a span wider than the grid so they slide
      // in from the left edge and off the right, seamlessly
      for (const cl of CLOUDS) {
        const cw = cl.art[0].length;
        const span = W + cw + 8;
        const x0 = Math.floor((((cl.phase * span + cl.speed * ts) % span) + span) % span) - cw - 4;
        const y0 = Math.floor(cl.fy * (H - cl.art.length));
        for (let r = 0; r < cl.art.length; r++) {
          const line = cl.art[r];
          const mline = cl.map[r];
          for (let c = 0; c < line.length; c++) {
            const ch = line[c];
            if (ch === ' ') continue;
            const m = mline[c];
            const col = m === '2' ? 2 : 1;
            put(x0 + c, y0 + r, ch, col);
          }
        }
      }

      // paint: clear (transparent) + run-batched text per row
      ctx.clearRect(0, 0, cssW, cssH);
      for (let y = 0; y < H; y++) {
        const py = y * CELL_H;
        let x = 0;
        while (x < W) {
          const col = colorBuf[y * W + x];
          if (!col) {
            x++;
            continue;
          }
          let s = charBuf[y * W + x];
          let x2 = x + 1;
          while (x2 < W && colorBuf[y * W + x2] === col) {
            s += charBuf[y * W + x2];
            x2++;
          }
          ctx.fillStyle = palette[col];
          ctx.fillText(s, offsetX + x * cellW, py);
          x = x2;
        }
      }
    };

    resize();

    if (reduced) {
      render(4000); // a settled static frame
      const ro = new ResizeObserver(() => {
        resize();
        render(4000);
      });
      ro.observe(wrap);
      return () => ro.disconnect();
    }

    let raf = 0;
    let elapsed = 0;
    let lastTs = -1;
    const frame = (ts: number) => {
      raf = requestAnimationFrame(frame);
      if (lastTs < 0) lastTs = ts;
      const dt = ts - lastTs;
      if (dt < 31) return; // ~30fps cap
      lastTs = ts;
      elapsed += Math.min(dt, 100);
      render(elapsed);
    };

    const start = () => {
      if (!raf) {
        lastTs = -1;
        raf = requestAnimationFrame(frame);
      }
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };

    const io = new IntersectionObserver(([e]) => (e.isIntersecting ? start() : stop()));
    io.observe(wrap);
    const ro = new ResizeObserver(() => {
      resize();
      render(elapsed);
    });
    ro.observe(wrap);

    return () => {
      stop();
      io.disconnect();
      ro.disconnect();
    };
  }, [resolvedTheme]);

  return (
    <div ref={wrapRef} className={`pointer-events-none overflow-hidden ${className}`} aria-hidden>
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
