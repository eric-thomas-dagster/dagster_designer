import { computeProfile } from '@/components/ColumnProfileStrip';

/**
 * Trifacta/Dataprep-style transform suggestions -- two sources:
 *
 * 1. computeColumnSuggestions: scans the loaded sample rows (the same data
 *    already driving Profile mode) for common data-quality patterns --
 *    inconsistent whitespace/casing, a delimiter that splits every value
 *    the same way, date/email-shaped strings, excess numeric precision,
 *    punctuation, exact-duplicate rows, high null rates -- and proposes the
 *    existing op that would fix each one. Nothing here is a new backend
 *    capability; every suggestion's `action` maps onto a TransformConfig
 *    field DataPreviewModal's save path already sends.
 *
 * 2. computeSelectionSuggestions: given a cell's raw text and a substring
 *    the user selected inside it (offsets into that string), proposes
 *    candidates for turning that selection into its own column -- prefix
 *    extraction, suffix extraction (via substring_ops' negative-start
 *    convention), a delimiter split if the selection sits right next to
 *    one, or a plain fixed-offset extraction as a fallback. This is
 *    Trifacta's "Transformation by Example": you highlight the part of the
 *    value you care about, it infers what you're pointing at.
 */

export type SuggestionAction =
  | { type: 'stringOp'; column: string; operation: string }
  | { type: 'dropDuplicates' }
  | { type: 'splitOp'; column: string; delimiter: string; into: string }
  | { type: 'substringOp'; column: string; start: number; length: number | null; into: string }
  | { type: 'dateExtractOp'; column: string; part: string; into: string }
  | { type: 'numericOp'; column: string; op: string; digits: number; into: string }
  | { type: 'fillDirectionOp'; column: string; direction: 'ffill' | 'bfill' };

export interface TransformSuggestion {
  id: string;
  column: string | null; // null for table-wide suggestions (e.g. dedupe)
  title: string;
  description: string;
  action: SuggestionAction;
}

const DELIMITER_CANDIDATES = ['-', '_', '/', ':', '|', ','];
const PUNCTUATION_RE = /[!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\]/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function nonNullStrings(rows: Array<Record<string, any>>, column: string): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const v = row[column];
    if (v !== null && v !== undefined && v !== '') out.push(String(v));
  }
  return out;
}

function uniqueInto(base: string, taken: Set<string>): string {
  let name = base;
  let n = 2;
  while (taken.has(name)) {
    name = `${base}_${n}`;
    n += 1;
  }
  taken.add(name);
  return name;
}

