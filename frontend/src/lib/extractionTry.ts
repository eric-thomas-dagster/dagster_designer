/** Pure helpers for the "Try on samples" panel: what a result cell shows, when results are stale, and the run summary. */

export interface TryResult {
  file: string;
  ok: boolean;
  fields?: Record<string, unknown>;
  error?: string;
  raw?: string;
  warnings?: string[];
  ms: number;
  cached: boolean;
}

export interface TrySettings {
  outputFields: string[];
  documentType: string;
  model: string;
  apiBaseEnvVar?: string;
  fieldRegions?: Record<string, unknown>;
}

/** Same settings => same signature. Compared against the settings a run was made with to tell the user the table is stale. */
export function settingsSignature(s: TrySettings): string {
  return JSON.stringify([s.outputFields, s.documentType, s.model, s.apiBaseEnvVar || '', s.fieldRegions || {}]);
}

/** A table cell: scalars as text, structures (line items...) as compact JSON, missing as an em dash. */
export function formatCell(value: unknown, max = 80): { text: string; full: string; missing: boolean } {
  if (value === null || value === undefined || value === '') return { text: '—', full: '', missing: true };
  const full = typeof value === 'string' ? value : JSON.stringify(value);
  return { text: full.length > max ? `${full.slice(0, max - 1)}…` : full, full, missing: false };
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/** "3 documents · 2 model calls, 1 cached · 4.2s slowest · 1 failed" */
export function summarize(results: TryResult[]): string {
  if (results.length === 0) return '';
  const cached = results.filter((r) => r.cached).length;
  const failed = results.filter((r) => !r.ok).length;
  const slowest = Math.max(...results.filter((r) => !r.cached).map((r) => r.ms), 0);
  const parts = [`${results.length} document${results.length === 1 ? '' : 's'}`];
  parts.push(cached > 0 ? `${results.length - cached} model call${results.length - cached === 1 ? '' : 's'}, ${cached} cached` : `${results.length} model call${results.length === 1 ? '' : 's'}`);
  if (slowest > 0) parts.push(`${(slowest / 1000).toFixed(1)}s slowest`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(' · ');
}

/** Fields the model left empty for every successful document -- usually a field name it can't map to anything on the page. */
export function alwaysEmptyFields(results: TryResult[], fields: string[]): string[] {
  const good = results.filter((r) => r.ok && r.fields);
  if (good.length < 2) return [];
  return fields.filter((f) => good.every((r) => formatCell(r.fields![f]).missing));
}
