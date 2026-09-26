import { useState } from 'react';
import { X, Loader2, Mic2, Sparkles } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { projectsApi, API_BASE } from '@/services/api';
import { notify } from './Notifications';
import { extractComponentId } from '@/lib/componentId';
import { MediaPreviewPanel } from './MediaPreviewPanel';
import type { ComponentInstance } from '@/types';

/**
 * Bespoke config step for audio_diarized_transcriber -- same real-preview
 * treatment (MediaPreviewPanel's <audio> player) as the other steps.
 * Two backends with genuinely different config shapes (cloud creds vs
 * local HF token + Whisper model); shows only the fields for whichever
 * is selected, not both at once -- exactly the "raw form dumps every
 * field regardless of relevance" complaint this whole family of bespoke
 * steps exists to avoid.
 */
export function AudioDiarizedConfigStep({
  componentType,
  component,
  initialAttributes,
  onDone,
  onClose,
  onReviewTranscripts,
}: {
  componentType: string;
  component?: ComponentInstance | null;
  initialAttributes?: Record<string, any>;
  onDone: () => void;
  onClose: () => void;
  onReviewTranscripts?: (component: ComponentInstance) => void;
}) {
  const { currentProject, loadProject } = useProjectStore();
  const isEditing = !!component;
  const seedAttrs = component?.attributes || initialAttributes || {};
  const upstreamAssetKey: string | undefined = seedAttrs.upstream_asset_key;

  const [assetName, setAssetName] = useState<string>(
    seedAttrs.asset_name || component?.label || (upstreamAssetKey ? `${upstreamAssetKey}_transcripts` : 'diarized_transcripts'),
  );
  const [backend, setBackend] = useState<'google_cloud_speech' | 'pyannote'>(seedAttrs.diarization_backend || 'google_cloud_speech');
  // google_cloud_speech fields
  const [credentialsPath, setCredentialsPath] = useState<string>(seedAttrs.credentials_path || '');
  const [languageCodes, setLanguageCodes] = useState<string>((seedAttrs.language_codes || ['en-US']).join(', '));
  const [minSpeakerCount, setMinSpeakerCount] = useState<number>(seedAttrs.min_speaker_count ?? 2);
  const [maxSpeakerCount, setMaxSpeakerCount] = useState<number>(seedAttrs.max_speaker_count ?? 6);
  // pyannote fields
  const [hfTokenEnvVar, setHfTokenEnvVar] = useState<string>(seedAttrs.hf_token_env_var || 'HF_TOKEN');
  const [whisperModelSize, setWhisperModelSize] = useState<string>(seedAttrs.whisper_model_size || 'base');
  const [saving, setSaving] = useState(false);

  const canSave = assetName.trim().length > 0 && !!upstreamAssetKey
    && (backend !== 'google_cloud_speech' || !!credentialsPath.trim());

  const handleSave = async () => {
    if (!currentProject || !canSave || saving) return;
    setSaving(true);
    try {
      const componentId = extractComponentId(componentType) || 'audio_diarized_transcriber';
      const config: Record<string, any> = {
        name: assetName.trim(),
        asset_name: assetName.trim(),
        upstream_asset_key: upstreamAssetKey,
        diarization_backend: backend,
      };
      if (backend === 'google_cloud_speech') {
        config.credentials_path = credentialsPath.trim();
        config.language_codes = languageCodes.split(',').map((s) => s.trim()).filter(Boolean);
        config.min_speaker_count = minSpeakerCount;
        config.max_speaker_count = maxSpeakerCount;
      } else {
        config.hf_token_env_var = hfTokenEnvVar.trim();
        config.whisper_model_size = whisperModelSize;
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
        console.error('[AudioDiarizedConfigStep] Failed to regenerate lineage:', e);
      }

      if (body.assets_regenerated) {
        notify.success(isEditing ? `Updated "${assetName.trim()}".` : `Added "${assetName.trim()}" — transcribing with speaker labels.`);
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
            <Mic2 className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">{isEditing ? 'Edit diarized transcription' : 'Configure diarized transcription'}</h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>

        <div className="flex-1 overflow-hidden grid grid-cols-1 sm:grid-cols-[1fr_380px]">
          <MediaPreviewPanel upstreamAssetKey={upstreamAssetKey} kind="audio" />

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
              <label className="block text-xs font-medium text-gray-700 mb-1">Diarization backend</label>
              <select
                value={backend}
                onChange={(e) => setBackend(e.target.value as 'google_cloud_speech' | 'pyannote')}
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
              >
                <option value="google_cloud_speech">Google Cloud Speech-to-Text (cloud)</option>
                <option value="pyannote">pyannote + local Whisper (local, free after setup)</option>
              </select>
            </div>

            {backend === 'google_cloud_speech' ? (
              <>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Service account credentials path</label>
                  <input
                    type="text"
                    value={credentialsPath}
                    onChange={(e) => setCredentialsPath(e.target.value)}
                    placeholder="/path/to/service-account.json"
                    className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Language codes</label>
                  <input
                    type="text"
                    value={languageCodes}
                    onChange={(e) => setLanguageCodes(e.target.value)}
                    placeholder="en-US"
                    className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                  />
                  <p className="text-[10px] text-gray-400 mt-0.5">Comma-separated BCP-47 codes.</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Min speakers</label>
                    <input
                      type="number" min={1}
                      value={minSpeakerCount}
                      onChange={(e) => setMinSpeakerCount(Number(e.target.value))}
                      className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Max speakers</label>
                    <input
                      type="number" min={1}
                      value={maxSpeakerCount}
                      onChange={(e) => setMaxSpeakerCount(Number(e.target.value))}
                      className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                    />
                  </div>
                </div>
              </>
            ) : (
              <>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">HuggingFace token env var</label>
                  <input
                    type="text"
                    value={hfTokenEnvVar}
                    onChange={(e) => setHfTokenEnvVar(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                  />
                  <p className="text-[10px] text-gray-400 mt-0.5">pyannote's model is gated — accept its terms on HuggingFace first, then set this env var to your access token.</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Whisper model size</label>
                  <select
                    value={whisperModelSize}
                    onChange={(e) => setWhisperModelSize(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                  >
                    {['tiny', 'base', 'small', 'medium', 'large'].map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-200">
          {isEditing && onReviewTranscripts && (
            <button
              onClick={() => onReviewTranscripts(component!)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-emerald-700 border border-emerald-200 bg-emerald-50 rounded-md hover:bg-emerald-100 mr-auto"
            >
              <Mic2 className="w-3.5 h-3.5" /> Review transcripts
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
