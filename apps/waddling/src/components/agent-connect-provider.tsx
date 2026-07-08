'use client';

import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from 'react';

type AgentConnectCtx = {
  activeAgent: string | undefined;
  pulseAgent: string | null;
  mcpRef: React.RefObject<HTMLDivElement | null>;
  onAgentClick: (agentId: string) => void;
  setActiveAgent: (id: string | undefined) => void;
};

const Ctx = createContext<AgentConnectCtx | null>(null);

export function AgentConnectProvider({ children }: { children: ReactNode }) {
  const mcpRef = useRef<HTMLDivElement>(null);
  const [activeAgent, setActiveAgent] = useState<string | undefined>();
  const [pulseAgent, setPulseAgent] = useState<string | null>(null);

  const onAgentClick = useCallback((agentId: string) => {
    setActiveAgent(agentId);
    setPulseAgent(agentId);
    mcpRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => setPulseAgent(null), 2000);
  }, []);

  return (
    <Ctx.Provider value={{ activeAgent, pulseAgent, mcpRef, onAgentClick, setActiveAgent }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAgentConnect() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAgentConnect must be used within AgentConnectProvider');
  return ctx;
}
