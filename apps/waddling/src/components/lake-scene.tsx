'use client';

import { useEffect, useRef } from 'react';
import { useTheme } from 'fumadocs-ui/provider/base';

/**
 * ASCII-shader hero scene: a looped watery-noise lake, a simulated Claude
 * Code terminal rising out of it flanked by Python/JS DuckDB code windows,
 * rubber ducks on floaties, and a flock of colored ducks paddling around.
 *
 * Zero assets, zero deps. Every frame is computed as a coarse cell grid
 * (char + palette index) and drawn as run-batched monospace text on a 2D
 * canvas. Capped at 30fps, paused offscreen, static under reduced motion.
 *
 * Seamless loop: every periodic term is a function of the phase angle
 * p = 2π·(t mod LOOP_MS)/LOOP_MS, and the water noise is sampled on a
 * circular path through the lattice — frame(t) === frame(t + LOOP_MS)
 * exactly (once the one-shot emergence intro has finished).
 */

const RAMP = ' .·:~=+*#%@';
const FONT = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const CELL_H = 14;
const LOOP_MS = 12000;
const TAU = Math.PI * 2;

const PALETTE = [
  '', //          0  empty (never drawn)
  '#3f3f46', //   1  sky star
  '#047857', //   2  water dim
  '#10b981', //   3  water mid
  '#6ee7b7', //   4  water sparkle
  '#e4e4e7', //   5  bright text / window frame
  '#34d399', //   6  emerald accent
  '#059669', //   7  emerald dim
  '#fbbf24', //   8  hero duck body
  '#fb923c', //   9  duck beak
  '#fb7185', //  10  floatie ring
  '#f87171', //  11  red (traffic dot, deny)
  '#facc15', //  12  traffic dot yellow
  '#34d399', //  13  traffic dot green
  '#52525b', //  14  chrome dim (title, box border)
  '#a78bfa', //  15  violet duck
  '#7dd3fc', //  16  sky duck
  '#f0abfc', //  17  pink duck
  '#fafafa', //  18  white duck
  '#bef264', //  19  lime duck
  '#fdba74', //  20  peach duck
  '#a1a1aa', //  21  terminal dim text
];

// Light-mode palette (same slots). The near-white slots — bright text/frame
// (5), white duck (18), terminal dim (21) — invert to warm ink so they read on
// paper; the water tiers shift a step darker (sparkle→emerald-500, dim→-800);
// the duck/status hues deepen one stop for contrast on the light background.
const PALETTE_LIGHT = [
  '', //          0  empty (never drawn)
  '#a8a29e', //   1  sky star (subtle warm gray)
  '#065f46', //   2  water dim
  '#059669', //   3  water mid
  '#10b981', //   4  water sparkle
  '#1c1917', //   5  bright text / window frame (ink)
  '#059669', //   6  emerald accent
  '#047857', //   7  emerald dim
  '#f59e0b', //   8  hero duck body
  '#ea580c', //   9  duck beak
  '#e11d48', //  10  floatie ring
  '#dc2626', //  11  red (deny)
  '#ca8a04', //  12  traffic dot yellow
  '#059669', //  13  traffic dot green
  '#78716c', //  14  chrome dim (title, box border)
  '#7c3aed', //  15  violet duck
  '#0284c7', //  16  sky duck
  '#c026d3', //  17  pink duck
  '#57534e', //  18  white duck → warm ink
  '#65a30d', //  19  lime duck
  '#f97316', //  20  peach duck
  '#57534e', //  21  terminal dim text
];

const BG_DARK = '#09090b';
const BG_LIGHT = '#fafaf9';

// rubber duck on a floatie ring, facing left; the color map doubles as an
// opacity mask: hex digit = palette slot (8 body→remapped, 9 beak, A ring),
// '0' = opaque interior (erases water/stars behind), ' ' = transparent
const DUCK = [
  '  __    ',
  '<(o )__ ',
  ' (    \\ ',
  '(~~~~~~)',
];
const DUCK_COLOR = [
  '  88    ',
  '9880888 ',
  ' 800008 ',
  'AAAAAAAA',
];

