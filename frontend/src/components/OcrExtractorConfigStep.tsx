import { useState } from 'react';
import { X, Loader2, ScanText, Image as ImageIcon } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { projectsApi, API_BASE } from '@/services/api';
import { notify } from './Notifications';
import { DocumentPreviewPanel } from './DocumentPreviewPanel';
import type { ComponentInstance } from '@/types';

/**
 * Bespoke config step for ocr_extractor -- same shape as
 * DocumentExtractorConfigStep (real document preview instead of a raw
 * schema-driven form), but for the simpler Tesseract OCR component, which
 * has no document_type/output_fields preset system, no `path` direct
 * mode (upstream_asset_key only), and its own OCR-specific tuning knobs
 * (language, page segmentation mode, preprocessing) instead. Kept as a
 * separate component rather than one big branchy step, since the two
 * components' config shapes only share "there's a document to look at" --
 * document_ai_extractor/vision_api_asset (cloud APIs with processor IDs /
 * feature-type enums) and future image/video/audio components need their
 * own bespoke steps too, reusing DocumentPreviewPanel the same way this
 * one does, not a bigger version of this file.
 */
export function OcrExtractorConfigStep({
  componentType,
  component,
  initialAttributes,
  onDone,
  onClose,
  onReviewExtractions,
}: {
  componentType: string;
  component?: ComponentInstance | null;
  initialAttributes?: Record<string, any>;
  onDone: () => void;
  onClose: () => void;
  onReviewExtractions?: (component: ComponentInstance) => void;
}) {
  const { currentProject, loadProject } = useProjectStore();
  const isEditing = !!component;
  const seedAttrs = component?.attributes || initialAttributes || {};
  const upstreamAssetKey: string | undefined = seedAttrs.upstream_asset_key;

  const [assetName, setAssetName] = useState<string>(
    seedAttrs.asset_name || component?.label || (upstreamAssetKey ? `${upstreamAssetKey}_ocr` : 'ocr_text'),
  );
  const [imageColumn, setImageColumn] = useState<string>(seedAttrs.image_column || 'local_path');
  const [language, setLanguage] = useState<string>(seedAttrs.language || 'eng');
  const [preprocessed, setPreprocessed] = useState<boolean>(seedAttrs.preprocessed ?? false);
  const [saving, setSaving] = useState(false);

  const canSave = assetName.trim().length > 0 && imageColumn.trim().length > 0 && !!upstreamAssetKey;

  const handleSave = async () => {
    if (!currentProject || !canSave || saving) return;
    setSaving(true);
    try {
      const parts = componentType.split('.');
      const componentsIndex = parts.indexOf('components');
      const componentId = componentsIndex >= 0 ? parts[componentsIndex + 1] : 'ocr_extractor';

      const config: Record<string, any> = {
        name: assetName.trim(),
        asset_name: assetName.trim(),
        upstream_asset_key: upstreamAssetKey,
        image_column: imageColumn.trim(),
        language: language.trim() || 'eng',
        preprocessed,
      };

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
        console.error('[OcrExtractorConfigStep] Failed to regenerate lineage:', e);
      }

      if (body.assets_regenerated) {
        notify.success(isEditing ? `Updated "${assetName.trim()}".` : `Added "${assetName.trim()}" — running OCR.`);
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
            <ScanText className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">{isEditing ? 'Edit OCR' : 'Configure OCR'}</h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>

        <div className="flex-1 overflow-hidden grid grid-cols-1 sm:grid-cols-[1fr_380px]">
          <DocumentPreviewPanel upstreamAssetKey={upstreamAssetKey} />

          <div className="space-y-4 overflow-y-auto px-6 py-4">
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
              <label className="block text-xs font-medium text-gray-700 mb-1">Image column</label>
              <input
                type="text"
                value={imageColumn}
                onChange={(e) => setImageColumn(e.target.value)}
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
              <p className="text-[10px] text-gray-400 mt-0.5">Column with image file paths — 'local_path' pairs directly with file_lister's output.</p>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Language</label>
              <input
                type="text"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                placeholder="eng"
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
              <p className="text-[10px] text-gray-400 mt-0.5">Tesseract language code(s), e.g. 'eng', 'eng+fra'.</p>
            </div>

            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={preprocessed} onChange={(e) => setPreprocessed(e.target.checked)} />
              Images are already preprocessed
            </label>
            <p className="text-[10px] text-gray-400 -mt-3">
              Leave unchecked to auto-preprocess (grayscale + threshold) before OCR — usually improves accuracy on photos/scans.
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-200">
          {isEditing && onReviewExtractions && (
            <button
              onClick={() => onReviewExtractions(component!)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-emerald-700 border border-emerald-200 bg-emerald-50 rounded-md hover:bg-emerald-100 mr-auto"
            >
              <ImageIcon className="w-3.5 h-3.5" /> Review extractions
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
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ScanText className="w-3.5 h-3.5" />}
            {saving ? 'Saving…' : isEditing ? 'Save changes' : 'Add extractor'}
          </button>
        </div>
      </div>
    </div>
  );
}
