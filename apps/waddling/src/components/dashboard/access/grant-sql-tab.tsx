'use client';

/**
 * Grant SQL tab (power users). Three clearly-separated regions over the SAME draft
 * the Picker edits — resolving the old two-list confusion (Diagnosis #1):
 *
 *  1. This key's statements (editable) — own, structurally-recognized rows. Delete
 *     to stage a removal; paste a block to author more.
 *  2. Advanced (N) — own statements the Picker can't model (server `parsed === null`),
 *     preserved verbatim, delete-only.
 *  3. Inherited (read-only) — role- and PUBLIC-derived statements, muted, chipped
 *     with their source. Managed on the role/PUBLIC, not this key.
 *
 * NOTE (contract gap): the POST /api/cp/acl body is structured (target/membership).
 * Pasted/hand-authored raw SQL has no structured form and a client SQL parser is
 * forbidden, so raw statements are POSTed as a raw `sql` field — accepted by the
 * lab mock; in prod they surface as per-grant save failures if unsupported.
 */
import { useState } from 'react';
import { Ban, Check, Trash2, ChevronRight, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import type { DraftStatement, ResolvedStatement } from './access-draft';

function isDeny(sql: string): boolean {
  return /^\s*deny\b/i.test(sql);
}

function StatementRow({
  sql,
  muted,
  action,
  chip,
}: {
  sql: string;
  muted?: boolean;
  action?: React.ReactNode;
  chip?: React.ReactNode;
}) {
  const deny = isDeny(sql);
  return (
    <div
      className={cn(
        'group flex items-start gap-3 rounded-md border-l-2 py-2 pr-2 pl-3 font-mono text-xs leading-relaxed',
        muted
          ? 'border-l-border bg-muted/30 text-muted-foreground'
          : deny
            ? 'border-l-destructive bg-destructive/5 text-destructive'
            : 'border-l-emerald-500 bg-emerald-500/5 text-foreground dark:border-l-emerald-400',
      )}
    >
      {deny ? (
        <Ban className="mt-0.5 size-3.5 shrink-0" aria-label="deny" />
      ) : (
        <Check className={cn('mt-0.5 size-3.5 shrink-0', !muted && 'text-emerald-600 dark:text-emerald-400')} aria-label="grant" />
      )}
      <code className="min-w-0 flex-1 break-all whitespace-pre-wrap">{sql}</code>
      {chip}
      {action}
    </div>
  );
}

export function GrantSqlTab({
  own,
  inherited,
  onRemove,
  onAddRaw,
  readOnly,
}: {
  own: DraftStatement[];
  inherited: ResolvedStatement[];
  onRemove: (sql: string) => void;
  onAddRaw: (statements: string[]) => void;
  readOnly?: boolean;
}) {
  const [pasteOpen, setPasteOpen] = useState(false);
  const [buffer, setBuffer] = useState('');

  const editable = own.filter((s) => s.parsed !== null);
  const advanced = own.filter((s) => s.parsed === null);

  const commitPaste = () => {
    const statements = buffer
      .split(/\n|;/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (statements.length) onAddRaw(statements);
    setBuffer('');
    setPasteOpen(false);
  };

  const removeBtn = (sql: string) =>
    readOnly ? null : (
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0 opacity-60 transition-opacity group-hover:opacity-100"
        onClick={() => onRemove(sql)}
        aria-label="Remove statement"
      >
        <Trash2 />
      </Button>
    );

  return (
    <div className="flex flex-col gap-4">
      {/* editable own statements */}
      <div>
        <div className="flex items-center justify-between border-b pb-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            This key&apos;s statements {editable.length > 0 && `(${editable.length})`}
          </span>
          {!readOnly && (
            <Button size="sm" variant="outline" className="h-7" onClick={() => setPasteOpen((v) => !v)}>
              <Plus className="size-3.5" /> Add / paste
            </Button>
          )}
        </div>

        {pasteOpen && (
          <div className="mt-2 flex flex-col gap-2">
            <Textarea
              value={buffer}
              onChange={(e) => setBuffer(e.target.value)}
              placeholder={'GRANT SELECT ON analytics.events TO agent:…\nDENY SELECT ON analytics.pii TO agent:…'}
              className="min-h-20 font-mono text-xs"
            />
            <div className="flex items-center justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => { setBuffer(''); setPasteOpen(false); }}>
                Cancel
              </Button>
              <Button size="sm" onClick={commitPaste} disabled={!buffer.trim()}>
                Add statements
              </Button>
            </div>
          </div>
        )}

        <div className="mt-3 flex flex-col gap-1.5">
          {editable.length === 0 && !pasteOpen ? (
            <p className="text-sm text-muted-foreground">
              No direct statements on this key. Author them in the Picker, or paste them here.
            </p>
          ) : (
            editable.map((s, i) => (
              <StatementRow key={`${i}-${s.sql}`} sql={s.sql} action={removeBtn(s.sql)} />
            ))
          )}
        </div>
      </div>

      {/* advanced (unparsed) bucket */}
      {advanced.length > 0 && (
        <Collapsible defaultOpen={false}>
          <CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-3.5 transition-transform data-[state=open]:rotate-90" />
            Advanced statements ({advanced.length}) — not shown in the Picker, edit here
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 flex flex-col gap-1.5">
            {advanced.map((s, i) => (
              <StatementRow key={`${i}-${s.sql}`} sql={s.sql} muted action={removeBtn(s.sql)} />
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* inherited read-only */}
      {inherited.length > 0 && (
        <div>
          <div className="border-b pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Inherited (read-only) — managed on the role / PUBLIC, not this key
          </div>
          <div className="mt-3 flex flex-col gap-1.5">
            {inherited.map((s, i) => (
              <StatementRow
                key={`${i}-${s.sql}`}
                sql={s.sql}
                muted
                chip={
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {s.inherited && s.inherited.via === 'role' ? `via role · ${s.inherited.role}` : 'PUBLIC'}
                  </span>
                }
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
