import { useState } from 'react';
import { X, Loader2, Sparkles, BarChart3 } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { projectsApi, API_BASE } from '@/services/api';
import { notify } from './Notifications';
import { extractComponentId } from '@/lib/componentId';
import { TextSamplePreviewPanel } from './TextSamplePreviewPanel';
import type { ComponentInstance } from '@/types';

/**
 * Bespoke config step for mlflow_model_inference -- fits the same
 * "point at a tabular source, configure, save" shape as the classifiers
 * (upstream_asset_key + column names), unlike bigquery_ml_train_asset/
 * bigquery_ml_predict_asset which train/predict from a SQL query against
 * a warehouse table directly, with no upstream DataFrame source at all --
 * a genuinely different UX (credentials + query authoring) scoped
 * separately, not force-fit into this wizard shape.
 *
 * mlflow_model_inference's OWN schema.json ships with an empty
 * `attributes: {}` (a real gap in the catalog, not something to work
 * around here) -- every field below is read straight from the real
 * Pydantic model in component.py instead of trusting the schema.
 */
export function MlflowInferenceConfigStep({
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
    seedAttrs.asset_name || component?.label || (upstreamAssetKey ? `${upstreamAssetKey}_scored` : 'mlflow_scored'),
  );
  const [trackingUriEnvVar, setTrackingUriEnvVar] = useState<string>(seedAttrs.tracking_uri_env_var || 'MLFLOW_TRACKING_URI');
  const [modelName, setModelName] = useState<string>(seedAttrs.model_name || '');
  const [pinMode, setPinMode] = useState<'stage' | 'version'>(seedAttrs.model_version ? 'version' : 'stage');
  const [modelStage, setModelStage] = useState<string>(seedAttrs.model_stage || 'Production');
  const [modelVersion, setModelVersion] = useState<string>(seedAttrs.model_version || '');
  const [outputColumn, setOutputColumn] = useState<string>(seedAttrs.output_column || 'prediction');
  const [featureColumns, setFeatureColumns] = useState<string>((seedAttrs.feature_columns || []).join(', '));
  const [idColumns, setIdColumns] = useState<string>((seedAttrs.id_columns || []).join(', '));
  const [keepInputColumns, setKeepInputColumns] = useState<boolean>(seedAttrs.keep_input_columns ?? true);
  const [saving, setSaving] = useState(false);

  const canSave = assetName.trim().length > 0 && !!upstreamAssetKey
    && trackingUriEnvVar.trim().length > 0 && modelName.trim().length > 0
    && (pinMode === 'stage' ? modelStage.trim().length > 0 : modelVersion.trim().length > 0);

  const handleSave = async () => {
    if (!currentProject || !canSave || saving) return;
    setSaving(true);
    try {
      const componentId = extractComponentId(componentType) || 'mlflow_model_inference';
      const config: Record<string, any> = {
        name: assetName.trim(),
        asset_name: assetName.trim(),
        upstream_asset_key: upstreamAssetKey,
        tracking_uri_env_var: trackingUriEnvVar.trim(),
        model_name: modelName.trim(),
        output_column: outputColumn.trim() || 'prediction',
        keep_input_columns: keepInputColumns,
      };
      if (pinMode === 'stage') {
        config.model_stage = modelStage.trim();
      } else {
        config.model_version = modelVersion.trim();
        config.model_stage = null;
      }
      const features = featureColumns.split(',').map((s) => s.trim()).filter(Boolean);
      if (features.length > 0) config.feature_columns = features;
      const ids = idColumns.split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.length > 0) config.id_columns = ids;

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
        console.error('[MlflowInferenceConfigStep] Failed to regenerate lineage:', e);
      }

      if (body.assets_regenerated) {
        notify.success(isEditing ? `Updated "${assetName.trim()}".` : `Added "${assetName.trim()}" — scoring with ${modelName.trim()}.`);
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
            <BarChart3 className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">{isEditing ? 'Edit MLflow scoring' : 'Configure MLflow scoring'}</h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>

        <div className="flex-1 overflow-hidden grid grid-cols-1 sm:grid-cols-[1fr_380px]">
          <TextSamplePreviewPanel upstreamAssetKey={upstreamAssetKey} />

          <div className="space-y-4 overflow-y-auto px-6 py-4">
            <div className="bg-blue-50 border border-blue-100 rounded-md p-3 text-xs text-blue-900 space-y-1">
              <p className="font-medium">How this works</p>
              <p>Loads an already-registered MLflow model and scores every row of your source with it, adding a prediction column — this doesn't train anything, it runs an existing model.</p>
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
              <label className="block text-xs font-medium text-gray-700 mb-1">MLflow tracking URI env var</label>
              <input
                type="text"
                value={trackingUriEnvVar}
                onChange={(e) => setTrackingUriEnvVar(e.target.value)}
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Registered model name</label>
              <input
                type="text"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                placeholder="churn_model"
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Which version to load</label>
              <div className="flex gap-2 mb-1.5">
                <button
                  onClick={() => setPinMode('stage')}
                  className={`flex-1 px-2.5 py-1.5 text-xs rounded-md border ${pinMode === 'stage' ? 'bg-primary text-primary-foreground border-primary' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                >
                  By stage
                </button>
                <button
                  onClick={() => setPinMode('version')}
                  className={`flex-1 px-2.5 py-1.5 text-xs rounded-md border ${pinMode === 'version' ? 'bg-primary text-primary-foreground border-primary' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                >
                  Pin a version
                </button>
              </div>
              {pinMode === 'stage' ? (
                <input
                  type="text"
                  value={modelStage}
                  onChange={(e) => setModelStage(e.target.value)}
                  placeholder="Production"
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
              ) : (
                <input
                  type="text"
                  value={modelVersion}
                  onChange={(e) => setModelVersion(e.target.value)}
                  placeholder="7"
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Feature columns</label>
              <input
                type="text"
                value={featureColumns}
                onChange={(e) => setFeatureColumns(e.target.value)}
                placeholder="leave empty to use every upstream column"
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
              <p className="text-[10px] text-gray-400 mt-0.5">Comma-separated. Passed to the model as input.</p>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">ID columns to always keep</label>
              <input
                type="text"
                value={idColumns}
                onChange={(e) => setIdColumns(e.target.value)}
                placeholder="customer_id, order_id"
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
            </div>

            <div className="grid grid-cols-2 gap-3 items-start">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Prediction column name</label>
                <input
                  type="text"
                  value={outputColumn}
                  onChange={(e) => setOutputColumn(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-gray-700 mt-6">
                <input type="checkbox" checked={keepInputColumns} onChange={(e) => setKeepInputColumns(e.target.checked)} />
                Keep all input columns in output
              </label>
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
            {saving ? 'Saving…' : isEditing ? 'Save changes' : 'Add component'}
          </button>
        </div>
      </div>
    </div>
  );
}
