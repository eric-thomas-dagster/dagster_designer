import { describe, expect, it } from 'vitest';
import { computeColumnSuggestions, computeSelectionSuggestions } from './transformSuggestions';

describe('computeColumnSuggestions', () => {
  it('suggests trimming whitespace', () => {
    const rows = [{ name: '  Alice' }, { name: 'Bob' }];
    const suggestions = computeColumnSuggestions(rows, ['name']);
    expect(suggestions.some((s) => s.action.type === 'stringOp' && s.action.operation === 'trim')).toBe(true);
  });

  it('suggests case normalization when the same value has inconsistent casing', () => {
    const rows = [{ status: 'Active' }, { status: 'active' }, { status: 'active' }];
    const suggestions = computeColumnSuggestions(rows, ['status']);
    expect(suggestions.some((s) => s.action.type === 'stringOp' && s.action.operation === 'lower')).toBe(true);
  });

  it('does not suggest case normalization when casing is already consistent', () => {
    const rows = [{ status: 'active' }, { status: 'inactive' }];
    const suggestions = computeColumnSuggestions(rows, ['status']);
    expect(suggestions.some((s) => s.action.type === 'stringOp' && s.action.operation === 'lower')).toBe(false);
  });

  it('suggests a split when every value has the same delimiter count', () => {
    const rows = [{ sku: 'A-100-X' }, { sku: 'B-200-Y' }, { sku: 'C-300-Z' }];
    const suggestions = computeColumnSuggestions(rows, ['sku']);
    const split = suggestions.find((s) => s.action.type === 'splitOp');
    expect(split).toBeTruthy();
    expect(split!.action).toMatchObject({ type: 'splitOp', column: 'sku', delimiter: '-' });
    if (split!.action.type === 'splitOp') {
      expect(split!.action.into.split(',')).toHaveLength(3);
    }
  });

  it('does not suggest a split when delimiter count is inconsistent', () => {
    const rows = [{ sku: 'A-100-X' }, { sku: 'B-200' }, { sku: 'C-300-Z-extra' }];
    const suggestions = computeColumnSuggestions(rows, ['sku']);
    expect(suggestions.some((s) => s.action.type === 'splitOp')).toBe(false);
  });

  it('suggests splitting emails into username/domain', () => {
    const rows = [{ email: 'a@example.com' }, { email: 'b@test.org' }];
    const suggestions = computeColumnSuggestions(rows, ['email']);
    const emailSplit = suggestions.find((s) => s.id.startsWith('email-split'));
    expect(emailSplit).toBeTruthy();
    expect(emailSplit!.action).toMatchObject({ type: 'splitOp', delimiter: '@' });
  });

  it('suggests rounding when numeric values have excess decimal precision', () => {
    const rows = [{ amount: '150.45678' }, { amount: '20.1' }];
    const suggestions = computeColumnSuggestions(rows, ['amount'], { amount: 'float' });
    expect(suggestions.some((s) => s.action.type === 'numericOp' && s.action.op === 'round')).toBe(true);
  });

  it('suggests forward-fill for a column with a moderate null rate', () => {
    const rows = [{ price: '10' }, { price: null }, { price: '30' }, { price: '40' }];
    const suggestions = computeColumnSuggestions(rows, ['price'], { price: 'float' });
    expect(suggestions.some((s) => s.action.type === 'fillDirectionOp' && s.action.direction === 'ffill')).toBe(true);
  });

  it('suggests dropping duplicate rows when exact duplicates exist', () => {
    const rows = [{ id: 1, name: 'a' }, { id: 1, name: 'a' }, { id: 2, name: 'b' }];
    const suggestions = computeColumnSuggestions(rows, ['id', 'name']);
    expect(suggestions.some((s) => s.action.type === 'dropDuplicates')).toBe(true);
  });

  it('returns no suggestions for clean, unique data', () => {
    const rows = [{ id: 1, status: 'active' }, { id: 2, status: 'inactive' }];
    const suggestions = computeColumnSuggestions(rows, ['id', 'status']);
    expect(suggestions).toHaveLength(0);
  });

  it('generates unique "into" names across multiple split suggestions', () => {
    const rows = [{ a: 'x-y', b: 'p-q' }];
    const suggestions = computeColumnSuggestions(rows, ['a', 'b']);
    const intoNames = suggestions
      .filter((s) => s.action.type === 'splitOp')
      .flatMap((s) => (s.action.type === 'splitOp' ? s.action.into.split(',') : []));
    expect(new Set(intoNames).size).toBe(intoNames.length);
  });

  it('shows at most one suggestion per column, even when several issues apply', () => {
    // Messy whitespace AND inconsistent casing AND punctuation, all on the
    // same column -- should collapse to a single highest-priority pick,
    // not three stacked cards for one column.
    const rows = [
      { note: '  Hello, World!!  ' },
      { note: 'hello, world!!' },
      { note: 'HELLO, WORLD!!' },
    ];
    const suggestions = computeColumnSuggestions(rows, ['note']);
    expect(suggestions.filter((s) => s.column === 'note')).toHaveLength(1);
  });

  it('does not suggest a split for prose that happens to share a comma count (comma excluded)', () => {
    const rows = [
      { bio: 'Loves hiking, camping, and long walks on the beach every weekend' },
      { bio: 'Enjoys reading, writing, and playing chess with friends on weekends' },
    ];
    const suggestions = computeColumnSuggestions(rows, ['bio']);
    expect(suggestions.some((s) => s.action.type === 'splitOp')).toBe(false);
  });

  it('does not suggest a split for long free text even with a consistent single-hyphen count', () => {
    const rows = [
      { comment: 'This is a well-written and thoughtful piece of long-form text' },
      { comment: 'Another example of well-formed but decidedly long-form prose' },
    ];
    const suggestions = computeColumnSuggestions(rows, ['comment']);
    expect(suggestions.some((s) => s.action.type === 'splitOp')).toBe(false);
  });

  it('does not suggest a split when the resulting first part varies too much in length', () => {
    // Same hyphen count everywhere, but the first segment length is wildly
    // inconsistent -- not a genuine fixed-shape code.
    const rows = [{ v: 'a-100-x' }, { v: 'alpha-200-y' }, { v: 'ab-300-z' }];
    const suggestions = computeColumnSuggestions(rows, ['v']);
    expect(suggestions.some((s) => s.action.type === 'splitOp')).toBe(false);
  });

  it('still suggests a split for a genuine fixed-shape code', () => {
    const rows = [{ sku: 'CHI-202425-001' }, { sku: 'NYC-202426-042' }, { sku: 'LAX-202427-099' }];
    const suggestions = computeColumnSuggestions(rows, ['sku']);
    expect(suggestions.some((s) => s.action.type === 'splitOp')).toBe(true);
  });

  describe('pattern-consistency outlier detection', () => {
    it('flags a value that breaks the dominant pattern (the CHI vs CHICAGO case)', () => {
      const rows = [
        { code: 'CHI-001-xxxx' }, { code: 'CHI-002-xxxx' }, { code: 'CHI-003-xxxx' },
        { code: 'CHICAGO-001-xxxx' },
      ];
      const suggestions = computeColumnSuggestions(rows, ['code']);
      const outlier = suggestions.find((s) => s.action.type === 'excludeValues');
      expect(outlier).toBeTruthy();
      expect(outlier!.action).toMatchObject({ type: 'excludeValues', column: 'code', values: ['CHICAGO-001-xxxx'] });
      // It wins priority over whatever split suggestion the same column
      // might also qualify for -- one card, the most actionable one.
      expect(suggestions.filter((s) => s.column === 'code')).toHaveLength(1);
    });

    it('does not flag anything when every value shares the same shape', () => {
      const rows = [{ code: 'CHI-001-xxxx' }, { code: 'NYC-002-yyyy' }, { code: 'LAX-003-zzzz' }];
      const suggestions = computeColumnSuggestions(rows, ['code']);
      expect(suggestions.some((s) => s.action.type === 'excludeValues')).toBe(false);
    });

    it('does not flag anything with too few sampled rows to be confident', () => {
      const rows = [{ code: 'CHI-001-xxxx' }, { code: 'CHICAGO-001-xxxx' }];
      const suggestions = computeColumnSuggestions(rows, ['code']);
      expect(suggestions.some((s) => s.action.type === 'excludeValues')).toBe(false);
    });

    it('does not flag anything when the column is too chaotic to have a dominant shape', () => {
      const rows = [{ v: 'a1' }, { v: 'BB-2' }, { v: '333' }, { v: 'dddd/4' }, { v: 'E' }];
      const suggestions = computeColumnSuggestions(rows, ['v']);
      expect(suggestions.some((s) => s.action.type === 'excludeValues')).toBe(false);
    });

    it('does not flag anything when the minority is too large a share to call an outlier', () => {
      // Half and half -- not "a few outliers", genuinely two formats.
      const rows = [
        { code: 'CHI-001' }, { code: 'CHI-002' },
        { code: 'CHICAGO-001' }, { code: 'CHICAGO-002' },
      ];
      const suggestions = computeColumnSuggestions(rows, ['code']);
      expect(suggestions.some((s) => s.action.type === 'excludeValues')).toBe(false);
    });
  });

  it('caps the total number of suggestions shown', () => {
    const rows: Array<Record<string, any>> = [{}];
    const columns: string[] = [];
    for (let i = 0; i < 20; i++) {
      const col = `messy_${i}`;
      columns.push(col);
      rows[0][col] = '  Value  ';
    }
    // A second row so whitespace inconsistency is real and every column
    // independently qualifies.
    rows.push(Object.fromEntries(columns.map((c) => [c, 'value'])));
    const suggestions = computeColumnSuggestions(rows, columns);
    expect(suggestions.length).toBeLessThanOrEqual(8);
  });
});

