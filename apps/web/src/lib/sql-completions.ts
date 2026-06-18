import type { Monaco } from "@monaco-editor/react";
import type { editor, languages, Position } from "monaco-editor";
import type { Dialect, SchemaTable } from "@/lib/types";

// A single store on globalThis holds the current schema + dialect + a one-time
// registration flag. Keeping it global (not module-local) means the completion
// provider — registered on Monaco once and living for the page's lifetime —
// always reads the latest data, and survives dev hot-reloads without registering
// duplicate providers.
interface CompletionStore {
  tables: SchemaTable[];
  dialect: Dialect;
  registered: boolean;
}

const store: CompletionStore = ((
  globalThis as unknown as { __sqlCompletions?: CompletionStore }
).__sqlCompletions ??= {
  tables: [],
  dialect: { keywords: [], functions: [] },
  registered: false,
});

/** Update the table/column schema used for autocomplete (local + peer). */
export function setSchemaTables(tables: SchemaTable[]): void {
  store.tables = tables;
}

/** Update the DuckDB dialect (keywords + functions) used for autocomplete. */
export function setDialect(dialect: Dialect): void {
  store.dialect = dialect;
}

/** Register the schema- and dialect-aware SQL completion provider exactly once. */
export function ensureSqlCompletions(monaco: Monaco): void {
  if (store.registered) return;
  store.registered = true;

  const { CompletionItemKind } = monaco.languages;

  monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: ["."],
    provideCompletionItems(model: editor.ITextModel, position: Position) {
      const word = model.getWordUntilPosition(position);
      const range: languages.CompletionItem["range"] = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const suggestions: languages.CompletionItem[] = [];

      // 1. Tables (peers sorted first so they surface prominently).
      const seenColumns = new Set<string>();
      for (const t of store.tables) {
        suggestions.push({
          label: t.qualifiedName,
          kind: CompletionItemKind.Struct,
          insertText: t.qualifiedName,
          detail: t.scope === "peer" ? "peer table" : "local table",
          sortText: `${t.scope === "peer" ? "0" : "1"}_${t.qualifiedName}`,
          range,
        });
        for (const c of t.columns) {
          if (seenColumns.has(c.name)) continue;
          seenColumns.add(c.name);
          suggestions.push({
            label: c.name,
            kind: CompletionItemKind.Field,
            insertText: c.name,
            detail: `${c.type} · ${t.qualifiedName}`,
            sortText: `2_${c.name}`,
            range,
          });
        }
      }

      // 2. DuckDB keywords — tiered by category so core clause keywords (reserved:
      // FROM/WHERE/SELECT/GROUP) rank highest, then grammar keywords (type_function:
      // JOIN/LEFT), both above functions; obscure keywords rank below functions.
      // This keeps FROM from being buried under same-prefix functions (from_hex).
      for (const kw of store.dialect.keywords) {
        const tier =
          kw.category === "reserved" ? "2" : kw.category === "type_function" ? "3" : "5";
        suggestions.push({
          label: kw.name,
          kind: CompletionItemKind.Keyword,
          insertText: kw.name,
          // Match against a lowercase form so typing lowercase (e.g. "fr") doesn't
          // incur Monaco's case-mismatch penalty vs lowercase function names.
          filterText: kw.name.toLowerCase(),
          sortText: `${tier}_${kw.name}`,
          range,
        });
      }

      // 3. DuckDB functions (with signature + return type + description).
      for (const fn of store.dialect.functions) {
        suggestions.push({
          label: fn.name,
          kind: CompletionItemKind.Function,
          insertText: fn.name,
          detail: fn.returnType ? `${fn.signature} → ${fn.returnType}` : fn.signature,
          documentation: fn.description ? { value: fn.description } : undefined,
          filterText: fn.name,
          sortText: `4_${fn.name}`,
          range,
        });
      }

      return { suggestions };
    },
  });
}
