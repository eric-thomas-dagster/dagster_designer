import { useMemo, useState } from 'react';
import { isDbtBackedType } from '@/lib/dbtUpstream';
import { X, Loader2, Search } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { projectsApi, API_BASE } from '@/services/api';
import { notify } from './Notifications';
import { extractComponentId } from '@/lib/componentId';
import { ANSWER_PROVIDERS, buildRagQueryConfig, deriveKnowledgeBases } from '@/lib/ragQuery';
import { RequiredResourcesBanner } from './RequiredResourcesBanner';

/**
 * Guided config for rag_pipeline -- the QUERY side of a knowledge base built with context_engineering_pipeline.
 *
 * The part worth guiding is the part that goes wrong silently: the retriever has to describe the same index AND the same
 * embedding model the knowledge base was built with. Picking a knowledge base from this project fills both in; the config
 * itself comes from lib/ragQuery.ts (unit-tested). Reranking, hybrid search, HyDE and partitioning stay in the raw form.
 */
const INPUT = 'w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500';

export function RagQueryConfigStep({
  componentType,
  initialAttributes,
  onDone,
  onClose,
}: {
  componentType: string;
  initialAttributes?: Record<string, any>;
  onDone: () => void;
  onClose: () => void;
}) {
  const { currentProject, loadProject } = useProjectStore();
  const seed = initialAttributes || {};
  const { supported, unsupported } = useMemo(() => deriveKnowledgeBases(currentProject?.components || []), [currentProject]);
  const dataframeAssets = useMemo(() => {
    if (!currentProject) return [];
    return currentProject.graph.nodes
      .filter((n) => !isDbtBackedType((n.data as any)?.component_type) && (n.type === 'asset' || (n.data as any)?.asset_key) && typeof (n.data as any)?.io_output_type === 'string' && (n.data as any).io_output_type.toLowerCase().includes('dataframe'))
      .map((n) => (n.data as any)?.asset_key || n.id) as string[];
  }, [currentProject]);

  const [kbName, setKbName] = useState<string>(supported[0]?.assetName || '');
  const kb = supported.find((k) => k.assetName === kbName);
  const [upstreamAssetKey, setUpstreamAssetKey] = useState<string>(seed.upstream_asset_key || '');
  const [assetName, setAssetName] = useState<string>(seed.asset_name || '');
  const [assetNameTouched, setAssetNameTouched] = useState(!!seed.asset_name);
  const [queryColumn, setQueryColumn] = useState<string>(seed.query_column || 'query');
  const [answerColumn, setAnswerColumn] = useState<string>(seed.answer_column || 'answer');
  const [topK, setTopK] = useState<number>(5);
  const [generate, setGenerate] = useState(true);
  const [provider, setProvider] = useState<string>('openai');
  const [model, setModel] = useState<string>(ANSWER_PROVIDERS.openai.model);
  const [apiKeyEnvVar, setApiKeyEnvVar] = useState<string>(ANSWER_PROVIDERS.openai.apiKeyEnvVar);
  const [receiptsOn, setReceiptsOn] = useState(false);
  const [receiptsKey, setReceiptsKey] = useState('context_receipts');
  const [saving, setSaving] = useState(false);

  const effectiveName = assetNameTouched ? assetName : kb ? `${kb.assetName}_qa` : '';
  const storeInstalled = (currentProject?.components || []).some(
    (c) => (c.component_type || '').toLowerCase().includes('contextreceiptstore') && c.attributes?.resource_key === receiptsKey,
  );
  const canSave = !!kb && !!upstreamAssetKey && !!effectiveName.trim() && !!queryColumn.trim() && (!generate || (!!model.trim() && !!apiKeyEnvVar.trim()));

  const pickProvider = (p: string) => {
    setProvider(p);
    const d = ANSWER_PROVIDERS[p];
    if (d) { setModel(d.model); setApiKeyEnvVar(d.apiKeyEnvVar); }
  };

  const save = async () => {
    if (!currentProject || !kb || saving) return;
    setSaving(true);
    try {
      const config = buildRagQueryConfig({
        assetName: effectiveName.trim(),
        upstreamAssetKey,
        queryColumn: queryColumn.trim(),
        answerColumn: answerColumn.trim() || 'answer',
        kb,
        topK,
        answer: generate ? { provider, model: model.trim(), apiKeyEnvVar: apiKeyEnvVar.trim() } : null,
        receipts: receiptsOn ? { resourceKey: receiptsKey.trim() } : null,
      });
      const res = await fetch(`${API_BASE}/templates/configure/${extractComponentId(componentType)}`, {
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
        console.error('[RagQueryConfigStep] Failed to regenerate lineage:', e);
      }
      if (body.assets_regenerated) {
        notify.success(`Added "${effectiveName.trim()}" — answering from ${kb.assetName}.`);
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
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <Search className="w-5 h-5 text-primary" />
            <h2 className="text-base font-semibold text-gray-900">Query a knowledge base</h2>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Knowledge base</label>
            {supported.length === 0 ? (
              <p className="text-xs text-amber-700 bg-amber-50 rounded px-2.5 py-2">
                No queryable knowledge base in this project yet. Build one first with “Build a knowledge base”.
              </p>
            ) : (
              <select value={kbName} onChange={(e) => setKbName(e.target.value)} className={INPUT}>
                {supported.map((k) => <option key={k.assetName} value={k.assetName}>{k.assetName} ({k.store.kind}: {k.store.collectionName})</option>)}
              </select>
            )}
            {kb && (
              <p className="text-[10px] text-gray-400 mt-0.5">
                Retrieval embeds each question with <span className="font-mono">{kb.embedding.provider}{kb.embedding.model ? ` / ${kb.embedding.model}` : ''}</span> — the same model the knowledge base was built with.
              </p>
            )}
            {unsupported.length > 0 && (
              <p className="text-[10px] text-gray-400 mt-1">
                Not listed: {unsupported.map((u) => `${u.assetName} (${u.reason})`).join('; ')}.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Questions come from (asset)</label>
              <select value={upstreamAssetKey} onChange={(e) => setUpstreamAssetKey(e.target.value)} className={INPUT}>
                <option value="">Pick an asset…</option>
                {dataframeAssets.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Question column</label>
              <input value={queryColumn} onChange={(e) => setQueryColumn(e.target.value)} className={`${INPUT} font-mono`} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Asset name</label>
              <input value={effectiveName} onChange={(e) => { setAssetNameTouched(true); setAssetName(e.target.value); }} className={`${INPUT} font-mono`} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Chunks to retrieve (top-k)</label>
              <input type="number" min={1} value={topK} onChange={(e) => setTopK(Math.max(1, Number(e.target.value) || 1))} className={`${INPUT} font-mono`} />
            </div>
          </div>

          <div className="border-t border-gray-100 pt-4 space-y-3">
            <label className="flex items-start gap-2 text-xs text-gray-700">
              <input type="checkbox" checked={generate} onChange={(e) => setGenerate(e.target.checked)} className="mt-0.5" />
              <span>Write an answer from the retrieved chunks<span className="block text-[10px] text-gray-400">Off = retrieval only: the output has the retrieved sources and no generated answer.</span></span>
            </label>
            {generate && (
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Provider</label>
                  <select value={provider} onChange={(e) => pickProvider(e.target.value)} className={INPUT}>
                    {Object.entries(ANSWER_PROVIDERS).map(([id, p]) => <option key={id} value={id}>{p.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Model</label>
                  <input value={model} onChange={(e) => setModel(e.target.value)} className={`${INPUT} font-mono`} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">API key env var</label>
                  <input value={apiKeyEnvVar} onChange={(e) => setApiKeyEnvVar(e.target.value)} className={`${INPUT} font-mono`} />
                </div>
                <div className="col-span-3">
                  <label className="block text-xs font-medium text-gray-700 mb-1">Answer column</label>
                  <input value={answerColumn} onChange={(e) => setAnswerColumn(e.target.value)} className={`${INPUT} font-mono`} />
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-gray-100 pt-4 space-y-2">
            <label className="flex items-start gap-2 text-xs text-gray-700">
              <input type="checkbox" checked={receiptsOn} onChange={(e) => setReceiptsOn(e.target.checked)} className="mt-0.5" />
              <span>Record retrieval receipts<span className="block text-[10px] text-gray-400">Logs which chunks answered each question so feedback can flow back into the next knowledge-base build.</span></span>
            </label>
            {receiptsOn && (
              <>
                <input value={receiptsKey} onChange={(e) => setReceiptsKey(e.target.value)} placeholder="context_receipts" className={`${INPUT} font-mono`} />
                {currentProject && (
                  <RequiredResourcesBanner
                    projectId={currentProject.id}
                    resources={[{ component_id: 'context_receipt_store', resource_key: receiptsKey.trim() || 'context_receipts', reason: 'records every retrieval', needed_by: effectiveName || 'this asset', installed: storeInstalled }]}
                    onInstalled={() => loadProject(currentProject.id)}
                  />
                )}
              </>
            )}
          </div>
        </div>

        <div className="px-6 py-3 border-t border-gray-200 flex items-center justify-between">
          <span className="text-[10px] text-gray-400">Reranking, hybrid search and partitioning: edit the component's raw config after adding.</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
            <button onClick={save} disabled={!canSave || saving} className="px-3 py-1.5 text-sm rounded-md bg-primary text-white disabled:opacity-50 inline-flex items-center gap-1.5">
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Add
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
