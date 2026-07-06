'use client';

/**
 * AgentCarousel — the agents that connect to waddling, scrolling as an infinite
 * marquee. Copied from the anomalous.computer landing (LogoLoop + SurfaceIcons):
 * same component, same agent set (Claude, Codex, Gemini, Cursor, Pi, OpenCode),
 * same config. OpenCode ships as a light/dark wordmark image swapped by theme.
 */

import { LogoLoop, type LogoItem } from '@/components/logo-loop';
import {
  ClaudeIcon,
  CodexIcon,
  GeminiIcon,
  CursorIcon,
  PiIcon,
} from '@/components/agent-logos';

const OPENCODE_W = 28 * (640 / 115);

const AGENT_LOGOS: LogoItem[] = [
  { node: <ClaudeIcon size={28} />, title: 'Claude Code' },
  { node: <CodexIcon size={28} />, title: 'Codex' },
  { node: <GeminiIcon size={28} />, title: 'Gemini' },
  { node: <CursorIcon size={28} />, title: 'Cursor' },
  { node: <PiIcon size={28} />, title: 'pi' },
  {
    // Wordmark image. The marketing surface is always dark (layout forces
    // bg-zinc-950), so use the light-on-dark variant unconditionally.
    node: (
      <img
        src="/opencode-wordmark-simple-dark.svg"
        alt="OpenCode"
        style={{ height: 28, width: OPENCODE_W }}
      />
    ),
    title: 'OpenCode',
  },
];

export function AgentCarousel({ className }: { className?: string }) {
  return (
    <LogoLoop
      logos={AGENT_LOGOS}
      gap={24}
      logoHeight={28}
      speed={30}
      fadeOut
      fadeOutColor="#09090b"
      ariaLabel="Supported coding agents"
      className={className}
    />
  );
}
