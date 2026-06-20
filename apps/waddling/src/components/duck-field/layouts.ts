import type { DuckSpec, DuckInstance, Edge } from './types';

// A small deterministic-ish jitter helper so layouts can vary ducks without
// pulling in a seeded RNG. (Math.random is fine here — these run once at build.)
const rand = (a: number, b: number) => a + Math.random() * (b - a);

// ── 1. Cube lattice ───────────────────────────────────────────────────────
// The original /memory scene: a 5×5×5 grid of ducks wired into a 3-axis lattice,
// nearest duck to the camera hidden. Behavior-preserving reference layout.
export function cubeLattice({ n = 5, spacing = 5 }: { n?: number; spacing?: number } = {}): DuckSpec {
  return () => {
    const off = (n - 1) * spacing * 0.5;
    const ducks: DuckInstance[] = [];
    const idx = (l: number, r: number, c: number) => l * n * n + r * n + c;
    for (let layer = 0; layer < n; layer++) {
      for (let row = 0; row < n; row++) {
        for (let col = 0; col < n; col++) {
          ducks.push({
            position: [col * spacing - off, layer * spacing - off, row * spacing - off],
            scale: rand(0.85, 1.15),
            wobbleAmp: rand(0.02, 0.06),
            wobbleSpeed: rand(1, 3),
            spinSpeed: rand(0.3, 1.0),
          });
        }
      }
    }
    const edges: Edge[] = [];
    for (let layer = 0; layer < n; layer++) {
      for (let row = 0; row < n; row++) {
        for (let col = 0; col < n; col++) {
          const a = idx(layer, row, col);
          for (const [dl, dr, dc] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const) {
            const l2 = layer + dl, r2 = row + dr, c2 = col + dc;
            if (l2 < n && r2 < n && c2 < n) edges.push([a, idx(l2, r2, c2)]);
          }
        }
      }
    }
    return {
      ducks,
      edges,
      hideNearest: true,
      camera: { position: [0.0367, 2.7524, 11.9785], target: [0.3078, 3.1382, -0.0541] },
    };
  };
}

// ── 2. Single duck ────────────────────────────────────────────────────────
// One hero duck, gently turning. "Easy analytics agents."
export function singleDuck(): DuckSpec {
  // One centred duck; the camera auto-fits so it fills the frame. Target the
  // duck's own centre (origin) so the fit doesn't pad empty space above it.
  return () => ({
    ducks: [{ position: [0, 0, 0], scale: 6, wobbleAmp: 0.1, wobbleSpeed: 1.2, spinSpeed: 0.5 }],
    camera: { position: [0, 1.5, 12], target: [0, 0, 0], fov: 45 },
  });
}

// ── 3. Lakehouse ──────────────────────────────────────────────────────────
// A shallow stack of ducks floating above the layered data-lake mark — the three
// logo layers laid out as flat lake planes below the cube — in 3/4 isometric.
export function lakehouse(): DuckSpec {
  // 2×2×2 cube; bottom layer at y = -spacing/2 so it can rest on the lake.
  const spacing = 5;
  const base = cubeLattice({ n: 2, spacing });
  const lift = 2; // float the whole cube up off the lake
  return (ctx) => {
    const built = base(ctx);
    return {
      ...built,
      hideNearest: false,
      seatOnGrid: true,
      // Lift the cube up...
      ducks: built.ducks.map((d) => ({ ...d, position: [d.position[0], d.position[1] + lift, d.position[2]] as [number, number, number] })),
      // ...and drop the lake down, so the stack visibly floats above the surface.
      lakes: [{ layer: 2, y: -4, size: 28, rotate: Math.PI / 4 }],
      // 3/4 isometric read framing both the floating stack and the lake below.
      camera: { position: [10, 7, 14], target: [0, 0, 0], fov: 50 },
    };
  };
}

