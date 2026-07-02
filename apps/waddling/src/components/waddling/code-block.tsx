import { CopyButton } from '@/components/waddling/copy-button';
import { cn } from '@/lib/utils';

interface CodeBlockProps {
  /** The code or snippet to display. */
  code: string;
  /**
   * Short label shown as a header above the block (e.g. "mcp.json", "DuckDB SQL").
   * When omitted the block has no header row.
   */
  label?: string;
  /**
   * Accessible label for the copy button, e.g. "Copy MCP config".
   * Defaults to "Copy code" if not specified.
   */
  copyLabel?: string;
  className?: string;
}

/**
 * A monospace code surface with an embedded CopyButton.
 *
 * Intended for displaying connection snippets, SQL, JSON configs, etc.
 * Combine two CodeBlocks inside shadcn `<Tabs>` for multi-format options.
 *
 * The `<pre>` element is `tabIndex={0}` so keyboard users can scroll
 * long snippets without a pointer device.
 */
export function CodeBlock({ code, label, copyLabel = 'Copy code', className }: CodeBlockProps) {
  return (
    <div className={cn('relative rounded-lg border bg-muted/50', className)}>
      {/* Optional header with label */}
      {label && (
        <div className="flex items-center justify-between border-b px-4 py-2">
          <span className="font-mono text-xs text-muted-foreground">{label}</span>
        </div>
      )}

      {/* Copy button — absolute-positioned in the top-right */}
      <div className="absolute right-2 top-2">
        <CopyButton text={code} label={copyLabel} size="icon" className="size-7" />
      </div>

      {/* Code body */}
      <pre
        tabIndex={0}
        aria-label={label ? `${label} snippet` : 'Code snippet'}
        className="overflow-x-auto p-4 pr-10 font-mono text-xs leading-relaxed text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      >
        {code}
      </pre>
    </div>
  );
}
