# Fumadocs Setup Reference

**Target**: Install into existing Next.js 15 App Router + Tailwind v4 project. Packages: `fumadocs-mdx`, `fumadocs-core`, `fumadocs-ui`.

## 1. Install Packages

```bash
npm i fumadocs-mdx fumadocs-core fumadocs-ui @types/mdx zod
```

## 2. Configure `source.config.ts`

Create at project root:

```typescript
import { defineConfig, defineDocs, defineCollections } from 'fumadocs-mdx/config';
import { pageSchema } from 'fumadocs-core/source/schema';
import { z } from 'zod';

export const docs = defineDocs({
  dir: 'content/docs',
});

export const blog = defineCollections({
  type: 'doc',
  dir: 'content/blog',
  schema: pageSchema.extend({
    author: z.string(),
    date: z.string().date().or(z.date()),
  }),
});

export default defineConfig();
```

## 3. Update `next.config.mjs`

```javascript
import { createMDX } from 'fumadocs-mdx/next';

const config = {
  reactStrictMode: true,
};

const withMDX = createMDX();
export default withMDX(config);
```

## 4. Create `lib/source.ts`

```typescript
import { docs, blog } from '@/../source.config';
import { loader } from 'fumadocs-core/source';

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
});

export const blogSource = loader({
  baseUrl: '/blog',
  source: blog.toFumadocsSource(),
});
```

## 5. Update `app/layout.tsx` (Root)

```typescript
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
```

## 6. Create `app/docs/layout.tsx` (Docs Layout)

```typescript
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { source } from '@/lib/source';
import type { ReactNode } from 'react';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout tree={source.getPageTree()}>
      {children}
    </DocsLayout>
  );
}
```

## 7. Create `app/docs/[[...slug]]/page.tsx`

```typescript
import { source } from '@/lib/source';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from 'fumadocs-ui/layouts/docs/page';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '@/components/mdx';

export default async function Page({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug = [] } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const MDX = page.data.body;

  return (
    <DocsPage toc={page.data.toc}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}
```

## 8. Search API Route: `app/api/search/route.ts`

```typescript
import { source } from '@/lib/source';
import { createFromSource } from 'fumadocs-core/search/server';

export const { GET } = createFromSource(source);

export const revalidate = 3600; // ISR: revalidate every hour
```

Optional: For advanced (Orama) search instead of simple:

```typescript
import { source } from '@/lib/source';
import { createSearchAPI } from 'fumadocs-core/search/server';

const searchIndex = source.getPages().map((page) => ({
  title: page.data.title,
  description: page.data.description,
  url: page.url,
  id: page.url,
  structuredData: page.data.structuredData,
}));

export const { GET } = createSearchAPI('advanced', {
  language: 'english',
  indexes: searchIndex,
});
```

## 9. MDX Frontmatter Schema (Example)

```yaml
---
title: Getting Started
description: Set up your project
---

# Content here...
```

For docs only. Blog posts require `author` + `date`:

```yaml
---
title: New Features
author: Jane Doe
date: 2025-06-12
description: Latest releases
---
```

## 10. Blog Setup: `app/blog/[[...slug]]/page.tsx`

```typescript
import { blogSource } from '@/lib/source';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from 'fumadocs-ui/layouts/docs/page';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '@/components/mdx';

export default async function BlogPage({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug = [] } = await params;
  const post = blogSource.getPage(slug);
  if (!post) notFound();

  const MDX = post.data.body;

  return (
    <DocsPage toc={post.data.toc}>
      <DocsTitle>{post.data.title}</DocsTitle>
      <div className="text-sm text-muted-foreground">
        {post.data.author} · {new Date(post.data.date).toLocaleDateString()}
      </div>
      <DocsDescription>{post.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return blogSource.generateParams();
}
```

## 11. Tailwind CSS: `app/globals.css`

```css
@import 'tailwindcss';
@import 'fumadocs-ui/css/neutral.css';
@import 'fumadocs-ui/css/preset.css';

@source '../node_modules/fumadocs-ui/dist/**/*.js';
```

Update `tailwind.config.ts` if custom theme needed; `fumadocs-ui` defaults cover most cases.

## 12. Directory Structure

```
project/
├── app/
│   ├── layout.tsx (RootProvider)
│   ├── docs/
│   │   ├── layout.tsx (DocsLayout)
│   │   └── [[...slug]]/
│   │       └── page.tsx
│   ├── blog/
│   │   └── [[...slug]]/
│   │       └── page.tsx
│   ├── api/
│   │   └── search/
│   │       └── route.ts
│   └── globals.css
├── content/
│   ├── docs/ (MDX files for docs)
│   └── blog/ (MDX files for blog posts)
├── lib/
│   └── source.ts
├── source.config.ts
└── next.config.mjs
```

## Key APIs

- `source.getPage(slug)` - Retrieve single page data (title, body, toc, description)
- `source.getPageTree()` - Get page tree for sidebar navigation
- `source.getPages()` - All pages (for search indexing)
- `source.generateParams()` - Generate static params for `generateStaticParams()`
- `page.data.body` - MDX component, render with `<MDX components={...} />`
- `page.data.toc` - Table of contents (auto-generated from headings)
- `page.data.structuredData` - For search API indexing

## Notes

- **ISR Revalidation**: Set `revalidate` in search route or page routes for incremental static regeneration.
- **Collections**: Docs and blog are separate collections; docs is default (no author/date required). Use `pageSchema.extend()` for custom frontmatter per collection.
- **MDX Components**: Create `components/mdx.ts` exporting `getMDXComponents()` for custom rendering (code blocks, callouts, etc.).
- **Layouts**: `DocsLayout` wraps page tree sidebar + breadcrumbs. `DocsPage` wraps individual pages with TOC sidebar. Customize via `baseOptions()` or pass `tree` prop.
