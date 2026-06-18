'use client';

import { useEffect, useRef } from 'react';
import { useTheme } from 'fumadocs-ui/provider/base';
import type { IconType } from 'react-icons';

/**
 * A small lake rendered with the SAME engine as lake-scene.tsx: a coarse cell
 * grid of two-octave looped value-noise water, with ducks stamped as ASCII
 * sprites that paddle in lanes (the flock's wrap/osc + bob movement) and a
 * snoozing duck's z's drawn as changing canvas text. Run-batched monospace
 * text on a 2D canvas, 30fps, paused offscreen, static under reduced motion.
 *
 * The only non-ASCII element is the hat: each hatted duck gets a react-icons
 * glyph overlaid as a DOM node whose transform is updated every frame to track
 * that duck's head cell, so it rides along with the moving sprite.
 */

const RAMP = ' .·:~=+*#%@';
const FONT_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
// loop period — longer = the whole scene (water ripples, paddling, bob) drifts slower
const LOOP_MS = 19000;
const TAU = Math.PI * 2;

const WATER_DARK = ['#047857', '#10b981', '#6ee7b7'];
const WATER_LIGHT = ['#065f46', '#059669', '#10b981'];

// floatie "hero" duck (the lake's DUCK sprite), right- and left-facing
const DUCK_R = ['    __  ', ' __( o)>', ' /    ) ', '(~~~~~~)'];
const DUCK_R_COLOR = ['    88  ', ' 8880889', ' 800008 ', 'AAAAAAAA'];
const DUCK_L = ['  __    ', '<(o )__ ', ' (    \\ ', '(~~~~~~)'];
const DUCK_L_COLOR = ['  88    ', '9880888 ', ' 800008 ', 'AAAAAAAA'];

// small swimming ducklings, left- and right-facing
const DUCKLING_L = ['  _   ', '<(o)__', ' (___/'];
const DUCKLING_R = ['   _  ', '__(o)>', '\\___) '];

// head-centre column within each sprite (for anchoring the hat)
const HEAD_COL = { heroR: 5, heroL: 2.5, duckR: 3, duckL: 2 };

export interface PondHat {
  icon: IconType;
  color?: string;
  /** hat width in cells */
  cells?: number;
  /** fine offsets in cells */
  dx?: number;
  dy?: number;
  rotate?: number;
  /** mirror independent of the duck's facing */
  flip?: boolean;
}

export interface PondDuck {
  kind: 'hero' | 'duckling';
  body: string;
  beak?: string;
  ring?: string;
  sleeping?: boolean;
  /** lane row (cells from the top) the duck paddles in */
  lane: number;
  /** horizontal home as a fraction of the width */
  fx: number;
  bobK: number;
  ph: number;
  /** wrap movement: laps per loop + direction … */
  laps?: number;
  dir?: number;
  /** … or osc movement: amplitude (fraction of width) + speed */
  osc?: number;
  oscK?: number;
  hat?: PondHat;
}

export interface LakePondProps {
  ducks: PondDuck[];
  size?: number;
  seed?: number;
  /** fixed height in px; omit to fill the parent (use h-full on className) */
  height?: number;
  className?: string;
}

