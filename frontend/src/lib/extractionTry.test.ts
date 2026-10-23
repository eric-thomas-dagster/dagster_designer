import { describe, it, expect } from 'vitest';
import { alwaysEmptyFields, fileName, formatCell, settingsSignature, summarize, type TryResult } from './extractionTry';

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
