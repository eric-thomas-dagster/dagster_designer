import { useState, useEffect } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import Editor from '@monaco-editor/react';
import { X, Play, Tag, AlertCircle, CheckCircle2, Calendar } from 'lucide-react';
import yaml from 'js-yaml';
import { partitionsApi, type PartitionDef, type BackfillRequest } from '@/services/api';

interface PartitionBackfillProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  assetKey: string;
  onLaunch: (request: BackfillRequest) => Promise<void>;
}

export function PartitionBackfill({
  open,
  onOpenChange,
  projectId,
  assetKey,
  onLaunch,
}: PartitionBackfillProps) {
  const [partitionDef, setPartitionDef] = useState<PartitionDef | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Partition selection state
  const [partitionInput, setPartitionInput] = useState('');
  const [selectedPartitions, setSelectedPartitions] = useState<string[]>([]);
  const [quickFilter, setQuickFilter] = useState<'latest' | 'all' | 'custom'>('latest');

  // Date picker state for time-based partitions
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Config and tags
  const [configYaml, setConfigYaml] = useState<string>('');
  const [tags, setTags] = useState<Record<string, string>>({});
  const [showTagEditor, setShowTagEditor] = useState(false);
  const [showConfigEditor, setShowConfigEditor] = useState(false);

  // Options
  const [backfillFailedOnly, setBackfillFailedOnly] = useState(false);

  // Launch state
  const [isLaunching, setIsLaunching] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  // Load partition info when modal opens
  useEffect(() => {
    if (open && projectId && assetKey) {
      setLoading(true);
      setError(null);

      partitionsApi
        .getPartitionInfo(projectId, assetKey)
        .then((response) => {
          if (response.is_partitioned && response.partitions_def) {
            setPartitionDef(response.partitions_def);

            // Initialize with latest partition if available
            const keys = response.partitions_def.partition_keys || [];
            if (keys.length > 0) {
              setSelectedPartitions([keys[keys.length - 1]]);
              setPartitionInput(keys[keys.length - 1]);

              // Initialize date pickers with first and last partition keys (if date-like)
              if (response.partitions_def.start_date) {
                setStartDate(keys[0] || '');
                setEndDate(keys[keys.length - 1] || '');
              }
            }
          } else {
            setError('This asset is not partitioned');
          }
        })
        .catch((err) => {
          setError(`Failed to load partition info: ${err.message}`);
        })
        .finally(() => {
          setLoading(false);
        });
    }
  }, [open, projectId, assetKey]);

  // Handle quick filter changes
  useEffect(() => {
    if (!partitionDef?.partition_keys) return;

    const keys = partitionDef.partition_keys;
    if (keys.length === 0) return;

    if (quickFilter === 'latest') {
      setSelectedPartitions([keys[keys.length - 1]]);
      setPartitionInput(keys[keys.length - 1]);
      // Update date pickers to latest
      if (partitionDef.start_date) {
        setStartDate(keys[keys.length - 1]);
        setEndDate(keys[keys.length - 1]);
      }
    } else if (quickFilter === 'all') {
      setSelectedPartitions(keys);
      // Build range string if we have start and end dates
      if (partitionDef.start_date && keys.length > 0) {
        const start = keys[0];
        const end = keys[keys.length - 1];
        setPartitionInput(`[${start}...${end}]`);
        setStartDate(start);
        setEndDate(end);
      } else {
        setPartitionInput(keys.join(', '));
      }
    }
  }, [quickFilter, partitionDef]);

  // Parse partition input (e.g., "2023-05-25, 2023-05-26, [2023-05-27...2025-11-20]")
  const handlePartitionInputChange = (value: string) => {
    setPartitionInput(value);
    setQuickFilter('custom');

    if (!value.trim() || !partitionDef?.partition_keys) {
      setSelectedPartitions([]);
      return;
    }

    const allKeys = partitionDef.partition_keys;
    const selected: string[] = [];

    // Parse ranges like [2023-05-27...2025-11-20]
    const rangeMatch = value.match(/\[([^\]]+)\.\.\.([^\]]+)\]/);
    if (rangeMatch) {
      const start = rangeMatch[1].trim();
      const end = rangeMatch[2].trim();
      const startIdx = allKeys.indexOf(start);
      const endIdx = allKeys.indexOf(end);

      if (startIdx !== -1 && endIdx !== -1) {
        selected.push(...allKeys.slice(startIdx, endIdx + 1));
      }
    }

    // Parse comma-separated keys
    const parts = value.split(',').map(p => p.trim()).filter(p => p && !p.includes('['));
    for (const part of parts) {
      if (allKeys.includes(part)) {
        selected.push(part);
      }
    }

    setSelectedPartitions(selected);
  };

  // Validate YAML on change
  const handleConfigChange = (value: string | undefined) => {
    setConfigYaml(value || '');

    if (!value?.trim()) {
      setErrors([]);
      return;
    }

    try {
      yaml.load(value);
      setErrors([]);
    } catch (err: any) {
      setErrors([err.message]);
    }
  };

  const handleLaunchBackfill = async () => {
    // Parse YAML config
    let config: Record<string, any> | undefined;
    try {
      if (configYaml.trim()) {
        config = yaml.load(configYaml) as Record<string, any>;
      }
    } catch (err: any) {
      setErrors([`Invalid YAML: ${err.message}`]);
      return;
    }

    // Build partition range if applicable
    let partitionRange: { start: string; end: string } | undefined;
    const rangeMatch = partitionInput.match(/\[([^\]]+)\.\.\.([^\]]+)\]/);
    if (rangeMatch) {
      partitionRange = {
        start: rangeMatch[1].trim(),
        end: rangeMatch[2].trim(),
      };
    }

    const request: BackfillRequest = {
      asset_keys: [assetKey],
      partition_selection: rangeMatch ? undefined : selectedPartitions,
      partition_range: partitionRange,
      config,
      tags: Object.keys(tags).length > 0 ? tags : undefined,
      backfill_failed_only: backfillFailedOnly,
    };

    setIsLaunching(true);
    try {
      await onLaunch(request);
      onOpenChange(false);
    } catch (err: any) {
      setErrors([err.message || 'Backfill launch failed']);
    } finally {
      setIsLaunching(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-xl z-50 w-[90vw] h-[85vh] max-w-[1400px] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
            <div>
              <Dialog.Title className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <Calendar className="w-5 h-5 text-gray-400" />
                Launch runs to materialize {assetKey}
              </Dialog.Title>
              <Dialog.Description className="sr-only">
                Select partitions and configure backfill parameters
              </Dialog.Description>
            </div>
            <Dialog.Close className="p-2 hover:bg-gray-100 rounded">
              <X className="w-5 h-5" />
            </Dialog.Close>
          </div>

          {loading && (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-gray-500">Loading partition info...</div>
            </div>
          )}

          {error && (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-red-600">{error}</div>
            </div>
          )}

          {!loading && !error && partitionDef && (
            <>
              {/* Main Content */}
              <div className="flex-1 overflow-y-auto p-6 space-y-6">
                {/* Partition Selection */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-gray-700">Partition selection</h3>
                    <span className="text-sm text-gray-500">
                      {selectedPartitions.length} partition{selectedPartitions.length !== 1 ? 's' : ''}
                    </span>
                  </div>

                  {/* Quick filters */}
                  <div className="flex gap-2 mb-3">
                    <button
                      onClick={() => setQuickFilter('latest')}
                      className={`px-3 py-1.5 text-sm rounded border ${
                        quickFilter === 'latest'
                          ? 'bg-blue-50 border-blue-300 text-blue-700'
                          : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      Latest
                    </button>
                    <button
                      onClick={() => setQuickFilter('all')}
                      className={`px-3 py-1.5 text-sm rounded border ${
                        quickFilter === 'all'
                          ? 'bg-blue-50 border-blue-300 text-blue-700'
                          : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      All
                    </button>
                    <button
                      onClick={() => setQuickFilter('custom')}
                      className={`px-3 py-1.5 text-sm rounded border ${
                        quickFilter === 'custom'
                          ? 'bg-blue-50 border-blue-300 text-blue-700'
                          : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      Custom
                    </button>
                  </div>

                  {/* Partition input - use date pickers for time-based partitions */}
                  {partitionDef.start_date ? (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs font-medium text-gray-700 mb-1">
                            Start Date
                          </label>
                          <input
                            type="date"
                            value={startDate}
                            onChange={(e) => {
                              setStartDate(e.target.value);
                              setQuickFilter('custom');
                              // Update partition input and selection
                              const input = `[${e.target.value}...${endDate || e.target.value}]`;
                              handlePartitionInputChange(input);
                            }}
                            className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-700 mb-1">
                            End Date
                          </label>
                          <input
                            type="date"
                            value={endDate}
                            onChange={(e) => {
                              setEndDate(e.target.value);
                              setQuickFilter('custom');
                              // Update partition input and selection
                              const input = `[${startDate || e.target.value}...${e.target.value}]`;
                              handlePartitionInputChange(input);
                            }}
                            className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                      </div>
                      <div className="text-xs text-gray-500">
                        Or enter custom partition expression:
                      </div>
                      <input
                        type="text"
                        value={partitionInput}
                        onChange={(e) => {
                          handlePartitionInputChange(e.target.value);
                          // Try to extract dates from input for date pickers
                          const rangeMatch = e.target.value.match(/\[([^\]]+)\.\.\.([^\]]+)\]/);
                          if (rangeMatch) {
                            setStartDate(rangeMatch[1].trim());
                            setEndDate(rangeMatch[2].trim());
                          }
                        }}
                        placeholder="ex: [2023-05-27...2025-11-20] or 2023-05-25, 2023-05-26"
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                      />
                    </div>
                  ) : (
                    <input
                      type="text"
                      value={partitionInput}
                      onChange={(e) => handlePartitionInputChange(e.target.value)}
                      placeholder="ex: partition_1, partition_2, partition_3"
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  )}

                  {/* Partition info */}
                  {partitionDef.partition_count !== undefined && (
                    <div className="mt-2 text-xs text-gray-500">
                      Total partitions: {partitionDef.partition_count}
                      {partitionDef.sample_note && ` (${partitionDef.sample_note})`}
                    </div>
                  )}
                </div>

                {/* Tags Section */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-gray-700">Tags</h3>
                    <button
                      onClick={() => setShowTagEditor(!showTagEditor)}
                      className="text-sm text-blue-600 hover:text-blue-700"
                    >
                      {showTagEditor ? 'Hide' : 'Add tags'}
                    </button>
                  </div>

                  {showTagEditor && (
                    <div className="flex gap-2 flex-wrap p-3 bg-gray-50 rounded-md">
                      {Object.entries(tags).map(([key, value]) => (
                        <div key={key} className="flex items-center gap-1 px-2 py-1 bg-white border border-gray-300 rounded text-sm">
                          <span className="text-gray-600">{key}:</span>
                          <span>{value}</span>
                          <button
                            onClick={() => {
                              const newTags = { ...tags };
                              delete newTags[key];
                              setTags(newTags);
                            }}
                            className="ml-1 text-gray-400 hover:text-gray-600"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                      <button
                        onClick={() => {
                          const key = prompt('Tag key:');
                          if (key) {
                            const value = prompt('Tag value:');
                            if (value !== null) {
                              setTags({ ...tags, [key]: value });
                            }
                          }
                        }}
                        className="px-2 py-1 text-sm text-blue-600 hover:bg-blue-50 border border-dashed border-blue-300 rounded"
                      >
                        + Add tag
                      </button>
                    </div>
                  )}
                  <p className="text-xs text-gray-500 mt-2">Tags will be applied to all backfill runs</p>
                </div>

                {/* Config Section */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-gray-700">Config</h3>
                    <button
                      onClick={() => setShowConfigEditor(!showConfigEditor)}
                      className="text-sm text-blue-600 hover:text-blue-700"
                    >
                      {showConfigEditor ? 'Hide' : 'Add config'}
                    </button>
                  </div>

                  {showConfigEditor && (
                    <div className="h-64 border border-gray-300 rounded overflow-hidden">
                      <Editor
                        height="100%"
                        defaultLanguage="yaml"
                        value={configYaml}
                        onChange={handleConfigChange}
                        theme="vs-light"
                        options={{
                          minimap: { enabled: false },
                          fontSize: 13,
                          lineNumbers: 'on',
                          scrollBeyondLastLine: false,
                          automaticLayout: true,
                          tabSize: 2,
                        }}
                      />
                    </div>
                  )}
                  <p className="text-xs text-gray-500 mt-2">Config will be applied to all backfill runs</p>
                </div>

                {/* Options */}
                <div>
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">Options</h3>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={backfillFailedOnly}
                      onChange={(e) => setBackfillFailedOnly(e.target.checked)}
                      className="w-4 h-4 text-blue-600"
                    />
                    <span className="text-sm text-gray-700">Backfill only failed and missing partitions within selection</span>
                  </label>
                </div>

                {/* Info message */}
                <div className="flex items-center gap-2 p-3 bg-blue-50 border border-blue-200 rounded-md text-sm text-blue-800">
                  <AlertCircle className="w-4 h-4" />
                  <span>Backfills all partitions in a single run.</span>
                </div>
              </div>

              {/* Bottom Section */}
              <div className="border-t border-gray-200 px-6 py-3">
                {errors.length > 0 && (
                  <div className="mb-3 space-y-2">
                    {errors.map((error, i) => (
                      <div key={i} className="flex items-start gap-2 text-sm text-red-600">
                        <AlertCircle className="w-4 h-4 mt-0.5" />
                        <span>{error}</span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex items-center justify-end gap-3">
                  <button
                    onClick={() => onOpenChange(false)}
                    className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleLaunchBackfill}
                    disabled={isLaunching || errors.length > 0 || selectedPartitions.length === 0}
                    className="flex items-center gap-2 px-4 py-2 bg-black text-white rounded hover:bg-gray-800 disabled:bg-gray-300 disabled:cursor-not-allowed"
                  >
                    <Play className="w-4 h-4" />
                    {isLaunching ? 'Launching...' : 'Launch backfill'}
                  </button>
                </div>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
