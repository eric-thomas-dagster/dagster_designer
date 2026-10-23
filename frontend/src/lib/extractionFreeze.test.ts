import { describe, it, expect } from 'vitest';
import {
  automationNames, buildValidation, EMPTY_VALIDATION, freezeDescription, processedDirFor, suggestValidation,
  validationDraftFromConfig, watchDirectory, watchPattern, type ValidationDraft,
} from './extractionFreeze';
import type { TryResult } from './extractionTry';

const FIELDS = ['invoice_number', 'vendor', 'total_amount', 'tax', 'line_items', 'po_number'];
const doc = (fields: Record<string, unknown>, over: Partial<TryResult> = {}): TryResult => ({ file: '/x/a.pdf', ok: true, fields, ms: 1, cached: false, ...over });
const INVOICE = { invoice_number: 'INV-1', vendor: 'ACME', total_amount: 110, tax: 10, line_items: [{ description: 'x', amount: 100 }], po_number: null };

describe('suggestValidation', () => {
  it('requires the fields that were filled in on every extracted document', () => {
    const s = suggestValidation([doc(INVOICE), doc({ ...INVOICE, vendor: '' })], FIELDS);
    expect(s.requiredFields).toEqual(['invoice_number', 'total_amount', 'tax', 'line_items']);
    expect(s.basedOn).toBe(2);
  });
  it('says nothing about required fields from fewer than two documents, ignoring failed ones', () => {
    expect(suggestValidation([doc(INVOICE)], FIELDS).requiredFields).toEqual([]);
    expect(suggestValidation([doc(INVOICE), doc({}, { ok: false, fields: undefined })], FIELDS).requiredFields).toEqual([]);
    expect(suggestValidation([], FIELDS)).toMatchObject({ requiredFields: [], basedOn: 0 });
  });
  it('suggests reconciling when the fields look like an invoice, and learns the amount key from a sample', () => {
    const s = suggestValidation([doc({ ...INVOICE, line_items: [{ desc: 'a', line_total: 5 }] }), doc(INVOICE)], FIELDS);
    expect(s.reconcile).toEqual({ enabled: true, totalField: 'total_amount', itemsField: 'line_items', amountKey: 'line_total', addFields: ['tax'], tolerance: 0.01 });
  });
  it('defaults the amount key to "amount" when no sample shows line items', () => {
    expect(suggestValidation([], FIELDS).reconcile?.amountKey).toBe('amount');
  });
  it('does not suggest reconciling for fields that are not an invoice', () => {
    expect(suggestValidation([], ['name', 'email']).reconcile).toBeNull();
    expect(suggestValidation([], ['total_amount', 'vendor']).reconcile).toBeNull();
  });
});

describe('buildValidation', () => {
  const draft: ValidationDraft = {
    enabled: true, requiredFields: ['invoice_number', 'ghost'], minPassPercent: 85,
    reconcile: { enabled: true, totalField: 'total_amount', itemsField: 'line_items', amountKey: ' ', addFields: ['tax', 'ghost'], tolerance: 0.05 },
  };
  it('is null when validation is off', () => expect(buildValidation({ ...draft, enabled: false }, FIELDS)).toBeNull());
  it('drops fields that are no longer extracted, defaults a blank amount key, and converts the percent', () => {
    expect(buildValidation(draft, FIELDS)).toEqual({
      required_fields: ['invoice_number'],
      min_pass_rate: 0.85,
      reconcile: { total_field: 'total_amount', items_field: 'line_items', item_amount_key: 'amount', add_fields: ['tax'], tolerance: 0.05 },
    });
  });
  it('omits reconcile when it is off or its fields are gone', () => {
    expect(buildValidation({ ...draft, reconcile: { ...draft.reconcile, enabled: false } }, FIELDS)).not.toHaveProperty('reconcile');
    expect(buildValidation(draft, ['invoice_number'])).not.toHaveProperty('reconcile');
  });
  it('clamps the pass rate and tolerance into range', () => {
    expect(buildValidation({ ...draft, minPassPercent: 250 }, FIELDS)?.min_pass_rate).toBe(1);
    expect(buildValidation({ ...draft, minPassPercent: -5 }, FIELDS)?.min_pass_rate).toBe(0);
  });
});

describe('validationDraftFromConfig', () => {
  it('is off for a missing or malformed setting', () => {
    expect(validationDraftFromConfig(undefined)).toEqual(EMPTY_VALIDATION);
    expect(validationDraftFromConfig('x')).toEqual(EMPTY_VALIDATION);
  });
  it('round-trips with buildValidation', () => {
    const config = { required_fields: ['vendor'], min_pass_rate: 0.8, reconcile: { total_field: 'total_amount', items_field: 'line_items', item_amount_key: 'price', add_fields: ['tax'], tolerance: 0.02 } };
    expect(buildValidation(validationDraftFromConfig(config), FIELDS)).toEqual(config);
  });
  it('has defaults for a bare setting', () => {
    const d = validationDraftFromConfig({});
    expect(d).toMatchObject({ enabled: true, requiredFields: [], minPassPercent: 90 });
    expect(d.reconcile.enabled).toBe(false);
  });
});

describe('watchDirectory', () => {
  it.each([
    ['/data/invoices/*.pdf', '/data/invoices'],
    ['/data/invoices/**/*.pdf', '/data/invoices'],
    ['/data/invoices', '/data/invoices'],
    ['/data/invoices/', '/data/invoices'],
    ['/data/invoices/a.pdf', '/data/invoices'],
    ['file:///data/inv/*.png', '/data/inv'],
    ['/data/in[0-9]/*.pdf', '/data'],
    ['/*.pdf', '/'],
  ])('%s -> %s', (input, expected) => expect(watchDirectory(input)).toBe(expected));
  it.each([['s3://bucket/invoices/*.pdf'], ['gs://b/x'], ['abfss://c@a/x'], [''], [undefined]])('%s cannot be watched from here', (input) =>
    expect(watchDirectory(input as string | undefined)).toBeNull());
});

describe('small helpers', () => {
  it('processedDirFor', () => {
    expect(processedDirFor('/data/inv')).toBe('/data/inv/_processed');
    expect(processedDirFor('/data/inv/')).toBe('/data/inv/_processed');
  });
  it('watchPattern uses the samples extensions, else common document types', () => {
    expect(watchPattern(['/a/x.PDF', '/a/y.png', '/a/z.pdf'])).toBe('(?i).*\\.(?:pdf|png)$');
    expect(watchPattern([])).toBe('(?i).*\\.(?:pdf|png|jpg|jpeg)$');
    expect(watchPattern(['/a/noext'])).toBe('(?i).*\\.(?:pdf|png|jpg|jpeg)$');
  });
  it('automationNames are safe identifiers', () => {
    expect(automationNames('invoice fields!')).toEqual({ job: 'invoice_fields__job', sensor: 'invoice_fields__new_files' });
    expect(automationNames('invoice_fields')).toEqual({ job: 'invoice_fields_job', sensor: 'invoice_fields_new_files' });
  });
  it('freezeDescription says what it was frozen at, or nothing', () => {
    expect(freezeDescription('invoice', 3, 12, 11)).toBe('Frozen from 3 sample documents: 92% of 12 checked invoice fields were right.');
    expect(freezeDescription('custom', 1, 4, 4)).toBe('Frozen from 1 sample document: 100% of 4 checked fields were right.');
    expect(freezeDescription('invoice', 3, 0, 0)).toBe('');
  });
});