// ── 4. Sphere (ContextLake) ───────────────────────────────────────────────
// Ducks on a Fibonacci sphere, wired to their nearest neighbors for a globe.
export function sphere({ count = 24, radius = 7 }: { count?: number; radius?: number } = {}): DuckSpec {
  return () => {
    const ducks: DuckInstance[] = [];
    const pts: [number, number, number][] = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < count; i++) {
      const y = 1 - (i / (count - 1)) * 2; // 1 → -1
      const r = Math.sqrt(1 - y * y);
      const theta = golden * i;
      const p: [number, number, number] = [Math.cos(theta) * r * radius, y * radius, Math.sin(theta) * r * radius];
      pts.push(p);
      ducks.push({ position: p, scale: 1.3, spinSpeed: rand(0.2, 0.6), wobbleAmp: 0.05, wobbleSpeed: rand(0.8, 1.6) });
    }
    // Connect each duck to its 2 nearest neighbors → sparse globe wireframe.
    const edges: Edge[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < count; i++) {
      const dists = pts
        .map((q, j) => ({ j, d: (q[0] - pts[i][0]) ** 2 + (q[1] - pts[i][1]) ** 2 + (q[2] - pts[i][2]) ** 2 }))
        .filter((o) => o.j !== i)
        .sort((a, b) => a.d - b.d);
      for (let k = 0; k < 2; k++) {
        const j = dists[k].j;
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (!seen.has(key)) { seen.add(key); edges.push([i, j]); }
      }
    }
    return { ducks, edges, camera: { position: [0, 0, radius * 3], target: [0, 0, 0], fov: 50 } };
  };
}

// ── 5. Orbit (Orchestration) ──────────────────────────────────────────────
// One big central duck; a ring of smaller ducks orbit it while self-spinning.
export function orbit({ ringCount = 10, radius = 7, bigScale = 6 }: { ringCount?: number; radius?: number; bigScale?: number } = {}): DuckSpec {
  return () => {
    const ducks: DuckInstance[] = [
      { position: [0, 0, 0], scale: bigScale, spinSpeed: 0.25, wobbleAmp: 0.05, wobbleSpeed: 0.8 },
    ];
    for (let i = 0; i < ringCount; i++) {
      ducks.push({
        position: [0, 0, 0], // overridden by orbit each frame
        scale: 2,
        spinSpeed: rand(1.5, 2.5),
        orbit: { center: [0, 0, 0], radius, speed: 0.5, phase: (i / ringCount) * Math.PI * 2 },
      });
    }
    return { ducks, camera: { position: [0, 7, 16], target: [0, 0, 0], fov: 55 } };
  };
}

// ── 6. Edge burst (Edge analytics) ────────────────────────────────────────
// Several small rings of ducks, each duck firing a solid edge into one big duck.
export function edgeBurst({ rings = 3, perRing = 5, bigScale = 6 }: { rings?: number; perRing?: number; bigScale?: number } = {}): DuckSpec {
  return () => {
    const ducks: DuckInstance[] = [
      { position: [0, 0, 0], scale: bigScale, spinSpeed: 0.2, wobbleAmp: 0.05, wobbleSpeed: 0.7 },
    ];
    const edges: Edge[] = [];
    // Ring cluster centers spread on a circle *below* the big duck, so the small
    // ducks sit under it and fire their edges upward into it.
    const clusterR = 9;
    for (let g = 0; g < rings; g++) {
      const ga = (g / rings) * Math.PI * 2;
      const cx = Math.cos(ga) * clusterR;
      const cy = -7;
      const cz = Math.sin(ga) * clusterR;
      const localR = 2.2;
      for (let i = 0; i < perRing; i++) {
        const a = (i / perRing) * Math.PI * 2;
        ducks.push({
          position: [cx + Math.cos(a) * localR, cy + Math.sin(a) * localR * 0.6, cz + Math.sin(a) * localR],
          scale: 1.4,
          spinSpeed: rand(0.5, 1.2),
          wobbleAmp: 0.04,
          wobbleSpeed: rand(1, 2),
        });
        edges.push([0, ducks.length - 1]);
      }
    }
    return { ducks, edges, camera: { position: [0, 4, 26], target: [0, -1, 0], fov: 55 } };
  };
}
