import { useEffect, useMemo, useState } from 'react';
import { X, Loader2, Plus, Sparkles, Layers, Database, FileSpreadsheet } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { projectsApi, API_BASE } from '@/services/api';
import { notify } from './Notifications';
import { extractComponentId } from '@/lib/componentId';
import { TextSamplePreviewPanel } from './TextSamplePreviewPanel';
import type { ComponentInstance } from '@/types';

/**
 * Bespoke config step for context_engineering_pipeline -- chunk, (optionally)
 * classify, embed, and write raw text into a searchable vector store.
 *
 * Two real, separate shapes covered here, both straight from the actual
 * Pydantic model (not the README summary):
 *
 * 1. Asset source, execution_mode='python' (the common case): read an
 *    existing DataFrame asset, run chunk/classify/embed/write_vector_store
 *    as Python/API calls. Full 4-stage builder below.
 * 2. Warehouse source (`source: {kind: warehouse_query, resource_key, sql}`),
 *    with a further choice: pull into Python here (same 4 stages, just
 *    sourced via SQL instead of an asset), or run the WHOLE chunk/classify/
 *    embed chain as one server-side query via a warehouse-native AI function
 *    (execution_mode='sql', only for snowflake_cortex/bigquery/databricks
 *    dialects) -- data never leaves the database. Pushdown mode has no
 *    write_vector_store equivalent (per the component's own docstring --
 *    there's no in-warehouse vector index that behaves like chromadb/
 *    pinecone/qdrant); it lands in `output_table` instead, which
 *    rag_pipeline queries directly.
 *
 * Multiple classify passes, mixing sources, or any other steps: shape falls
 * back to the raw generic form, same call made for ml_pipeline.
 */

const EMBED_PROVIDERS: Record<string, { label: string; modelDefault: string; needsApiKey: boolean; apiKeyDefault?: string }> = {
  sentence_transformers: { label: 'sentence-transformers (local, free)', modelDefault: 'all-MiniLM-L6-v2', needsApiKey: false },
  openai: { label: 'OpenAI', modelDefault: 'text-embedding-3-small', needsApiKey: true, apiKeyDefault: 'OPENAI_API_KEY' },
  cohere: { label: 'Cohere', modelDefault: 'embed-english-v3.0', needsApiKey: true, apiKeyDefault: 'COHERE_API_KEY' },
  litellm: { label: 'LiteLLM (any provider)', modelDefault: 'text-embedding-3-small', needsApiKey: false },
};

const VECTOR_STORE_PROVIDERS: Record<string, { label: string; connectionLabel: string; connectionPlaceholder: string; needsApiKey: boolean; apiKeyDefault?: string }> = {
  chromadb: { label: 'ChromaDB (local, free)', connectionLabel: 'Storage path', connectionPlaceholder: './chroma_db', needsApiKey: false },
  pinecone: { label: 'Pinecone', connectionLabel: 'Index name', connectionPlaceholder: 'my-index', needsApiKey: true, apiKeyDefault: 'PINECONE_API_KEY' },
  qdrant: { label: 'Qdrant', connectionLabel: 'URL', connectionPlaceholder: 'localhost', needsApiKey: false },
};

const SQL_DIALECTS: Record<string, string> = {
  snowflake_cortex: 'Snowflake (Cortex)',
  bigquery: 'BigQuery',
  databricks: 'Databricks',
};

// Best-effort guess from the resource's own name -- same lenient
// substring-match philosophy used everywhere else in this app (sourceKind
// guessing, etc.). duckdb/postgres/mysql resources have no native
// embedding/completion function, so they only ever get 'python' mode with
// a warehouse_query source, never the SQL pushdown option.
function guessDialect(resourceName: string): string | null {
  const n = resourceName.toLowerCase();
  if (n.includes('snowflake')) return 'snowflake_cortex';
  if (n.includes('bigquery') || /\bbq\b/.test(n)) return 'bigquery';
  if (n.includes('databricks')) return 'databricks';
  return null;
}

