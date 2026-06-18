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
