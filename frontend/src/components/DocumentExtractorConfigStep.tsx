import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Loader2, FileText, ImageOff, Plus, Sparkles, ZoomIn } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { assetsApi, projectsApi, API_BASE } from '@/services/api';
import { notify } from './Notifications';

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;

// Mirrors structured_document_extractor's own `_PRESET_FIELDS` (see that
// component's README "Presets" table) -- duplicated here purely as
// editable DEFAULTS for this form, not a source of truth the backend
// depends on; the component re-derives the same defaults itself if
// output_fields is left unset, this just lets the wizard show them
// up front instead of a blank list.
const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  invoice: 'Invoice', receipt: 'Receipt', bank_statement: 'Bank statement',
  expense_report: 'Expense report', purchase_order: 'Purchase order', shipping_label: 'Shipping label',
  contract: 'Contract', legal_document: 'Legal document', insurance_claim: 'Insurance claim',
  medical_record: 'Medical record', resume: 'Resume', job_posting: 'Job posting',
  scientific_paper: 'Scientific paper', custom: 'Something else (custom fields)',
};
const PRESET_FIELDS: Record<string, string[]> = {
  invoice: ['invoice_number', 'date', 'vendor', 'total_amount', 'line_items', 'tax', 'currency'],
  receipt: ['merchant_name', 'merchant_address', 'date', 'time', 'items', 'subtotal', 'tax', 'total', 'payment_method', 'card_last_four', 'receipt_number'],
  bank_statement: ['account_number', 'account_holder', 'bank_name', 'statement_period', 'opening_balance', 'closing_balance', 'transactions', 'total_credits', 'total_debits'],
  expense_report: ['employee_name', 'employee_id', 'department', 'report_date', 'period_start', 'period_end', 'line_items', 'total_amount', 'currency', 'approver', 'status'],
  purchase_order: ['po_number', 'vendor', 'buyer', 'issue_date', 'delivery_date', 'line_items', 'subtotal', 'tax', 'total', 'payment_terms', 'shipping_address', 'billing_address'],
  shipping_label: ['tracking_number', 'carrier', 'service_type', 'sender_name', 'sender_address', 'recipient_name', 'recipient_address', 'weight', 'dimensions', 'ship_date', 'estimated_delivery'],
  contract: ['contract_type', 'parties', 'effective_date', 'expiration_date', 'governing_law', 'payment_terms', 'termination_clause', 'liability_cap', 'signatures'],
  legal_document: ['document_type', 'jurisdiction', 'court', 'case_number', 'parties', 'filing_date', 'key_dates', 'relief_sought', 'defined_terms', 'obligations', 'penalties'],
  insurance_claim: ['claim_id', 'policy_number', 'insurer', 'claimant_name', 'claimant_contact', 'incident_date', 'incident_description', 'damage_type', 'claimed_amount', 'adjuster', 'status'],
  medical_record: ['patient_name', 'dob', 'provider', 'visit_date', 'chief_complaint', 'diagnoses', 'icd_codes', 'medications', 'procedures', 'cpt_codes', 'follow_up'],
  resume: ['name', 'email', 'phone', 'location', 'summary', 'skills', 'experience', 'education', 'certifications', 'languages'],
  job_posting: ['job_title', 'company', 'location', 'remote_policy', 'employment_type', 'salary_range', 'required_skills', 'preferred_skills', 'experience_required', 'education_required', 'responsibilities', 'benefits', 'application_deadline'],
  scientific_paper: ['title', 'authors', 'journal', 'publication_date', 'doi', 'abstract', 'keywords', 'methodology', 'key_findings', 'limitations', 'citations_count', 'data_availability'],
  custom: [],
};

function defaultAssetName(documentType: string, upstreamAssetKey?: string): string {
  const base = documentType && documentType !== 'custom' ? documentType : (upstreamAssetKey || 'document');
  return `${base}_fields`;
}

