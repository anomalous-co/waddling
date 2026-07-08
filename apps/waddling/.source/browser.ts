// @ts-nocheck
import { browser } from 'fumadocs-mdx/runtime/browser';
import type * as Config from '../source.config';

const create = browser<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>();
const browserCollections = {
  blog: create.doc("blog", {"introducing-waddling.mdx": () => import("../content/blog/introducing-waddling.mdx?collection=blog"), }),
  docs: create.doc("docs", {"access-control.mdx": () => import("../content/docs/access-control.mdx?collection=docs"), "agents.mdx": () => import("../content/docs/agents.mdx?collection=docs"), "data-lakes.mdx": () => import("../content/docs/data-lakes.mdx?collection=docs"), "enterprise-setup.mdx": () => import("../content/docs/enterprise-setup.mdx?collection=docs"), "extension-install.mdx": () => import("../content/docs/extension-install.mdx?collection=docs"), "index.mdx": () => import("../content/docs/index.mdx?collection=docs"), "lakehouse-maintenance.mdx": () => import("../content/docs/lakehouse-maintenance.mdx?collection=docs"), "mcp-tools.mdx": () => import("../content/docs/mcp-tools.mdx?collection=docs"), "plugin.mdx": () => import("../content/docs/plugin.mdx?collection=docs"), "quickstart.mdx": () => import("../content/docs/quickstart.mdx?collection=docs"), "security.mdx": () => import("../content/docs/security.mdx?collection=docs"), "skills.mdx": () => import("../content/docs/skills.mdx?collection=docs"), "telemetry.mdx": () => import("../content/docs/telemetry.mdx?collection=docs"), "topics.mdx": () => import("../content/docs/topics.mdx?collection=docs"), "tutorial-load-data.mdx": () => import("../content/docs/tutorial-load-data.mdx?collection=docs"), "tutorial-memory.mdx": () => import("../content/docs/tutorial-memory.mdx?collection=docs"), "tutorial-query.mdx": () => import("../content/docs/tutorial-query.mdx?collection=docs"), "tutorial-request-access.mdx": () => import("../content/docs/tutorial-request-access.mdx?collection=docs"), "workspaces.mdx": () => import("../content/docs/workspaces.mdx?collection=docs"), }),
};
export default browserCollections;