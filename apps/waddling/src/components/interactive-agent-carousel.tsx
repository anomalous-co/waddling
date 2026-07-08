'use client';

import { AgentCarousel } from '@/components/agent-carousel';
import { useAgentConnect } from '@/components/agent-connect-provider';

export function InteractiveAgentCarousel({ className }: { className?: string }) {
  const { onAgentClick } = useAgentConnect();

  return <AgentCarousel className={className} onAgentClick={onAgentClick} />;
}
