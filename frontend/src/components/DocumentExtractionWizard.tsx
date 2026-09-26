import { useMemo, useState } from 'react';
import {
  X, ArrowLeft, ArrowRight, Loader2, FileText, ScanText, Receipt, FileSearch, Layers, Terminal,
} from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { notify } from './Notifications';
import { API_BASE } from '@/services/api';

// Same lenient substring check as ComponentConfigModal's isDataFrameType --
// community components phrase x-dagster-io.outputs.type by hand (not a
// strict enum), so an exact "dataframe" match silently under-matches.
function isDataFrameType(t: unknown): boolean {
  return typeof t === 'string' && t.toLowerCase().includes('dataframe');
}

// Auto-derive a file_lister asset name from a raw path/glob -- only
// needed as a fallback for the extractor ids that still require a real
// upstream_asset_key (everything except structured_document_extractor,
// which reads a path directly and doesn't need a named asset at all).
// Takes the last non-glob path segment, strips a file extension if the
// path pointed at one file rather than a directory, and dedupes against
// names already in use.
function deriveSourceName(path: string, existingNames: Set<string>): string {
  const cleaned = path.replace(/[*?[\]{}].*$/, '').replace(/\/+$/, '');
  const segments = cleaned.split(/[\\/]/).filter(Boolean);
  let base = (segments[segments.length - 1] || 'documents').replace(/\.[^./]+$/, '');
  base = base.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'documents';
  if (!/^[a-z]/.test(base)) base = `source_${base}`;
  if (!existingNames.has(base)) return base;
  let n = 2;
  while (existingNames.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

// The 24 real "extraction"/"ocr"/"document" tagged components in the
// manifest's "ai" category (verified against the live manifest, not
// guessed) grouped by what they're actually for. Each one already
// requires `upstream_asset_key` + a file-path column (per their real
// schemas) -- ComponentConfigModal's own column picker handles the
// specific column field once opened, so this wizard only needs to seed
// upstream_asset_key, not guess every extractor's exact field name.
//
// "Structured business documents" installs ONE component
// (structured_document_extractor) for every option in that group, not a
// different component per option -- confirmed by diffing the source
// directly: invoice_extractor/receipt_extractor/bank_statement_extractor/
// etc. were the SAME component with a different default `output_fields`
// value. structured_document_extractor consolidates them with a
// `document_type` field that picks the same preset; `documentType` below
// is seeded as that field's initial value.
interface ExtractorOption {
  id: string;
  label: string;
  documentType?: string;
}
interface ExtractorGroup {
  label: string;
  icon: any;
  options: ExtractorOption[];
}
const EXTRACTOR_GROUPS: ExtractorGroup[] = [
  {
    label: 'Generic OCR / text extraction',
    icon: ScanText,
    options: [
      { id: 'ocr_extractor', label: 'OCR (Tesseract)' },
      { id: 'document_text_extractor', label: 'Document text extractor' },
      { id: 'document_ai_extractor', label: 'Cloud Document AI (forms, tables, entities)' },
      { id: 'vision_api_asset', label: 'Cloud Vision API (OCR + image analysis)' },
    ],
  },
  {
    label: 'Structured business documents',
    icon: Receipt,
    options: [
      { id: 'structured_document_extractor', documentType: 'invoice', label: 'Invoice' },
      { id: 'structured_document_extractor', documentType: 'receipt', label: 'Receipt' },
      { id: 'structured_document_extractor', documentType: 'bank_statement', label: 'Bank statement' },
      { id: 'structured_document_extractor', documentType: 'expense_report', label: 'Expense report' },
      { id: 'structured_document_extractor', documentType: 'purchase_order', label: 'Purchase order' },
      { id: 'structured_document_extractor', documentType: 'shipping_label', label: 'Shipping label' },
      { id: 'structured_document_extractor', documentType: 'contract', label: 'Contract' },
      { id: 'structured_document_extractor', documentType: 'legal_document', label: 'Legal document' },
      { id: 'structured_document_extractor', documentType: 'insurance_claim', label: 'Insurance claim' },
      { id: 'structured_document_extractor', documentType: 'medical_record', label: 'Medical record' },
      { id: 'structured_document_extractor', documentType: 'resume', label: 'Resume' },
      { id: 'structured_document_extractor', documentType: 'job_posting', label: 'Job posting' },
      { id: 'structured_document_extractor', documentType: 'scientific_paper', label: 'Scientific paper' },
      { id: 'structured_document_extractor', documentType: 'custom', label: 'Something else (custom fields)' },
    ],
  },
  {
    label: 'Layout & structure',
    icon: Layers,
    options: [
      { id: 'document_layout_analyzer', label: 'Layout analyzer (text blocks, tables, figures)' },
      { id: 'document_chunker', label: 'Chunker (for embeddings/RAG)' },
      { id: 'document_summarizer', label: 'Summarizer' },
    ],
  },
  {
    label: 'Other structured extraction',
    icon: FileSearch,
    options: [
      { id: 'instructor_extractor', label: 'Pydantic model extractor (Instructor)' },
      { id: 'litellm_structured_output', label: 'Structured JSON output (any LiteLLM model)' },
      { id: 'image_llm_extractor', label: 'Vision-LLM field extractor (GPT-4o/Claude/Gemini)' },
      { id: 'entity_extractor', label: 'Named entity extractor' },
    ],
  },
];

export function DocumentExtractionWizard({
  onClose,
  onOpenComponentConfig,
}: {
  onClose: () => void;
  onOpenComponentConfig: (componentType: string, initialAttributes?: Record<string, any>, sourcePath?: string) => void;
}) {
  const { currentProject, loadProject } = useProjectStore();
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  // The raw fsspec path/glob behind selectedSource -- carried alongside the
  // asset key (not looked up again downstream) so the config step can show
  // a real document preview via GET /assets/{project}/sample-files before
  // the source asset has ever been materialized. Existing sources resolve
  // it from the matching component's own `path` attribute; a freshly-added
  // source already has it in hand from the "connect a new source" form.
  const [selectedSourcePath, setSelectedSourcePath] = useState<string | null>(null);
  const [showNewSourceForm, setShowNewSourceForm] = useState(false);
  const [newSourcePath, setNewSourcePath] = useState('');
  const [newSourceDownload, setNewSourceDownload] = useState(true);

  const existingSources = useMemo(() => {
    if (!currentProject) return [];
    return currentProject.graph.nodes
      .filter((n) => (n.type === 'asset' || (n.data as any)?.asset_key) && isDataFrameType((n.data as any)?.io_output_type))
      .map((n) => {
        const assetKey = (n.data as any)?.asset_key || n.id;
        // Resolve the raw path from the underlying component instance, if
        // it has one (file_lister and similar source components) -- not
        // every source shape will (e.g. a dbt model), so this can be null.
        const comp = currentProject.components.find((c) => (c.attributes?.asset_name || c.id) === assetKey);
        return {
          assetKey,
          label: (n.data as any)?.label || assetKey,
          componentType: (n.data as any)?.component_type,
          path: (comp?.attributes?.path as string | undefined) || undefined,
        };
      });
  }, [currentProject]);

  // No install call here anymore -- just capturing the raw path. Whether a
  // real file_lister asset needs to exist for it (and what name it gets)
  // is decided in pickExtractor once we know which extractor is chosen:
  // structured_document_extractor reads a path directly and needs neither;
  // everything else still requires a real upstream_asset_key, so THAT path
  // lazily installs file_lister with an auto-derived name.
  const confirmNewSourcePath = () => {
    if (!newSourcePath.trim()) return;
    setSelectedSource(null);
    setSelectedSourcePath(newSourcePath.trim());
    setShowNewSourceForm(false);
    setStep(2);
  };

  const [installingExtractorId, setInstallingExtractorId] = useState<string | null>(null);
  // Set when install-via-cli reports missing_system_deps (a binary like
  // tesseract/ffmpeg that pip/uv can never install) -- holds what to do
  // once the user confirms or skips, since the component itself is
  // already installed either way at this point.
  const [pendingSystemDeps, setPendingSystemDeps] = useState<{
    formulas: string[];
    componentType: string;
    initialAttributes?: Record<string, any>;
  } | null>(null);
  const [installingBrewDeps, setInstallingBrewDeps] = useState(false);

  const finishPick = (componentType: string, initialAttributes?: Record<string, any>) => {
    onOpenComponentConfig(componentType, initialAttributes, selectedSourcePath || undefined);
    onClose();
  };

  const pickExtractor = async (opt: ExtractorOption) => {
    const optKey = `${opt.id}:${opt.documentType ?? ''}`;
    if (!currentProject || (!selectedSource && !selectedSourcePath) || installingExtractorId) return;
    setInstallingExtractorId(optKey);
    try {
      // structured_document_extractor reads a path directly (no separate
      // file_lister asset needed); every other extractor id still requires
      // a real upstream_asset_key, so lazily install file_lister here --
      // only now that we know it's actually needed -- with a name derived
      // from the path instead of asking the user to make one up.
      let upstreamAssetKey = selectedSource;
      if (opt.id !== 'structured_document_extractor' && !upstreamAssetKey) {
        const existingNames = new Set(
          currentProject.components.map((c) => (c.attributes?.asset_name as string) || c.id),
        );
        const derivedName = deriveSourceName(selectedSourcePath!, existingNames);
        const listerRes = await fetch(`${API_BASE}/templates/install-via-cli/file_lister`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: currentProject.id,
            config: {},
            attributes: { asset_name: derivedName, path: selectedSourcePath, download: newSourceDownload },
          }),
        });
        const listerBody = await listerRes.json().catch(() => ({} as any));
        if (!listerRes.ok) throw new Error(listerBody.detail || 'Failed to add source');
        upstreamAssetKey = derivedName;
        setSelectedSource(derivedName);
        // Without this, currentProject.components stays stale -- the
        // config step's preview resolves the new file_lister's path by
        // looking it up there, and would silently find nothing.
        await loadProject(currentProject.id);
      }

      const res = await fetch(`${API_BASE}/templates/install-via-cli/${opt.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: currentProject.id, config: {}, template_only: true }),
      });
      const body = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(body.detail || 'Install failed');
      const initialAttributes = {
        ...(upstreamAssetKey ? { upstream_asset_key: upstreamAssetKey } : { path: selectedSourcePath }),
        ...(opt.documentType ? { document_type: opt.documentType } : {}),
      };
      const missing: string[] = body.missing_system_deps || [];
      if (missing.length > 0) {
        // Component is already installed at this point (pip deps and
        // all) -- this is purely "it also needs a system binary to
        // actually run", confirmed before Designer shells out to brew.
        setPendingSystemDeps({ formulas: missing, componentType: body.component_type, initialAttributes });
      } else {
        finishPick(body.component_type, initialAttributes);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify.error(`Failed to add extractor: ${msg}`);
    } finally {
      setInstallingExtractorId(null);
    }
  };

  const confirmInstallBrewDeps = async () => {
    if (!pendingSystemDeps) return;
    setInstallingBrewDeps(true);
    try {
      const res = await fetch(`${API_BASE}/templates/install-system-deps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ formulas: pendingSystemDeps.formulas }),
      });
      const body = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(body.detail || 'brew install failed');
      notify.success(`Installed ${pendingSystemDeps.formulas.join(', ')} via Homebrew.`);
      finishPick(pendingSystemDeps.componentType, pendingSystemDeps.initialAttributes);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify.error(`Homebrew install failed: ${msg}`);
    } finally {
      setInstallingBrewDeps(false);
    }
  };

  const skipBrewDeps = () => {
    if (!pendingSystemDeps) return;
    finishPick(pendingSystemDeps.componentType, pendingSystemDeps.initialAttributes);
  };

  if (pendingSystemDeps) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg shadow-xl w-full max-w-md flex flex-col">
          <div className="flex items-center gap-2 px-6 py-4 border-b border-gray-200">
            <Terminal className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">Also needs a system tool</h2>
          </div>
          <div className="px-6 py-4 space-y-3">
            <p className="text-sm text-gray-600">
              This component is installed, but it also needs{' '}
              {pendingSystemDeps.formulas.map((f) => (
                <code key={f} className="px-1 py-0.5 bg-gray-100 rounded text-xs mr-1">{f}</code>
              ))}
              on your system to actually run — not something pip/uv can install on its own.
            </p>
            <p className="text-xs text-gray-500">
              Install via Homebrew now, or skip and do it yourself later
              (<code className="bg-gray-100 px-1 rounded">brew install {pendingSystemDeps.formulas.join(' ')}</code>).
              Either way the component is already configured and ready.
            </p>
          </div>
          <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-200">
            <button
              onClick={skipBrewDeps}
              disabled={installingBrewDeps}
              className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-md disabled:opacity-50"
            >
              Skip for now
            </button>
            <button
              onClick={confirmInstallBrewDeps}
              disabled={installingBrewDeps}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50"
            >
              {installingBrewDeps ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Terminal className="w-3.5 h-3.5" />}
              {installingBrewDeps ? 'Installing…' : 'Install with Homebrew'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">
              {step === 1 ? 'Document Extraction — where are your documents?' : 'What do you want to extract?'}
            </h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {step === 1 ? (
            <>
              <p className="text-sm text-gray-500">
                Extraction components read a batch of files from an upstream source — pick one already
                in the graph, or connect a new one (a bucket, folder, or any fsspec location).
              </p>

              {existingSources.length > 0 && (
                <div className="space-y-1.5">
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Existing sources</h3>
                  {existingSources.map((s) => (
                    <button
                      key={s.assetKey}
                      onClick={() => { setSelectedSource(s.assetKey); setSelectedSourcePath(s.path || null); setStep(2); }}
                      className="w-full flex items-center justify-between px-3 py-2 text-left border border-gray-200 rounded-md hover:border-blue-300 hover:bg-blue-50/40"
                    >
                      <div>
                        <div className="text-sm font-medium text-gray-900">{s.label}</div>
                        {s.componentType && <div className="text-xs text-gray-400 font-mono">{s.componentType}</div>}
                      </div>
                      <ArrowRight className="w-4 h-4 text-gray-300" />
                    </button>
                  ))}
                </div>
              )}

              <div className="space-y-1.5">
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Connect a new source</h3>
                {!showNewSourceForm ? (
                  <button
                    onClick={() => setShowNewSourceForm(true)}
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-left bg-gradient-to-br from-violet-50 to-blue-50 border border-violet-200 rounded-md hover:border-violet-400"
                  >
                    <FileSearch className="w-4 h-4 text-violet-600" />
                    <div>
                      <div className="text-sm font-medium text-gray-900">Point at a bucket or folder</div>
                      <div className="text-xs text-gray-500">S3, GCS, ADLS, or a local path — matches a glob pattern</div>
                    </div>
                  </button>
                ) : (
                  <div className="border border-gray-200 rounded-md p-3 space-y-2.5">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Path / glob</label>
                      <input
                        type="text"
                        value={newSourcePath}
                        onChange={(e) => setNewSourcePath(e.target.value)}
                        placeholder="s3://my-bucket/invoices/**/*.pdf"
                        className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                      />
                      <p className="text-[11px] text-gray-400 mt-0.5">
                        Also works with gs://, abfss:// / abfs:// / az://, or a plain local path.
                      </p>
                    </div>
                    <label className="flex items-center gap-1.5 text-xs text-gray-600">
                      <input
                        type="checkbox"
                        checked={newSourceDownload}
                        onChange={(e) => setNewSourceDownload(e.target.checked)}
                      />
                      Download files to a local cache (needed for most extractors to open them)
                    </label>
                    <div className="flex justify-end gap-2 pt-1">
                      <button
                        onClick={() => setShowNewSourceForm(false)}
                        className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded-md"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={confirmNewSourcePath}
                        disabled={!newSourcePath.trim()}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50"
                      >
                        <ArrowRight className="w-3.5 h-3.5" />
                        Use this path
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <button
                onClick={() => setStep(1)}
                className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
              >
                <ArrowLeft className="w-3.5 h-3.5" /> Back to source
              </button>
              <p className="text-sm text-gray-500">
                Reading from <span className="font-mono text-gray-700">{selectedSource || selectedSourcePath}</span> — pick what to extract.
                You'll configure the specific fields next.
              </p>
              <div className="space-y-4">
                {EXTRACTOR_GROUPS.map((group) => {
                  const Icon = group.icon;
                  return (
                    <div key={group.label}>
                      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                        <Icon className="w-3.5 h-3.5" /> {group.label}
                      </h3>
                      <div className="grid grid-cols-2 gap-1.5">
                        {group.options.map((opt) => {
                          const optKey = `${opt.id}:${opt.documentType ?? opt.label}`;
                          return (
                            <button
                              key={optKey}
                              onClick={() => pickExtractor(opt)}
                              disabled={!!installingExtractorId}
                              className="flex items-center justify-between px-2.5 py-2 text-left text-sm border border-gray-200 rounded-md hover:border-blue-300 hover:bg-blue-50/40 disabled:opacity-50 disabled:cursor-progress"
                            >
                              <span className="text-gray-800">{opt.label}</span>
                              {installingExtractorId === optKey && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
