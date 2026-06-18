// source.config.ts
import { defineConfig, defineDocs, defineCollections } from "fumadocs-mdx/config";
import { pageSchema } from "fumadocs-core/source/schema";
import { z } from "zod";
var docs = defineDocs({
  dir: "content/docs"
});
var blog = defineCollections({
  type: "doc",
  dir: "content/blog",
  schema: pageSchema.extend({
    author: z.string(),
    date: z.string().date().or(z.date())
  })
});
var source_config_default = defineConfig();
export {
  blog,
  source_config_default as default,
  docs
};