export function computeColumnSuggestions(
  rows: Array<Record<string, any>>,
  columns: string[],
  dtypes?: Record<string, string>,
): TransformSuggestion[] {
  if (!rows.length || !columns.length) return [];
  const suggestions: TransformSuggestion[] = [];
  const takenInto = new Set<string>();

  // Table-wide: exact duplicate rows.
  const seenRows = new Set<string>();
  let dupCount = 0;
  for (const row of rows) {
    const key = JSON.stringify(columns.map((c) => row[c]));
    if (seenRows.has(key)) dupCount++;
    else seenRows.add(key);
  }
  if (dupCount > 0) {
    suggestions.push({
      id: 'dedupe-rows',
      column: null,
      title: `Drop ${dupCount} duplicate row${dupCount === 1 ? '' : 's'}`,
      description: `${dupCount} of ${rows.length} sampled rows are exact duplicates across every column.`,
      action: { type: 'dropDuplicates' },
    });
  }

  for (const col of columns) {
    const profile = computeProfile(rows, col, dtypes?.[col]);
    if (profile.total === 0 || profile.nonNull === 0) continue;
    const values = nonNullStrings(rows, col);

    // Whitespace inconsistency.
    if (profile.kind === 'string' && values.some((v) => v !== v.trim())) {
      suggestions.push({
        id: `trim-${col}`,
        column: col,
        title: `Trim whitespace in "${col}"`,
        description: 'Some values have leading or trailing spaces.',
        action: { type: 'stringOp', column: col, operation: 'trim' },
      });
    }

    // Case inconsistency: values that collapse to the same thing when
    // lowercased but aren't already identical (e.g. "Yes" / "yes").
    if (profile.kind === 'string') {
      const byLower = new Map<string, Set<string>>();
      for (const v of values) {
        const key = v.trim().toLowerCase();
        if (!byLower.has(key)) byLower.set(key, new Set());
        byLower.get(key)!.add(v);
      }
      const inconsistent = Array.from(byLower.values()).some((variants) => variants.size > 1);
      if (inconsistent) {
        suggestions.push({
          id: `lower-${col}`,
          column: col,
          title: `Standardize casing in "${col}"`,
          description: 'The same value appears with different capitalization (e.g. "Yes" and "yes") -- lowercasing would merge them.',
          action: { type: 'stringOp', column: col, operation: 'lower' },
        });
      }
    }

    // Punctuation present (skip very short values -- likely codes where
    // the hyphen/etc. IS the meaningful content, not noise).
    if (profile.kind === 'string' && values.some((v) => v.length > 6 && PUNCTUATION_RE.test(v))) {
      suggestions.push({
        id: `punct-${col}`,
        column: col,
        title: `Remove punctuation from "${col}"`,
        description: 'Values contain punctuation characters.',
        action: { type: 'stringOp', column: col, operation: 'remove_punctuation' },
      });
    }

    // Email-shaped -- split into username/domain.
    if (profile.kind === 'string' && values.length > 0 && values.every((v) => EMAIL_RE.test(v))) {
      const into = uniqueInto(`${col}_user`, takenInto) + `,${uniqueInto(`${col}_domain`, takenInto)}`;
      suggestions.push({
        id: `email-split-${col}`,
        column: col,
        title: `Split "${col}" into username / domain`,
        description: 'Every value looks like an email address.',
        action: { type: 'splitOp', column: col, delimiter: '@', into },
      });
    } else if (profile.kind === 'string' && values.length > 0) {
      // Consistent delimiter -- every value contains the same count (>=1)
      // of one candidate delimiter. First qualifying delimiter wins so one
      // column doesn't get 6 near-identical suggestions.
      for (const delim of DELIMITER_CANDIDATES) {
        const counts = values.map((v) => v.split(delim).length - 1);
        const first = counts[0];
        if (first >= 1 && counts.every((c) => c === first)) {
          const partCount = first + 1;
          const partNames = Array.from({ length: partCount }, (_, i) => uniqueInto(`${col}_part${i + 1}`, takenInto));
          suggestions.push({
            id: `split-${col}-${delim}`,
            column: col,
            title: `Split "${col}" by "${delim}"`,
            description: `Every value has exactly ${first} "${delim}"${first === 1 ? '' : 's'} in the same shape.`,
            action: { type: 'splitOp', column: col, delimiter: delim, into: partNames.join(',') },
          });
          break;
        }
      }
    }

    // Date-shaped strings -- offer year extraction as a starting point.
    if (profile.kind === 'date') {
      const into = uniqueInto(`${col}_year`, takenInto);
      suggestions.push({
        id: `date-${col}`,
        column: col,
        title: `Extract year from "${col}"`,
        description: 'Values look like dates.',
        action: { type: 'dateExtractOp', column: col, part: 'year', into },
      });
    }

    // Numeric with excess decimal precision.
    if (profile.kind === 'numeric') {
      const hasExcessPrecision = values.some((v) => {
        const dot = v.indexOf('.');
        return dot >= 0 && v.length - dot - 1 > 2;
      });
      if (hasExcessPrecision) {
        const into = uniqueInto(`${col}_rounded`, takenInto);
        suggestions.push({
          id: `round-${col}`,
          column: col,
          title: `Round "${col}" to 2 decimal places`,
          description: 'Some values have more than 2 decimal digits.',
          action: { type: 'numericOp', column: col, op: 'round', digits: 2, into },
        });
      }
    }

    // High-ish null rate, not empty/all-null -- forward-fill is a
    // reasonable, precise (per-column) default suggestion rather than the
    // blanket drop-every-row-with-any-null flag.
    if (profile.nullFrac > 0.05 && profile.nullFrac < 1) {
      suggestions.push({
        id: `ffill-${col}`,
        column: col,
        title: `Forward-fill missing values in "${col}"`,
        description: `${Math.round(profile.nullFrac * 100)}% of sampled rows are missing a value here.`,
        action: { type: 'fillDirectionOp', column: col, direction: 'ffill' },
      });
    }
  }

  return suggestions;
}

