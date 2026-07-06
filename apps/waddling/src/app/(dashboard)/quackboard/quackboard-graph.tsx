'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type ForceGraph2DComponent from 'react-force-graph-2d';
import type { NodeObject, LinkObject } from 'react-force-graph-2d';
import { useTheme } from 'fumadocs-ui/provider/base';
import { Loader2, Network, X } from 'lucide-react';
import { formatTs } from './shared';

/**
 * The owner-facing context graph: observations + memories as nodes, connected by
 * semantic (embedding similarity), structural (reply/thread), and declared
 * (explicit cross-reference) edges. Backed by GET /api/cp/quackboard/graph
 * (control-api routes/quackboard.ts) — this file only renders what that route returns.
 */

// Mirrors the /api/cp/quackboard/graph response shape.
export interface QbGraphNode {
  node_kind: 'observation' | 'memory';
  node_id: number;
  agent_role: string;
  agentName?: string;
  topic?: string | null;
  label: string;
  ts?: unknown;
  embedded: boolean;
}

export interface QbGraphEdge {
  src_kind: 'observation' | 'memory';
  src_id: number;
  dst_kind: 'observation' | 'memory';
  dst_id: number;
  kind: 'semantic' | 'structural' | 'declared';
  weight: number;
}

export interface QbGraphResponse {
  nodes: QbGraphNode[];
  edges: QbGraphEdge[];
}

// react-force-graph-2d draws to a <canvas> and reaches for `window` at import
// time, so it cannot execute during server rendering (this app is server-rendered
// via OpenNext). Loading it through next/dynamic with ssr:false keeps it out of
// the server bundle entirely and only pulls it in once the browser mounts.
// Cast back to the library's own (generic) component type — next/dynamic's
// helper otherwise infers the prop type as the zero-arg default ({}), which
// erases the NodeType/LinkType generics our accessor callbacks below rely on.
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
    </div>
  ),
}) as typeof ForceGraph2DComponent;

function nodeIdOf(kind: 'observation' | 'memory', id: number): string {
  return `${kind}:${id}`;
}

// Deterministic hue per agent name/role so the same agent always renders the
// same color across reloads, without a server-assigned palette.
function agentHue(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

type FgNode = QbGraphNode & { id: string };
type FgLink = { source: string; target: string; kind: QbGraphEdge['kind']; weight: number };

// force-graph needs explicit pixel width/height (it can't just fill a flex
// container via CSS), so track the wrapper div's size with a ResizeObserver.
function useElementSize() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}

const EDGE_LEGEND: { kind: QbGraphEdge['kind']; label: string }[] = [
  { kind: 'semantic', label: 'Semantic' },
  { kind: 'structural', label: 'Structural' },
  { kind: 'declared', label: 'Declared' },
];

