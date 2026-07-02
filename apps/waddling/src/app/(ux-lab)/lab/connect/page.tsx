'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useConnectAgent } from '@/components/waddling/connect-agent-dialog';

/**
 * Connecting an agent is a modal overlay now, not a standalone page — the user
 * never leaves the screen they were on. This route only exists to keep old
 * deep links alive: it bounces to Home and opens the Connect modal there.
 */
export default function ConnectRedirectPage() {
  const router = useRouter();
  const { openConnect } = useConnectAgent();

  useEffect(() => {
    router.replace('/lab');
    openConnect();
  }, [router, openConnect]);

  return null;
}
