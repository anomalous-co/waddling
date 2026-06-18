"use client";

import { useEffect } from "react";
import dynamic from "next/dynamic";
import { useMonaco } from "@monaco-editor/react";
import { useTheme } from "next-themes";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { ensureSqlCompletions, setDialect, setSchemaTables } from "@/lib/sql-completions";
import type { Dialect, SchemaTable } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";

// Monaco is browser-only (web workers, DOM). Load it client-side, never on the
// server. @monaco-editor/react fetches the editor from its default CDN loader,
// so no Turbopack worker bundling is required.
const Editor = dynamic(() => import("@monaco-editor/react").then((m) => m.Editor), {
  ssr: false,
  loading: () => <Skeleton className="h-[160px] w-full rounded-md" />,
});

export function MonacoSql({
  value,
  onChange,
  height = 160,
}: {
  value: string;
  onChange: (value: string) => void;
  height?: number;
}) {
  const { resolvedTheme } = useTheme();
  const monaco = useMonaco();

  // Schema-aware autocomplete: fetch the available tables (local + peer, over
  // quack) and feed them to the shared completion provider. SWR dedups this
  // across every cell's editor, and refreshes so newly-reachable peer tables
  // show up. The provider itself is registered once Monaco is loaded.
  const { data: schema } = useSWR<SchemaTable[]>("/api/schema", fetcher, {
    refreshInterval: 15000,
  });
  // Dialect (keywords + functions) is static for the DuckDB build, so fetch once.
  const { data: dialect } = useSWR<Dialect>("/api/dialect", fetcher, {
    revalidateOnFocus: false,
    revalidateIfStale: false,
  });

  useEffect(() => {
    if (schema) setSchemaTables(schema);
  }, [schema]);

  useEffect(() => {
    if (dialect) setDialect(dialect);
  }, [dialect]);

  useEffect(() => {
    if (monaco) ensureSqlCompletions(monaco);
  }, [monaco]);

  return (
    <div className="overflow-hidden rounded-md border bg-card">
      <Editor
        height={height}
        language="sql"
        theme={resolvedTheme === "dark" ? "vs-dark" : "light"}
        value={value}
        onChange={(v) => onChange(v ?? "")}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
          lineNumbers: "on",
          scrollBeyondLastLine: false,
          automaticLayout: true,
          padding: { top: 10, bottom: 10 },
          renderLineHighlight: "none",
          overviewRulerLanes: 0,
          scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
          tabSize: 2,
          wordWrap: "on",
          // Render the suggestion/hover popups in a body-level fixed layer so they
          // overflow outside this short, `overflow-hidden` editor container instead
          // of being clipped to its ~160px height.
          fixedOverflowWidgets: true,
        }}
      />
    </div>
  );
}
