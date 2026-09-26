import { useState } from 'react';
import { X, Loader2, Sparkles, BarChart3 } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { projectsApi, API_BASE } from '@/services/api';
import { notify } from './Notifications';
import { extractComponentId } from '@/lib/componentId';
import { TextSamplePreviewPanel } from './TextSamplePreviewPanel';
import type { ComponentInstance } from '@/types';

/**
 * Bespoke config step for automl_asset -- real cross-model-family AutoML
 * via FLAML (searches LightGBM/XGBoost/random forest/linear/... and picks
 * the winner), as opposed to ml_pipeline's grid_search/random_search/
 * bayesian_search ops which tune hyperparameters for ONE model_type you
 * already specify. This is the "yes, I have labeled historical examples,
 * just train me a model" default answer -- almost no ML knowledge
 * required, unlike ml_pipeline's 30-op DSL which stays on the raw
 * generic form for users who already know exactly what they want.
 */
export function AutoMLConfigStep({
  componentType,
  component,
  initialAttributes,
  onDone,
  onClose,
  onReviewPredictions,
}: {
  componentType: string;
  component?: ComponentInstance | null;
  initialAttributes?: Record<string, any>;
  onDone: () => void;
  onClose: () => void;
  onReviewPredictions?: (component: ComponentInstance) => void;
}) {
  const { currentProject, loadProject } = useProjectStore();
  const isEditing = !!component;
  const seedAttrs = component?.attributes || initialAttributes || {};
  const upstreamAssetKey: string | undefined = seedAttrs.upstream_asset_key;

  const [assetName, setAssetName] = useState<string>(
    seedAttrs.asset_name || component?.label || (upstreamAssetKey ? `${upstreamAssetKey}_automl` : 'automl_scored'),
  );
  const [targetColumn, setTargetColumn] = useState<string>(seedAttrs.target_column || '');
  const [availableColumns, setAvailableColumns] = useState<string[]>([]);
  const targetWasExplicitlySet = !!seedAttrs.target_column;
  const handleColumnsResolved = (cols: string[]) => {
    setAvailableColumns(cols);
    if (!targetWasExplicitlySet && !targetColumn && cols.length > 0) {
      const guess = cols.find((c) => /label|target|churn|outcome|class/i.test(c)) || cols[cols.length - 1];
      setTargetColumn(guess);
    }
  };
  const [taskType, setTaskType] = useState<'classification' | 'regression'>(seedAttrs.task_type || 'classification');
  const [featureColumns, setFeatureColumns] = useState<string>((seedAttrs.feature_columns || []).join(', '));
  const [statePath, setStatePath] = useState<string>(
    seedAttrs.state_path || (upstreamAssetKey ? `automl_state/${upstreamAssetKey}.json` : 'automl_state/model.json'),
  );
  const [timeBudgetSeconds, setTimeBudgetSeconds] = useState<number>(seedAttrs.time_budget_seconds ?? 60);
  const [outputColumn, setOutputColumn] = useState<string>(seedAttrs.output_column || 'predicted');
  const [refreshSearch, setRefreshSearch] = useState<boolean>(seedAttrs.refresh_search ?? false);
  const [saving, setSaving] = useState(false);

  const canSave = assetName.trim().length > 0 && !!upstreamAssetKey
    && targetColumn.trim().length > 0 && statePath.trim().length > 0;

  const handleSave = async () => {
    if (!currentProject || !canSave || saving) return;
    setSaving(true);
    try {
      const componentId = extractComponentId(componentType) || 'automl_asset';
      const config: Record<string, any> = {
        name: assetName.trim(),
        asset_name: assetName.trim(),
        upstream_asset_key: upstreamAssetKey,
        target_column: targetColumn.trim(),
        task_type: taskType,
        state_path: statePath.trim(),
        time_budget_seconds: timeBudgetSeconds,
        output_column: outputColumn.trim() || 'predicted',
        refresh_search: refreshSearch,
      };
      const features = featureColumns.split(',').map((s) => s.trim()).filter(Boolean);
      if (features.length > 0) config.feature_columns = features;

      const res = await fetch(`${API_BASE}/templates/configure/${componentId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: currentProject.id, config }),
      });
      const body = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(body.detail || 'Failed to configure component');

      await loadProject(currentProject.id);
      try {
        await projectsApi.regenerateAssets(currentProject.id, true);
      } catch (e) {
        console.error('[AutoMLConfigStep] Failed to regenerate lineage:', e);
      }

      if (body.assets_regenerated) {
        notify.success(isEditing ? `Updated "${assetName.trim()}".` : `Added "${assetName.trim()}" — training on ${targetColumn.trim()}.`);
        onDone();
      } else {
        notify.error(`Saved, but Dagster couldn't load it:\n\n${body.regenerate_error || 'Unknown error'}`);
      }
    } catch (e: any) {
      notify.error(`Failed to save: ${e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">{isEditing ? 'Edit AutoML model' : 'Configure AutoML'}</h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>

        <div className="flex-1 overflow-hidden grid grid-cols-1 sm:grid-cols-[1fr_380px]">
          <TextSamplePreviewPanel upstreamAssetKey={upstreamAssetKey} onColumnsChange={handleColumnsResolved} />

          <div className="space-y-4 overflow-y-auto px-6 py-4">
            <div className="bg-blue-50 border border-blue-100 rounded-md p-3 text-xs text-blue-900 space-y-1">
              <p className="font-medium">How this works</p>
              <p>Searches across model families (LightGBM, XGBoost, random forest, linear, ...) to find the best fit for your labeled data — no algorithm choice required. The first run does a real search; every run after reuses the cached recipe with a cheap refit, so repeat runs stay fast.</p>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Asset name</label>
              <input
                type="text"
                value={assetName}
                onChange={(e) => setAssetName(e.target.value)}
                disabled={isEditing}
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono disabled:bg-gray-50 disabled:text-gray-400"
              />
              {isEditing && <p className="text-[10px] text-gray-400 mt-0.5">Can't be renamed after creation.</p>}
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Column to predict (target)</label>
              {availableColumns.length > 0 ? (
                <select
                  value={availableColumns.includes(targetColumn) ? targetColumn : ''}
                  onChange={(e) => setTargetColumn(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white font-mono"
                >
                  {!availableColumns.includes(targetColumn) && <option value="" disabled>{targetColumn || 'pick a column'}</option>}
                  {availableColumns.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={targetColumn}
                  onChange={(e) => setTargetColumn(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
              )}
              <p className="text-[10px] text-gray-400 mt-0.5">This is the labeled column from your historical data — the one the model learns to predict.</p>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">What kind of value is it?</label>
              <div className="flex gap-2">
                <button
                  onClick={() => setTaskType('classification')}
                  className={`flex-1 px-2.5 py-1.5 text-xs rounded-md border ${taskType === 'classification' ? 'bg-primary text-primary-foreground border-primary' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                >
                  A category (classification)
                </button>
                <button
                  onClick={() => setTaskType('regression')}
                  className={`flex-1 px-2.5 py-1.5 text-xs rounded-md border ${taskType === 'regression' ? 'bg-primary text-primary-foreground border-primary' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                >
                  A number (regression)
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Feature columns</label>
              <input
                type="text"
                value={featureColumns}
                onChange={(e) => setFeatureColumns(e.target.value)}
                placeholder="leave empty to use every other column"
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
              <p className="text-[10px] text-gray-400 mt-0.5">Comma-separated. Non-numeric columns are auto-encoded.</p>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Cache path (for cheap re-runs)</label>
              <input
                type="text"
                value={statePath}
                onChange={(e) => setStatePath(e.target.value)}
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
              <p className="text-[10px] text-gray-400 mt-0.5">Local or cloud (s3://, gs://) path. The winning model recipe is cached here after the first search.</p>
            </div>

            <div className="grid grid-cols-2 gap-3 items-end">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Search time budget (seconds)</label>
                <input
                  type="number"
                  min={1}
                  value={timeBudgetSeconds}
                  onChange={(e) => setTimeBudgetSeconds(Math.max(1, Number(e.target.value) || 1))}
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-gray-700 mb-2">
                <input type="checkbox" checked={refreshSearch} onChange={(e) => setRefreshSearch(e.target.checked)} />
                Force a fresh search (ignore any cache)
              </label>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Prediction column name</label>
              <input
                type="text"
                value={outputColumn}
                onChange={(e) => setOutputColumn(e.target.value)}
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-200">
          {isEditing && onReviewPredictions && (
            <button
              onClick={() => onReviewPredictions(component!)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-emerald-700 border border-emerald-200 bg-emerald-50 rounded-md hover:bg-emerald-100 mr-auto"
            >
              <BarChart3 className="w-3.5 h-3.5" /> Review predictions
            </button>
          )}
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-md">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave || saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {saving ? 'Saving…' : isEditing ? 'Save changes' : 'Train model'}
          </button>
        </div>
      </div>
    </div>
  );
}
