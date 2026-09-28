import { useMemo, useState } from 'react';
import { X, ArrowRight, FileSpreadsheet, Database, Wand2 } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';

/**
 * Step 1 for the "Transform / Clean Data" card: which source. An asset
 * already in this project opens the REAL Transform UI (DataPreviewModal --
 * the same ~4000-line, live-preview-driven visual builder the graph's own
 * Transform button opens, not a reduced form) directly against it. A
 * resource/connection string has no existing asset to preview yet, so it
 * goes to SqlTransformConfigStep's own smaller builder instead -- a real,
 * necessary difference in capability (no live preview possible before the
 * query's ever been run), not an arbitrary UI split.
 */
export function TransformSourcePicker({
  onPickExistingAsset,
  onPickRawSource,
  onClose,
}: {
  onPickExistingAsset: (assetKey: string) => void;
  onPickRawSource: () => void;
  onClose: () => void;
}) {
  const { currentProject } = useProjectStore();
  const [showAssetList, setShowAssetList] = useState(false);

  const existingAssets = useMemo(() => {
    if (!currentProject) return [];
    return currentProject.graph.nodes
      .filter((n) => n.type === 'asset' || (n.data as any)?.asset_key)
      .map((n) => ({
        assetKey: (n.data as any)?.asset_key || n.id,
        label: (n.data as any)?.label || (n.data as any)?.asset_key || n.id,
        componentType: (n.data as any)?.component_type as string | undefined,
      }));
  }, [currentProject]);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <Wand2 className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">{showAssetList ? 'Pick an asset to transform' : 'Transform — what are you cleaning up?'}</h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2">
          {!showAssetList ? (
            <>
              <button
                onClick={() => setShowAssetList(true)}
                className="w-full flex items-start gap-3 px-3 py-2.5 text-left border border-gray-200 rounded-md hover:border-blue-300 hover:bg-blue-50/40"
              >
                <FileSpreadsheet className="w-4 h-4 text-gray-500 mt-0.5 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-gray-900">An asset already in this project</div>
                  <div className="text-xs text-gray-500">Opens the full visual builder — filter/sort/group-by/etc. against real sample rows, live.</div>
                </div>
              </button>
              <button
                onClick={onPickRawSource}
                className="w-full flex items-start gap-3 px-3 py-2.5 text-left border border-gray-200 rounded-md hover:border-blue-300 hover:bg-blue-50/40"
              >
                <Database className="w-4 h-4 text-gray-500 mt-0.5 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-gray-900">A resource or connection string</div>
                  <div className="text-xs text-gray-500">No asset yet — write the source query directly. A smaller builder, since there's nothing to preview until it's run.</div>
                </div>
              </button>
            </>
          ) : existingAssets.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No assets in this project yet.</p>
          ) : (
            existingAssets.map((a) => (
              <button
                key={a.assetKey}
                onClick={() => onPickExistingAsset(a.assetKey)}
                className="w-full flex items-center justify-between px-3 py-2 text-left border border-gray-200 rounded-md hover:border-blue-300 hover:bg-blue-50/40"
              >
                <div>
                  <div className="text-sm font-medium text-gray-900">{a.label}</div>
                  {a.componentType && <div className="text-xs text-gray-400 font-mono">{a.componentType}</div>}
                </div>
                <ArrowRight className="w-4 h-4 text-gray-300" />
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
