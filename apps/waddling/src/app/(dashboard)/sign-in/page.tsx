import { Suspense } from 'react';
import { Spinner } from '@/components/dashboard/ui';
import { SignInForm } from './form';

export default function SignInPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-neutral-950 flex items-center justify-center">
          <Spinner size="lg" />
        </div>
      }
    >
      <SignInForm />
    </Suspense>
  );
}
