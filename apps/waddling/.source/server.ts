// @ts-nocheck
import * as __fd_glob_20 from "../content/docs/workspaces.mdx?collection=docs"
import * as __fd_glob_19 from "../content/docs/tutorial-request-access.mdx?collection=docs"
import * as __fd_glob_18 from "../content/docs/tutorial-query.mdx?collection=docs"
import * as __fd_glob_17 from "../content/docs/tutorial-memory.mdx?collection=docs"
import * as __fd_glob_16 from "../content/docs/tutorial-load-data.mdx?collection=docs"
import * as __fd_glob_15 from "../content/docs/topics.mdx?collection=docs"
import * as __fd_glob_14 from "../content/docs/telemetry.mdx?collection=docs"
import * as __fd_glob_13 from "../content/docs/skills.mdx?collection=docs"
import * as __fd_glob_12 from "../content/docs/security.mdx?collection=docs"
import * as __fd_glob_11 from "../content/docs/quickstart.mdx?collection=docs"
import * as __fd_glob_10 from "../content/docs/plugin.mdx?collection=docs"
import * as __fd_glob_9 from "../content/docs/mcp-tools.mdx?collection=docs"
import * as __fd_glob_8 from "../content/docs/lakehouse-maintenance.mdx?collection=docs"
import * as __fd_glob_7 from "../content/docs/index.mdx?collection=docs"
import * as __fd_glob_6 from "../content/docs/extension-install.mdx?collection=docs"
import * as __fd_glob_5 from "../content/docs/enterprise-setup.mdx?collection=docs"
import * as __fd_glob_4 from "../content/docs/data-lakes.mdx?collection=docs"
import * as __fd_glob_3 from "../content/docs/agents.mdx?collection=docs"
import * as __fd_glob_2 from "../content/docs/access-control.mdx?collection=docs"
import { default as __fd_glob_1 } from "../content/docs/meta.json?collection=docs"
import * as __fd_glob_0 from "../content/blog/introducing-waddling.mdx?collection=blog"
import { server } from 'fumadocs-mdx/runtime/server';
import type * as Config from '../source.config';

const create = server<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>({"doc":{"passthroughs":["extractedReferences"]}});

export const blog = await create.doc("blog", "content/blog", {"introducing-waddling.mdx": __fd_glob_0, });

export const docs = await create.docs("docs", "content/docs", {"meta.json": __fd_glob_1, }, {"access-control.mdx": __fd_glob_2, "agents.mdx": __fd_glob_3, "data-lakes.mdx": __fd_glob_4, "enterprise-setup.mdx": __fd_glob_5, "extension-install.mdx": __fd_glob_6, "index.mdx": __fd_glob_7, "lakehouse-maintenance.mdx": __fd_glob_8, "mcp-tools.mdx": __fd_glob_9, "plugin.mdx": __fd_glob_10, "quickstart.mdx": __fd_glob_11, "security.mdx": __fd_glob_12, "skills.mdx": __fd_glob_13, "telemetry.mdx": __fd_glob_14, "topics.mdx": __fd_glob_15, "tutorial-load-data.mdx": __fd_glob_16, "tutorial-memory.mdx": __fd_glob_17, "tutorial-query.mdx": __fd_glob_18, "tutorial-request-access.mdx": __fd_glob_19, "workspaces.mdx": __fd_glob_20, });