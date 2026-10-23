import { describe, it, expect } from 'vitest';
import { alwaysEmptyFields, fileName, formatCell, formatPercent, scoreResults, settingsSignature, summarize, withMark, type TryResult } from './extractionTry';

const r = (over: Partial<TryResult>): TryResult => ({ file: '/x/a.pdf', ok: true, fields: {}, ms: 1000, cached: false, ...over });

describe('settingsSignature', () => {
  const base = { outputFields: ['total'], documentType: 'invoice', model: 'gpt-4o' };
  it('is stable for the same settings and changes with any of them', () => {
    expect(settingsSignature(base)).toBe(settingsSignature({ ...base }));
    expect(settingsSignature({ ...base, outputFields: ['total', 'vendor'] })).not.toBe(settingsSignature(base));
    expect(settingsSignature({ ...base, model: 'claude' })).not.toBe(settingsSignature(base));
    expect(settingsSignature({ ...base, apiBaseEnvVar: 'OLLAMA_API_BASE' })).not.toBe(settingsSignature(base));
    expect(settingsSignature({ ...base, fieldRegions: { total: { x: 0 } } })).not.toBe(settingsSignature(base));
  });
  it('treats an unset base and an empty one the same', () => {
    expect(settingsSignature({ ...base, apiBaseEnvVar: '' })).toBe(settingsSignature(base));
  });
});

describe('formatCell', () => {
  it('shows scalars, JSON for structures and a dash for missing', () => {
    expect(formatCell('ACME').text).toBe('ACME');
    expect(formatCell(12.5).text).toBe('12.5');
    expect(formatCell([{ a: 1 }]).text).toBe('[{"a":1}]');
    for (const v of [null, undefined, '']) expect(formatCell(v)).toEqual({ text: '—', full: '', missing: true });
  });
  it('zero and false are values, not missing', () => {
    expect(formatCell(0).missing).toBe(false);
    expect(formatCell(false).missing).toBe(false);
  });
  it('truncates long values but keeps the full text for a tooltip', () => {
    const c = formatCell('x'.repeat(200), 10);
    expect(c.text).toHaveLength(10);
    expect(c.text.endsWith('…')).toBe(true);
    expect(c.full).toHaveLength(200);
  });
});

describe('summarize', () => {
  it('is empty with no results', () => expect(summarize([])).toBe(''));
  it('counts model calls vs cached, failures and the slowest call', () => {
    expect(summarize([r({}), r({ cached: true, ms: 0 }), r({ ok: false, ms: 4200 })])).toBe('3 documents · 2 model calls, 1 cached · 4.2s slowest · 1 failed');
  });
  it('singular wording and no cache clause when nothing was cached', () => {
    expect(summarize([r({ ms: 0 })])).toBe('1 document · 1 model call');
  });
});

describe('alwaysEmptyFields', () => {
  it('flags fields empty in every successful document', () => {
    const results = [r({ fields: { total: 1, po: null } }), r({ fields: { total: 2, po: '' } })];
    expect(alwaysEmptyFields(results, ['total', 'po'])).toEqual(['po']);
  });
  it('needs at least two successful documents to say anything, and ignores failures', () => {
    expect(alwaysEmptyFields([r({ fields: { po: null } })], ['po'])).toEqual([]);
    expect(alwaysEmptyFields([r({ fields: { po: null } }), r({ ok: false, fields: undefined })], ['po'])).toEqual([]);
  });
});

describe('fileName', () => {
  it('takes the last path segment for local, remote and windows paths', () => {
    expect(fileName('/a/b/inv.pdf')).toBe('inv.pdf');
    expect(fileName('s3://bucket/x/inv.pdf')).toBe('inv.pdf');
    expect(fileName('C:\\docs\\inv.pdf')).toBe('inv.pdf');
  });
});

describe('scoreResults', () => {
  it('is empty until something is marked', () => {
    expect(scoreResults([r({}), r({ match: {} })])).toEqual({ marked: 0, correct: 0, accuracy: null, byField: {} });
  });
  it('counts overall and per field across documents', () => {
    const s = scoreResults([r({ match: { total: true, vendor: false } }), r({ match: { total: true } }), r({ match: { total: false, vendor: false } })]);
    expect([s.marked, s.correct]).toEqual([5, 2]);
    expect(s.accuracy).toBeCloseTo(0.4);
    expect(s.byField.total).toMatchObject({ marked: 3, correct: 2 });
    expect(s.byField.total.accuracy).toBeCloseTo(2 / 3);
    expect(s.byField.vendor.accuracy).toBe(0);
  });
});

describe('formatPercent', () => {
  it('rounds and dashes', () => {
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(0.666)).toBe('67%');
    expect(formatPercent(1)).toBe('100%');
  });
});

describe('withMark', () => {
  const rows = [r({ file: 'a', expected: { total: 1 }, match: { total: true } }), r({ file: 'b' })];
  it('sets a mark on one document without touching the others', () => {
    const next = withMark(rows, 'b', 'vendor', { expected: null, match: false });
    expect(next[1].expected).toEqual({ vendor: null });
    expect(next[1].match).toEqual({ vendor: false });
    expect(next[0]).toBe(rows[0]);
  });
  it('keeps existing marks on the same document', () => {
    const next = withMark(rows, 'a', 'vendor', { expected: 'ACME', match: true });
    expect(next[0].expected).toEqual({ total: 1, vendor: 'ACME' });
    expect(next[0].match).toEqual({ total: true, vendor: true });
  });
  it('clears one mark and leaves the rest, and does not mutate its input', () => {
    const next = withMark(rows, 'a', 'total', null);
    expect(next[0].expected).toEqual({});
    expect(next[0].match).toEqual({});
    expect(rows[0].expected).toEqual({ total: 1 });
  });
  it('a null expected value is a real mark ("should be empty")', () => {
    expect('vendor' in (withMark(rows, 'b', 'vendor', { expected: null, match: true })[1].expected || {})).toBe(true);
  });
});