// small swimming ducks, left- and right-facing ('<'/'>' beaks get beak color)
const DUCKLING_L = ['  _   ', '<(o)__', ' (___/'];
const DUCKLING_R = ['   _  ', '__(o)>', '\\___) '];

// the flock: wrap ducks lap the lake (laps per loop), osc ducks paddle back
// and forth; dy is rows below the horizon, bobK/ph vary the bobbing
interface FlockDuck {
  color: number;
  fx: number;
  dy: number;
  bobK: number;
  ph: number;
  laps?: number;
  dir?: number;
  osc?: number;
  oscK?: number;
}
const FLOCK: FlockDuck[] = [
  { color: 15, fx: 0.08, dy: 1, laps: 1, dir: 1, bobK: 3, ph: 0.7 },
  { color: 16, fx: 0.5, dy: 3, laps: 1, dir: -1, bobK: 4, ph: 2.1 },
  { color: 17, fx: 0.25, dy: 5, osc: 0.16, oscK: 1, bobK: 2, ph: 4.2 },
  { color: 19, fx: 0.78, dy: 2, laps: 2, dir: 1, bobK: 5, ph: 1.3 },
  { color: 18, fx: 0.65, dy: 6, osc: 0.1, oscK: 2, bobK: 3, ph: 3.4 },
  { color: 20, fx: 0.35, dy: 4, laps: 1, dir: -1, bobK: 2, ph: 5.6 },
];

// extra floatie ducks drifting on the open water (wide screens only)
const FLOATIES = [
  { fx: 0.16, dy: 3, body: 17, ring: 19, bobK: 3, ph: 2.6, driftK: 1, drift: 0.03 },
  { fx: 0.34, dy: 5, body: 18, ring: 16, bobK: 2, ph: 5.1, driftK: 2, drift: 0.02 },
];

// drifting sky clouds. The digit map picks palette slot 14 (chrome dim) for the
// brighter tops, slot 1 (sky star colour) for the body; ' ' is transparent.
// Each sprite is a fixed-width box with the bottom widest and the body centred
// above it, so the shape holds together at any size.
const CLOUD_S = ['  .-.  ', ' (   ) ', '(_____)'];
const CLOUD_S_C = ['  222  ', ' 1   1 ', '1111111'];
const CLOUD_M = ['   .-~-.   ', ' (       ) ', '(_________)'];
const CLOUD_M_C = ['   22222   ', ' 1       1 ', '11111111111'];

// speed is in cols/sec — kept slow (and matched to the standalone SkyScene)
// so clouds barely creep; they wrap while fully off-screen in the gutter, so
// the drift reads as seamless even though it isn't locked to the 12s loop.
// fy is the cloud's height as a fraction of the sky band.
const SKY_CLOUDS = [
  { art: CLOUD_M, map: CLOUD_M_C, fy: 0.16, speed: 1.1, ph: 0.0 },
  { art: CLOUD_S, map: CLOUD_S_C, fy: 0.4, speed: 1.8, ph: 0.62 },
  { art: CLOUD_S, map: CLOUD_S_C, fy: 0.28, speed: 1.4, ph: 0.32 },
];

type Seg = [string, number];

// simulated Claude Code session — `at` is the reveal tick (64 ticks/loop);
// the transcript scrolls (tail shown) once it outgrows the pane
const TERM_MSG = 'do the EMEA revenue rollup';
const TERM_LINES: { at: number; segs: Seg[] }[] = [
  { at: 16, segs: [['> ', 21], [TERM_MSG, 5]] },
  { at: 17, segs: [] },
  { at: 19, segs: [['● ', 6], ['waddling — list_tables (mcp)', 21]] },
  { at: 21, segs: [['  └ ', 14], ['14 tables · 6ms · ', 21], ['allow', 6]] },
  { at: 23, segs: [] },
  { at: 25, segs: [['● ', 6], ['waddling — describe (mcp)', 21]] },
  { at: 27, segs: [['  └ ', 14], ['9 columns · 3ms · ', 21], ['allow', 6]] },
  { at: 29, segs: [] },
  { at: 31, segs: [['● ', 6], ['waddling — query (mcp)', 21]] },
  { at: 33, segs: [['  └ ', 14], ['SELECT region, sum(revenue)…', 7]] },
  { at: 35, segs: [['  └ ', 14], ['12 rows · 84ms · ', 21], ['allow', 6]] },
  { at: 37, segs: [] },
  { at: 39, segs: [['● ', 6], ['waddling — append events (mcp)', 21]] },
  { at: 41, segs: [['  └ ', 14], ['INSERT 1 row · 11ms · ', 21], ['allow', 6]] },
  { at: 43, segs: [] },
  { at: 45, segs: [['● ', 6], ['read customers.ssn', 21]] },
  { at: 47, segs: [['  └ ', 14], ['deny', 11], [' — column not in policy', 21]] },
  { at: 49, segs: [] },
  { at: 52, segs: [['✓ ', 6], ['4 allowed · 1 denied · audited', 21]] },
];

