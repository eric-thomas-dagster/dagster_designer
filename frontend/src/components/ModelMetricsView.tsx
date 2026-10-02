import { useMemo } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
} from 'recharts';
import {
  type MetadataEntryLite,
  metaByLabel,
  extractMetricRows,
  pickHeadline,
  parseJsonEntry,
  entryText,
  parseClusterSizesMarkdown,
} from '@/lib/modelMetrics';

interface ConfusionMatrix {
  labels: string[];
  matrix: number[][];
}

interface FeatureImportance {
  feature: string[];
  importance_mean: number[];
  importance_std: number[];
}

function heatColor(value: number, max: number): string {
  if (max <= 0) return 'rgba(37, 99, 235, 0.06)';
  const ratio = Math.min(1, value / max);
  const alpha = 0.06 + ratio * 0.55;
  return `rgba(37, 99, 235, ${alpha.toFixed(3)})`;
}

/**
 * Content-only model evaluation view -- headline metric, full metrics
 * grid, confusion matrix heatmap, feature importance bar chart,
 * classification report, and cluster-size chart, driven entirely by
 * which metadata keys are present on the entries passed in (see
 * lib/modelMetrics.ts). No modal chrome here on purpose: this same
 * rendering is used both inside ModelEvaluationPanel's modal (opened from
 * the AutoML config step) and inline as AssetDetailPage's Model tab (any
 * asset whose latest materialization looks like a model's).
 */
export function ModelMetricsView({ entries }: { entries: MetadataEntryLite[] }) {
  const byLabel = useMemo(() => metaByLabel(entries), [entries]);
  const metricRows = useMemo(() => extractMetricRows(entries), [entries]);
  const headline = useMemo(() => pickHeadline(metricRows), [metricRows]);

  const confusionMatrix = parseJsonEntry<ConfusionMatrix>(byLabel.get('confusion_matrix'));
  const featureImportance = parseJsonEntry<FeatureImportance>(byLabel.get('feature_importance'));
  const bestConfig = parseJsonEntry<Record<string, any>>(byLabel.get('best_config'));
  const bestEstimator = entryText(byLabel.get('best_estimator'));
  const searchMode = entryText(byLabel.get('search_mode'));
  const classificationReport = entryText(byLabel.get('classification_report'));
  const clusterSizesMd = entryText(byLabel.get('cluster_sizes'));
  const clusterChartData = useMemo(() => (clusterSizesMd ? parseClusterSizesMarkdown(clusterSizesMd) : []), [clusterSizesMd]);

  const importanceChartData = useMemo(() => {
    if (!featureImportance) return [];
    const { feature, importance_mean, importance_std } = featureImportance;
    return feature
      .map((f, i) => ({ feature: f, importance: importance_mean[i], std: importance_std[i] ?? 0 }))
      .slice(0, 15);
  }, [featureImportance]);

  const confusionMax = useMemo(() => {
    if (!confusionMatrix) return 0;
    let max = 0;
    for (const row of confusionMatrix.matrix) for (const v of row) max = Math.max(max, v);
    return max;
  }, [confusionMatrix]);

  if (metricRows.length === 0 && !confusionMatrix && !featureImportance && !classificationReport && !clusterSizesMd) {
    return null;
  }

  return (
    <div className="space-y-6">
      {headline && (
        <div className="bg-white border border-gray-200 rounded-lg p-5 flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{headline.text}</p>
            <p className="text-4xl font-semibold text-gray-900 mt-1">{headline.value.toFixed(3)}</p>
          </div>
          <div className="text-right text-xs text-gray-500 space-y-0.5">
            {bestEstimator && <p><span className="text-gray-400">Estimator:</span> <span className="font-mono">{bestEstimator}</span></p>}
            {searchMode && <p><span className="text-gray-400">Search:</span> {searchMode}</p>}
          </div>
        </div>
      )}

      {metricRows.length > 1 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {metricRows.filter((r) => r !== headline).map((m) => (
            <div key={m.label} className="bg-white border border-gray-200 rounded-md p-3">
              <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">{m.text}</p>
              <p className="text-lg font-semibold text-gray-900 mt-0.5">{m.value.toFixed(3)}</p>
            </div>
          ))}
        </div>
      )}

      {classificationReport && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <p className="text-sm font-medium text-gray-800 mb-2">Classification report</p>
          <pre className="text-[11px] font-mono bg-gray-50 border border-gray-100 rounded p-3 overflow-x-auto whitespace-pre">{classificationReport.replace(/^```\n?|\n?```$/g, '')}</pre>
        </div>
      )}

      {clusterChartData.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <p className="text-sm font-medium text-gray-800 mb-3">Cluster sizes</p>
          <div style={{ height: Math.max(160, clusterChartData.length * 32) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={clusterChartData} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="cluster" tick={{ fontSize: 11, fontFamily: 'monospace' }} width={80} />
                <Tooltip formatter={(value: any) => [value, 'rows']} />
                <Bar dataKey="rows" radius={[0, 3, 3, 0]}>
                  {clusterChartData.map((_, i) => <Cell key={i} fill="#2563eb" />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {confusionMatrix && confusionMatrix.labels.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <p className="text-sm font-medium text-gray-800 mb-1">Confusion matrix</p>
          <p className="text-xs text-gray-500 mb-3">Rows are true class, columns are predicted class.</p>
          <div className="overflow-x-auto">
            <table className="border-collapse text-xs">
              <thead>
                <tr>
                  <th className="p-2"></th>
                  <th colSpan={confusionMatrix.labels.length} className="text-center text-[11px] font-medium text-gray-500 pb-1">
                    predicted
                  </th>
                </tr>
                <tr>
                  <th className="p-2"></th>
                  {confusionMatrix.labels.map((l) => (
                    <th key={l} className="p-2 font-mono font-medium text-gray-600 text-center">{l}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {confusionMatrix.matrix.map((row, i) => (
                  <tr key={confusionMatrix.labels[i]}>
                    <th className="p-2 font-mono font-medium text-gray-600 text-right pr-3">{confusionMatrix.labels[i]}</th>
                    {row.map((v, j) => (
                      <td
                        key={j}
                        className="p-2 text-center font-mono border border-gray-100"
                        style={{ backgroundColor: heatColor(v, confusionMax), minWidth: 44 }}
                        title={`true=${confusionMatrix.labels[i]} predicted=${confusionMatrix.labels[j]}: ${v}`}
                      >
                        {v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {importanceChartData.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <p className="text-sm font-medium text-gray-800 mb-1">Feature importance</p>
          <p className="text-xs text-gray-500 mb-3">Permutation importance against the held-out test split — how much accuracy/R² drops when a feature is shuffled.</p>
          <div style={{ height: Math.max(180, importanceChartData.length * 28) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={importanceChartData} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="feature" tick={{ fontSize: 11, fontFamily: 'monospace' }} width={140} />
                <Tooltip formatter={(value: any, name: string) => [Number(value).toFixed(4), name === 'importance' ? 'importance' : name]} />
                <Bar dataKey="importance" radius={[0, 3, 3, 0]}>
                  {importanceChartData.map((_, i) => <Cell key={i} fill="#2563eb" />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {bestConfig && Object.keys(bestConfig).length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <p className="text-sm font-medium text-gray-800 mb-2">Winning hyperparameters{bestEstimator ? ` (${bestEstimator})` : ''}</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {Object.entries(bestConfig).map(([k, v]) => (
              <div key={k} className="text-xs bg-gray-50 border border-gray-100 rounded px-2 py-1.5">
                <span className="text-gray-500">{k}:</span>{' '}
                <span className="font-mono text-gray-800">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
