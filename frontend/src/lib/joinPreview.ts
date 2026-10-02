export type JoinHow = 'inner' | 'left' | 'right' | 'outer' | 'cross';

export interface JoinPreviewParams {
  leftRows: Record<string, any>[];
  leftColumns: string[];
  rightRows: Record<string, any>[];
  rightColumns: string[];
  how: JoinHow;
  on?: string[];
  leftOn?: string[];
  rightOn?: string[];
  suffixes?: [string, string];
  maxRows?: number;
}

export type ColumnSource = 'left' | 'right' | 'key';

export interface JoinPreviewResult {
  columns: string[];
  rows: Record<string, any>[];
  truncated: boolean;
  /** Which side each output column came from -- 'key' for an `on`-mode
   *  join key (shown once, semantically shared rather than owned by
   *  either side). Powers shading the preview table by source. */
  columnSource: Record<string, ColumnSource>;
  /** Output column names that exist because of a real left/right naming
   *  collision (e.g. "name_x"/"name_y") -- the ones a rename UI should
   *  actually offer to rename, since renaming a column with no conflict
   *  in the first place isn't the problem the user is solving. */
  conflictColumns: string[];
}

function rowKey(row: Record<string, any>, keys: string[]): string {
  return keys.map((k) => JSON.stringify(row[k])).join('\u0000');
}

function indexBy(rows: Record<string, any>[], keys: string[]): Map<string, Record<string, any>[]> {
  const idx = new Map<string, Record<string, any>[]>();
  for (const row of rows) {
    const k = rowKey(row, keys);
    const bucket = idx.get(k);
    if (bucket) bucket.push(row);
    else idx.set(k, [row]);
  }
  return idx;
}

/**
 * Approximate, client-side preview of a join across two already-fetched
 * DataFrame samples -- lets the join builder show "here's roughly what
 * you'd get" before saving, with no new backend endpoint. Not a full
 * pandas-merge reimplementation: overlapping non-key column names are
 * suffixed the same way the real dataframe_join component does, but this
 * runs against samples of both sides, so match counts (especially for
 * inner/left/right) are only representative, not exact -- the real join
 * runs against full data once materialized.
 */
export function computeJoinPreview(params: JoinPreviewParams): JoinPreviewResult {
  const { leftRows, leftColumns, rightRows, rightColumns, how, on, leftOn, rightOn, maxRows = 200 } = params;
  const suffixes = params.suffixes && params.suffixes.length === 2 ? params.suffixes : ['_x', '_y'];
  const leftKeys = on && on.length > 0 ? on : (leftOn || []);
  const rightKeys = on && on.length > 0 ? on : (rightOn || []);
  const onKeySet = new Set(on && on.length > 0 ? on : []);

  const sharedNonKeyCols = new Set(
    leftColumns.filter((c) => rightColumns.includes(c) && !onKeySet.has(c)),
  );

  function mergeRow(l: Record<string, any> | null, r: Record<string, any> | null): Record<string, any> {
    const out: Record<string, any> = {};
    for (const c of leftColumns) {
      const key = sharedNonKeyCols.has(c) ? `${c}${suffixes[0]}` : c;
      out[key] = l ? l[c] : null;
    }
    for (const c of rightColumns) {
      if (onKeySet.has(c)) continue; // shown once already, from the left side
      const key = sharedNonKeyCols.has(c) ? `${c}${suffixes[1]}` : c;
      out[key] = r ? r[c] : null;
    }
    return out;
  }

  const columns: string[] = [
    ...leftColumns.map((c) => (sharedNonKeyCols.has(c) ? `${c}${suffixes[0]}` : c)),
    ...rightColumns.filter((c) => !onKeySet.has(c)).map((c) => (sharedNonKeyCols.has(c) ? `${c}${suffixes[1]}` : c)),
  ];

  const columnSource: Record<string, ColumnSource> = {};
  const conflictColumns: string[] = [];
  for (const c of leftColumns) {
    const key = sharedNonKeyCols.has(c) ? `${c}${suffixes[0]}` : c;
    columnSource[key] = onKeySet.has(c) ? 'key' : 'left';
    if (sharedNonKeyCols.has(c)) conflictColumns.push(key);
  }
  for (const c of rightColumns) {
    if (onKeySet.has(c)) continue;
    const key = sharedNonKeyCols.has(c) ? `${c}${suffixes[1]}` : c;
    columnSource[key] = 'right';
    if (sharedNonKeyCols.has(c)) conflictColumns.push(key);
  }

  let rows: Record<string, any>[] = [];

  if (how === 'cross') {
    outer: for (const l of leftRows) {
      for (const r of rightRows) {
        rows.push(mergeRow(l, r));
        if (rows.length >= maxRows) break outer;
      }
    }
  } else if (how === 'inner' || how === 'left') {
    const rightIdx = indexBy(rightRows, rightKeys);
    for (const l of leftRows) {
      const matches = rightIdx.get(rowKey(l, leftKeys)) || [];
      if (matches.length > 0) {
        for (const r of matches) rows.push(mergeRow(l, r));
      } else if (how === 'left') {
        rows.push(mergeRow(l, null));
      }
      if (rows.length >= maxRows) break;
    }
  } else if (how === 'right') {
    const leftIdx = indexBy(leftRows, leftKeys);
    for (const r of rightRows) {
      const matches = leftIdx.get(rowKey(r, rightKeys)) || [];
      if (matches.length > 0) {
        for (const l of matches) rows.push(mergeRow(l, r));
      } else {
        rows.push(mergeRow(null, r));
      }
      if (rows.length >= maxRows) break;
    }
  } else if (how === 'outer') {
    const rightIdx = indexBy(rightRows, rightKeys);
    const matchedRightKeys = new Set<string>();
    for (const l of leftRows) {
      const lk = rowKey(l, leftKeys);
      const matches = rightIdx.get(lk) || [];
      if (matches.length > 0) {
        matchedRightKeys.add(lk);
        for (const r of matches) rows.push(mergeRow(l, r));
      } else {
        rows.push(mergeRow(l, null));
      }
      if (rows.length >= maxRows) break;
    }
    if (rows.length < maxRows) {
      for (const r of rightRows) {
        const rk = rowKey(r, rightKeys);
        if (!matchedRightKeys.has(rk)) rows.push(mergeRow(null, r));
        if (rows.length >= maxRows) break;
      }
    }
  }

  const truncated = rows.length >= maxRows;
  return { columns, rows: rows.slice(0, maxRows), truncated, columnSource, conflictColumns };
}