describe('computeSelectionSuggestions', () => {
  it('suggests prefix extraction when selection starts at offset 0', () => {
    const suggestions = computeSelectionSuggestions('code', 'CHI-202425-001', 'CHI', 0, 3);
    const prefix = suggestions.find((s) => s.id === 'sel-prefix');
    expect(prefix).toBeTruthy();
    expect(prefix!.action).toMatchObject({ type: 'substringOp', start: 1, length: 3 });
  });

  it('suggests suffix extraction (negative start) when selection ends at the string end', () => {
    const value = 'CHI-202425-001';
    const suggestions = computeSelectionSuggestions('code', value, '001', value.length - 3, value.length);
    const suffix = suggestions.find((s) => s.id === 'sel-suffix');
    expect(suffix).toBeTruthy();
    expect(suffix!.action).toMatchObject({ type: 'substringOp', start: -3, length: null });
  });

  it('suggests a delimiter split when the selection is adjacent to a delimiter', () => {
    const value = 'CHI-202425-001';
    // Select "202425", which sits between two hyphens.
    const start = value.indexOf('202425');
    const end = start + '202425'.length;
    const suggestions = computeSelectionSuggestions('code', value, '202425', start, end);
    const split = suggestions.find((s) => s.id === 'sel-split');
    expect(split).toBeTruthy();
    expect(split!.action).toMatchObject({ type: 'splitOp', delimiter: '-' });
  });

  it('falls back to a fixed-offset extraction when nothing else anchors the selection', () => {
    const value = 'abcdefghij';
    // Select "de" from the middle -- not at start, not at end, no delimiter.
    const suggestions = computeSelectionSuggestions('col', value, 'de', 3, 5);
    const fallback = suggestions.find((s) => s.id === 'sel-fixed');
    expect(fallback).toBeTruthy();
    expect(fallback!.action).toMatchObject({ type: 'substringOp', start: 4, length: 2 });
  });

  it('returns nothing for an empty or invalid selection', () => {
    expect(computeSelectionSuggestions('col', 'abc', '', 0, 0)).toHaveLength(0);
    expect(computeSelectionSuggestions('col', 'abc', 'x', 2, 1)).toHaveLength(0);
  });

  it('does not suggest both prefix and suffix when the selection spans the whole value', () => {
    const suggestions = computeSelectionSuggestions('col', 'abc', 'abc', 0, 3);
    expect(suggestions.some((s) => s.id === 'sel-prefix')).toBe(false);
    expect(suggestions.some((s) => s.id === 'sel-suffix')).toBe(false);
  });

  describe('timestamp/date context-awareness', () => {
    const iso = '2024-01-15T10:30:00';

    it('suggests splitting into date and time when the T separator itself is selected -- not a fixed-offset extraction', () => {
      const suggestions = computeSelectionSuggestions('created_at', iso, 'T', 10, 11);
      expect(suggestions.some((s) => s.id === 'sel-ts-split')).toBe(true);
      expect(suggestions.some((s) => s.id === 'sel-fixed')).toBe(false);
      const split = suggestions.find((s) => s.id === 'sel-ts-split')!;
      expect(split.action).toMatchObject({ type: 'splitOp', delimiter: 'T' });
    });

    it('suggests month extraction when the month digits are selected', () => {
      const suggestions = computeSelectionSuggestions('created_at', iso, '01', 5, 7);
      expect(suggestions.some((s) => s.id === 'sel-ts-month')).toBe(true);
    });

    it('suggests day extraction when the day digits are selected', () => {
      const suggestions = computeSelectionSuggestions('created_at', iso, '15', 8, 10);
      expect(suggestions.some((s) => s.id === 'sel-ts-day')).toBe(true);
    });

    it('suggests year extraction when the year digits are selected', () => {
      const suggestions = computeSelectionSuggestions('created_at', iso, '2024', 0, 4);
      expect(suggestions.some((s) => s.id === 'sel-ts-year')).toBe(true);
    });

    it('suggests hour extraction and time-portion extraction when the time part is selected', () => {
      const suggestions = computeSelectionSuggestions('created_at', iso, '10', 11, 13);
      expect(suggestions.some((s) => s.id === 'sel-ts-hour')).toBe(true);
      expect(suggestions.some((s) => s.id === 'sel-ts-time')).toBe(true);
    });

    it('offers date-segment extraction but no split for a plain date with no time component', () => {
      const suggestions = computeSelectionSuggestions('order_date', '2024-01-15', '01', 5, 7);
      expect(suggestions.some((s) => s.id === 'sel-ts-month')).toBe(true);
      expect(suggestions.some((s) => s.id === 'sel-ts-split')).toBe(false);
    });

    it('does not apply shape-aware logic to a value that is not a recognized date/timestamp', () => {
      const suggestions = computeSelectionSuggestions('code', 'CHI-202425-001', 'CHI', 0, 3);
      expect(suggestions.some((s) => s.id.startsWith('sel-ts-'))).toBe(false);
      expect(suggestions.some((s) => s.id === 'sel-prefix')).toBe(true);
    });
  });
});
