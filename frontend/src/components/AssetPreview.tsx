import { useState, useEffect } from 'react';
import { useProjectStore } from '@/hooks/useProject';
import { dagsterApi, AssetInfo } from '@/services/api';
import { RefreshCw, CheckCircle, XCircle, AlertCircle, Loader } from 'lucide-react';

interface AssetPreviewProps {
  projectId: string;
}

export function AssetPreview({ projectId }: AssetPreviewProps) {
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [assetCount, setAssetCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const loadAssets = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await dagsterApi.previewAssets(projectId);

      if (response.success) {
        setAssets(response.assets);
        setAssetCount(response.asset_count);
        setSuccess(true);
        setError(null);
      } else {
        setAssets([]);
        setAssetCount(0);
        setSuccess(false);
        setError(response.error || 'Failed to load assets');
      }
    } catch (err: any) {
      setAssets([]);
      setAssetCount(0);
      setSuccess(false);
      setError(err.message || 'Failed to load assets');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAssets();
  }, [projectId]);

  return (
    <div className="border border-gray-200 rounded-lg bg-white">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between bg-gray-50">
        <div className="flex items-center space-x-2">
          <h3 className="text-sm font-semibold text-gray-900">Generated Assets</h3>
          {success && !loading && (
            <span className="text-xs text-green-600 flex items-center gap-1">
              <CheckCircle className="w-3 h-3" />
              {assetCount} asset{assetCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <button
          onClick={loadAssets}
          disabled={loading}
          className="p-1 text-gray-600 hover:text-gray-900 disabled:opacity-50"
          title="Refresh assets"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Content */}
      <div className="p-4">
        {/* Loading State */}
        {loading && (
          <div className="flex items-center justify-center py-8 text-gray-500">
            <Loader className="w-5 h-5 animate-spin mr-2" />
            <span className="text-sm">Loading Dagster definitions...</span>
          </div>
        )}

        {/* Error State */}
        {!loading && error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3">
            <div className="flex items-start space-x-2">
              <XCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="text-sm font-medium text-red-900">Error Loading Assets</div>
                <div className="text-sm text-red-700 mt-1 font-mono whitespace-pre-wrap">
                  {error}
                </div>
              </div>
            </div>
            <div className="mt-3 text-xs text-red-600">
              <strong>Possible causes:</strong>
              <ul className="list-disc list-inside mt-1 space-y-1">
                <li>Component configuration is invalid</li>
                <li>Required dependencies are missing</li>
                <li>Project hasn't been initialized with Dagster</li>
              </ul>
            </div>
          </div>
        )}

        {/* No Assets State */}
        {!loading && !error && assetCount === 0 && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3">
            <div className="flex items-start space-x-2">
              <AlertCircle className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-yellow-800">
                <div className="font-medium">No assets generated yet</div>
                <div className="mt-1">
                  Add and configure components to see generated assets.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Assets List */}
        {!loading && !error && assets.length > 0 && (
          <div className="space-y-3">
            {assets.map((asset) => (
              <div
                key={asset.key}
                className="border border-gray-200 rounded-md p-3 hover:border-blue-300 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    {/* Asset Key */}
                    <div className="font-mono text-sm font-medium text-gray-900 break-all">
                      {asset.key}
                    </div>

                    {/* Group Name */}
                    {asset.group_name && (
                      <div className="text-xs text-gray-600 mt-1">
                        Group: <span className="font-medium">{asset.group_name}</span>
                      </div>
                    )}

                    {/* Description */}
                    {asset.description && (
                      <div className="text-xs text-gray-600 mt-1">{asset.description}</div>
                    )}

                    {/* Dependencies */}
                    {asset.deps && asset.deps.length > 0 && (
                      <div className="text-xs text-gray-500 mt-2">
                        <span className="font-medium">Depends on:</span>
                        <div className="mt-1 space-y-1">
                          {asset.deps.map((dep) => (
                            <div key={dep} className="font-mono text-xs bg-gray-100 px-2 py-1 rounded inline-block mr-2">
                              {dep}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Metadata */}
                    {asset.metadata && Object.keys(asset.metadata).length > 0 && (
                      <div className="text-xs text-gray-500 mt-2">
                        <span className="font-medium">Metadata:</span>
                        <div className="mt-1 font-mono text-xs bg-gray-50 p-2 rounded">
                          {JSON.stringify(asset.metadata, null, 2)}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Info Box */}
        {!loading && success && (
          <div className="mt-4 text-xs text-gray-600 bg-blue-50 border border-blue-200 rounded-md p-3">
            <div className="font-medium text-blue-900 mb-1">ℹ️ About Asset Preview</div>
            <div className="space-y-1">
              <div>
                • Assets are generated by loading your Dagster definitions
              </div>
              <div>
                • The actual count and dependencies are computed by Dagster
              </div>
              <div>
                • Click refresh to reload after configuration changes
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
