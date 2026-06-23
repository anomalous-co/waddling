import { Suspense } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { SignInForm } from './form';

export default function SignInPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-background">
          <Skeleton className="h-64 w-full max-w-sm" />
        </div>
      }
    >
      <SignInForm />
    </Suspense>
  );
}
