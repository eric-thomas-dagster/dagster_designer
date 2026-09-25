import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  X, ArrowLeft, ArrowRight, Loader2, FileText, ScanText, Receipt, FileSearch, Layers,
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

// The 24 real "extraction"/"ocr"/"document" tagged components in the
// manifest's "ai" category (verified against the live manifest, not
// guessed) grouped by what they're actually for. Each one already
// requires `upstream_asset_key` + a file-path column (per their real
// schemas) -- ComponentConfigModal's own column picker handles the
// specific column field once opened, so this wizard only needs to seed
// upstream_asset_key, not guess every extractor's exact field name.
interface ExtractorOption {
  id: string;
  label: string;
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
      { id: 'invoice_extractor', label: 'Invoice' },
      { id: 'receipt_extractor', label: 'Receipt' },
      { id: 'bank_statement_extractor', label: 'Bank statement' },
      { id: 'expense_report_extractor', label: 'Expense report' },
      { id: 'purchase_order_extractor', label: 'Purchase order' },
      { id: 'shipping_label_extractor', label: 'Shipping label' },
      { id: 'contract_extractor', label: 'Contract' },
      { id: 'legal_document_extractor', label: 'Legal document' },
      { id: 'insurance_claim_extractor', label: 'Insurance claim' },
      { id: 'medical_record_extractor', label: 'Medical record' },
      { id: 'resume_extractor', label: 'Resume' },
      { id: 'job_posting_extractor', label: 'Job posting' },
      { id: 'scientific_paper_extractor', label: 'Scientific paper' },
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
    label: 'Generic / custom structured extraction',
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
  onOpenComponentConfig: (componentType: string, initialAttributes?: Record<string, any>) => void;
}) {
  const { currentProject } = useProjectStore();
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [showNewSourceForm, setShowNewSourceForm] = useState(false);
  const [newSourceName, setNewSourceName] = useState('');
  const [newSourcePath, setNewSourcePath] = useState('');
  const [newSourceDownload, setNewSourceDownload] = useState(true);

  const existingSources = useMemo(() => {
    if (!currentProject) return [];
    return currentProject.graph.nodes
      .filter((n) => (n.type === 'asset' || (n.data as any)?.asset_key) && isDataFrameType((n.data as any)?.io_output_type))
      .map((n) => ({
        assetKey: (n.data as any)?.asset_key || n.id,
        label: (n.data as any)?.label || (n.data as any)?.asset_key || n.id,
        componentType: (n.data as any)?.component_type,
      }));
  }, [currentProject]);

  const installNewSource = useMutation({
    mutationFn: async () => {
      if (!currentProject) throw new Error('No project selected');
      if (!newSourceName.trim() || !newSourcePath.trim()) throw new Error('Name and path are required');
      const res = await fetch(`${API_BASE}/templates/install-via-cli/file_lister`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: currentProject.id,
          config: {},
          attributes: {
            asset_name: newSourceName.trim(),
            path: newSourcePath.trim(),
            download: newSourceDownload,
          },
        }),
      });
      const body = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(body.detail || 'Failed to add source');
      return newSourceName.trim();
    },
    onSuccess: (assetName) => {
      notify.success(`Added "${assetName}" as a document source.`);
      setSelectedSource(assetName);
      setShowNewSourceForm(false);
      setStep(2);
    },
    onError: (e: Error) => notify.error(`Failed to add source: ${e.message}`),
  });

  const [installingExtractorId, setInstallingExtractorId] = useState<string | null>(null);
  const pickExtractor = async (extractorId: string) => {
    if (!currentProject || !selectedSource || installingExtractorId) return;
    setInstallingExtractorId(extractorId);
    try {
      const res = await fetch(`${API_BASE}/templates/install-via-cli/${extractorId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: currentProject.id, config: {}, template_only: true }),
      });
      const body = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(body.detail || 'Install failed');
      onOpenComponentConfig(body.component_type, { upstream_asset_key: selectedSource });
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify.error(`Failed to add extractor: ${msg}`);
    } finally {
      setInstallingExtractorId(null);
    }
  };

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
                      onClick={() => { setSelectedSource(s.assetKey); setStep(2); }}
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
                      <label className="block text-xs font-medium text-gray-700 mb-1">Name</label>
                      <input
                        type="text"
                        value={newSourceName}
                        onChange={(e) => setNewSourceName(e.target.value)}
                        placeholder="incoming_invoices"
                        className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
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
                        onClick={() => installNewSource.mutate()}
                        disabled={installNewSource.isPending || !newSourceName.trim() || !newSourcePath.trim()}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50"
                      >
                        {installNewSource.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
                        Add source
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
                Reading from <span className="font-mono text-gray-700">{selectedSource}</span> — pick what to extract.
                You'll configure the specific fields (which column has the file path, language, etc.) next.
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
                        {group.options.map((opt) => (
                          <button
                            key={opt.id}
                            onClick={() => pickExtractor(opt.id)}
                            disabled={!!installingExtractorId}
                            className="flex items-center justify-between px-2.5 py-2 text-left text-sm border border-gray-200 rounded-md hover:border-blue-300 hover:bg-blue-50/40 disabled:opacity-50 disabled:cursor-progress"
                          >
                            <span className="text-gray-800">{opt.label}</span>
                            {installingExtractorId === opt.id && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />}
                          </button>
                        ))}
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
