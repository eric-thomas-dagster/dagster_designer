export interface MetadataEntryLite {
  label: string;
  type: string;
  value: any;
  description?: string | null;
}

// Metric label names seen across the analytics component catalog
// (automl_asset, linear_regression_model, logistic_regression_model,
// k_means_clustering, neural_network_model, gradient_boosting_model, and
// others that follow the same convention) -- deliberately name-based
// rather than a hardcoded component-id whitelist, since the catalog has
// ~90 analytics components and new ones follow this same metadata
// convention without Designer needing to know their id in advance.
const RECOGNIZED_METRIC_LABELS = new Set([
  'accuracy', 'precision', 'recall', 'f1', 'f1_score',
  'r2', 'r2_score', 'mae', 'mean_absolute_error', 'mse', 'mean_squared_error', 'rmse',
  'auc', 'roc_auc', 'log_loss',
  'inertia', 'n_clusters', 'n_iterations', 'silhouette_score',
  'n_classes', 'n_estimators', 'train_rows', 'test_rows', 'rows',
  'search_time_seconds', 'explained_variance', 'explained_variance_ratio',
]);

const HEADLINE_PRIORITY = [
  'holdout_r2', 'r2_score', 'r2', 'holdout_accuracy', 'accuracy',
  'holdout_f1', 'f1_score', 'f1', 'auc', 'roc_auc',
  'holdout_rmse', 'rmse', 'holdout_mae', 'mean_absolute_error', 'mae',
];

export const METRIC_LABEL_TEXT: Record<string, string> = {
  accuracy: 'Accuracy', precision: 'Precision', recall: 'Recall',
  f1: 'F1', f1_score: 'F1',
  mae: 'MAE', mean_absolute_error: 'MAE',
  mse: 'MSE', mean_squared_error: 'MSE', rmse: 'RMSE',
  r2: 'R²', r2_score: 'R²',
  auc: 'AUC', roc_auc: 'ROC AUC', log_loss: 'Log loss',
  inertia: 'Inertia', n_clusters: 'Clusters', n_iterations: 'Iterations',
  silhouette_score: 'Silhouette score', n_classes: 'Classes',
  n_estimators: 'Estimators', train_rows: 'Train rows', test_rows: 'Test rows',
  rows: 'Rows', search_time_seconds: 'Search time (s)',
  explained_variance: 'Explained variance', explained_variance_ratio: 'Explained variance ratio',
};

function isMetricLabel(label: string): boolean {
  return RECOGNIZED_METRIC_LABELS.has(label) || label.startsWith('holdout_');
}

export function metaByLabel(entries: MetadataEntryLite[]): Map<string, MetadataEntryLite> {
  const m = new Map<string, MetadataEntryLite>();
  for (const e of entries || []) m.set(e.label, e);
  return m;
}

export function hasModelMetrics(entries: MetadataEntryLite[] | undefined): boolean {
  if (!entries || entries.length === 0) return false;
  return entries.some((e) => isMetricLabel(e.label) || e.label === 'confusion_matrix' || e.label === 'feature_importance' || e.label === 'classification_report' || e.label === 'cluster_sizes');
}

export interface MetricRow { label: string; text: string; value: number }

export function extractMetricRows(entries: MetadataEntryLite[]): MetricRow[] {
  const out: MetricRow[] = [];
  for (const e of entries) {
    if (!isMetricLabel(e.label)) continue;
    const v = typeof e.value === 'number' ? e.value : Number(e.value);
    if (!Number.isFinite(v)) continue;
    const displayLabel = e.label.startsWith('holdout_') ? e.label.replace('holdout_', '') : e.label;
    out.push({ label: e.label, text: METRIC_LABEL_TEXT[displayLabel] || displayLabel, value: v });
  }
  return out;
}

export function pickHeadline(rows: MetricRow[]): MetricRow | undefined {
  for (const key of HEADLINE_PRIORITY) {
    const m = rows.find((r) => r.label === key || r.label === `holdout_${key}`);
    if (m) return m;
  }
  return rows[0];
}

export function parseJsonEntry<T>(entry: MetadataEntryLite | undefined): T | null {
  if (!entry || entry.value == null) return null;
  if (typeof entry.value === 'object') return entry.value as T;
  try {
    return JSON.parse(entry.value) as T;
  } catch {
    return null;
  }
}

export function entryText(entry: MetadataEntryLite | undefined): string | null {
  if (!entry || entry.value == null) return null;
  return String(entry.value);
}

// Parses k_means_clustering's cluster_sizes markdown ("- cluster 0: 42
// rows" per line) back into chart-ready rows -- the component emits it as
// markdown text (there's no JSON metadata type this repo's convention
// reaches for casually), but the underlying data is tabular and reads
// far better as a bar chart than a bulleted list.
export function parseClusterSizesMarkdown(md: string): Array<{ cluster: string; rows: number }> {
  const out: Array<{ cluster: string; rows: number }> = [];
  for (const line of md.split('\n')) {
    const m = /-\s*cluster\s+(\S+):\s*(\d+)\s*rows/i.exec(line);
    if (m) out.push({ cluster: m[1], rows: Number(m[2]) });
  }
  return out;
}
