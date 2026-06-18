'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef } from 'react';
import { useMonaco } from '@monaco-editor/react';
import { useTheme } from 'fumadocs-ui/provider/base';
import type { languages } from 'monaco-editor';
import { Spinner } from './ui';
import type { TableInfo } from '@/lib/types';

// Monaco is browser-only (web workers, DOM). Load client-side only.
// @monaco-editor/react fetches the editor from its default CDN loader, so the
// host needs network access on first load (the rest of the demo is offline-safe).
const Editor = dynamic(() => import('@monaco-editor/react').then((m) => m.Editor), {
  ssr: false,
  loading: () => (
    <div className="flex h-[160px] items-center justify-center rounded-md border border-neutral-800 bg-neutral-900">
      <Spinner />
    </div>
  ),
});

// One completion provider per Monaco instance. We mutate this live so the
// suggestions track the currently-connected agent's grants. `currentTables` is
// the bare list of granted "schema.table" refs (always available after connect);
// `currentSchema` adds columns + types once the governed describe probe returns.
let registered = false;
let currentTables: string[] = [];
let currentSchema: TableInfo[] = [];

const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'LIMIT', 'JOIN',
  'LEFT JOIN', 'INNER JOIN', 'ON', 'AS', 'AND', 'OR', 'NOT', 'IN', 'IS NULL',
  'COUNT(*)', 'SUM', 'AVG', 'MIN', 'MAX', 'DISTINCT', 'INSERT INTO', 'VALUES',
];

export function setSqlTables(tables: string[]): void {
  currentTables = tables;
}

export function setSqlSchema(schema: TableInfo[]): void {
  currentSchema = schema;
}

function ensureCompletions(monaco: NonNullable<ReturnType<typeof useMonaco>>): void {
  if (registered) return;
  registered = true;
  monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.'],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const { CompletionItemKind } = monaco.languages;
      const suggestions: languages.CompletionItem[] = [];

      // Prefer the richer schema (columns + types) when the describe probe has
      // returned; fall back to the bare granted-table list otherwise.
      if (currentSchema.length > 0) {
        const seenColumns = new Set<string>();
        for (const t of currentSchema) {
          const qualified = `${t.schema}.${t.table}`;
          suggestions.push({
            label: qualified,
            kind: CompletionItemKind.Struct,
            insertText: qualified,
            detail: 'granted table',
            sortText: `0_${qualified}`,
            range,
          });
          for (const c of t.columns) {
            if (seenColumns.has(c.name)) continue;
            seenColumns.add(c.name);
            suggestions.push({
              label: c.name,
              kind: CompletionItemKind.Field,
              insertText: c.name,
              detail: `${c.type} · ${qualified}`,
              sortText: `1_${c.name}`,
              range,
            });
          }
        }
      } else {
        for (const t of currentTables) {
          suggestions.push({
            label: t,
            kind: CompletionItemKind.Struct,
            insertText: t,
            detail: 'granted table',
            sortText: `0_${t}`,
            range,
          });
        }
      }

      for (const k of SQL_KEYWORDS) {
        suggestions.push({
          label: k,
          kind: CompletionItemKind.Keyword,
          insertText: k,
          sortText: `2_${k}`,
          range,
        });
      }

      return { suggestions };
    },
  });
}

export function MonacoSql({
  value,
  onChange,
  tables = [],
  schema = [],
  height = 150,
  onRun,
}: {
  value: string;
  onChange: (value: string) => void;
  tables?: string[];
  schema?: TableInfo[];
  height?: number;
  onRun?: () => void;
}) {
  const monaco = useMonaco();
  const { resolvedTheme } = useTheme();
  const isLight = resolvedTheme === 'light';

  // Cmd/Ctrl+Enter is registered once in onMount, so its closure would otherwise
  // capture the first onRun (which closes over the cell's starter SQL). Keep the
  // latest onRun in a ref so the command always runs the current cell's query.
  const onRunRef = useRef(onRun);
  useEffect(() => {
    onRunRef.current = onRun;
  }, [onRun]);

  useEffect(() => {
    setSqlTables(tables);
  }, [tables]);

  useEffect(() => {
    setSqlSchema(schema);
  }, [schema]);

  useEffect(() => {
    if (monaco) ensureCompletions(monaco);
  }, [monaco]);

  return (
    <div
      className={`overflow-hidden rounded-md border border-neutral-800 ${
        isLight ? 'bg-[#fffffe]' : 'bg-[#1e1e1e]'
      }`}
    >
      <Editor
        height={height}
        language="sql"
        theme={isLight ? 'vs' : 'vs-dark'}
        value={value}
        onChange={(v) => onChange(v ?? '')}
        onMount={(editor, m) => {
          // Cmd/Ctrl+Enter runs the cell. Call through the ref so the latest
          // onRun (closing over the current cell SQL) is always used.
          editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.Enter, () => onRunRef.current?.());
        }}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          fontFamily: 'var(--font-geist-mono), ui-monospace, monospace',
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          automaticLayout: true,
          padding: { top: 10, bottom: 10 },
          renderLineHighlight: 'none',
          overviewRulerLanes: 0,
          scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
          tabSize: 2,
          wordWrap: 'on',
          fixedOverflowWidgets: true,
        }}
      />
    </div>
  );
}
