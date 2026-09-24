import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';

/** Clickable, sortable `<th>` — click toggles asc/desc on that column,
 *  switching to a new column always starts at asc. Shared across every
 *  data table in the app (Ingestions, Asset Catalog, Monitors, ...) so
 *  the affordance (chevron, hover state, click-to-toggle) stays
 *  identical everywhere rather than each table reinventing it. `T` is
 *  that table's own union of sortable column keys. */
export function SortableTh<T extends string>({ label, col, sortColumn, sortDirection, onSort, align = 'left' }: {
  label: string;
  col: T;
  sortColumn: T | null;
  sortDirection: 'asc' | 'desc';
  onSort: (col: T) => void;
  align?: 'left' | 'right';
}) {
  const active = sortColumn === col;
  return (
    <th className={`px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button
        onClick={() => onSort(col)}
        className={`inline-flex items-center gap-1 hover:text-gray-900 ${active ? 'text-gray-900' : ''} ${align === 'right' ? 'flex-row-reverse' : ''}`}
        title={`Sort by ${label.toLowerCase()}`}
      >
        {label}
        {active ? (
          sortDirection === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronsUpDown className="w-3 h-3 text-gray-300" />
        )}
      </button>
    </th>
  );
}

/** Toggle-sort state helper: same asc-then-desc-then-asc cycle every
 *  sortable table uses. Returns the new [column, direction] pair to set. */
export function nextSortState<T extends string>(
  current: T | null,
  currentDirection: 'asc' | 'desc',
  clicked: T,
): { column: T; direction: 'asc' | 'desc' } {
  if (current !== clicked) return { column: clicked, direction: 'asc' };
  return { column: clicked, direction: currentDirection === 'asc' ? 'desc' : 'asc' };
}
