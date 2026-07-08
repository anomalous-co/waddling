import { Suspense } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { SignUpForm } from './form';

export default function SignUpPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-background">
          <Skeleton className="h-64 w-full max-w-sm" />
        </div>
      }
    >
      <SignUpForm />
    </Suspense>
  );
}