/** Delimiter set checked when a selection sits right next to one. Order
 * matters only for the fallback single-char lookup below. */
const SELECTION_DELIMITERS = ['-', '_', '/', ':', '|', ',', '@', ' '];

export function computeSelectionSuggestions(
  column: string,
  cellValue: string,
  selectedText: string,
  startOffset: number,
  endOffset: number,
): TransformSuggestion[] {
  if (!selectedText || startOffset < 0 || endOffset > cellValue.length || startOffset >= endOffset) return [];
  const suggestions: TransformSuggestion[] = [];
  const selLen = endOffset - startOffset;
  const takenInto = new Set<string>();

  const atStart = startOffset === 0;
  const atEnd = endOffset === cellValue.length;

  if (atStart && !atEnd) {
    suggestions.push({
      id: 'sel-prefix',
      column,
      title: `Extract first ${selLen} character${selLen === 1 ? '' : 's'}`,
      description: `New column with "${selectedText}" pulled from the start of every row in "${column}".`,
      action: { type: 'substringOp', column, start: 1, length: selLen, into: uniqueInto(`${column}_prefix`, takenInto) },
    });
  }

  if (atEnd && !atStart) {
    suggestions.push({
      id: 'sel-suffix',
      column,
      title: `Extract last ${selLen} character${selLen === 1 ? '' : 's'}`,
      description: `New column with "${selectedText}" pulled from the end of every row in "${column}" (works even when other values are a different length).`,
      action: { type: 'substringOp', column, start: -selLen, length: null, into: uniqueInto(`${column}_suffix`, takenInto) },
    });
  }

  const charBefore = startOffset > 0 ? cellValue[startOffset - 1] : null;
  const charAfter = endOffset < cellValue.length ? cellValue[endOffset] : null;
  const adjacentDelim = [charBefore, charAfter].find((c) => c && SELECTION_DELIMITERS.includes(c));
  if (adjacentDelim) {
    const partCount = cellValue.split(adjacentDelim).length;
    const partNames = Array.from({ length: partCount }, (_, i) => uniqueInto(`${column}_part${i + 1}`, takenInto));
    suggestions.push({
      id: 'sel-split',
      column,
      title: `Split "${column}" by "${adjacentDelim === ' ' ? 'space' : adjacentDelim}"`,
      description: `"${selectedText}" sits right next to a "${adjacentDelim === ' ' ? 'space' : adjacentDelim}" -- split the whole column on it.`,
      action: { type: 'splitOp', column, delimiter: adjacentDelim, into: partNames.join(',') },
    });
  }

  // Fallback: always offer the literal fixed-offset extraction, lowest
  // priority (shown last), so a selection with no start/end/delimiter
  // anchor still gets *something* actionable.
  if (!atStart && !atEnd && !adjacentDelim) {
    suggestions.push({
      id: 'sel-fixed',
      column,
      title: `Extract characters ${startOffset + 1}–${endOffset}`,
      description: `New column with "${selectedText}" from this fixed position -- only reliable if every row has this text in the same place.`,
      action: { type: 'substringOp', column, start: startOffset + 1, length: selLen, into: uniqueInto(`${column}_extract`, takenInto) },
    });
  }

  return suggestions;
}
