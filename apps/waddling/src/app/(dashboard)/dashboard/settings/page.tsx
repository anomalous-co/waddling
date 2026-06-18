import { Suspense } from 'react';
import { Spinner } from '@/components/dashboard/ui';
import { SettingsContent } from './content';

export default function SettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-24">
          <Spinner size="lg" />
        </div>
      }
    >
      <SettingsContent />
    </Suspense>
  );
}
