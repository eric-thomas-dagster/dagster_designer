import { useState } from 'react';
import { X, FileCode } from 'lucide-react';
import { templatesApi } from '@/services/api';
import { projectsApi } from '@/services/api';

interface CreatePythonAssetDialogProps {
  projectId: string;
  onClose: () => void;
  onSuccess: () => void;
}

export function CreatePythonAssetDialog({
  projectId,
  onClose,
  onSuccess,
}: CreatePythonAssetDialogProps) {
  const [assetName, setAssetName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      // Create the Python asset file using dg scaffold
      const result = await templatesApi.createPythonAsset({
        project_id: projectId,
        asset_name: assetName,
        group_name: 'default',
        description: '',
        deps: [],
      });

      console.log('[CreatePythonAssetDialog] Created asset file:', result.file_path);

      // Regenerate assets to pick up the new file
      await projectsApi.regenerateAssets(projectId);

      onSuccess();
      onClose();
    } catch (err: any) {
      console.error('[CreatePythonAssetDialog] Error:', err);
      setError(err.response?.data?.detail || 'Failed to create Python asset');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center space-x-2">
            <FileCode className="w-5 h-5 text-blue-600" />
            <h2 className="text-lg font-semibold text-gray-900">Create Python Asset</h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
            disabled={isSubmitting}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Description */}
        <p className="text-sm text-gray-600 mb-4">
          Create a new Python asset using Dagster's official <code className="px-1 py-0.5 bg-gray-100 rounded text-xs">dg scaffold</code> command.
          You can customize the asset properties in the code editor after creation.
        </p>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Asset Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Asset Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={assetName}
              onChange={(e) => setAssetName(e.target.value)}
              placeholder="my_asset"
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={isSubmitting}
              autoFocus
            />
            <p className="text-xs text-gray-500 mt-1">
              File will be created at <code className="text-xs bg-gray-100 px-1 rounded">assets/{assetName || 'asset_name'}.py</code>
            </p>
          </div>

          {/* Error */}
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md text-sm">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end space-x-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={isSubmitting || !assetName}
            >
              {isSubmitting ? 'Creating...' : 'Create Asset'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