// side windows: DuckDB access code in python and javascript
const CODE_WINS = [
  {
    title: ' etl.py',
    cx: 0.52,
    w: 32,
    h: 9,
    delay: 1100,
    bobPh: 2.2,
    lines: [
      [['import', 6], [' duckdb', 21]],
      [['con = duckdb.connect()', 21]],
      [['con.sql(', 21], ['"ATTACH \'quack:gw\'"', 7], [')', 21]],
      [['df = con.sql(', 21]],
      [['  "FROM lake.sales"', 7], [').df()', 21]],
    ] as Seg[][],
  },
  {
    title: ' query.ts',
    cx: 0.93,
    w: 26,
    h: 9,
    delay: 1900,
    bobPh: 4.4,
    lines: [
      [['import', 6], [' { connect }', 21]],
      [['  from ', 6], ["'@duckdb/node'", 7]],
      [['const', 6], [' db = connect()', 21]],
      [['await', 6], [' db.run(', 21]],
      [['  "FROM lake.sales"', 7], [')', 21]],
    ] as Seg[][],
  },
];

const hash = (x: number, y: number) => {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
};

// integer lattice hash (no trig — cheap enough for per-cell fBm)
const ihash = (x: number, y: number) => {
  let n = (x | 0) * 374761393 + (y | 0) * 668265263;
  n = (n ^ (n >> 13)) * 1274126177;
  return ((n ^ (n >> 16)) >>> 0) / 4294967295;
};

// smooth 2D value noise
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

