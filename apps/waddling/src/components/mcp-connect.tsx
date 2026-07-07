'use client';

/**
 * McpConnect — landing widget: pick your agent, copy the waddling MCP config.
 * The endpoint is real (https://api.getwaddling.com/mcp); the bearer is a
 * placeholder the user swaps for their own agent key from the dashboard.
 *
 * Each agent has its own config surface (CLI vs. config file, and slightly
 * different JSON/TOML shapes), so the snippet swaps per selection.
 */

import { useState } from 'react';
import { CopyButton } from '@/components/waddling/copy-button';
import {
  ClaudeIcon,
  CodexIcon,
  GeminiIcon,
  CursorIcon,
  PiIcon,
  OpenCodeIcon,
} from '@/components/agent-logos';
import { cn } from '@/lib/utils';

const URL = 'https://api.getwaddling.com/mcp';
const KEY = 'sk_agent_…';

// Universal remote-MCP JSON (Claude Code, pi, and any `type: "http"` host).
const httpJson = (file: string) => ({
  file,
  code: JSON.stringify(
    { mcpServers: { waddling: { type: 'http', url: URL, headers: { Authorization: `Bearer ${KEY}` } } } },
    null,
    2,
  ),
});

type Agent = {
  id: string;
  label: string;
  icon: React.ReactNode;
  file: string;
  code: string;
};

const AGENTS: Agent[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    icon: <ClaudeIcon size={16} />,
    file: 'terminal',
    code: `claude mcp add --transport http waddling \\\n  ${URL} \\\n  --header "Authorization: Bearer ${KEY}"`,
  },
  {
    id: 'codex',
    label: 'Codex',
    icon: <CodexIcon size={16} />,
    file: 'terminal',
    code: `export WADDLING_KEY=${KEY}\ncodex mcp add waddling \\\n  --url ${URL} \\\n  --bearer-token-env-var WADDLING_KEY`,
  },
  {
    id: 'gemini',
    label: 'Gemini',
    icon: <GeminiIcon size={16} />,
    file: 'terminal',
    code: `gemini mcp add --transport http waddling \\\n  ${URL} \\\n  --header "Authorization: Bearer ${KEY}"`,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    icon: <CursorIcon size={16} />,
    file: '~/.cursor/mcp.json',
    code: JSON.stringify(
      { mcpServers: { waddling: { url: URL, headers: { Authorization: `Bearer ${KEY}` } } } },
      null,
      2,
    ),
  },
  {
    id: 'pi',
    label: 'pi',
    icon: <PiIcon size={16} />,
    ...httpJson('.mcp.json'),
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    icon: <OpenCodeIcon size={16} />,
    file: 'opencode.json',
    code: JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        mcp: {
          waddling: { type: 'remote', url: URL, enabled: true, headers: { Authorization: `Bearer ${KEY}` } },
        },
      },
      null,
      2,
    ),
  },
];

export function McpConnect({ className }: { className?: string }) {
  const [active, setActive] = useState(AGENTS[0].id);
  const agent = AGENTS.find((a) => a.id === active) ?? AGENTS[0];

  return (
    <div
      className={cn(
        'border border-zinc-800 bg-zinc-950/85 shadow-2xl shadow-black/40 backdrop-blur-sm',
        className,
      )}
    >
      {/* Agent picker */}
      <div
        role="tablist"
        aria-label="Choose your agent"
        className="flex flex-wrap gap-px border-b border-zinc-800 bg-zinc-800/40"
      >
        {AGENTS.map((a) => {
          const selected = a.id === active;
          return (
            <button
              key={a.id}
              role="tab"
              type="button"
              aria-selected={selected}
              onClick={() => setActive(a.id)}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-2 font-mono text-xs transition-colors',
                selected
                  ? 'bg-zinc-900 text-emerald-400'
                  : 'bg-transparent text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-100',
              )}
            >
              <span className="inline-flex size-4 items-center justify-center">{a.icon}</span>
              {a.label}
            </button>
          );
        })}
      </div>

      {/* Snippet */}
      <div className="relative">
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-1.5">
          <span className="font-mono text-[11px] text-zinc-500">{agent.file}</span>
          <CopyButton
            text={agent.code}
            label={`Copy ${agent.label} config`}
            className="size-6 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          />
        </div>
        <pre
          tabIndex={0}
          aria-label={`${agent.label} MCP config`}
          className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-zinc-200 outline-none"
        >
          {agent.code}
        </pre>
      </div>
    </div>
  );
}
