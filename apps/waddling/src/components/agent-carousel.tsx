/**
 * AgentCarousel — an infinite horizontal marquee of the agent brand logos that
 * connect to waddling. Adapted from the anomalous agent ticker (TaskCard's
 * AgentTicker): the item list is rendered twice and translated -50%, so the
 * loop is seamless.
 *
 * Logos are Simple Icons (via react-icons) rendered as monochrome silhouettes
 * in `currentColor`, so they theme with the surrounding text. Cursor isn't in
 * Simple Icons, so its official mark is inlined below.
 */

import type { ComponentType, SVGProps } from 'react';
import {
  SiClaude,
  SiOpenai,
  SiGithubcopilot,
  SiWindsurf,
  SiZedindustries,
  SiGooglegemini,
  SiReplit,
} from 'react-icons/si';

// Cursor's mark — not published in Simple Icons, so inline the official path.
function CursorIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 466.73 532.09" fill="currentColor" aria-hidden {...props}>
      <path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z" />
    </svg>
  );
}

type Agent = { name: string; Icon: ComponentType<SVGProps<SVGSVGElement>> };

// The hosts/agents that speak MCP and can drive a waddling lake today.
const AGENTS: Agent[] = [
  { name: 'Claude Code', Icon: SiClaude },
  { name: 'Cursor', Icon: CursorIcon },
  { name: 'GitHub Copilot', Icon: SiGithubcopilot },
  { name: 'Codex', Icon: SiOpenai },
  { name: 'Windsurf', Icon: SiWindsurf },
  { name: 'Zed', Icon: SiZedindustries },
  { name: 'Gemini CLI', Icon: SiGooglegemini },
  { name: 'Replit', Icon: SiReplit },
];

function Chip({ name, Icon }: Agent) {
  return (
    <span className="inline-flex shrink-0 items-center gap-2.5 whitespace-nowrap font-mono text-sm text-muted-foreground transition-colors hover:text-foreground">
      <Icon className="size-5 shrink-0" />
      {name}
    </span>
  );
}

export function AgentCarousel({ className }: { className?: string }) {
  // One rendered run of the chips; duplicated below for the seamless loop.
  const run = AGENTS.map((a) => <Chip key={a.name} {...a} />);

  return (
    <div className={className}>
      {/* edge fades so logos dissolve in/out rather than clip at the border */}
      <div className="relative overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]">
        <div
          className="flex w-max items-center gap-10 motion-reduce:animate-none"
          style={{ animation: 'ticker-scroll 40s linear infinite' }}
        >
          {run}
          <span aria-hidden className="font-mono text-muted-foreground/30">
            ·
          </span>
          {run}
        </div>
      </div>
    </div>
  );
}
