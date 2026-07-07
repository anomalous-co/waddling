'use client';

/**
 * AgentCarousel — the agents that connect to waddling, scrolling as an infinite
 * marquee. Copied from the anomalous.computer landing (LogoLoop + SurfaceIcons):
 * same component, same agent set (Claude, Codex, Gemini, Cursor, Pi, OpenCode),
 * same config. OpenCode ships as a light/dark wordmark image swapped by theme.
 */

import { useMemo } from 'react';
import { useTheme } from 'fumadocs-ui/provider/base';
import { LogoLoop, type LogoItem } from '@/components/logo-loop';
import {
  ClaudeIcon,
  CodexIcon,
  GeminiIcon,
  CursorIcon,
  PiIcon,
} from '@/components/agent-logos';

const OPENCODE_W = 28 * (640 / 115);

const BASE_LOGOS: LogoItem[] = [
  { node: <ClaudeIcon size={28} />, title: 'Claude Code' },
  { node: <CodexIcon size={28} />, title: 'Codex' },
  { node: <GeminiIcon size={28} />, title: 'Gemini' },
  { node: <CursorIcon size={28} />, title: 'Cursor' },
  { node: <PiIcon size={28} />, title: 'pi' },
];

export function AgentCarousel({ className }: { className?: string }) {
  const { resolvedTheme } = useTheme();
  const logos = useMemo<LogoItem[]>(() => {
    const isLight = resolvedTheme === 'light';
    const openCodeSrc = isLight
      ? '/opencode-wordmark-simple-dark.svg'   // dark logo on light background
      : '/opencode-wordmark-simple-light.svg'; // light logo on dark background

    return [
      ...BASE_LOGOS,
      {
        node: (
          <img
            src={openCodeSrc}
            alt="OpenCode"
            style={{ height: 28, width: OPENCODE_W }}
          />
        ),
        title: 'OpenCode',
      },
    ];
  }, [resolvedTheme]);

  return (
    <LogoLoop
      logos={logos}
      gap={24}
      logoHeight={28}
      speed={30}
      fadeOut
      ariaLabel="Supported coding agents"
      className={className}
    />
  );
}