export function LakeScene({ className = '' }: { className?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Re-keyed on resolvedTheme: the whole loop reinitialises on theme change,
    // so the scene repaints in the active palette (and replays its emergence).
    const isLight = resolvedTheme === 'light';
    const palette = isLight ? PALETTE_LIGHT : PALETTE;
    const bg = isLight ? BG_LIGHT : BG_DARK;

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
      rows = Math.max(14, Math.floor(cssH / CELL_H));
      offsetX = (cssW - cols * cellW) / 2;
      charBuf = new Array(cols * rows).fill(' ');
      colorBuf = new Uint8Array(cols * rows);
      const horizon = Math.floor(rows * 0.58);
      stars = [];
      for (let y = 0; y < horizon; y++) {
        for (let x = 0; x < cols; x++) {
          if (hash(x, y) > 0.991) stars.push({ x, y, s: hash(y, x) });
        }
      }
    };

    const render = (t: number) => {
      colorBuf.fill(0);
      const W = cols;
      const H = rows;
      const horizon = Math.floor(H * 0.58);

      // loop phase — all periodic motion derives from p
      const p = ((t % LOOP_MS) / LOOP_MS) * TAU;
      const c1 = Math.cos(p);
      const s1 = Math.sin(p);
      const c2 = Math.cos(2 * p);
      const s2 = Math.sin(2 * p);

      const put = (x: number, y: number, ch: string, col: number) => {
        if (x >= 0 && x < W && y >= 0 && y < H) {
          const i = y * W + x;
          charBuf[i] = ch;
          colorBuf[i] = col;
        }
      };

      const stampFloatie = (dx: number, dy: number, body: number, ring: number) => {
        for (let r = 0; r < DUCK.length; r++) {
          for (let c = 0; c < DUCK[r].length; c++) {
            const mc = DUCK_COLOR[r][c];
            if (mc === ' ') continue;
            if (mc === '0') {
              put(dx + c, dy + r, ' ', 0); // opaque interior — no water inside
              continue;
            }
            const base = parseInt(mc, 16);
            const col = base === 8 ? body : base === 10 ? ring : base;
            put(dx + c, dy + r, DUCK[r][c], col);
          }
        }
      };

      // terminal geometry — rises out of the lake, then bobs; sits to the
      // right on wide grids, centered on narrow (mobile) ones. Width is
      // content-driven: wide enough for the transcript, shrink only when
      // the grid itself is too small.
      const narrow = W < 64;
      const winW = Math.min(44, Math.max(24, W - 6));
      const winH = Math.min(16, Math.max(8, Math.floor(H * 0.52)), horizon - 2);
      const winX = Math.min(W - winW - 3, Math.max(2, Math.floor(W * (narrow ? 0.5 : 0.72) - winW / 2)));
      const emerge = Math.min(1, Math.max(0, (t - 400) / 2800));
      const ease = 1 - (1 - emerge) ** 3;
      const bob = emerge >= 1 ? Math.round(Math.sin(2 * p)) : 0;
      const winTop = horizon + 1 - Math.round(ease * winH) + bob;

      // side code windows (skipped on narrow grids, or when the terminal
      // would cover them so fully that only a broken sliver pokes out)
      const sideWins = narrow
        ? []
        : CODE_WINS.map((cw) => {
            const e = Math.min(1, Math.max(0, (t - cw.delay) / 2800));
            const cease = 1 - (1 - e) ** 3;
            const cbob = e >= 1 ? Math.round(Math.sin(2 * p + cw.bobPh)) : 0;
            return {
              ...cw,
              x: Math.min(W - cw.w - 1, Math.max(1, Math.floor(W * cw.cx - cw.w / 2))),
              top: horizon + 1 - Math.round(cease * cw.h) + cbob,
            };
          }).filter((sw) => {
            if (sw.x + sw.w <= winX || sw.x >= winX + winW) return true; // no overlap
            const leftVis = winX - sw.x;
            const rightVis = sw.x + sw.w - (winX + winW);
            return Math.max(leftVis, rightVis) >= 10;
          });

      // reflection rects for every window
      const reflect = [
        ...sideWins.map((sw) => ({ x: sw.x, w: sw.w, top: sw.top })),
        { x: winX, w: winW, top: winTop },
      ];

      // sky — sparse twinkling stars
      for (const st of stars) {
        if (Math.sin(2 * p + st.s * 31) > 0.2) put(st.x, st.y, '·', 1);
      }

      // drifting clouds — wrap across a span wider than the grid, creeping at a
      // few cols/sec (continuous, not loop-locked). Drawn over the stars, but
      // before the water/windows so the terminal rises in front of them.
      const tcloud = t / 1000;
      const cloudClan = narrow ? SKY_CLOUDS.slice(0, 2) : SKY_CLOUDS;
      for (const cl of cloudClan) {
        const cw = cl.art[0].length;
        const cspan = W + cw + 8;
        const pos = cl.ph * cspan + cl.speed * tcloud;
        const cx0 = Math.floor(((pos % cspan) + cspan) % cspan) - cw - 4;
        const cy0 = Math.max(0, Math.floor(cl.fy * (horizon - cl.art.length)));
        for (let r = 0; r < cl.art.length; r++) {
          const line = cl.art[r];
          const mline = cl.map[r];
          for (let c = 0; c < line.length; c++) {
            const ch = line[c];
            if (ch === ' ') continue;
            put(cx0 + c, cy0 + r, ch, mline[c] === '2' ? 14 : 1);
          }
        }
      }

      // water — two-octave looped value noise with window reflections
      for (let y = horizon; y < H; y++) {
        const depth = (y - horizon) / (H - horizon);
        const my = 2 * horizon - y; // mirrored row for reflection
        const jitter = Math.round(Math.sin(y * 1.7 + 2 * p) * 1.4);
        for (let x = 0; x < W; x++) {
          const n =
            0.62 * vnoise(x * 0.14 + 5 * c1 + 31.7, y * 0.42 + 5 * s1 + 11.3) +
            0.38 * vnoise(x * 0.31 + 9 * c2 + 73.1, y * 0.83 + 9 * s2 + 47.9);
          let b = 0.1 + 0.8 * n;
          b = b * b * (3 - 2 * b); // contrast curve — makes glints pop
          b *= 1 - depth * 0.4;
          const jx = x + jitter;
          for (const rw of reflect) {
            if (my >= rw.top && my < horizon && jx >= rw.x && jx < rw.x + rw.w) {
              b += 0.2;
              if (my === rw.top || jx === rw.x || jx === rw.x + rw.w - 1) b += 0.25;
              break;
            }
          }
          if (emerge < 1 && y <= horizon + 2 && x >= winX - 2 && x <= winX + winW + 1) {
            b += (1 - ease) * 0.5 * hash(x, y + Math.floor(t / 180)); // churn while rising
          }
          if (b < 0.08) continue;
          const ch = RAMP[Math.min(RAMP.length - 1, Math.floor(b * (RAMP.length - 1)))];
          put(x, y, ch, b > 0.68 ? 4 : b > 0.42 ? 3 : 2);
        }
      }

      // side code windows — behind the terminal, dim chrome
      for (const sw of sideWins) {
        for (let y = Math.max(0, sw.top); y < horizon; y++) {
          const r = y - sw.top;
          for (let x = sw.x; x < sw.x + sw.w; x++) put(x, y, ' ', 0); // opaque pane
          if (r === 0) {
            put(sw.x, y, '┌', 14);
            for (let x = sw.x + 1; x < sw.x + sw.w - 1; x++) put(x, y, '─', 14);
            put(sw.x + sw.w - 1, y, '┐', 14);
            continue;
          }
          put(sw.x, y, '│', 14);
          put(sw.x + sw.w - 1, y, '│', 14);
          if (r === 1) {
            for (let k = 0; k < Math.min(sw.title.length, sw.w - 4); k++) {
              if (sw.title[k] !== ' ') put(sw.x + 2 + k, y, sw.title[k], 14);
            }
          } else if (r === 2) {
            put(sw.x, y, '├', 14);
            for (let x = sw.x + 1; x < sw.x + sw.w - 1; x++) put(x, y, '─', 14);
            put(sw.x + sw.w - 1, y, '┤', 14);
          } else {
            const line = sw.lines[r - 3];
            if (line) {
              let cx = sw.x + 2;
              for (const [s, col] of line) {
                for (let k = 0; k < s.length && cx < sw.x + sw.w - 2; k++, cx++) {
                  if (s[k] !== ' ') put(cx, y, s[k], col);
                }
              }
            }
          }
        }
      }

      // the terminal — only rows above the waterline (the rest is submerged)
      const title = winW - 11 >= 20 ? ' claude — waddling' : ' claude';
      const tick = (p / TAU) * 64;
      const typedN =
        tick < 2 ? 0 : tick < 14 ? Math.floor(((tick - 2) / 12) * TERM_MSG.length) : TERM_MSG.length;
      const sent = tick >= 16;
      const cursorOn = Math.sin(8 * p) > 0;
      const boxTop = winH - 4;
      const paneRows = Math.max(1, boxTop - 3);
      const visibleLines = TERM_LINES.filter((l) => sent && tick >= l.at).slice(-paneRows);
      for (let y = Math.max(0, winTop); y < horizon; y++) {
        const r = y - winTop;
        for (let x = winX; x < winX + winW; x++) put(x, y, ' ', 0); // opaque pane
        if (r === 0) {
          put(winX, y, '┌', 5);
          for (let x = winX + 1; x < winX + winW - 1; x++) put(x, y, '─', 5);
          put(winX + winW - 1, y, '┐', 5);
          continue;
        }
        put(winX, y, '│', 5);
        put(winX + winW - 1, y, '│', 5);
        if (r === 1) {
          put(winX + 2, y, '●', 11);
          put(winX + 4, y, '●', 12);
          put(winX + 6, y, '●', 13);
          for (let k = 0; k < Math.min(title.length, winW - 11); k++) {
            if (title[k] !== ' ') put(winX + 9 + k, y, title[k], 14);
          }
        } else if (r === 2) {
          put(winX, y, '├', 5);
          for (let x = winX + 1; x < winX + winW - 1; x++) put(x, y, '─', 5);
          put(winX + winW - 1, y, '┤', 5);
        } else if (r === boxTop || r === boxTop + 2) {
          // input box top/bottom
          put(winX + 2, y, r === boxTop ? '╭' : '╰', 14);
          for (let x = winX + 3; x < winX + winW - 3; x++) put(x, y, '─', 14);
          put(winX + winW - 3, y, r === boxTop ? '╮' : '╯', 14);
        } else if (r === boxTop + 1) {
          // input line: typing before send, blinking idle cursor after
          put(winX + 2, y, '│', 14);
          put(winX + winW - 3, y, '│', 14);
          put(winX + 4, y, '>', 21);
          let cx = winX + 6;
          if (!sent) {
            for (let k = 0; k < typedN && cx < winX + winW - 4; k++, cx++) {
              if (TERM_MSG[k] !== ' ') put(cx, y, TERM_MSG[k], 5);
            }
          }
          if (cursorOn && cx < winX + winW - 4) put(cx, y, '█', 6);
        } else if (r >= 3 && r < boxTop) {
          // transcript line
          const line = visibleLines[r - 3];
          if (line) {
            let cx = winX + 2;
            for (const [s, col] of line.segs) {
              for (let k = 0; k < s.length && cx < winX + winW - 2; k++, cx++) {
                if (s[k] !== ' ') put(cx, y, s[k], col);
              }
            }
          }
        }
      }

      // the flock — colored ducks lapping the lake or paddling back and forth
      const span = W + 16;
      const flock = narrow ? FLOCK.slice(0, 4) : FLOCK;
      for (const d of flock) {
        let dx: number;
        let facingRight: boolean;
        if (d.osc && d.oscK) {
          dx = Math.round(d.fx * W + Math.sin(d.oscK * p + d.ph) * d.osc * W);
          facingRight = Math.cos(d.oscK * p + d.ph) >= 0;
        } else {
          const pos = d.fx * span + d.dir! * d.laps! * span * (p / TAU);
          dx = Math.round(((pos % span) + span) % span) - 8;
          facingRight = d.dir! > 0;
        }
        const dy = Math.min(H - 3, horizon + d.dy + Math.round(Math.sin(d.bobK * p + d.ph)));
        const sprite = facingRight ? DUCKLING_R : DUCKLING_L;
        for (let r = 0; r < sprite.length; r++) {
          for (let c = 0; c < sprite[r].length; c++) {
            const ch = sprite[r][c];
            if (ch === ' ') continue;
            put(dx + c, dy + r, ch, ch === '<' || ch === '>' ? 9 : d.color);
          }
        }
      }

      // extra floatie ducks drifting on open water
      if (!narrow) {
        for (const f of FLOATIES) {
          const fdx = Math.round((f.fx + Math.sin(f.driftK * p + f.ph) * f.drift) * W);
          const fdy = horizon + f.dy - 3 + Math.round(Math.sin(f.bobK * p + f.ph));
          stampFloatie(fdx, fdy, f.body, f.ring);
        }
      }

      // the hero duck — paddles in from the left, bobs in front of the terminal
      const enter = Math.min(1, Math.max(0, (t - 1200) / 2600));
      const enterEase = 1 - (1 - enter) ** 2;
      const driftRange = Math.min(8, Math.floor(winW * 0.25));
      const targetX = Math.round(winX + winW * 0.5 - 4 + Math.sin(p) * driftRange);
      const dx = Math.round(-10 + (targetX + 10) * enterEase);
      const dy = horizon - 1 + Math.round(Math.sin(4 * p + 1));
      stampFloatie(dx, dy, 8, 10);

      // paint: background fill + run-batched text per row
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, cssW, cssH);
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
      render(LOOP_MS + 7500); // settled mid-loop scene, single frame
      const ro = new ResizeObserver(() => {
        resize();
        render(LOOP_MS + 7500);
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
    <div ref={wrapRef} className={`pointer-events-none overflow-hidden ${className}`}>
      <canvas
        ref={canvasRef}
        className="block h-full w-full"
        role="img"
        aria-label="Animated ASCII art: a Claude Code terminal and Python/JavaScript DuckDB code windows emerging from a lake, with colored rubber ducks on floaties paddling around"
      />

    </div>
  );
}
