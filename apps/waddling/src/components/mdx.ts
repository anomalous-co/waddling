import defaultMdxComponents from 'fumadocs-ui/mdx';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import type { MDXComponents } from 'mdx/types';

export function getMDXComponents(
  overrides?: MDXComponents,
): MDXComponents {
  return {
    ...defaultMdxComponents,
    // Registered globally so docs MDX can use them without per-file imports.
    Step,
    Steps,
    ...overrides,
  };
}
