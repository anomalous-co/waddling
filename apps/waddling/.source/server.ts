// @ts-nocheck
import * as __fd_glob_11 from "../content/blog/introducing-waddling.mdx?collection=blog"
import * as __fd_glob_10 from "../content/docs/telemetry.mdx?collection=docs"
import * as __fd_glob_9 from "../content/docs/security.mdx?collection=docs"
import * as __fd_glob_8 from "../content/docs/quickstart.mdx?collection=docs"
import * as __fd_glob_7 from "../content/docs/plugin.mdx?collection=docs"
import * as __fd_glob_6 from "../content/docs/mcp-tools.mdx?collection=docs"
import * as __fd_glob_5 from "../content/docs/lakehouse-maintenance.mdx?collection=docs"
import * as __fd_glob_4 from "../content/docs/index.mdx?collection=docs"
import * as __fd_glob_3 from "../content/docs/extension-install.mdx?collection=docs"
import * as __fd_glob_2 from "../content/docs/enterprise-setup.mdx?collection=docs"
import * as __fd_glob_1 from "../content/docs/acl-model.mdx?collection=docs"
import { default as __fd_glob_0 } from "../content/docs/meta.json?collection=docs"
import { server } from 'fumadocs-mdx/runtime/server';
import type * as Config from '../source.config';

const create = server<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>({"doc":{"passthroughs":["extractedReferences"]}});

export const blog = await create.doc("blog", "content/blog", {"introducing-waddling.mdx": __fd_glob_11, });

export const docs = await create.docs("docs", "content/docs", {"meta.json": __fd_glob_0, }, {"acl-model.mdx": __fd_glob_1, "enterprise-setup.mdx": __fd_glob_2, "extension-install.mdx": __fd_glob_3, "index.mdx": __fd_glob_4, "lakehouse-maintenance.mdx": __fd_glob_5, "mcp-tools.mdx": __fd_glob_6, "plugin.mdx": __fd_glob_7, "quickstart.mdx": __fd_glob_8, "security.mdx": __fd_glob_9, "telemetry.mdx": __fd_glob_10, });