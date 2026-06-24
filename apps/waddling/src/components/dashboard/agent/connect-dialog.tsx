'use client';

import { useCallback, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';

// ── Key placeholder ────────────────────────────────────────────────────────────
// An existing agent's key is NOT retrievable after creation — it is shown once
// at creation time only. We template with a readable placeholder so the user
// knows exactly where to substitute the key they copied at creation.
const KEY_PLACEHOLDER = 'sk_agent_…';

// ── Snippet builders (mirrored from connect-wizard; do not import from there) ──
function mcpConfig(agentKey: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        waddling: {
          command: 'npx',
          args: ['-y', '@waddling/mcp@latest'],
          env: {
            WADDLING_URL: 'https://api.getwaddling.com',
            WADDLING_API_KEY: agentKey,
          },
        },
      },
    },
    null,
    2,
  );
}

const EXTENSION_SQL = [
  'SET allow_unsigned_extensions = true;',
  "INSTALL birdshot FROM 'https://ext.getwaddling.com';",
  'LOAD birdshot;',
].join('\n');

function duckdbAttach(agentKey: string): string {
  // quack: scheme (single colon, per spec); host is your gateway endpoint URL
  // (shown in your data lake details). Using a placeholder here — do not invent.
  return `${EXTENSION_SQL}\nATTACH 'quack:<your-gateway-endpoint>?token=${agentKey}' AS lake;`;
}

// ── CopyBlock ──────────────────────────────────────────────────────────────────
// A mono code surface with an icon-swap copy button (Copy→Check for ~2s).
function CopyBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [code]);

  return (
    <div className="relative rounded-lg border bg-muted/50">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-2 top-2 size-7 text-muted-foreground hover:text-foreground"
        onClick={copy}
        aria-label="Copy to clipboard"
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </Button>
      <pre className="overflow-x-auto p-4 pr-10 font-mono text-xs leading-relaxed text-foreground">
        {code}
      </pre>
    </div>
  );
}

// ── Key note ───────────────────────────────────────────────────────────────────
function KeyNote() {
  return (
    <p className="text-xs text-muted-foreground">
      Use the key shown when this agent was created. Replace{' '}
      <code className="rounded bg-muted px-1 py-0.5 font-mono">{KEY_PLACEHOLDER}</code>{' '}
      with your actual key. Lost it?{' '}
      <span className="text-muted-foreground/70">
        Per-key rotation is coming soon.
      </span>
    </p>
  );
}

// ── ConnectDialog ──────────────────────────────────────────────────────────────
export function ConnectDialog({
  open,
  onOpenChange,
  agentId: _agentId,
  agentName,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  agentId: string;
  agentName: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Connect &middot;{' '}
            <span className="font-mono text-base font-semibold">{agentName}</span>
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="mcp" className="mt-2">
          <TabsList>
            <TabsTrigger value="mcp">MCP (recommended)</TabsTrigger>
            <TabsTrigger value="duckdb">Raw DuckDB</TabsTrigger>
          </TabsList>

          {/* MCP panel */}
          <TabsContent value="mcp" className="mt-4 flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Add to your MCP client config (e.g. Claude Desktop). Replace the
              placeholder with your agent key.
            </p>
            <CopyBlock code={mcpConfig(KEY_PLACEHOLDER)} />
            <KeyNote />
          </TabsContent>

          {/* Raw DuckDB panel */}
          <TabsContent value="duckdb" className="mt-4 flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              For connecting or checking access by hand with a local DuckDB
              (v1.5.3). Loads the birdshot extension and attaches to the
              governed gateway.
            </p>
            <CopyBlock code={duckdbAttach(KEY_PLACEHOLDER)} />
            <KeyNote />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
