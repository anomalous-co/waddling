import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { blogSource } from '@/lib/source';
import type { ReactNode } from 'react';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={blogSource.getPageTree()}
      nav={{ title: 'waddling blog' }}
    >
      {children}
    </DocsLayout>
  );
}
