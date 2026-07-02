'use client';

import { useCallback, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface CopyButtonProps {
  /** The text to copy to the clipboard. */
  text: string;
  /**
   * Accessible name for the button, e.g. "Copy MCP config".
   * Keep it stable — the visual icon swap (Copy→Check) communicates the
   * transient success; the aria-live region announces "Copied" to screen readers.
   */
  label: string;
  /** Visual size variant (mirrors Button size). Defaults to 'icon'. */
  size?: 'icon' | 'sm' | 'default';
  className?: string;
}

/**
 * An icon-only button that copies `text` to the clipboard.
 *
 * A11y:
 * - `aria-label` is always the stable label prop; it does NOT swap on success
 *   (the live region carries the announcement instead — combining both causes
 *   double-announcement).
 * - An `aria-live="polite"` sr-only region is ALWAYS mounted; its text content
 *   is toggled between '' and 'Copied' so the mutation triggers a single
 *   announcement. Mounting the element with content already set would not announce.
 * - The Check icon swap is `aria-hidden` — it is purely visual feedback.
 */
export function CopyButton({ text, label, size = 'icon', className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);

  return (
    <>
      {/* Always-mounted live region — text mutation triggers the announcement */}
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {copied ? 'Copied' : ''}
      </span>

      <Button
        type="button"
        variant="ghost"
        size={size}
        onClick={handleCopy}
        aria-label={label}
        className={cn(
          'shrink-0 text-muted-foreground hover:text-foreground',
          className,
        )}
      >
        {copied ? (
          <Check className="size-4" aria-hidden="true" />
        ) : (
          <Copy className="size-4" aria-hidden="true" />
        )}
      </Button>
    </>
  );
}
