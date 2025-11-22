import React, { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, AlertCircle, Table as TableIcon } from 'lucide-react';
import { assetsApi, type AssetDataPreview } from '@/services/api';

interface DataPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  assetKey: string;
  assetName: string;
}

export function DataPreviewModal({
  isOpen,
  onClose,
  projectId,
  assetKey,
  assetName,
}: DataPreviewModalProps) {
  const [data, setData] = useState<AssetDataPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load data when modal opens
  React.useEffect(() => {
    if (isOpen && !data && !loading) {
      loadData();
    }
  }, [isOpen]);

  const loadData = async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await assetsApi.previewData(projectId, assetKey);

      if (!result.success) {
        setError(result.error || 'Failed to load asset data');
      } else {
        setData(result);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load asset data');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setData(null);
    setError(null);
    onClose();
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={handleClose}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-xl z-50 w-[90vw] h-[80vh] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
            <div className="flex items-center space-x-3">
              <TableIcon className="w-5 h-5 text-blue-600" />
              <div>
                <Dialog.Title className="text-lg font-semibold text-gray-900">
                  Data Preview: {assetName}
                </Dialog.Title>
                {data && data.success && (
                  <div className="text-sm text-gray-500 mt-1">
                    {data.row_count?.toLocaleString()} rows × {data.column_count} columns
                    {data.sample_limit && data.row_count && data.row_count > data.sample_limit && (
                      <span className="ml-2 text-amber-600">
                        (showing first {data.sample_limit.toLocaleString()} rows)
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
            <Dialog.Close asChild>
              <button
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                aria-label="Close"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </Dialog.Close>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-auto p-6">
            {loading && (
              <div className="flex items-center justify-center h-full">
                <div className="text-center">
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
                  <p className="text-gray-600">Loading asset data...</p>
                </div>
              </div>
            )}

            {error && (
              <div className="flex items-center justify-center h-full">
                <div className="bg-red-50 border border-red-200 rounded-lg p-6 max-w-2xl">
                  <div className="flex items-start space-x-3">
                    <AlertCircle className="w-5 h-5 text-red-600 mt-0.5 flex-shrink-0" />
                    <div>
                      <h3 className="text-sm font-medium text-red-900 mb-1">
                        Cannot Preview Asset
                      </h3>
                      <p className="text-sm text-red-700">{error}</p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {data && data.success && data.data && data.columns && (
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        {data.columns.map((col, idx) => (
                          <th
                            key={idx}
                            className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider"
                          >
                            <div className="flex flex-col">
                              <span>{col}</span>
                              {data.dtypes && data.dtypes[col] && (
                                <span className="text-[10px] text-gray-500 font-normal normal-case mt-1">
                                  {data.dtypes[col]}
                                </span>
                              )}
                            </div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {data.data.map((row, rowIdx) => (
                        <tr key={rowIdx} className="hover:bg-gray-50">
                          {data.columns!.map((col, colIdx) => (
                            <td
                              key={colIdx}
                              className="px-4 py-3 text-sm text-gray-900 whitespace-nowrap"
                            >
                              {row[col] === null || row[col] === undefined
                                ? <span className="text-gray-400 italic">null</span>
                                : String(row[col])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          {data && data.success && (
            <div className="px-6 py-4 border-t border-gray-200 bg-gray-50">
              <button
                onClick={loadData}
                disabled={loading}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? 'Refreshing...' : 'Refresh Data'}
              </button>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
