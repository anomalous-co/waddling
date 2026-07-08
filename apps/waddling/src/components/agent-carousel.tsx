'use client';

/**
 * AgentCarousel — the agents that connect to waddling, scrolling as an infinite
 * marquee. Copied from the anomalous.computer landing (LogoLoop + SurfaceIcons):
 * same component, same agent set (Claude, Codex, Gemini, Cursor, Pi, OpenCode),
 * same config. OpenCode ships as a light/dark logo image swapped by theme.
 */

import { useMemo, useCallback } from 'react';
import { useTheme } from 'fumadocs-ui/provider/base';
import { LogoLoop, type LogoItem } from '@/components/logo-loop';
import {
  ClaudeIcon,
  CodexIcon,
  GeminiIcon,
  //CursorIcon,
  PiIcon,
} from '@/components/agent-logos';

const OPENCODE_W = 28 * (240 / 300);

/** Map carousel title → McpConnect agent id. */
const AGENT_ID: Record<string, string> = {
  'Claude Code': 'claude',
  Codex: 'codex',
  Gemini: 'gemini',
  Cursor: 'cursor',
  pi: 'pi',
  'Open Code': 'opencode',
};

const BASE_LOGOS: LogoItem[] = [
  { node: <ClaudeIcon size={28} />, title: 'Claude Code' },
  { node: <CodexIcon size={28} />, title: 'Codex' },
  { node: <GeminiIcon size={28} />, title: 'Gemini' },
  //{ node: <CursorIcon size={28} />, title: 'Cursor' },
  { node: <PiIcon size={28} />, title: 'pi' },
];

export function AgentCarousel({
  className,
  onAgentClick,
}: {
  className?: string;
  onAgentClick?: (agentId: string) => void;
}) {
  const { resolvedTheme } = useTheme();
  const logos = useMemo<LogoItem[]>(() => {
    const isLight = resolvedTheme === 'light';
    const openCodeSrc = isLight
      ? '/opencode-logo-light.svg'  // black logo on light background
      : '/opencode-logo-dark.svg';  // white logo on dark background

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
        title: 'Open Code',
      },
    ];
  }, [resolvedTheme]);

  const handleClick = useCallback(
    (title: string) => {
      const agentId = AGENT_ID[title];
      if (agentId) onAgentClick?.(agentId);
    },
    [onAgentClick],
  );

  const clickableLogos = useMemo(
    () =>
      logos.map((item: any) => ({
        ...item,
        node: (
          <button
            type="button"
            onClick={() => handleClick(item.title)}
            className="cursor-pointer transition-opacity hover:opacity-70"
            aria-label={`Show ${item.title} config`}
          >
            {item.node}
          </button>
        ),
      })),
    [logos, handleClick],
  );

  return (
    <LogoLoop
      logos={clickableLogos}
      gap={24}
      logoHeight={28}
      speed={30}
      fadeOut
      ariaLabel="Supported coding agents"
      className={className}
    />
  );
}