export function ContextEngineeringConfigStep({
  componentType,
  component,
  initialAttributes,
  onDone,
  onClose,
  onReviewKnowledgeBase,
}: {
  componentType: string;
  component?: ComponentInstance | null;
  initialAttributes?: Record<string, any>;
  onDone: () => void;
  onClose: () => void;
  onReviewKnowledgeBase?: (component: ComponentInstance) => void;
}) {
  const { currentProject, loadProject } = useProjectStore();
  const isEditing = !!component;
  const seedAttrs = component?.attributes || initialAttributes || {};
  const seedSource: any = seedAttrs.source;
  const seedSteps: any[] = seedAttrs.steps || [];
  const seedChunk = seedSteps.find((s) => s.op === 'chunk') || {};
  const seedClassify = seedSteps.find((s) => s.op === 'classify');
  const seedEmbed = seedSteps.find((s) => s.op === 'embed') || {};
  const seedWrite = seedSteps.find((s) => s.op === 'write_vector_store') || {};

  // Which existing asset to read from, when sourceMode='asset' -- state,
  // not a const derived from props, since this screen now owns picking it
  // (previously forced through SingleComponentWizard's source step before
  // ever reaching here, which hid the warehouse path entirely behind a
  // "pick a CSV first" gate with no way to skip it).
  const [upstreamAssetKey, setUpstreamAssetKey] = useState<string | undefined>(seedAttrs.upstream_asset_key);
  const [showNewAssetForm, setShowNewAssetForm] = useState(false);
  const [newAssetPath, setNewAssetPath] = useState('');
  const [installingAsset, setInstallingAsset] = useState(false);

  const [assetName, setAssetName] = useState<string>(
    seedAttrs.asset_name || component?.label || (upstreamAssetKey ? `${upstreamAssetKey}_kb` : 'knowledge_base'),
  );
  const [assetNameTouched, setAssetNameTouched] = useState<boolean>(!!(seedAttrs.asset_name || component?.label));
  const handleAssetNameChange = (v: string) => { setAssetNameTouched(true); setAssetName(v); };

  // Source: an existing asset (default, simple) vs. querying a warehouse
  // directly. Only known for certain when editing an existing instance;
  // a fresh install has neither yet -- the user picks one on this screen.
  const [sourceMode, setSourceMode] = useState<'asset' | 'warehouse'>(seedSource ? 'warehouse' : 'asset');

  useEffect(() => {
    // assetName's default above only fires once, at mount -- before a
    // source has even been picked on a fresh add (upstreamAssetKey starts
    // undefined now that this screen owns picking it). Re-derive the
    // default once a source lands, same as every other bespoke step's
    // "<source>_<suffix>" convention, but never clobber a name the user
    // already typed themselves.
    if (!assetNameTouched && sourceMode === 'asset' && upstreamAssetKey) {
      setAssetName(`${upstreamAssetKey}_kb`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upstreamAssetKey, sourceMode]);

  const existingAssetSources = useMemo(() => {
    if (!currentProject) return [];
    return currentProject.graph.nodes
      .filter((n) => (n.type === 'asset' || (n.data as any)?.asset_key) && typeof (n.data as any)?.io_output_type === 'string' && (n.data as any).io_output_type.toLowerCase().includes('dataframe'))
      .map((n) => ({
        assetKey: (n.data as any)?.asset_key || n.id,
        label: (n.data as any)?.label || (n.data as any)?.asset_key || n.id,
        componentType: (n.data as any)?.component_type as string | undefined,
      }));
  }, [currentProject]);

  const connectNewAsset = async () => {
    if (!currentProject || !newAssetPath.trim() || installingAsset) return;
    setInstallingAsset(true);
    try {
      const cleaned = newAssetPath.trim().replace(/\/+$/, '');
      const segments = cleaned.split(/[\\/]/).filter(Boolean);
      let base = (segments[segments.length - 1] || 'data').replace(/\.[^./]+$/, '');
      base = base.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'data';
      if (!/^[a-z]/.test(base)) base = `source_${base}`;
      const existingNames = new Set(currentProject.components.map((c) => (c.attributes?.asset_name as string) || c.id));
      let derivedName = base;
      let n = 2;
      while (existingNames.has(derivedName)) { derivedName = `${base}_${n}`; n += 1; }

      const installRes = await fetch(`${API_BASE}/templates/install-via-cli/dataframe_from_csv`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: currentProject.id, config: {}, template_only: true }),
      });
      const installBody = await installRes.json().catch(() => ({} as any));
      if (!installRes.ok) throw new Error(installBody.detail || 'Failed to add source');

      const configRes = await fetch(`${API_BASE}/templates/configure/dataframe_from_csv`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: currentProject.id, config: { name: derivedName, asset_name: derivedName, file_path: newAssetPath.trim() } }),
      });
      const configBody = await configRes.json().catch(() => ({} as any));
      if (!configRes.ok) throw new Error(configBody.detail || 'Failed to configure source');

      notify.success(`Added "${derivedName}" as a source.`);
      await loadProject(currentProject.id);
      setUpstreamAssetKey(derivedName);
      setShowNewAssetForm(false);
      setNewAssetPath('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify.error(`Failed to add source: ${msg}`);
    } finally {
      setInstallingAsset(false);
    }
  };
  const [resources, setResources] = useState<{ name: string }[]>([]);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [resourceKey, setResourceKey] = useState<string>(seedSource?.resource_key || '');
  // A registered Dagster resource (preferred -- reusable across every
  // component that reads this warehouse, and the only path that supports
  // SQL-pushdown mode below) vs. a bare SQLAlchemy connection string via
  // an env var (quicker for a one-off, no resource registration needed --
  // but python-mode only: _run_sql_mode still hard-requires resource_key
  // in the real component, unlike the python-mode ingestion path which
  // now accepts either).
  const [warehouseAuthMode, setWarehouseAuthMode] = useState<'resource' | 'connection_string'>(
    seedSource?.database_url_env_var ? 'connection_string' : 'resource',
  );
  const [databaseUrlEnvVar, setDatabaseUrlEnvVar] = useState<string>(seedSource?.database_url_env_var || '');
  const [sourceSql, setSourceSql] = useState<string>(seedSource?.sql || '');
  const dialectGuess = warehouseAuthMode === 'resource' && resourceKey ? guessDialect(resourceKey) : null;
  const [runMode, setRunMode] = useState<'python' | 'sql'>(seedAttrs.execution_mode === 'sql' ? 'sql' : 'python');
  const [sqlDialect, setSqlDialect] = useState<string>(seedAttrs.sql_dialect || dialectGuess || '');
  const [outputTable, setOutputTable] = useState<string>(seedAttrs.output_table || '');

  const switchWarehouseAuthMode = (mode: 'resource' | 'connection_string') => {
    setWarehouseAuthMode(mode);
    if (mode === 'connection_string') setRunMode('python');
  };

  useEffect(() => {
    if (sourceMode !== 'warehouse' || !currentProject || resources.length > 0 || resourcesLoading) return;
    setResourcesLoading(true);
    fetch(`${API_BASE}/templates/resources/${currentProject.id}`)
      .then((r) => r.json())
      .then((body) => setResources(body.resources || []))
      .catch(() => notify.error('Failed to load registered resources.'))
      .finally(() => setResourcesLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceMode, currentProject]);

  useEffect(() => {
    // Once a resource is picked (and no explicit dialect was seeded),
    // adopt the guess -- but only auto-flip TO pushdown, never away from
    // it, so an explicit user choice of 'python' mode is never overridden.
    if (sourceMode === 'warehouse' && resourceKey && !seedAttrs.sql_dialect) {
      const guess = guessDialect(resourceKey);
      if (guess) {
        setSqlDialect(guess);
        setRunMode((prev) => (prev === 'python' && !seedAttrs.execution_mode ? 'sql' : prev));
      } else {
        setSqlDialect('');
        setRunMode('python');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceKey]);

  const [idColumn, setIdColumn] = useState<string>(seedAttrs.id_column || '');
  const [textColumn, setTextColumn] = useState<string>(seedAttrs.text_column || '');
  const [availableColumns, setAvailableColumns] = useState<string[]>([]);
  const idWasExplicitlySet = !!seedAttrs.id_column;
  const textWasExplicitlySet = !!seedAttrs.text_column;
  const handleColumnsResolved = (cols: string[]) => {
    setAvailableColumns(cols);
    if (!idWasExplicitlySet && !idColumn && cols.length > 0) {
      setIdColumn(cols.find((c) => /^id$|_id$/i.test(c)) || cols[0]);
    }
    if (!textWasExplicitlySet && !textColumn && cols.length > 0) {
      setTextColumn(cols.find((c) => /text|body|content|description/i.test(c)) || cols[cols.length - 1]);
    }
  };
  const [metadataColumns, setMetadataColumns] = useState<string>((seedAttrs.metadata_columns || []).join(', '));

  // Stage 1: chunk (always on)
  const [chunkSize, setChunkSize] = useState<number>(seedChunk.chunk_size ?? 500);
  const [chunkOverlap, setChunkOverlap] = useState<number>(seedChunk.chunk_overlap ?? 50);
  const [preserveSentences, setPreserveSentences] = useState<boolean>(seedChunk.preserve_sentences ?? true);

  // Stage 2: classify (optional). Pushdown mode ignores `mode` entirely
  // (always uses the warehouse's native classify function), so that
  // sub-choice only renders in python mode.
  const [classifyEnabled, setClassifyEnabled] = useState<boolean>(!!seedClassify);
  const [candidateLabels, setCandidateLabels] = useState<string[]>(seedClassify?.candidate_labels || []);
  const [newLabel, setNewLabel] = useState('');
  const [classifyMode, setClassifyMode] = useState<'zero_shot' | 'llm'>(seedClassify?.mode || 'zero_shot');
  const [classifyModel, setClassifyModel] = useState<string>(seedClassify?.model || '');
  const [classifyApiKeyEnvVar, setClassifyApiKeyEnvVar] = useState<string>(seedClassify?.api_key_env_var || 'OPENAI_API_KEY');

  // Stage 3: embed (always on). Pushdown mode ignores `provider` (implied
  // by sql_dialect) -- only `model` matters there.
  const [embedProvider, setEmbedProvider] = useState<string>(seedEmbed.provider || 'sentence_transformers');
  const [embedModel, setEmbedModel] = useState<string>(seedEmbed.model || '');
  const [embedApiKeyEnvVar, setEmbedApiKeyEnvVar] = useState<string>(seedEmbed.api_key_env_var || '');

  // Stage 4: write_vector_store -- python mode only, no SQL equivalent.
  const [storeProvider, setStoreProvider] = useState<string>(seedWrite.provider || 'chromadb');
  const [connectionString, setConnectionString] = useState<string>(seedWrite.connection_string || '');
  const [collectionName, setCollectionName] = useState<string>(seedWrite.collection_name || '');
  const [storeApiKeyEnvVar, setStoreApiKeyEnvVar] = useState<string>(seedWrite.api_key_env_var || '');

  // Real value here is many independent per-source chains landing in the
  // SAME knowledge base -- confirmed against dbt Labs' own jaffle-logistics
  // reference project (five source-specific chunk/classify/embed chains --
  // legal docs, incident reports, CRM notes, call transcripts, support
  // tickets -- unioned into one knowledge_base model). This component has
  // no multi-source concept of its own (exactly one upstream_asset_key OR
  // source per instance), so "many sources, one KB" here means many
  // context_engineering_pipeline instances, each with its own source/
  // columns/chunk/classify config, all write_vector_store-ing into the
  // same provider+connection_string+collection_name -- upsert semantics
  // already merge them, no union step needed. Discovered by scanning this
  // project's OTHER instances of this same component for their
  // write_vector_store step, not tracked as separate state anywhere.
  const knownKnowledgeBases = useMemo(() => {
    if (!currentProject) return [];
    const seen = new Map<string, { key: string; label: string; provider: string; connectionString: string; collectionName: string; sourceCount: number }>();
    for (const c of currentProject.components) {
      if (component && c.id === component.id) continue;
      if (extractComponentId(c.component_type) !== 'context_engineering_pipeline') continue;
      const steps: any[] = c.attributes?.steps || [];
      const write = steps.find((s) => s.op === 'write_vector_store');
      if (!write) continue;
      const provider = write.provider || 'chromadb';
      const connStr = write.connection_string || VECTOR_STORE_PROVIDERS[provider]?.connectionPlaceholder || '';
      const collName = write.collection_name || '';
      if (!collName) continue;
      const key = `${provider}::${connStr}::${collName}`;
      const existing = seen.get(key);
      if (existing) {
        existing.sourceCount += 1;
      } else {
        seen.set(key, { key, label: collName, provider, connectionString: connStr, collectionName: collName, sourceCount: 1 });
      }
    }
    return Array.from(seen.values());
  }, [currentProject, component]);

  const matchedExistingKB = knownKnowledgeBases.find(
    (kb) => kb.provider === storeProvider && kb.connectionString === (connectionString || VECTOR_STORE_PROVIDERS[storeProvider]?.connectionPlaceholder) && kb.collectionName === collectionName,
  );
  const [kbChoice, setKbChoice] = useState<'new' | string>(matchedExistingKB?.key || 'new');
  const joiningExistingKB = kbChoice !== 'new';

  const joinKnowledgeBase = (kb: (typeof knownKnowledgeBases)[number]) => {
    setKbChoice(kb.key);
    setStoreProvider(kb.provider);
    setConnectionString(kb.connectionString);
    setCollectionName(kb.collectionName);
  };
  const startNewKnowledgeBase = () => {
    setKbChoice('new');
  };

  const [saving, setSaving] = useState(false);

  const addLabel = () => {
    const l = newLabel.trim();
    if (l && !candidateLabels.includes(l)) setCandidateLabels((prev) => [...prev, l]);
    setNewLabel('');
  };
  const removeLabel = (l: string) => setCandidateLabels((prev) => prev.filter((x) => x !== l));

  const pushdown = sourceMode === 'warehouse' && runMode === 'sql';

  const canSave = assetName.trim().length > 0
    && (sourceMode === 'asset'
      ? !!upstreamAssetKey
      : sourceSql.trim().length > 0 && (warehouseAuthMode === 'resource' ? !!resourceKey : databaseUrlEnvVar.trim().length > 0))
    && idColumn.trim().length > 0 && textColumn.trim().length > 0
    && (!classifyEnabled || candidateLabels.length > 0)
    && (!pushdown || (!!sqlDialect && outputTable.trim().length > 0));

  const handleSave = async () => {
    if (!currentProject || !canSave || saving) return;
    setSaving(true);
    try {
      const componentId = extractComponentId(componentType) || 'context_engineering_pipeline';

      const steps: any[] = [
        { id: 'chunks', op: 'chunk', chunk_size: chunkSize, chunk_overlap: chunkOverlap, preserve_sentences: preserveSentences },
      ];
      if (classifyEnabled) {
        const classifyStep: any = { id: 'classified', op: 'classify', candidate_labels: candidateLabels };
        if (!pushdown) {
          classifyStep.mode = classifyMode;
          if (classifyMode === 'llm') {
            if (classifyModel.trim()) classifyStep.model = classifyModel.trim();
            if (classifyApiKeyEnvVar.trim()) classifyStep.api_key_env_var = classifyApiKeyEnvVar.trim();
          }
        }
        steps.push(classifyStep);
      }
      const embedStep: any = { id: 'embedded', op: 'embed' };
      if (!pushdown) {
        embedStep.provider = embedProvider;
        if (EMBED_PROVIDERS[embedProvider]?.needsApiKey && embedApiKeyEnvVar.trim()) embedStep.api_key_env_var = embedApiKeyEnvVar.trim();
      }
      if (embedModel.trim()) embedStep.model = embedModel.trim();
      steps.push(embedStep);

      if (!pushdown) {
        const writeStep: any = { id: 'indexed', op: 'write_vector_store', provider: storeProvider };
        if (connectionString.trim()) writeStep.connection_string = connectionString.trim();
        writeStep.collection_name = collectionName.trim() || `${assetName.trim()}_kb`;
        if (VECTOR_STORE_PROVIDERS[storeProvider]?.needsApiKey && storeApiKeyEnvVar.trim()) writeStep.api_key_env_var = storeApiKeyEnvVar.trim();
        steps.push(writeStep);
      }

      const config: Record<string, any> = {
        name: assetName.trim(),
        asset_name: assetName.trim(),
        id_column: idColumn.trim(),
        text_column: textColumn.trim(),
        steps,
      };
      if (sourceMode === 'asset') {
        config.upstream_asset_key = upstreamAssetKey;
      } else {
        config.source = {
          kind: 'warehouse_query',
          sql: sourceSql.trim(),
          ...(warehouseAuthMode === 'resource' ? { resource_key: resourceKey } : { database_url_env_var: databaseUrlEnvVar.trim() }),
        };
        if (pushdown) {
          config.execution_mode = 'sql';
          config.sql_dialect = sqlDialect;
          config.output_table = outputTable.trim();
        }
      }
      const metaCols = metadataColumns.split(',').map((s) => s.trim()).filter(Boolean);
      if (metaCols.length > 0) config.metadata_columns = metaCols;

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
        console.error('[ContextEngineeringConfigStep] Failed to regenerate lineage:', e);
      }

      if (body.assets_regenerated) {
        notify.success(isEditing ? `Updated "${assetName.trim()}".` : pushdown ? `Added "${assetName.trim()}" — running natively in the warehouse.` : `Added "${assetName.trim()}" — building a knowledge base in ${storeProvider}.`);
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
            <Layers className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">{isEditing ? 'Edit knowledge base' : 'Configure knowledge base'}</h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>

        <div className="flex-1 overflow-hidden grid grid-cols-1 sm:grid-cols-[1fr_420px]">
          {sourceMode === 'asset' && !upstreamAssetKey ? (
            <div className="overflow-y-auto px-6 py-4 space-y-3 bg-gray-50">
              {existingAssetSources.length > 0 && (
                <div className="space-y-1.5">
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Existing sources</h3>
                  {existingAssetSources.map((s) => (
                    <button
                      key={s.assetKey}
                      onClick={() => setUpstreamAssetKey(s.assetKey)}
                      className="w-full flex items-center justify-between px-3 py-2 text-left border border-gray-200 rounded-md hover:border-blue-300 hover:bg-blue-50/40 bg-white"
                    >
                      <div>
                        <div className="text-sm font-medium text-gray-900">{s.label}</div>
                        {s.componentType && <div className="text-xs text-gray-400 font-mono">{s.componentType}</div>}
                      </div>
                    </button>
                  ))}
                </div>
              )}
              <div className="space-y-1.5">
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Connect a new source</h3>
                {!showNewAssetForm ? (
                  <button
                    onClick={() => setShowNewAssetForm(true)}
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-left bg-gradient-to-br from-violet-50 to-blue-50 border border-violet-200 rounded-md hover:border-violet-400"
                  >
                    <FileSpreadsheet className="w-4 h-4 text-violet-600 flex-shrink-0" />
                    <div>
                      <div className="text-sm font-medium text-gray-900">A CSV / data file</div>
                      <div className="text-xs text-gray-500">Each ROW becomes one thing to chunk and index</div>
                    </div>
                  </button>
                ) : (
                  <div className="border border-gray-200 rounded-md p-3 space-y-2.5 bg-white">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Path or URL to the CSV file</label>
                      <input
                        type="text"
                        value={newAssetPath}
                        onChange={(e) => setNewAssetPath(e.target.value)}
                        placeholder="s3://my-bucket/support-tickets.csv"
                        className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                      />
                    </div>
                    <div className="flex justify-end gap-2 pt-1">
                      <button onClick={() => { setShowNewAssetForm(false); setNewAssetPath(''); }} className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded-md">
                        Cancel
                      </button>
                      <button
                        onClick={connectNewAsset}
                        disabled={installingAsset || !newAssetPath.trim()}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50"
                      >
                        {installingAsset ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                        Use this source
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : sourceMode === 'asset' ? (
            <TextSamplePreviewPanel upstreamAssetKey={upstreamAssetKey} onColumnsChange={handleColumnsResolved} />
          ) : (
            <div className="overflow-y-auto px-6 py-4 space-y-3 bg-gray-50">
              <p className="text-[11px] font-medium text-gray-500">No live preview for a raw SQL source — double-check column names against your query.</p>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Connect via</label>
                <div className="flex gap-2 mb-1">
                  <button
                    onClick={() => switchWarehouseAuthMode('resource')}
                    className={`flex-1 px-2.5 py-1.5 text-xs rounded-md border ${warehouseAuthMode === 'resource' ? 'bg-primary text-primary-foreground border-primary' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                  >
                    A registered resource
                  </button>
                  <button
                    onClick={() => switchWarehouseAuthMode('connection_string')}
                    className={`flex-1 px-2.5 py-1.5 text-xs rounded-md border ${warehouseAuthMode === 'connection_string' ? 'bg-primary text-primary-foreground border-primary' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                  >
                    A connection string
                  </button>
                </div>
                <p className="text-[10px] text-gray-400 mb-1.5">
                  {warehouseAuthMode === 'resource'
                    ? 'Preferred — reusable by every other component that reads this warehouse, and the only path that supports running natively in the warehouse below.'
                    : "Quicker for a one-off, no resource registration needed — but always pulls into Python here; there's no pushdown mode without a registered resource."}
                </p>
              </div>

              {warehouseAuthMode === 'resource' ? (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Resource</label>
                  {resourcesLoading ? (
                    <div className="flex items-center gap-2 text-xs text-gray-400"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading registered resources…</div>
                  ) : resources.length === 0 ? (
                    <p className="text-xs text-amber-600">No resources registered in this project yet — add one (e.g. a Snowflake or DuckDB resource), or use a connection string instead.</p>
                  ) : (
                    <select
                      value={resourceKey}
                      onChange={(e) => setResourceKey(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white font-mono"
                    >
                      <option value="" disabled>pick a resource</option>
                      {resources.map((r) => (<option key={r.name} value={r.name}>{r.name}</option>))}
                    </select>
                  )}
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Connection string env var</label>
                  <input
                    type="text"
                    value={databaseUrlEnvVar}
                    onChange={(e) => setDatabaseUrlEnvVar(e.target.value)}
                    placeholder="DATABASE_URL"
                    className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                  />
                  <p className="text-[10px] text-gray-400 mt-0.5">Env var holding a bare SQLAlchemy URL, e.g. <span className="font-mono">postgresql://user:pass@host/db</span> — read at runtime, never stored here.</p>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">SQL query</label>
                <textarea
                  value={sourceSql}
                  onChange={(e) => setSourceSql(e.target.value)}
                  rows={8}
                  placeholder={`SELECT ticket_id, body, customer_id\nFROM support_tickets\nWHERE created_at > CURRENT_DATE - 7`}
                  className="w-full px-2.5 py-1.5 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
                <p className="text-[10px] text-gray-400 mt-0.5">Must return the ID/text/metadata columns you reference below.</p>
              </div>
            </div>
          )}

          <div className="space-y-5 overflow-y-auto px-6 py-4">
            <div className="bg-blue-50 border border-blue-100 rounded-md p-3 text-xs text-blue-900 space-y-1">
              <p className="font-medium">How this works</p>
              <p>Splits each row's text into chunks, optionally tags each chunk with a category (helps search rank relevance over boilerplate length), embeds every chunk, and writes it all into a searchable vector store — the knowledge base a RAG pipeline queries against.</p>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Where does the text come from?</label>
              <div className="flex gap-2">
                <button
                  onClick={() => setSourceMode('asset')}
                  disabled={isEditing}
                  className={`flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border disabled:opacity-50 disabled:cursor-not-allowed ${sourceMode === 'asset' ? 'bg-primary text-primary-foreground border-primary' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" /> An asset in this project
                </button>
                <button
                  onClick={() => setSourceMode('warehouse')}
                  disabled={isEditing}
                  className={`flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md border disabled:opacity-50 disabled:cursor-not-allowed ${sourceMode === 'warehouse' ? 'bg-primary text-primary-foreground border-primary' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                >
                  <Database className="w-3.5 h-3.5" /> Query a warehouse directly
                </button>
              </div>
              {isEditing && <p className="text-[10px] text-gray-400 mt-0.5">Source can't be changed after creation.</p>}
              {!isEditing && sourceMode === 'asset' && upstreamAssetKey && (
                <p className="text-[10px] text-gray-500 mt-0.5">
                  Reading from <span className="font-mono text-gray-700">{upstreamAssetKey}</span> —{' '}
                  <button onClick={() => setUpstreamAssetKey(undefined)} className="text-blue-600 hover:underline">change</button>
                </p>
              )}
            </div>

            {sourceMode === 'warehouse' && resourceKey && (
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">How should this run?</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setRunMode('python')}
                    className={`flex-1 px-2.5 py-1.5 text-xs rounded-md border ${runMode === 'python' ? 'bg-primary text-primary-foreground border-primary' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                  >
                    Pull into Python here
                  </button>
                  <button
                    onClick={() => dialectGuess && setRunMode('sql')}
                    disabled={!dialectGuess}
                    className={`flex-1 px-2.5 py-1.5 text-xs rounded-md border disabled:opacity-40 disabled:cursor-not-allowed ${runMode === 'sql' ? 'bg-primary text-primary-foreground border-primary' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                  >
                    Run natively in the warehouse
                  </button>
                </div>
                <p className="text-[10px] text-gray-400 mt-0.5">
                  {dialectGuess
                    ? 'Data never leaves the database — the whole chunk/classify/embed chain runs as one query.'
                    : "This resource doesn't look like Snowflake/BigQuery/Databricks, so pushdown isn't available — runs in Python instead."}
                </p>
                {pushdown && (
                  <div className="grid grid-cols-2 gap-3 mt-2">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Dialect</label>
                      <select
                        value={sqlDialect}
                        onChange={(e) => setSqlDialect(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                      >
                        {Object.entries(SQL_DIALECTS).map(([id, label]) => (<option key={id} value={id}>{label}</option>))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Output table</label>
                      <input
                        type="text"
                        value={outputTable}
                        onChange={(e) => setOutputTable(e.target.value)}
                        placeholder="analytics.support_kb"
                        className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Asset name</label>
              <input
                type="text"
                value={assetName}
                onChange={(e) => handleAssetNameChange(e.target.value)}
                disabled={isEditing}
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono disabled:bg-gray-50 disabled:text-gray-400"
              />
              {isEditing && <p className="text-[10px] text-gray-400 mt-0.5">Can't be renamed after creation.</p>}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">ID column</label>
                {sourceMode === 'asset' && availableColumns.length > 0 ? (
                  <select
                    value={availableColumns.includes(idColumn) ? idColumn : ''}
                    onChange={(e) => setIdColumn(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white font-mono"
                  >
                    {!availableColumns.includes(idColumn) && <option value="" disabled>{idColumn || 'pick a column'}</option>}
                    {availableColumns.map((c) => (<option key={c} value={c}>{c}</option>))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={idColumn}
                    onChange={(e) => setIdColumn(e.target.value)}
                    placeholder="ticket_id"
                    className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                  />
                )}
                <p className="text-[10px] text-gray-400 mt-0.5">Threaded onto every chunk as a citation back to the source row.</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Text column</label>
                {sourceMode === 'asset' && availableColumns.length > 0 ? (
                  <select
                    value={availableColumns.includes(textColumn) ? textColumn : ''}
                    onChange={(e) => setTextColumn(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white font-mono"
                  >
                    {!availableColumns.includes(textColumn) && <option value="" disabled>{textColumn || 'pick a column'}</option>}
                    {availableColumns.map((c) => (<option key={c} value={c}>{c}</option>))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={textColumn}
                    onChange={(e) => setTextColumn(e.target.value)}
                    placeholder="body"
                    className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                  />
                )}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Metadata columns <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={metadataColumns}
                onChange={(e) => setMetadataColumns(e.target.value)}
                placeholder="customer_id, created_at"
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
              <p className="text-[10px] text-gray-400 mt-0.5">Comma-separated. Carried onto every chunk for filtered search later.</p>
            </div>

            <div className="border-t border-gray-100 pt-4">
              <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider mb-2">1. Chunking</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Chunk size (characters)</label>
                  <input
                    type="number"
                    min={1}
                    value={chunkSize}
                    onChange={(e) => setChunkSize(Math.max(1, Number(e.target.value) || 1))}
                    className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Overlap</label>
                  <input
                    type="number"
                    min={0}
                    value={chunkOverlap}
                    onChange={(e) => setChunkOverlap(Math.max(0, Number(e.target.value) || 0))}
                    className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                  />
                </div>
              </div>
              {!pushdown && (
                <label className="flex items-center gap-2 text-xs text-gray-700 mt-2">
                  <input type="checkbox" checked={preserveSentences} onChange={(e) => setPreserveSentences(e.target.checked)} />
                  Snap chunk boundaries to nearby sentence ends
                </label>
              )}
            </div>

            <div className="border-t border-gray-100 pt-4">
              <label className="flex items-center gap-2 mb-2">
                <input type="checkbox" checked={classifyEnabled} onChange={(e) => setClassifyEnabled(e.target.checked)} />
                <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">2. Classify chunks (optional)</h3>
              </label>
              {classifyEnabled && (
                <div className="space-y-2.5 pl-6">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Categories</label>
                    <div className="flex flex-wrap gap-1.5 mb-1.5">
                      {candidateLabels.map((l) => (
                        <span key={l} className="inline-flex items-center gap-1 px-1.5 py-1 text-xs bg-violet-50 text-violet-700 border border-violet-100 rounded-md font-mono">
                          {l}
                          <button onClick={() => removeLabel(l)} className="text-violet-400 hover:text-violet-700 flex-shrink-0">
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      ))}
                      {candidateLabels.length === 0 && <span className="text-xs text-gray-400 italic py-1">No categories yet.</span>}
                    </div>
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={newLabel}
                        onChange={(e) => setNewLabel(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLabel(); } }}
                        placeholder="add a category"
                        className="flex-1 px-2.5 py-1.5 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                      />
                      <button onClick={addLabel} disabled={!newLabel.trim()} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50">
                        <Plus className="w-3.5 h-3.5" /> Add
                      </button>
                    </div>
                    {pushdown && <p className="text-[10px] text-gray-400 mt-1">Classified via the warehouse's own native function — no model/API key choice here.</p>}
                  </div>
                  {!pushdown && (
                    <>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setClassifyMode('zero_shot')}
                          className={`flex-1 px-2.5 py-1.5 text-xs rounded-md border ${classifyMode === 'zero_shot' ? 'bg-primary text-primary-foreground border-primary' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                        >
                          Zero-shot (local, free)
                        </button>
                        <button
                          onClick={() => setClassifyMode('llm')}
                          className={`flex-1 px-2.5 py-1.5 text-xs rounded-md border ${classifyMode === 'llm' ? 'bg-primary text-primary-foreground border-primary' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                        >
                          LLM judgment
                        </button>
                      </div>
                      {classifyMode === 'llm' && (
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">Model</label>
                            <input
                              type="text"
                              value={classifyModel}
                              onChange={(e) => setClassifyModel(e.target.value)}
                              placeholder="gpt-4o-mini"
                              className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">API key env var</label>
                            <input
                              type="text"
                              value={classifyApiKeyEnvVar}
                              onChange={(e) => setClassifyApiKeyEnvVar(e.target.value)}
                              className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                            />
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="border-t border-gray-100 pt-4">
              <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider mb-2">3. Embed</h3>
              <div className="space-y-2.5">
                {!pushdown && (
                  <select
                    value={embedProvider}
                    onChange={(e) => { setEmbedProvider(e.target.value); setEmbedModel(''); }}
                    className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                  >
                    {Object.entries(EMBED_PROVIDERS).map(([id, p]) => (<option key={id} value={id}>{p.label}</option>))}
                  </select>
                )}
                {pushdown && <p className="text-[10px] text-gray-400">Embedded via the warehouse's own native function — no provider choice here.</p>}
                <div className={`grid ${!pushdown && EMBED_PROVIDERS[embedProvider]?.needsApiKey ? 'grid-cols-2' : 'grid-cols-1'} gap-3`}>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Model {pushdown && <span className="text-gray-400 font-normal">(optional — uses the dialect's default)</span>}</label>
                    <input
                      type="text"
                      value={embedModel}
                      onChange={(e) => setEmbedModel(e.target.value)}
                      placeholder={!pushdown ? EMBED_PROVIDERS[embedProvider]?.modelDefault : undefined}
                      className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                    />
                  </div>
                  {!pushdown && EMBED_PROVIDERS[embedProvider]?.needsApiKey && (
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">API key env var</label>
                      <input
                        type="text"
                        value={embedApiKeyEnvVar}
                        onChange={(e) => setEmbedApiKeyEnvVar(e.target.value)}
                        placeholder={EMBED_PROVIDERS[embedProvider]?.apiKeyDefault}
                        className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {!pushdown && (
              <div className="border-t border-gray-100 pt-4">
                <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider mb-2">4. Write to vector store</h3>

                {knownKnowledgeBases.length > 0 && !isEditing && (
                  <div className="mb-3 space-y-1.5">
                    <p className="text-[11px] text-gray-500">
                      The real value is combining sources — each one gets its own chunk/classify config above, but they can all land in the same searchable knowledge base (upsert, not overwrite — nothing here gets clobbered by adding another source).
                    </p>
                    <div className="space-y-1">
                      {knownKnowledgeBases.map((kb) => (
                        <button
                          key={kb.key}
                          onClick={() => joinKnowledgeBase(kb)}
                          className={`w-full flex items-center justify-between px-2.5 py-2 text-left border rounded-md text-xs ${kbChoice === kb.key ? 'border-primary bg-blue-50/60' : 'border-gray-200 hover:border-blue-300 hover:bg-blue-50/40'}`}
                        >
                          <div>
                            <div className="font-medium text-gray-900">Add to "{kb.label}"</div>
                            <div className="text-gray-400 font-mono">{VECTOR_STORE_PROVIDERS[kb.provider]?.label || kb.provider} — {kb.sourceCount} source{kb.sourceCount === 1 ? '' : 's'} already in it</div>
                          </div>
                        </button>
                      ))}
                      <button
                        onClick={startNewKnowledgeBase}
                        className={`w-full flex items-center px-2.5 py-2 text-left border rounded-md text-xs ${kbChoice === 'new' ? 'border-primary bg-blue-50/60' : 'border-gray-200 hover:border-blue-300 hover:bg-blue-50/40'}`}
                      >
                        <div className="font-medium text-gray-900">Start a new knowledge base</div>
                      </button>
                    </div>
                  </div>
                )}

                {joiningExistingKB && !isEditing ? (
                  <p className="text-xs text-gray-500">
                    Joining <span className="font-mono text-gray-700">{collectionName}</span> ({VECTOR_STORE_PROVIDERS[storeProvider]?.label || storeProvider} @ <span className="font-mono">{connectionString}</span>) — provider, storage, and collection are locked to match the sources already in it.
                  </p>
                ) : (
                  <div className="space-y-2.5">
                    <select
                      value={storeProvider}
                      onChange={(e) => { setStoreProvider(e.target.value); setConnectionString(''); }}
                      className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                    >
                      {Object.entries(VECTOR_STORE_PROVIDERS).map(([id, p]) => (<option key={id} value={id}>{p.label}</option>))}
                    </select>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">{VECTOR_STORE_PROVIDERS[storeProvider]?.connectionLabel}</label>
                        <input
                          type="text"
                          value={connectionString}
                          onChange={(e) => setConnectionString(e.target.value)}
                          placeholder={VECTOR_STORE_PROVIDERS[storeProvider]?.connectionPlaceholder}
                          className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">Collection name</label>
                        <input
                          type="text"
                          value={collectionName}
                          onChange={(e) => setCollectionName(e.target.value)}
                          placeholder={`${assetName.trim() || 'context'}_kb`}
                          className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                        />
                      </div>
                    </div>
                    {VECTOR_STORE_PROVIDERS[storeProvider]?.needsApiKey && (
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">API key env var</label>
                        <input
                          type="text"
                          value={storeApiKeyEnvVar}
                          onChange={(e) => setStoreApiKeyEnvVar(e.target.value)}
                          placeholder={VECTOR_STORE_PROVIDERS[storeProvider]?.apiKeyDefault}
                          className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            {pushdown && (
              <div className="border-t border-gray-100 pt-4">
                <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider mb-1">4. Query it back</h3>
                <p className="text-xs text-gray-500">No separate vector store — the result lands in <span className="font-mono text-gray-700">{outputTable || 'your output table'}</span>. Point rag_pipeline's retrieve/hybrid_search ops at that table directly.</p>
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-200">
          {isEditing && onReviewKnowledgeBase && !pushdown && (
            <button
              onClick={() => onReviewKnowledgeBase(component!)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-emerald-700 border border-emerald-200 bg-emerald-50 rounded-md hover:bg-emerald-100 mr-auto"
            >
              <Layers className="w-3.5 h-3.5" /> Review chunks
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
            {saving ? 'Saving…' : isEditing ? 'Save changes' : 'Build knowledge base'}
          </button>
        </div>
      </div>
    </div>
  );
}
