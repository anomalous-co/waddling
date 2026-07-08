'use client';

import { McpConnect } from '@/components/mcp-connect';
import { useAgentConnect } from '@/components/agent-connect-provider';

export function AgentMcpSection({ className }: { className?: string }) {
  const { activeAgent, pulseAgent, mcpRef, setActiveAgent } = useAgentConnect();

  return (
    <div ref={mcpRef}>
      <McpConnect
        className={className}
        active={activeAgent}
        onActiveChange={setActiveAgent}
        pulseAgent={pulseAgent}
      />
    </div>
  );
}
