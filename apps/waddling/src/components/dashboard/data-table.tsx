'use client';

/**
 * Sortable, paginated, column-resizable result table for governed query results.
 *
 * Ported from the web app's DataTable, adapted to (a) the dashboard's dark UI
 * primitives and (b) waddling's QueryResult shape (`columns: string[]` +
 * `rows: unknown[][]` row tuples, not row objects). Sorting, pagination, and
 * column resizing are client-side and dependency-free (no @tanstack/react-table)
 * — the gateway has already capped/projected the rows server-side, so the set is
 * small enough to hold and sort in memory.
 *
 * Resizing uses `table-layout: fixed` + a <colgroup>: each column has an explicit
 * width that a drag handle on its header edge adjusts. Cells truncate (with the
 * full value on hover) so a narrow column stays one row tall and widening it
 * reveals the rest.
 */
import { useMemo, useState } from 'react';
import { Button } from './ui';

type SortDir = 'asc' | 'desc';

const DEFAULT_COL_W = 160;
const MIN_COL_W = 60;

function renderCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Total order over heterogeneous, possibly-null cell values. NULLs sort last;
 * numbers compare numerically; everything else compares as a localized string.
 * Gateway results are JSON-normalized (BigInt→Number), so values are primitives
 * or plain objects here — never throws on mixed types.
 */
function compareValues(a: unknown, b: unknown): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return renderCell(a).localeCompare(renderCell(b), undefined, { numeric: true });
}

export function DataTable({
  columns,
  rows,
  pageSize = 25,
}: {
  columns: string[];
  rows: unknown[][];
  pageSize?: number;
}) {
  const [sort, setSort] = useState<{ col: number; dir: SortDir } | null>(null);
  const [page, setPage] = useState(0);
  const [widths, setWidths] = useState<Record<number, number>>({});
  // The column currently being dragged, so its handle stays highlighted even
  // when the pointer drifts off the 8px hit zone mid-drag.
  const [activeResize, setActiveResize] = useState<number | null>(null);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const factor = sort.dir === 'asc' ? 1 : -1;
    // Copy before sort — never mutate the prop array.
    return [...rows].sort((ra, rb) => factor * compareValues(ra[sort.col], rb[sort.col]));
  }, [rows, sort]);

  const pageCount = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  // Clamp the page if the data shrank (e.g. re-run returned fewer rows).
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = sortedRows.slice(safePage * pageSize, safePage * pageSize + pageSize);

  const getWidth = (ci: number) => widths[ci] ?? DEFAULT_COL_W;
  const totalWidth = columns.reduce((sum, _, ci) => sum + getWidth(ci), 0);

  function toggleSort(col: number) {
    setPage(0);
    setSort((s) =>
      s?.col === col
        ? s.dir === 'asc'
          ? { col, dir: 'desc' }
          : null // asc → desc → unsorted
        : { col, dir: 'asc' },
    );
  }

  /** Drag the right edge of column `ci` to resize it. */
  function startResize(ci: number, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation(); // don't trigger the header's sort
    const startX = e.clientX;
    const startW = getWidth(ci);
    setActiveResize(ci);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(MIN_COL_W, startW + (ev.clientX - startX));
      setWidths((w) => ({ ...w, [ci]: next }));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      setActiveResize(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded border border-neutral-800">
        <table className="text-sm" style={{ tableLayout: 'fixed', width: totalWidth }}>
          <colgroup>
            {columns.map((_, ci) => (
              <col key={ci} style={{ width: getWidth(ci) }} />
            ))}
          </colgroup>
          <thead>
            <tr className="border-b border-neutral-800 divide-x divide-neutral-800/60">
              {columns.map((h, ci) => {
                const active = sort?.col === ci;
                return (
                  <th key={ci} className="relative overflow-hidden px-3 py-2 text-left">
                    <button
                      type="button"
                      onClick={() => toggleSort(ci)}
                      title={h}
                      className="flex w-full items-center gap-1 text-xs font-medium uppercase tracking-wider text-neutral-500 hover:text-neutral-200 transition-colors cursor-pointer"
                    >
                      <span className="min-w-0 truncate">{h}</span>
                      <span className="flex-shrink-0 text-[10px] opacity-70">
                        {active ? (sort.dir === 'asc' ? '▲' : '▼') : '⇅'}
                      </span>
                    </button>
                    {/* Resize handle — an 8px hit zone aligned to the column
                        divider (drawn by divide-x). The 1px line is transparent
                        at rest so it doesn't double the divider, and accents to
                        blue on hover / while dragging (matching Input's focus ring). */}
                    <span
                      onMouseDown={(e) => startResize(ci, e)}
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize ${h} column`}
                      className="group/resize absolute inset-y-0 right-0 z-10 flex w-2 cursor-col-resize touch-none select-none justify-end"
                    >
                      <span
                        className={[
                          'w-px transition-colors',
                          activeResize === ci
                            ? 'bg-blue-500'
                            : 'bg-transparent group-hover/resize:bg-blue-500',
                        ].join(' ')}
                      />
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800/60">
            {pageRows.map((row, ri) => (
              <tr key={ri} className="divide-x divide-neutral-800/60">
                {row.map((cellVal, ci) => {
                  const isNull = cellVal === null || cellVal === undefined;
                  const text = renderCell(cellVal);
                  return (
                    <td
                      key={ci}
                      title={isNull ? 'NULL' : text}
                      className="truncate px-3 py-2 font-mono text-xs text-neutral-300 tabular-nums"
                    >
                      {isNull ? <span className="text-neutral-600">NULL</span> : text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-neutral-600">
        <span className="tabular-nums">
          {sortedRows.length} row{sortedRows.length === 1 ? '' : 's'}
        </span>
        {pageCount > 1 && (
          <div className="flex items-center gap-2">
            <span className="tabular-nums">
              Page {safePage + 1} of {pageCount}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPage(safePage - 1)}
              disabled={safePage <= 0}
            >
              Prev
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPage(safePage + 1)}
              disabled={safePage >= pageCount - 1}
            >
              Next
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