/**
 * Bespoke config step for structured_document_extractor, opened straight
 * off the Document Extraction wizard instead of the raw generic
 * ComponentConfigModal form -- built because that form shows every schema
 * field at once (including the `path`/`upstream_asset_key` pair, only one
 * of which is ever relevant) with no document preview, which read as "no
 * dedicated UI" to the person using it. Persists via the same
 * /templates/configure/{id} path ComponentConfigModal itself uses for
 * community components -- this is a different FRONT END, not a different
 * save mechanism.
 */
export function DocumentExtractorConfigStep({
  componentType,
  initialAttributes,
  sourcePath,
  onDone,
  onClose,
}: {
  componentType: string;
  initialAttributes: Record<string, any>;
  sourcePath?: string;
  onDone: () => void;
  onClose: () => void;
}) {
  const { currentProject, loadProject } = useProjectStore();
  const upstreamAssetKey: string | undefined = initialAttributes.upstream_asset_key;
  const initialDocType = initialAttributes.document_type || 'custom';

  const [documentType, setDocumentType] = useState(initialDocType);
  const [assetName, setAssetName] = useState(defaultAssetName(initialDocType, upstreamAssetKey));
  const [outputFields, setOutputFields] = useState<string[]>(PRESET_FIELDS[initialDocType] || []);
  const [newField, setNewField] = useState('');
  const [model, setModel] = useState('gpt-4o');
  const [apiKeyEnvVar, setApiKeyEnvVar] = useState('OPENAI_API_KEY');
  const [postProcess, setPostProcess] = useState<'none' | 'move' | 'delete'>('none');
  const [postProcessDir, setPostProcessDir] = useState('');
  const [saving, setSaving] = useState(false);

  const handleDocumentTypeChange = (dt: string) => {
    setDocumentType(dt);
    setOutputFields(PRESET_FIELDS[dt] || []);
    setAssetName((prev) => {
      // Only replace the name if it still looks auto-generated (matches
      // the previous doc type's default) -- don't clobber something the
      // user already typed themselves.
      const prevDefault = defaultAssetName(documentType, upstreamAssetKey);
      return prev === prevDefault ? defaultAssetName(dt, upstreamAssetKey) : prev;
    });
  };

  const addField = () => {
    const f = newField.trim().toLowerCase().replace(/\s+/g, '_');
    if (f && !outputFields.includes(f)) setOutputFields((prev) => [...prev, f]);
    setNewField('');
  };
  const removeField = (f: string) => setOutputFields((prev) => prev.filter((x) => x !== f));

  const { data: sample, isLoading: sampleLoading } = useQuery({
    queryKey: ['document-extractor-sample', currentProject?.id, sourcePath],
    queryFn: () => assetsApi.sampleFiles(currentProject!.id, sourcePath!, 12),
    enabled: !!currentProject && !!sourcePath,
  });
  const files = sample?.files || [];
  const [activeIndex, setActiveIndex] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const previewFile = files[activeIndex];
  const previewIsImage = previewFile ? IMAGE_EXTENSIONS.test(previewFile.path) : false;
  const previewUrl = (f: { path: string }) =>
    `${API_BASE}/assets/${currentProject?.id}/local-file?path=${encodeURIComponent(f.path)}`;

  const canSave = assetName.trim().length > 0
    && (documentType !== 'custom' || outputFields.length > 0)
    && (postProcess !== 'move' || postProcessDir.trim().length > 0);

  const handleSave = async () => {
    if (!currentProject || !canSave || saving) return;
    setSaving(true);
    try {
      const parts = componentType.split('.');
      const componentsIndex = parts.indexOf('components');
      const componentId = componentsIndex >= 0 ? parts[componentsIndex + 1] : 'structured_document_extractor';

      const config: Record<string, any> = {
        name: assetName.trim(),
        asset_name: assetName.trim(),
        document_type: documentType,
        model,
        api_key_env_var: apiKeyEnvVar,
      };
      if (upstreamAssetKey) {
        config.upstream_asset_key = upstreamAssetKey;
        config.input_column = 'local_path';
        config.input_type = 'file';
      } else if (sourcePath) {
        config.path = sourcePath;
      }
      if (outputFields.length > 0) config.output_fields = outputFields;
      if (postProcess !== 'none') {
        config.post_process = postProcess;
        if (postProcess === 'move') config.post_process_dir = postProcessDir.trim();
      }

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
        console.error('[DocumentExtractorConfigStep] Failed to regenerate lineage:', e);
      }

      if (body.assets_regenerated) {
        notify.success(`Added "${assetName.trim()}" — extracting ${DOCUMENT_TYPE_LABELS[documentType] || documentType} fields.`);
        onDone();
      } else {
        notify.error(`Saved, but Dagster couldn't load it:\n\n${body.regenerate_error || 'Unknown error'}`);
      }
    } catch (e: any) {
      notify.error(`Failed to add extractor: ${e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">Configure extraction</h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>

        <div className="flex-1 overflow-hidden grid grid-cols-1 sm:grid-cols-[1fr_380px]">
          {/* Document preview -- main image + a scrollable thumbnail strip
              of every sample file found at the source path, not just one.
              Click a thumbnail to preview that file instead; click the
              main image to zoom to a full-size lightbox. Extracted-field
              highlighting on the document isn't possible here -- nothing's
              been extracted yet at config time, and even post-extraction
              it would need the model to return bounding boxes, which
              these prompts don't request today. That's a real, separate
              feature for the post-materialize review UI, not this step. */}
          <div className="flex flex-col min-w-0 border-r border-gray-100 bg-gray-50">
            <div className="flex-1 min-h-0 flex items-center justify-center p-6">
              {!sourcePath ? (
                <div className="flex flex-col items-center gap-1.5 text-gray-300 px-3 text-center">
                  <ImageOff className="w-8 h-8" />
                  <span className="text-xs">reading from an existing asset — no preview available yet</span>
                </div>
              ) : sampleLoading ? (
                <Loader2 className="w-6 h-6 text-gray-300 animate-spin" />
              ) : previewFile && previewIsImage ? (
                <button
                  onClick={() => setZoomed(true)}
                  className="relative group max-w-full max-h-full rounded-lg overflow-hidden border border-gray-200 bg-white shadow-sm"
                  title="Click to zoom"
                >
                  <img src={previewUrl(previewFile)} alt={previewFile.name} className="max-w-full max-h-[calc(90vh-220px)] object-contain" />
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center">
                    <ZoomIn className="w-6 h-6 text-white opacity-0 group-hover:opacity-90 drop-shadow" />
                  </div>
                </button>
              ) : previewFile ? (
                <div className="flex flex-col items-center gap-1.5 text-gray-400 px-3 text-center">
                  <FileText className="w-10 h-10" />
                  <span className="text-xs break-all">{previewFile.name}</span>
                  <span className="text-[10px] text-gray-400">no inline preview for this file type</span>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-1 text-gray-300 px-3 text-center">
                  <ImageOff className="w-8 h-8" />
                  <span className="text-xs">no matching files found</span>
                </div>
              )}
            </div>
            {files.length > 0 && (
              <div className="flex-shrink-0 border-t border-gray-200 bg-white px-3 py-2 flex items-center gap-2 overflow-x-auto">
                {files.map((f, i) => (
                  <button
                    key={f.path}
                    onClick={() => setActiveIndex(i)}
                    title={f.name}
                    className={`flex-shrink-0 w-12 h-14 rounded border overflow-hidden bg-gray-100 flex items-center justify-center ${
                      i === activeIndex ? 'border-primary ring-2 ring-primary/30' : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    {IMAGE_EXTENSIONS.test(f.path) ? (
                      <img src={previewUrl(f)} alt={f.name} className="w-full h-full object-cover" />
                    ) : (
                      <FileText className="w-4 h-4 text-gray-400" />
                    )}
                  </button>
                ))}
              </div>
            )}
            <p className="flex-shrink-0 text-[11px] text-gray-400 text-center py-1.5 border-t border-gray-100 bg-white">
              {files.length > 0 ? `${activeIndex + 1} of ${files.length} real file(s) from your source` : 'Preview'}
            </p>
          </div>

          {/* Curated fields */}
          <div className="space-y-4 overflow-y-auto px-6 py-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Asset name</label>
              <input
                type="text"
                value={assetName}
                onChange={(e) => setAssetName(e.target.value)}
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Document type</label>
              <select
                value={documentType}
                onChange={(e) => handleDocumentTypeChange(e.target.value)}
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
              >
                {Object.entries(DOCUMENT_TYPE_LABELS).map(([id, label]) => (
                  <option key={id} value={id}>{label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Fields to extract
                {documentType !== 'custom' && (
                  <span className="text-gray-400 font-normal"> — starting point, edit as needed</span>
                )}
              </label>
              <div className="flex flex-wrap gap-1.5 mb-1.5">
                {outputFields.map((f) => (
                  <span key={f} className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-violet-50 text-violet-700 border border-violet-100 rounded-md font-mono">
                    {f}
                    <button onClick={() => removeField(f)} className="text-violet-400 hover:text-violet-700">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
                {outputFields.length === 0 && (
                  <span className="text-xs text-gray-400 italic py-1">No fields yet — add at least one below.</span>
                )}
              </div>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={newField}
                  onChange={(e) => setNewField(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addField(); } }}
                  placeholder="add a field, e.g. po_reference"
                  className="flex-1 px-2.5 py-1.5 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
                <button
                  onClick={addField}
                  disabled={!newField.trim()}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
                >
                  <Plus className="w-3.5 h-3.5" /> Add
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Model</label>
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
                <p className="text-[10px] text-gray-400 mt-0.5">litellm format, e.g. gpt-4o, claude-3-5-sonnet-20241022</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">API key env var</label>
                <input
                  type="text"
                  value={apiKeyEnvVar}
                  onChange={(e) => setApiKeyEnvVar(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
              </div>
            </div>

            {!upstreamAssetKey && (
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">After a file is extracted</label>
                <select
                  value={postProcess}
                  onChange={(e) => setPostProcess(e.target.value as 'none' | 'move' | 'delete')}
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  <option value="none">Leave it in place (reprocessed every run)</option>
                  <option value="move">Move it to another folder</option>
                  <option value="delete">Delete it</option>
                </select>
                {postProcess === 'move' && (
                  <input
                    type="text"
                    value={postProcessDir}
                    onChange={(e) => setPostProcessDir(e.target.value)}
                    placeholder="s3://my-bucket/invoices/_processed/"
                    className="w-full mt-1.5 px-2.5 py-1.5 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                  />
                )}
                <p className="text-[10px] text-gray-400 mt-0.5">
                  {postProcess === 'none'
                    ? "Since this component lists files itself, without this the same files get re-extracted on every run."
                    : 'Only applied to files that extracted successfully — a failed one is left in place so the next run retries it.'}
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-200">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-md">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave || saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {saving ? 'Adding…' : 'Add extractor'}
          </button>
        </div>
      </div>

      {zoomed && previewFile && previewIsImage && (
        <div
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-[60] p-8"
          onClick={() => setZoomed(false)}
        >
          <button onClick={() => setZoomed(false)} className="absolute top-4 right-4 text-white/70 hover:text-white" aria-label="Close zoom">
            <X className="w-6 h-6" />
          </button>
          <img src={previewUrl(previewFile)} alt={previewFile.name} className="max-w-full max-h-full object-contain" />
        </div>
      )}
    </div>
  );
}
