import { useState } from 'react';
import { X, Loader2, Plus, Sparkles, Scale } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { projectsApi, API_BASE } from '@/services/api';
import { notify } from './Notifications';
import { extractComponentId } from '@/lib/componentId';
import { TextSamplePreviewPanel } from './TextSamplePreviewPanel';
import type { ComponentInstance } from '@/types';

/**
 * Bespoke config step for llm_judge -- scores a rubric (0-10 + a reason)
 * rather than sorting into a discrete category, which is what sets it
 * apart from text_classifier/zero_shot_classifier despite the shared
 * "point an LLM at a text column" shape.
 */
export function LlmJudgeConfigStep({
  componentType,
  component,
  initialAttributes,
  onDone,
  onClose,
  onReviewJudgments,
}: {
  componentType: string;
  component?: ComponentInstance | null;
  initialAttributes?: Record<string, any>;
  onDone: () => void;
  onClose: () => void;
  onReviewJudgments?: (component: ComponentInstance) => void;
}) {
  const { currentProject, loadProject } = useProjectStore();
  const isEditing = !!component;
  const seedAttrs = component?.attributes || initialAttributes || {};
  const upstreamAssetKey: string | undefined = seedAttrs.upstream_asset_key;

  const [assetName, setAssetName] = useState<string>(
    seedAttrs.asset_name || component?.label || (upstreamAssetKey ? `${upstreamAssetKey}_judged` : 'judged'),
  );
  const [responseColumn, setResponseColumn] = useState<string>(seedAttrs.response_column || '');
  const [availableColumns, setAvailableColumns] = useState<string[]>([]);
  const responseWasExplicitlySet = !!seedAttrs.response_column;
  const handleColumnsResolved = (cols: string[]) => {
    setAvailableColumns(cols);
    if (!responseWasExplicitlySet && !responseColumn && cols.length > 0) {
      const guess = cols.find((c) => /text|response|answer|content/i.test(c)) || cols[0];
      setResponseColumn(guess);
    }
  };
  const [referenceColumn, setReferenceColumn] = useState<string>(seedAttrs.reference_column || '');
  const [criteria, setCriteria] = useState<string[]>(seedAttrs.criteria || []);
  const [newCriterion, setNewCriterion] = useState('');
  const [rubric, setRubric] = useState<string>(seedAttrs.rubric || '');
  const [modelId, setModelId] = useState<string>(seedAttrs.model || 'gpt-4o');
  const [apiKeyEnvVar, setApiKeyEnvVar] = useState<string>(seedAttrs.api_key_env_var || '');
  const [saving, setSaving] = useState(false);

  const addCriterion = () => {
    const c = newCriterion.trim();
    if (c && !criteria.includes(c)) setCriteria((prev) => [...prev, c]);
    setNewCriterion('');
  };
  const removeCriterion = (c: string) => setCriteria((prev) => prev.filter((x) => x !== c));
  const renameCriterion = (oldC: string, renamedTo: string) => setCriteria((prev) => prev.map((x) => (x === oldC ? renamedTo : x)));

  const canSave = assetName.trim().length > 0 && !!upstreamAssetKey
    && responseColumn.trim().length > 0 && criteria.length > 0;

  const handleSave = async () => {
    if (!currentProject || !canSave || saving) return;
    setSaving(true);
    try {
      const componentId = extractComponentId(componentType) || 'llm_judge';
      const config: Record<string, any> = {
        name: assetName.trim(),
        asset_name: assetName.trim(),
        upstream_asset_key: upstreamAssetKey,
        response_column: responseColumn.trim(),
        criteria,
        model: modelId.trim() || 'gpt-4o',
      };
      if (referenceColumn.trim()) config.reference_column = referenceColumn.trim();
      if (rubric.trim()) config.rubric = rubric.trim();
      if (apiKeyEnvVar.trim()) config.api_key_env_var = apiKeyEnvVar.trim();

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
        console.error('[LlmJudgeConfigStep] Failed to regenerate lineage:', e);
      }

      if (body.assets_regenerated) {
        notify.success(isEditing ? `Updated "${assetName.trim()}".` : `Added "${assetName.trim()}" — scoring against ${criteria.length} criteria.`);
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
            <Scale className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">{isEditing ? 'Edit LLM judge' : 'Configure LLM judge'}</h2>
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
              <p>Scores each row 0-10 against the criteria below, plus a written reason — for rating quality on a scale, not sorting into a fixed category (that's what the classifiers are for).</p>
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
              <label className="block text-xs font-medium text-gray-700 mb-1">Column to judge</label>
              {availableColumns.length > 0 ? (
                <select
                  value={availableColumns.includes(responseColumn) ? responseColumn : ''}
                  onChange={(e) => setResponseColumn(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white font-mono"
                >
                  {!availableColumns.includes(responseColumn) && <option value="" disabled>{responseColumn || 'pick a column'}</option>}
                  {availableColumns.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={responseColumn}
                  onChange={(e) => setResponseColumn(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Reference / ground-truth column <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <select
                value={availableColumns.includes(referenceColumn) ? referenceColumn : ''}
                onChange={(e) => setReferenceColumn(e.target.value)}
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white font-mono"
              >
                <option value="">none</option>
                {availableColumns.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Criteria</label>
              <p className="text-[10px] text-gray-400 mb-1.5">Each row gets scored 0-10 on every criterion below, plus an overall average.</p>
              <div className="flex flex-wrap gap-1.5 mb-1.5">
                {criteria.map((c) => (
                  <span key={c} className="inline-flex items-center gap-1 px-1.5 py-1 text-xs bg-violet-50 text-violet-700 border border-violet-100 rounded-md font-mono">
                    <input
                      defaultValue={c}
                      size={Math.max(c.length, 3)}
                      onBlur={(e) => {
                        const cleaned = e.target.value.trim();
                        if (!cleaned || cleaned === c) {
                          e.target.value = c;
                          return;
                        }
                        if (criteria.includes(cleaned)) {
                          notify.error(`"${cleaned}" is already in the list.`);
                          e.target.value = c;
                          return;
                        }
                        renameCriterion(c, cleaned);
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      className="bg-transparent focus:outline-none focus:bg-white rounded px-0.5 min-w-0"
                    />
                    <button onClick={() => removeCriterion(c)} className="text-violet-400 hover:text-violet-700 flex-shrink-0">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
                {criteria.length === 0 && (
                  <span className="text-xs text-gray-400 italic py-1">No criteria yet — add at least one below.</span>
                )}
              </div>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={newCriterion}
                  onChange={(e) => setNewCriterion(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCriterion(); } }}
                  placeholder="e.g. accuracy, clarity, completeness"
                  className="flex-1 px-2.5 py-1.5 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
                <button
                  onClick={addCriterion}
                  disabled={!newCriterion.trim()}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
                >
                  <Plus className="w-3.5 h-3.5" /> Add
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Scoring rubric <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <textarea
                value={rubric}
                onChange={(e) => setRubric(e.target.value)}
                rows={3}
                placeholder="Free-text guidance for the judge, e.g. what separates a 3 from a 9 on each criterion"
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Judge model</label>
                <input
                  type="text"
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
                <p className="text-[10px] text-gray-400 mt-0.5">Use a strong model — it's grading, not just responding.</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">API key env var</label>
                <input
                  type="text"
                  value={apiKeyEnvVar}
                  onChange={(e) => setApiKeyEnvVar(e.target.value)}
                  placeholder="OPENAI_API_KEY"
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-200">
          {isEditing && onReviewJudgments && (
            <button
              onClick={() => onReviewJudgments(component!)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-emerald-700 border border-emerald-200 bg-emerald-50 rounded-md hover:bg-emerald-100 mr-auto"
            >
              <Scale className="w-3.5 h-3.5" /> Review judgments
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
            {saving ? 'Saving…' : isEditing ? 'Save changes' : 'Add judge'}
          </button>
        </div>
      </div>
    </div>
  );
}
