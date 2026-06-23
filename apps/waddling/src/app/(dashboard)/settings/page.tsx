import { Suspense } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { SettingsContent } from './content';

function SettingsFallback() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-10 w-72" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<SettingsFallback />}>
      <SettingsContent />
    </Suspense>
  );
}
