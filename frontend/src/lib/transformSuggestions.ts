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
 *
 * Also part of (1): pattern-consistency outlier detection. Reduces every
 * value to a character-class signature (upper-case run -> "A", lower-case
 * -> "a", digits -> "0", everything else kept literal -- "CHI-001-xxxx"
 * becomes "AAA-000-aaaa"), finds the dominant signature, and -- when it
 * covers most of the column and only a handful of values don't match it --
 * flags those specific values as pattern outliers ("CHICAGO-001-xxxx"
 * alongside a column that's otherwise all "AAA-000-aaaa"). Deliberately
 * does NOT try to auto-correct them (turning "CHICAGO" into "CHI" would be
 * a guess, not a fact derivable from the data); the honest, always-correct
 * action is excluding them from this asset so they can be reviewed on
 * their own, which needs no new backend capability -- it's just one
 * `not_equals` filter per outlier value, AND-combined the same way this
 * app's filters already compose.
 */

export type SuggestionAction =
  | { type: 'stringOp'; column: string; operation: string }
  | { type: 'dropDuplicates' }
  | { type: 'splitOp'; column: string; delimiter: string; into: string }
  | { type: 'substringOp'; column: string; start: number; length: number | null; into: string }
  | { type: 'dateExtractOp'; column: string; part: string; into: string }
  | { type: 'numericOp'; column: string; op: string; digits: number; into: string }
  | { type: 'fillDirectionOp'; column: string; direction: 'ffill' | 'bfill' }
  | { type: 'excludeValues'; column: string; values: string[] };

export interface TransformSuggestion {
  id: string;
  column: string | null; // null for table-wide suggestions (e.g. dedupe)
  title: string;
  description: string;
  action: SuggestionAction;
}

// Comma and space are deliberately excluded here (see detectStructuredSplit) --
// both are the highest false-positive delimiters on ordinary prose/numbers.
const DELIMITER_CANDIDATES = ['-', '_', '/', ':', '|'];
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

  // Per-column: collect every candidate, then keep only the single
  // highest-priority one. Multiple genuinely-independent issues on the
  // same column (e.g. both messy whitespace AND punctuation) are common,
  // but showing every one is exactly what read as "repetitive, does it
  // want to split every column?" -- one clear next-step per column,
  // ranked by how likely it's genuinely useful, keeps the strip short and
  // trustworthy instead of exhaustive.
  const PRIORITY: SuggestionAction['type'][] = [
    'excludeValues', 'splitOp', 'stringOp', 'dateExtractOp', 'numericOp', 'fillDirectionOp',
  ];

  for (const col of columns) {
    const profile = computeProfile(rows, col, dtypes?.[col]);
    if (profile.total === 0 || profile.nonNull === 0) continue;
    const values = nonNullStrings(rows, col);
    const candidates: TransformSuggestion[] = [];

    // Pattern-consistency outlier detection -- highest priority, since a
    // real data-quality problem (not "could be cleaner" but "this row
    // looks structurally different from the rest") is more actionable
    // than a cosmetic suggestion on the same column.
    if (profile.kind === 'string') {
      const outlierSuggestion = detectPatternOutliers(col, values);
      if (outlierSuggestion) candidates.push(outlierSuggestion);
    }

    // Whitespace inconsistency.
    if (profile.kind === 'string' && values.some((v) => v !== v.trim())) {
      candidates.push({
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
        candidates.push({
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
      candidates.push({
        id: `punct-${col}`,
        column: col,
        title: `Remove punctuation from "${col}"`,
        description: 'Values contain punctuation characters.',
        action: { type: 'stringOp', column: col, operation: 'remove_punctuation' },
      });
    }

    // Email-shaped -- split into username/domain. Unlike the generic
    // delimiter check below, matching EVERY sampled value against a real
    // email pattern is a strong, low-false-positive signal on its own.
    if (profile.kind === 'string' && values.length > 0 && values.every((v) => EMAIL_RE.test(v))) {
      const into = uniqueInto(`${col}_user`, takenInto) + `,${uniqueInto(`${col}_domain`, takenInto)}`;
      candidates.push({
        id: `email-split-${col}`,
        column: col,
        title: `Split "${col}" into username / domain`,
        description: 'Every value looks like an email address.',
        action: { type: 'splitOp', column: col, delimiter: '@', into },
      });
    } else if (profile.kind === 'string' && values.length > 0) {
      const split = detectStructuredSplit(col, values, takenInto);
      if (split) candidates.push(split);
    }

    // Date-shaped strings -- offer year extraction as a starting point.
    if (profile.kind === 'date') {
      const into = uniqueInto(`${col}_year`, takenInto);
      candidates.push({
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
        candidates.push({
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
      candidates.push({
        id: `ffill-${col}`,
        column: col,
        title: `Forward-fill missing values in "${col}"`,
        description: `${Math.round(profile.nullFrac * 100)}% of sampled rows are missing a value here.`,
        action: { type: 'fillDirectionOp', column: col, direction: 'ffill' },
      });
    }

    if (candidates.length === 0) continue;
    candidates.sort((a, b) => PRIORITY.indexOf(a.action.type) - PRIORITY.indexOf(b.action.type));
    suggestions.push(candidates[0]);
  }

  // Cap the total shown -- a wide table with many "legitimately messy"
  // columns can still produce a dozen-plus one-per-column suggestions,
  // which is its own kind of overwhelming even at one-per-column. Table-
  // wide dedupe (already pushed first, above) always stays; the rest are
  // capped after per-column dedup already thinned them out.
  const MAX_SUGGESTIONS = 8;
  return suggestions.slice(0, MAX_SUGGESTIONS);
}

/**
 * A column-wide split is only worth suggesting when it looks like a
 * genuinely structured code, not prose that happens to share a delimiter
 * count by coincidence (city names, sentences with consistent punctuation,
 * "1,234"-style thousands separators). Three guards, all required:
 *  - space and comma are excluded from the blind, whole-column check
 *    entirely (highest false-positive delimiters on ordinary text/
 *    numbers) -- still reachable via the selection-based suggestions,
 *    where the user has already pointed at the specific text they mean.
 *  - short average length (structured codes are compact; sentences/
 *    descriptions run long).
 *  - the first resulting part is a CONSISTENT length across every sampled
 *    value (+/-1 character) -- the actual signature of a fixed-shape code
 *    like "CHI-202425-001", which free text won't have.
 */
function detectStructuredSplit(column: string, values: string[], takenInto: Set<string>): TransformSuggestion | null {
  const avgLen = values.reduce((a, v) => a + v.length, 0) / values.length;
  if (avgLen > 30) return null;

  for (const delim of DELIMITER_CANDIDATES) {
    const counts = values.map((v) => v.split(delim).length - 1);
    const first = counts[0];
    if (first < 1 || first > 3 || !counts.every((c) => c === first)) continue;

    const firstPartLengths = values.map((v) => v.split(delim)[0].length);
    const minLen = Math.min(...firstPartLengths);
    const maxLen = Math.max(...firstPartLengths);
    if (maxLen - minLen > 1) continue;

    const partCount = first + 1;
    const partNames = Array.from({ length: partCount }, (_, i) => uniqueInto(`${column}_part${i + 1}`, takenInto));
    return {
      id: `split-${column}-${delim}`,
      column,
      title: `Split "${column}" by "${delim}"`,
      description: `Every value has exactly ${first} "${delim}"${first === 1 ? '' : 's'} in a consistent shape.`,
      action: { type: 'splitOp', column, delimiter: delim, into: partNames.join(',') },
    };
  }
  return null;
}

/** Upper-case run -> "A", lower-case -> "a", digits -> "0", anything else
 * (punctuation, spaces) kept literal as a structural anchor. Two values
 * with the same signature have the same shape; different signatures are
 * either a genuinely different kind of value or a data-quality outlier. */
function charClassSignature(v: string): string {
  let sig = '';
  for (const ch of v) {
    if (/[A-Z]/.test(ch)) sig += 'A';
    else if (/[a-z]/.test(ch)) sig += 'a';
    else if (/[0-9]/.test(ch)) sig += '0';
    else sig += ch;
  }
  return sig;
}

function detectPatternOutliers(column: string, values: string[]): TransformSuggestion | null {
  // Need enough rows to call a minority shape an "outlier" with any
  // confidence rather than just "this column has two legitimate formats".
  if (values.length < 4) return null;

  const bySignature = new Map<string, string[]>();
  for (const v of values) {
    const sig = charClassSignature(v);
    if (!bySignature.has(sig)) bySignature.set(sig, []);
    bySignature.get(sig)!.push(v);
  }
  // Perfectly uniform (nothing to flag) or too chaotic to call any one
  // shape "dominant" (e.g. a genuinely free-text column) -- either way,
  // not a pattern-outlier situation.
  if (bySignature.size < 2 || bySignature.size > 4) return null;

  const bySizeDesc = Array.from(bySignature.values()).sort((a, b) => b.length - a.length);
  const dominantValues = bySizeDesc[0];
  const dominantShare = dominantValues.length / values.length;
  if (dominantShare < 0.7) return null;

  const outliers = bySizeDesc.slice(1).flat();
  // More than a handful stops being "flag these specific rows" and starts
  // meaning the "dominant" shape isn't actually representative -- don't
  // suggest excluding a large chunk of the column on a shape heuristic.
  if (outliers.length === 0 || outliers.length > 5) return null;

  const exampleGood = dominantValues[0];
  const exampleBad = outliers[0];
  const n = outliers.length;
  return {
    id: `pattern-outlier-${column}`,
    column,
    title: `${n} value${n === 1 ? '' : 's'} in "${column}" break the pattern`,
    description: `Most values look like "${exampleGood}"; ${n === 1 ? "this one doesn't" : "these don't"} (e.g. "${exampleBad}"). Exclude ${n === 1 ? 'it' : 'them'} to review separately, rather than guessing at a fix.`,
    action: { type: 'excludeValues', column, values: outliers },
  };
}

/** Delimiter set checked when a selection sits right next to one. Order
 * matters only for the fallback single-char lookup below. */
const SELECTION_DELIMITERS = ['-', '_', '/', ':', '|', ',', '@', ' '];

// YYYY-MM-DD, optionally followed by a T-or-space + HH:MM:SS. Deliberately
// specific (not a general date parser) -- this only needs to recognize the
// one shape well enough to know where the year/month/day/separator/time
// segments fall, not accept every date format in the wild.
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})(?:([T ])(\d{2}):(\d{2}):(\d{2}))?/;

interface TimestampSegments {
  yearRange: [number, number];
  monthRange: [number, number];
  dayRange: [number, number];
  separatorIndex: number | null; // index of the T/space between date and time, if present
  separatorChar: string | null;
  timeStart: number | null; // offset where HH:MM:SS begins, if present
}

function recognizeTimestamp(value: string): TimestampSegments | null {
  const m = TIMESTAMP_RE.exec(value);
  if (!m) return null;
  const hasTime = m[4] !== undefined;
  return {
    yearRange: [0, 4],
    monthRange: [5, 7],
    dayRange: [8, 10],
    separatorIndex: hasTime ? 10 : null,
    separatorChar: hasTime ? m[4] : null,
    timeStart: hasTime ? 11 : null,
  };
}

/**
 * Context-aware layer, checked BEFORE the generic prefix/suffix/delimiter/
 * fallback logic below: if the whole cell value matches a recognized shape
 * (currently: dates and timestamps), the selection's position within that
 * shape drives specific, meaningful suggestions -- e.g. selecting the "T"
 * separator in an ISO timestamp offers "split into date and time" instead
 * of the generic "extract characters 11-11", which is technically what was
 * selected but not what anyone actually wants. When a shape is recognized,
 * its suggestions REPLACE the generic ones entirely rather than adding to
 * them, since a semantic match is always more useful than a positional one.
 */
function computeShapeAwareSuggestions(
  column: string,
  cellValue: string,
  startOffset: number,
  endOffset: number,
): TransformSuggestion[] | null {
  const ts = recognizeTimestamp(cellValue);
  if (!ts) return null;
  const suggestions: TransformSuggestion[] = [];
  const takenInto = new Set<string>();
  const overlaps = (range: [number, number]) => startOffset < range[1] && endOffset > range[0];

  if (ts.separatorIndex !== null && ts.separatorChar !== null) {
    const sepLabel = ts.separatorChar === 'T' ? '"T"' : 'space';
    suggestions.push({
      id: 'sel-ts-split',
      column,
      title: `Split "${column}" into date and time`,
      description: `This looks like a timestamp -- split on the ${sepLabel} separator.`,
      action: {
        type: 'splitOp', column, delimiter: ts.separatorChar,
        into: `${uniqueInto(`${column}_date`, takenInto)},${uniqueInto(`${column}_time`, takenInto)}`,
      },
    });
  }

  const inDatePart = overlaps(ts.yearRange) || overlaps(ts.monthRange) || overlaps(ts.dayRange) || ts.separatorIndex === null || startOffset < ts.separatorIndex;
  const inTimePart = ts.timeStart !== null && startOffset >= ts.timeStart;

  if (inDatePart) {
    if (overlaps(ts.monthRange)) {
      suggestions.push({
        id: 'sel-ts-month', column, title: `Extract month from "${column}"`,
        description: 'Pulls the month out of every timestamp/date in this column.',
        action: { type: 'dateExtractOp', column, part: 'month', into: uniqueInto(`${column}_month`, takenInto) },
      });
    } else if (overlaps(ts.dayRange)) {
      suggestions.push({
        id: 'sel-ts-day', column, title: `Extract day from "${column}"`,
        description: 'Pulls the day-of-month out of every timestamp/date in this column.',
        action: { type: 'dateExtractOp', column, part: 'day', into: uniqueInto(`${column}_day`, takenInto) },
      });
    } else {
      suggestions.push({
        id: 'sel-ts-year', column, title: `Extract year from "${column}"`,
        description: 'Pulls the year out of every timestamp/date in this column.',
        action: { type: 'dateExtractOp', column, part: 'year', into: uniqueInto(`${column}_year`, takenInto) },
      });
    }
  } else if (inTimePart && ts.separatorIndex !== null) {
    suggestions.push({
      id: 'sel-ts-time', column, title: `Extract time portion from "${column}"`,
      description: 'New column with just the HH:MM:SS part.',
      action: { type: 'substringOp', column, start: ts.separatorIndex + 2, length: null, into: uniqueInto(`${column}_time_only`, takenInto) },
    });
    suggestions.push({
      id: 'sel-ts-hour', column, title: `Extract hour from "${column}"`,
      description: 'Pulls just the hour out of every timestamp in this column.',
      action: { type: 'dateExtractOp', column, part: 'hour', into: uniqueInto(`${column}_hour`, takenInto) },
    });
  }

  return suggestions;
}

export function computeSelectionSuggestions(
  column: string,
  cellValue: string,
  selectedText: string,
  startOffset: number,
  endOffset: number,
): TransformSuggestion[] {
  if (!selectedText || startOffset < 0 || endOffset > cellValue.length || startOffset >= endOffset) return [];

  const shapeAware = computeShapeAwareSuggestions(column, cellValue, startOffset, endOffset);
  if (shapeAware && shapeAware.length > 0) return shapeAware;

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
