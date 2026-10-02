import { describe, it, expect } from 'vitest';
import {
  hasModelMetrics,
  extractMetricRows,
  pickHeadline,
  parseClusterSizesMarkdown,
  parseJsonEntry,
  type MetadataEntryLite,
} from './modelMetrics';

function entry(label: string, value: any, type = 'float'): MetadataEntryLite {
  return { label, type, value };
}

describe('hasModelMetrics', () => {
  it('flags a plain scalar metric like accuracy', () => {
    expect(hasModelMetrics([entry('accuracy', 0.91)])).toBe(true);
  });

  it('flags automl_asset holdout_* prefixed metrics', () => {
    expect(hasModelMetrics([entry('holdout_r2', 0.8)])).toBe(true);
  });

  it('flags a json/markdown-only entry like confusion_matrix or cluster_sizes', () => {
    expect(hasModelMetrics([entry('confusion_matrix', '{}', 'json')])).toBe(true);
    expect(hasModelMetrics([entry('cluster_sizes', '- cluster 0: 3 rows', 'markdown')])).toBe(true);
  });

  it('does not flag ordinary system metadata', () => {
    expect(hasModelMetrics([entry('dagster/row_count', 100, 'int')])).toBe(false);
  });

  it('does not flag an empty or undefined entry list', () => {
    expect(hasModelMetrics([])).toBe(false);
    expect(hasModelMetrics(undefined)).toBe(false);
  });
});

describe('extractMetricRows + pickHeadline', () => {
  it('extracts only recognized numeric metric labels, ignoring system fields', () => {
    const rows = extractMetricRows([
      entry('accuracy', 0.87),
      entry('dagster/row_count', 500, 'int'),
      entry('precision', 0.9),
    ]);
    expect(rows.map((r) => r.label).sort()).toEqual(['accuracy', 'precision']);
  });

  it('strips the holdout_ prefix for display text but keeps it in the raw label', () => {
    const rows = extractMetricRows([entry('holdout_r2', 0.75)]);
    expect(rows[0].label).toBe('holdout_r2');
    expect(rows[0].text).toBe('R²');
  });

  it('prefers r2/accuracy over a secondary metric for the headline', () => {
    const rows = extractMetricRows([entry('mean_absolute_error', 4.2), entry('r2_score', 0.83)]);
    const headline = pickHeadline(rows);
    expect(headline?.label).toBe('r2_score');
  });

  it('falls back to the first available metric when nothing in the priority list matches', () => {
    const rows = extractMetricRows([entry('inertia', 123.4)]);
    expect(pickHeadline(rows)?.label).toBe('inertia');
  });
});

describe('parseClusterSizesMarkdown', () => {
  it('parses the exact "- cluster N: M rows" format k_means_clustering emits', () => {
    const md = '- cluster 0: 42 rows\n- cluster 1: 17 rows\n- cluster 2: 5 rows';
    expect(parseClusterSizesMarkdown(md)).toEqual([
      { cluster: '0', rows: 42 },
      { cluster: '1', rows: 17 },
      { cluster: '2', rows: 5 },
    ]);
  });

  it('ignores unrelated lines mixed into the same markdown blob', () => {
    const md = 'Cluster summary:\n- cluster 0: 10 rows\nnot a cluster line';
    expect(parseClusterSizesMarkdown(md)).toEqual([{ cluster: '0', rows: 10 }]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(parseClusterSizesMarkdown('no clusters here')).toEqual([]);
  });
});

describe('parseJsonEntry', () => {
  it('parses a JSON-string-valued entry', () => {
    const parsed = parseJsonEntry<{ a: number }>(entry('x', '{"a": 1}', 'json'));
    expect(parsed).toEqual({ a: 1 });
  });

  it('passes an already-object value straight through', () => {
    const parsed = parseJsonEntry<{ a: number }>(entry('x', { a: 2 }, 'json'));
    expect(parsed).toEqual({ a: 2 });
  });

  it('returns null for a missing entry or invalid JSON', () => {
    expect(parseJsonEntry(undefined)).toBeNull();
    expect(parseJsonEntry(entry('x', 'not json', 'json'))).toBeNull();
  });
});
