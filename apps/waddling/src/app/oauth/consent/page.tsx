import { Suspense } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { ConsentForm } from './form';

// OAuth/MCP consent screen. Better Auth's mcp authorize redirects here (with
// consent_code/client_id/scope) when prompt=consent, after the user has signed in.
// The form POSTs the decision to the API's /api/auth/oauth2/consent and hands the
// browser back to the agent's callback.
export default function OAuthConsentPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-background">
          <Skeleton className="h-64 w-full max-w-sm" />
        </div>
      }
    >
      <ConsentForm />
    </Suspense>
  );
}