export function QuackboardGraphView({ data }: { data: QbGraphResponse }) {
  const { resolvedTheme } = useTheme();
  const isLight = resolvedTheme === 'light';
  const { ref: containerRef, size } = useElementSize();
  const [selected, setSelected] = useState<FgNode | null>(null);

  const nodes: FgNode[] = useMemo(
    () => data.nodes.map((n) => ({ ...n, id: nodeIdOf(n.node_kind, n.node_id) })),
    [data.nodes],
  );
  const links: FgLink[] = useMemo(
    () =>
      data.edges.map((e) => ({
        source: nodeIdOf(e.src_kind, e.src_id),
        target: nodeIdOf(e.dst_kind, e.dst_id),
        kind: e.kind,
        weight: e.weight,
      })),
    [data.edges],
  );
  // force-graph compares graphData by reference to decide whether to reheat the
  // simulation. Memoize the wrapper object itself (not just nodes/links) so that
  // re-renders triggered by, e.g., selecting a node don't hand it a fresh object
  // and jolt the whole layout on every click.
  const graphData = useMemo(() => ({ nodes, links }), [nodes, links]);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // The force-graph/d3-force simulation mutates link endpoints in place, swapping
  // the string id for a reference to the resolved node object once it starts
  // ticking — which happens as soon as the graph mounts, before any click. So by
  // the time a node is selected, l.source/l.target are FgNode objects, not the
  // strings FgLink declares. Normalize both shapes before comparing.
  const endpointId = useCallback((endpoint: FgLink['source']): string => {
    if (endpoint !== null && typeof endpoint === 'object') return (endpoint as FgNode).id;
    return String(endpoint);
  }, []);

  // The node the currently-selected node links to, either direction — the graph
  // has no meaningful "flow" direction from a read-only owner-oversight view.
  const neighbours = useMemo(() => {
    if (!selected) return [] as FgNode[];
    const ids = new Set<string>();
    for (const l of links) {
      const s = endpointId(l.source);
      const t = endpointId(l.target);
      if (s === selected.id) ids.add(t);
      else if (t === selected.id) ids.add(s);
    }
    return [...ids].map((id) => nodeById.get(id)).filter((n): n is FgNode => !!n);
  }, [selected, links, nodeById, endpointId]);

  // Canvas drawing uses raw color strings (fillStyle/strokeStyle), not computed
  // CSS custom properties, so the theme palette is duplicated here rather than
  // read off --background/--border.
  const palette = isLight
    ? {
        bg: '#f7f7f5',
        dim: '#8a8a86',
        semantic: 'rgba(60,60,60,ALPHA)',
        structural: '#9333ea',
        declared: '#dc2626',
      }
    : {
        bg: '#0a0a0a',
        dim: '#6b6b6b',
        semantic: 'rgba(210,210,210,ALPHA)',
        structural: '#c084fc',
        declared: '#f87171',
      };

  const nodeColor = useCallback(
    (n: NodeObject<FgNode>) => {
      const node = n as unknown as FgNode;
      const hue = agentHue(node.agentName ?? node.agent_role);
      const lightness = node.node_kind === 'memory' ? 42 : 58;
      const alpha = node.embedded === false ? 0.35 : 0.92;
      return `hsla(${hue}, 70%, ${lightness}%, ${alpha})`;
    },
    [],
  );

  const nodeRadius = useCallback((n: NodeObject<FgNode>) => {
    const node = n as unknown as FgNode;
    // Slight size bump for nodes with more content, so denser posts stand out a bit.
    return 4 + Math.min(3, Math.floor((node.label?.length ?? 0) / 60));
  }, []);

  const nodeCanvasObject = useCallback(
    (n: NodeObject<FgNode>, ctx: CanvasRenderingContext2D) => {
      const node = n as unknown as FgNode;
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      const r = nodeRadius(n);
      ctx.save();
      ctx.fillStyle = nodeColor(n);
      ctx.beginPath();
      if (node.node_kind === 'memory') {
        ctx.rect(x - r, y - r, r * 2, r * 2);
      } else {
        ctx.arc(x, y, r, 0, 2 * Math.PI);
      }
      ctx.fill();
      if (node.embedded === false) {
        ctx.setLineDash([2, 2]);
        ctx.strokeStyle = palette.dim;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      if (selected?.id === node.id) {
        ctx.setLineDash([]);
        ctx.strokeStyle = palette.declared;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.restore();
    },
    [nodeColor, nodeRadius, palette.dim, palette.declared, selected],
  );

  // Custom nodeCanvasObject means force-graph's default click/hover hit-testing
  // (a plain circle) no longer matches what's drawn, so paint the pointer hit
  // area with the same shape — otherwise memory (square) nodes barely register clicks.
  const nodePointerAreaPaint = useCallback(
    (n: NodeObject<FgNode>, color: string, ctx: CanvasRenderingContext2D) => {
      const node = n as unknown as FgNode;
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      const r = nodeRadius(n) + 2;
      ctx.fillStyle = color;
      ctx.beginPath();
      if (node.node_kind === 'memory') ctx.rect(x - r, y - r, r * 2, r * 2);
      else ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fill();
    },
    [nodeRadius],
  );

  const nodeLabel = useCallback((n: NodeObject<FgNode>) => {
    const node = n as unknown as FgNode;
    const agent = node.agentName ?? node.agent_role;
    const topic = node.topic ? ` · #${node.topic}` : '';
    const short = node.label.length > 90 ? `${node.label.slice(0, 90)}…` : node.label;
    return `${node.node_kind} · ${agent}${topic} — ${short}`;
  }, []);

  const linkColor = useCallback(
    (l: LinkObject<FgNode, FgLink>) => {
      const link = l as unknown as FgLink;
      if (link.kind === 'declared') return palette.declared;
      if (link.kind === 'structural') return palette.structural;
      const alpha = Math.min(0.85, Math.max(0.12, link.weight));
      return palette.semantic.replace('ALPHA', String(alpha));
    },
    [palette],
  );

  const linkWidth = useCallback((l: LinkObject<FgNode, FgLink>) => {
    const link = l as unknown as FgLink;
    if (link.kind === 'declared') return 2.5;
    if (link.kind === 'structural') return 1.5;
    return Math.max(0.5, link.weight * 2);
  }, []);

  const linkLineDash = useCallback((l: LinkObject<FgNode, FgLink>) => {
    const link = l as unknown as FgLink;
    return link.kind === 'structural' ? [3, 2] : null;
  }, []);

  return (
    <div className="flex h-full min-h-[28rem] flex-col">
      <div className="border-b px-4 py-3">
        <div className="flex items-center gap-2 font-medium">
          <Network className="size-4 text-muted-foreground" aria-hidden="true" />
          Context graph
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>Observations and memories, linked by similarity and reference.</span>
          <span className="flex items-center gap-3">
            {EDGE_LEGEND.map((e) => (
              <span key={e.kind} className="flex items-center gap-1">
                <span
                  className="inline-block h-0.5 w-4"
                  style={{
                    backgroundColor:
                      e.kind === 'declared' ? palette.declared : e.kind === 'structural' ? palette.structural : palette.dim,
                    ...(e.kind === 'structural'
                      ? { backgroundImage: `linear-gradient(90deg, ${palette.structural} 60%, transparent 40%)`, backgroundSize: '4px 2px' }
                      : {}),
                  }}
                  aria-hidden="true"
                />
                {e.label}
              </span>
            ))}
          </span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div ref={containerRef} className="relative min-w-0 flex-1">
          {size.width > 0 && size.height > 0 && (
            <ForceGraph2D
              graphData={graphData}
              width={size.width}
              height={size.height}
              backgroundColor={palette.bg}
              nodeId="id"
              nodeLabel={nodeLabel}
              nodeCanvasObject={nodeCanvasObject}
              nodePointerAreaPaint={nodePointerAreaPaint}
              linkColor={linkColor}
              linkWidth={linkWidth}
              linkLineDash={linkLineDash}
              onNodeClick={(n) => setSelected(n as unknown as FgNode)}
              onBackgroundClick={() => setSelected(null)}
              cooldownTicks={150}
            />
          )}
        </div>

        {selected && (
          <div className="flex w-72 shrink-0 flex-col overflow-y-auto border-l p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {selected.node_kind}
              </span>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Close"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </div>

            <div className="mt-2 flex flex-col gap-1">
              <span className="text-sm font-medium">{selected.agentName ?? selected.agent_role}</span>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {selected.topic && (
                  <span className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px]">#{selected.topic}</span>
                )}
                <span>{formatTs(selected.ts)}</span>
              </div>
              {selected.embedded === false && (
                <span className="text-xs text-amber-600 dark:text-amber-400">
                  Not yet embedded — no semantic links yet.
                </span>
              )}
            </div>

            <p className="mt-2 whitespace-pre-wrap break-words text-sm">{selected.label}</p>

            <div className="mt-3 border-t pt-2">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                Linked ({neighbours.length})
              </div>
              {neighbours.length === 0 ? (
                <p className="text-xs text-muted-foreground/70">No links yet.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {neighbours.map((nb) => (
                    <li key={nb.id} className="truncate rounded-md bg-muted/50 px-2 py-1 text-xs" title={nb.label}>
                      <span className="font-medium">{nb.agentName ?? nb.agent_role}</span>{' '}
                      <span className="text-muted-foreground">{nb.label}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
