import type { TryResult } from './extractionTry';

/**
 * The logic behind "Run unattended" in the extraction workbench: what to suggest from the sample runs, how the choices become the
 * extractor's `validation` setting, and what to watch. Kept pure so it is testable; the UI only collects choices.
 */

export interface ReconcileDraft {
  enabled: boolean;
  totalField: string;
  itemsField: string;
  amountKey: string;
  addFields: string[];
  tolerance: number;
}

export interface ValidationDraft {
  enabled: boolean;
  requiredFields: string[];
  reconcile: ReconcileDraft;
  /** Percent of documents that must pass for the check to pass (0-100). */
  minPassPercent: number;
}

export const EMPTY_RECONCILE: ReconcileDraft = { enabled: false, totalField: '', itemsField: '', amountKey: 'amount', addFields: [], tolerance: 0.01 };
export const EMPTY_VALIDATION: ValidationDraft = { enabled: false, requiredFields: [], reconcile: EMPTY_RECONCILE, minPassPercent: 90 };

/** The extractor's `validation` setting for a draft, or null when validation is off. */
export function buildValidation(d: ValidationDraft, fields: string[]): Record<string, unknown> | null {
  if (!d.enabled) return null;
  const known = new Set(fields);
  const out: Record<string, unknown> = {
    required_fields: d.requiredFields.filter((f) => known.has(f)),
    min_pass_rate: Math.min(1, Math.max(0, d.minPassPercent / 100)),
  };
  const r = d.reconcile;
  if (r.enabled && known.has(r.totalField) && known.has(r.itemsField)) {
    out.reconcile = {
      total_field: r.totalField,
      items_field: r.itemsField,
      item_amount_key: r.amountKey.trim() || 'amount',
      add_fields: r.addFields.filter((f) => known.has(f)),
      tolerance: Math.max(0, r.tolerance),
    };
  }
  return out;
}

/** A draft from an existing extractor's `validation` setting, so editing shows what is already configured. */
export function validationDraftFromConfig(validation: unknown): ValidationDraft {
  if (!validation || typeof validation !== 'object') return EMPTY_VALIDATION;
  const v = validation as Record<string, any>;
  const r = v.reconcile && typeof v.reconcile === 'object' ? v.reconcile : null;
  return {
    enabled: true,
    requiredFields: Array.isArray(v.required_fields) ? v.required_fields.map(String) : [],
    reconcile: r
      ? {
          enabled: true,
          totalField: String(r.total_field ?? ''),
          itemsField: String(r.items_field ?? ''),
          amountKey: String(r.item_amount_key ?? 'amount'),
          addFields: Array.isArray(r.add_fields) ? r.add_fields.map(String) : [],
          tolerance: typeof r.tolerance === 'number' ? r.tolerance : 0.01,
        }
      : EMPTY_RECONCILE,
    minPassPercent: typeof v.min_pass_rate === 'number' ? Math.round(v.min_pass_rate * 100) : 90,
  };
}

const TOTAL_NAME = /^(total|total_amount|amount_due|grand_total|invoice_total|balance_due)$/i;
const ITEMS_NAME = /^(line_items|items|lines|invoice_lines)$/i;
const ADJUSTMENT_NAME = /^(tax|sales_tax|vat|gst|shipping|freight|handling)$/i;
const AMOUNT_KEYS = ['amount', 'line_total', 'total', 'price', 'cost'];

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);
}

export interface Suggestion {
  requiredFields: string[];
  reconcile: ReconcileDraft | null;
  /** How many documents the suggestion rests on. */
  basedOn: number;
}

/** What to require, from what the samples show: a field is suggested as required when it came back filled in on every document that
 * extracted. Needs at least two such documents to say anything. Reconcile is suggested when the fields look like an invoice. */
export function suggestValidation(results: TryResult[], fields: string[]): Suggestion {
  const good = results.filter((r) => r.ok && r.fields);
  const reconcile = suggestReconcile(good, fields);
  if (good.length < 2) return { requiredFields: [], reconcile, basedOn: good.length };
  return { requiredFields: fields.filter((f) => good.every((r) => !isEmpty(r.fields![f]))), reconcile, basedOn: good.length };
}

function suggestReconcile(good: TryResult[], fields: string[]): ReconcileDraft | null {
  const totalField = fields.find((f) => TOTAL_NAME.test(f));
  const itemsField = fields.find((f) => ITEMS_NAME.test(f));
  if (!totalField || !itemsField) return null;
  let amountKey = 'amount';
  for (const r of good) {
    const items = r.fields?.[itemsField];
    const first = Array.isArray(items) ? items.find((i) => i && typeof i === 'object') : undefined;
    if (first) {
      const keys = Object.keys(first as object);
      const found = AMOUNT_KEYS.find((k) => keys.some((x) => x.toLowerCase() === k));
      if (found) amountKey = keys.find((x) => x.toLowerCase() === found)!;
      break;
    }
  }
  return { enabled: true, totalField, itemsField, amountKey, addFields: fields.filter((f) => ADJUSTMENT_NAME.test(f)), tolerance: 0.01 };
}

const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
const GLOB_CHARS = /[*?[]/;

/** The local folder to watch for a source path, or null when it can't be watched from here (s3://, gs://, ...). */
export function watchDirectory(sourcePath: string | undefined): string | null {
  if (!sourcePath) return null;
  let path = sourcePath.trim();
  const scheme = SCHEME.exec(path);
  if (scheme) {
    if (scheme[1].toLowerCase() !== 'file') return null;
    path = path.replace(SCHEME, '');
  }
  if (!path) return null;
  const segments = path.split('/');
  const globAt = segments.findIndex((s) => GLOB_CHARS.test(s));
  const kept = globAt === -1 ? segments : segments.slice(0, globAt);
  // a plain path with a file extension on its last segment is a single file: watch its folder
  if (globAt === -1 && /\.[A-Za-z0-9]{1,5}$/.test(kept[kept.length - 1] || '')) kept.pop();
  const dir = kept.join('/').replace(/\/+$/, '');
  return dir || (path.startsWith('/') ? '/' : null);
}

export const processedDirFor = (directory: string): string => `${directory.replace(/\/+$/, '')}/_processed`;

const DEFAULT_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg'];

/** The sensor's `file_pattern` (a regex): the extensions of the sample files, else common document types. */
export function watchPattern(samplePaths: string[]): string {
  const found = new Set<string>();
  for (const p of samplePaths) {
    const m = /\.([A-Za-z0-9]{1,5})$/.exec(p);
    if (m) found.add(m[1].toLowerCase());
  }
  const exts = found.size > 0 ? [...found].sort() : DEFAULT_EXTENSIONS;
  return `(?i).*\\.(?:${exts.join('|')})$`;
}

export function automationNames(assetName: string): { job: string; sensor: string } {
  const base = assetName.trim().replace(/[^A-Za-z0-9_]+/g, '_');
  return { job: `${base}_job`, sensor: `${base}_new_files` };
}

/** One line for the asset's description: what the pipeline was frozen at. Empty when nothing was marked. */
export function freezeDescription(documentType: string, sampleCount: number, marked: number, correct: number): string {
  if (marked === 0) return '';
  const pct = Math.round((correct / marked) * 100);
  return `Frozen from ${sampleCount} sample ${sampleCount === 1 ? 'document' : 'documents'}: ${pct}% of ${marked} checked ${documentType === 'custom' ? '' : `${documentType.replace(/_/g, ' ')} `}fields were right.`.replace(/\s{2,}/g, ' ');
}