// Bright duck colours read on the dark canvas but burn out on the light paper
// background. For light mode, cap each colour's lightness (and floor its
// saturation) so it stays legible — the equivalent of lake-scene's PALETTE_LIGHT.
const darkenForPaper = (hex: string): string => {
  const m = hex.replace('#', '');
  if (m.length !== 6) return hex;
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  l = Math.min(l, 0.44); // never brighter than mid-tone on paper
  if (s > 0.1) s = Math.max(s, 0.5); // keep colours saturated (grays stay gray)
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let nr = l;
  let ng = l;
  let nb = l;
  if (s !== 0) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    nr = hue2rgb(p, q, h + 1 / 3);
    ng = hue2rgb(p, q, h);
    nb = hue2rgb(p, q, h - 1 / 3);
  }
  const hx = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${hx(nr)}${hx(ng)}${hx(nb)}`;
};

const ihash = (x: number, y: number) => {
  let n = (x | 0) * 374761393 + (y | 0) * 668265263;
  n = (n ^ (n >> 13)) * 1274126177;
  return ((n ^ (n >> 16)) >>> 0) / 4294967295;
};
const vnoise = (u: number, v: number) => {
  const xi = Math.floor(u);
  const yi = Math.floor(v);
  const xf = u - xi;
  const yf = v - yi;
  const sx = xf * xf * (3 - 2 * xf);
  const sy = yf * yf * (3 - 2 * yf);
  const a = ihash(xi, yi);
  const b = ihash(xi + 1, yi);
  const c = ihash(xi, yi + 1);
  const d = ihash(xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
};

export function LakePond({ ducks, size = 20, seed = 0, height, className = '' }: LakePondProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hatRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const FONT = `${size}px ${FONT_STACK}`;
    const CELL_H = Math.round(size * 1.15);
    const isLight = resolvedTheme === 'light';
    const water = isLight ? WATER_LIGHT : WATER_DARK;
    const tone = (c: string) => (isLight ? darkenForPaper(c) : c);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // dynamic palette: 0 empty · 1-3 water · 4 z · then each duck's body/beak/ring
    const pal: string[] = ['', water[0], water[1], water[2], isLight ? '#78716c' : '#a1a1aa'];
    const meta = ducks.map((d) => {
      const bodyIdx = pal.push(tone(d.body)) - 1;
      const beakIdx = pal.push(tone(d.beak ?? '#fb923c')) - 1;
      const ringIdx = pal.push(tone(d.ring ?? d.body)) - 1;
      // pre-swap the sleepy eye on the hero
      return { bodyIdx, beakIdx, ringIdx };
    });

    let cols = 0;
    let rows = 0;
    let cellW = 6.6;
    let offsetX = 0;
    let cssW = 0;
    let cssH = 0;
    let charBuf: string[] = [];
    let colorBuf = new Uint8Array(0);

    const resize = () => {
      cssW = wrap.clientWidth;
      cssH = wrap.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = FONT;
      ctx.textBaseline = 'top';
      cellW = ctx.measureText('M').width || 6.6;
      cols = Math.max(10, Math.floor(cssW / cellW));
      rows = Math.max(4, Math.floor(cssH / CELL_H));
      offsetX = (cssW - cols * cellW) / 2;
      charBuf = new Array(cols * rows).fill(' ');
      colorBuf = new Uint8Array(cols * rows);
      // size + colour each hat to its duck (colour set here, not in render, so
      // it can't cause an SSR/client hydration mismatch when the theme resolves)
      ducks.forEach((d, i) => {
        const el = hatRefs.current[i];
        if (!el || !d.hat) return;
        el.style.width = `${(d.hat.cells ?? (d.kind === 'hero' ? 3.6 : 2.6)) * cellW}px`;
        if (d.hat.color) el.style.color = tone(d.hat.color);
      });
    };

    const put = (x: number, y: number, ch: string, col: number) => {
      if (x >= 0 && x < cols && y >= 0 && y < rows) {
        const i = y * cols + x;
        charBuf[i] = ch;
        colorBuf[i] = col;
      }
    };

    const render = (t: number) => {
      colorBuf.fill(0);
      const W = cols;
      const H = rows;
      const p = ((t % LOOP_MS) / LOOP_MS) * TAU;
      const c1 = Math.cos(p);
      const s1 = Math.sin(p);
      const c2 = Math.cos(2 * p);
      const s2 = Math.sin(2 * p);
      const sx = seed * 13.37;

      // water — two-octave looped value noise (same as the lake)
      for (let y = 0; y < H; y++) {
        const depth = y / H;
        for (let x = 0; x < W; x++) {
          const n =
            0.62 * vnoise(x * 0.16 + 5 * c1 + sx + 31.7, y * 0.5 + 5 * s1 + 11.3) +
            0.38 * vnoise(x * 0.34 + 9 * c2 + sx + 73.1, y * 0.9 + 9 * s2 + 47.9);
          let b = 0.1 + 0.8 * n;
          b = b * b * (3 - 2 * b);
          b *= 1 - depth * 0.2;
          if (b < 0.12) continue;
          const ch = RAMP[Math.min(RAMP.length - 1, Math.floor(b * (RAMP.length - 1)))];
          put(x, y, ch, b > 0.68 ? 3 : b > 0.42 ? 2 : 1);
        }
      }

      // ducks — paddling in their lanes, stamped over the water. Centre the
      // whole flock vertically in the grid (lanes are relative to each other).
      const span = W + 16;
      const sH = (d: PondDuck) => (d.kind === 'hero' ? 4 : 3);
      const laneMin = Math.min(...ducks.map((d) => d.lane));
      const laneMax = Math.max(...ducks.map((d) => d.lane + sH(d)));
      const laneOffset = Math.round((H - (laneMax - laneMin)) / 2 - laneMin);
      ducks.forEach((d, i) => {
        const m = meta[i];
        let dx: number;
        let facingRight: boolean;
        if (d.osc && d.oscK) {
          dx = Math.round(d.fx * W + Math.sin(d.oscK * p + d.ph) * d.osc * W);
          facingRight = Math.cos(d.oscK * p + d.ph) >= 0;
        } else {
          const pos = d.fx * span + (d.dir ?? 1) * (d.laps ?? 1) * span * (p / TAU);
          dx = Math.round(((pos % span) + span) % span) - 8;
          facingRight = (d.dir ?? 1) > 0;
        }
        const spriteH = d.kind === 'hero' ? 4 : 3;
        const row = Math.min(
          H - spriteH,
          Math.max(0, d.lane + laneOffset + Math.round(Math.sin(d.bobK * p + d.ph))),
        );

        if (d.kind === 'hero') {
          const baseSprite = facingRight ? DUCK_R : DUCK_L;
          const cmap = facingRight ? DUCK_R_COLOR : DUCK_L_COLOR;
          const sprite = d.sleeping ? baseSprite.map((l) => l.replace('o', 'u')) : baseSprite;
          for (let r = 0; r < sprite.length; r++) {
            for (let c = 0; c < sprite[r].length; c++) {
              const mc = cmap[r][c];
              if (mc === ' ') continue;
              if (mc === '0') {
                put(dx + c, row + r, ' ', 0); // erase water inside the duck
                continue;
              }
              const code = parseInt(mc, 16);
              const col = code === 9 ? m.beakIdx : code === 10 ? m.ringIdx : m.bodyIdx;
              put(dx + c, row + r, sprite[r][c], col);
            }
          }
        } else {
          const sprite = facingRight ? DUCKLING_R : DUCKLING_L;
          for (let r = 0; r < sprite.length; r++) {
            for (let c = 0; c < sprite[r].length; c++) {
              const ch = sprite[r][c];
              if (ch === ' ') continue;
              const col = ch === '<' || ch === '>' ? m.beakIdx : m.bodyIdx;
              put(dx + c, row + r, ch, col);
            }
          }
        }

        // head-centre column (for z's + hat anchoring)
        const headCol =
          dx + (d.kind === 'hero' ? (facingRight ? HEAD_COL.heroR : HEAD_COL.heroL) : facingRight ? HEAD_COL.duckR : HEAD_COL.duckL);

        // sleepy z's — changing canvas text drifting up off the head
        if (d.sleeping) {
          for (let k = 0; k < 2; k++) {
            const step = Math.floor((((t / 650 + k * 1.3) % 1) + 1) % 1 * 3);
            put(Math.round(headCol + 1 + k), row - 1 - step, step >= 2 ? 'Z' : 'z', 4);
          }
        }

        // move this duck's hat (DOM) to ride on its head
        if (d.hat) {
          const el = hatRefs.current[i];
          if (el) {
            const px = offsetX + (headCol + (d.hat.dx ?? 0)) * cellW;
            const py = (row + (d.hat.dy ?? 0)) * CELL_H;
            const sgn = (facingRight ? 1 : -1) * (d.hat.flip ? -1 : 1);
            el.style.transform = `translate(${px}px, ${py}px) translate(-50%, -100%) rotate(${d.hat.rotate ?? 0}deg) scaleX(${sgn})`;
          }
        }
      });

      // paint: clear + run-batched text per row
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
          ctx.fillStyle = pal[col];
          ctx.fillText(s, offsetX + x * cellW, py);
          x = x2;
        }
      }
    };

    resize();

    if (reduced) {
      render(LOOP_MS + 5200);
      const ro = new ResizeObserver(() => {
        resize();
        render(LOOP_MS + 5200);
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
      if (dt < 31) return;
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
  }, [resolvedTheme, ducks, size, seed]);

  return (
    <div
      ref={wrapRef}
      className={`pointer-events-none relative overflow-hidden ${className}`}
      style={{ height }}
      aria-hidden
    >
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" />
      {ducks.map((d, i) => {
        if (!d.hat) return null;
        const Hat = d.hat.icon;
        // colour is applied imperatively in the effect (theme-dependent) to
        // avoid a hydration mismatch; keep a static fallback here for SSR
        return (
          <span
            key={i}
            ref={(el) => {
              hatRefs.current[i] = el;
            }}
            className="absolute left-0 top-0"
            style={{ willChange: 'transform', color: d.hat.color }}
            suppressHydrationWarning
          >
            <Hat style={{ width: '100%', height: 'auto', display: 'block' }} />
          </span>
        );
      })}
    </div>
  );
}
