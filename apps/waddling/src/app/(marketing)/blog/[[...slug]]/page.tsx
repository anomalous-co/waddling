import { blogSource } from '@/lib/source';
import { DocsBody } from 'fumadocs-ui/layouts/docs/page';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getMDXComponents } from '@/components/mdx';
import type { Metadata } from 'next';

type Props = { params: Promise<{ slug?: string[] }> };

function BlogIndex() {
  const posts = blogSource.getPages();

  return (
    <div className="mx-auto max-w-3xl px-6 py-20">
      <h1 className="text-3xl font-mono font-bold tracking-tight text-zinc-50 mb-2">
        waddling blog
      </h1>
      <p className="text-zinc-400 mb-12 font-mono text-sm">
        Engineering, product, and the story of building governed data access for AI agents.
      </p>

      <ul className="space-y-8">
        {posts.map((post) => (
          <li key={post.url} className="border border-zinc-800 rounded p-6 hover:border-zinc-600 transition-colors">
            <Link href={post.url} className="group">
              <div className="text-xs font-mono text-zinc-500 mb-2">
                {new Date(post.data.date as string).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
                {' · '}
                {post.data.author as string}
              </div>
              <h2 className="text-lg font-semibold text-zinc-100 group-hover:text-zinc-50 transition-colors mb-2">
                {post.data.title}
              </h2>
              {post.data.description && (
                <p className="text-sm text-zinc-400 leading-relaxed">
                  {post.data.description}
                </p>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default async function BlogPage({ params }: Props) {
  const { slug = [] } = await params;
  if (!slug.length) return <BlogIndex />;

  const post = blogSource.getPage(slug);
  if (!post) notFound();

  const MDX = post.data.body;

  return (
    <article className="mx-auto max-w-3xl px-6 py-20">
      <Link
        href="/blog"
        className="text-xs font-mono text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        ← all posts
      </Link>
      <h1 className="mt-6 mb-2 text-3xl font-mono font-bold tracking-tight text-zinc-50">
        {post.data.title}
      </h1>
      <div className="text-sm font-mono text-zinc-400">
        {post.data.author as string}
        {' · '}
        {new Date(post.data.date as string).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })}
      </div>
      {post.data.description && (
        <p className="mt-4 text-zinc-400 leading-relaxed">
          {post.data.description}
        </p>
      )}
      <DocsBody className="mt-10">
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </article>
  );
}

export async function generateStaticParams() {
  return blogSource.generateParams();
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug = [] } = await params;
  if (!slug.length) {
    return {
      title: 'Blog — waddling',
      description:
        'Engineering posts, product updates, and announcements from the waddling team.',
    };
  }
  const post = blogSource.getPage(slug);
  if (!post) return {};
  return {
    title: `${post.data.title} — waddling blog`,
    description: post.data.description,
  };
}
