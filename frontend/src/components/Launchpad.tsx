import { useState, useEffect } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import Editor from '@monaco-editor/react';
import { X, Play, Tag, AlertCircle, CheckCircle2, Calendar, Loader2 } from 'lucide-react';
import yaml from 'js-yaml';
import { partitionsApi, type PartitionDef } from '@/services/api';
import { useIsDarkMode } from '@/hooks/useIsDarkMode';

interface LaunchpadProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  mode: 'materialize' | 'job';
  assetKeys?: string[];
  jobName?: string;
  onLaunch: (config?: Record<string, any>, tags?: Record<string, string>, partition?: string) => Promise<void>;
  defaultConfig?: Record<string, any>;
  configSchema?: Record<string, any>;
}

export function Launchpad({
  open,
  onOpenChange,
  projectId,
  mode,
  assetKeys = [],
  jobName,
  onLaunch,
  defaultConfig = {},
  configSchema: _configSchema = {},
}: LaunchpadProps) {
  const isDark = useIsDarkMode();
  const [configYaml, setConfigYaml] = useState<string>('');
  const [tags, setTags] = useState<Record<string, string>>({});
  const [showTagEditor, setShowTagEditor] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [isLaunching, setIsLaunching] = useState(false);

  // Partition state
  const [partitionDef, setPartitionDef] = useState<PartitionDef | null>(null);
  const [selectedPartition, setSelectedPartition] = useState<string>('');
  const [loadingPartitions, setLoadingPartitions] = useState(false);

  // Initialize config YAML from defaultConfig
  useEffect(() => {
    if (open) {
      try {
        const yamlString = yaml.dump(defaultConfig || {});
        setConfigYaml(yamlString);
        setErrors([]);
      } catch (err) {
        console.error('Failed to serialize default config:', err);
        setConfigYaml('# Error loading default config\n');
      }
    }
  }, [open, defaultConfig]);

  // Fetch partition info for single-asset materialization, or for a job
  // -- a job's own constituent assets can be partitioned too (confirmed
  // live: `dg launch --job` rejects a partitioned job with no partition
  // key the exact same way it rejects a partitioned asset), but this
  // used to only ever check for `mode === 'materialize'`, so the job
  // Launchpad never showed a partition picker at all even when the job
  // genuinely needed one. A job can have several assets in its
  // selection; checking the first one is a reasonable proxy since a
  // job's assets are expected to share a compatible partition scheme
  // (that's what lets one `--partition` flag apply to the whole run).
  useEffect(() => {
    const checkKey = mode === 'materialize' ? (assetKeys.length === 1 ? assetKeys[0] : null)
      : mode === 'job' ? (assetKeys.length >= 1 ? assetKeys[0] : null)
      : null;
    if (open && checkKey) {
      setLoadingPartitions(true);
      setPartitionDef(null);
      setSelectedPartition('');

      partitionsApi
        .getPartitionInfo(projectId, checkKey)
        .then((response) => {
          if (response.is_partitioned && response.partitions_def) {
            setPartitionDef(response.partitions_def);
            // Auto-select latest partition
            const keys = response.partitions_def.partition_keys || [];
            if (keys.length > 0) {
              setSelectedPartition(keys[keys.length - 1]);
            }
          }
        })
        .catch((err) => {
          console.error('Failed to load partition info:', err);
        })
        .finally(() => {
          setLoadingPartitions(false);
        });
    } else {
      // Reset partition state if nothing to check
      setPartitionDef(null);
      setSelectedPartition('');
    }
  }, [open, mode, assetKeys, projectId]);

  // Validate YAML on change
  const handleEditorChange = (value: string | undefined) => {
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

  const handleLaunch = async () => {
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

    setIsLaunching(true);
    try {
      await onLaunch(
        config,
        Object.keys(tags).length > 0 ? tags : undefined,
        selectedPartition || undefined
      );
      onOpenChange(false);
    } catch (err: any) {
      setErrors([err.message || 'Launch failed']);
    } finally {
      setIsLaunching(false);
    }
  };

  const title = mode === 'materialize'
    ? `Launchpad (configure assets)`
    : `Launchpad (${jobName || 'job'})`;

  const buttonText = mode === 'materialize' ? 'Materialize' : 'Launch Run';

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-xl z-50 w-[90vw] h-[85vh] max-w-[1400px] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
            <div className="flex items-center gap-4">
              <div>
                <Dialog.Title className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                  <span className="text-gray-400">◇</span>
                  {title}
                </Dialog.Title>
                <Dialog.Description className="sr-only">
                  Configure run parameters including config and tags before launching
                </Dialog.Description>
              </div>

              {/* Partition selector -- shown as soon as we START checking
                  (not just once we've confirmed the asset/job IS
                  partitioned), so there's never a silent gap where the
                  user can't tell whether anything is loading at all.
                  Previously this whole block was gated on `partitionDef`,
                  which stays null for the entire fetch -- confirmed live,
                  reported as "the user thinks they can launch a job/asset
                  but need to wait" with no visible indication why. */}
              {(loadingPartitions || partitionDef) && (
                <div className="flex items-center gap-2 ml-4">
                  <Calendar className="w-4 h-4 text-gray-400" />
                  <label className="text-sm font-medium text-gray-700">Partition:</label>
                  {loadingPartitions ? (
                    <span className="inline-flex items-center gap-1.5 text-sm text-gray-500">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Checking for partitions…
                    </span>
                  ) : (
                    <select
                      value={selectedPartition}
                      onChange={(e) => setSelectedPartition(e.target.value)}
                      className="px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      {partitionDef!.partition_keys?.map((key) => (
                        <option key={key} value={key}>
                          {key}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              {assetKeys.length > 0 && (
                <span className="text-sm text-gray-600">
                  {assetKeys.length} asset{assetKeys.length !== 1 ? 's' : ''} selected
                </span>
              )}
              <button
                onClick={() => setShowTagEditor(!showTagEditor)}
                className="flex items-center gap-1 px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50"
              >
                <Tag className="w-4 h-4" />
                Edit tags
              </button>
              <Dialog.Close className="p-2 hover:bg-gray-100 rounded">
                <X className="w-5 h-5" />
              </Dialog.Close>
            </div>
          </div>

          {/* Tag Editor (collapsible) */}
          {showTagEditor && (
            <div className="px-6 py-3 bg-gray-50 border-b border-gray-200">
              <div className="text-sm font-medium mb-2">Tags</div>
              <div className="flex gap-2 flex-wrap">
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
            </div>
          )}

          {/* Main Content */}
          <div className="flex-1 flex overflow-hidden">
            {/* Left Panel - YAML Editor */}
            <div className="flex-1 flex flex-col border-r border-gray-200">
              <div className="flex-1 overflow-hidden">
                <Editor
                  height="100%"
                  defaultLanguage="yaml"
                  value={configYaml}
                  onChange={handleEditorChange}
                  theme={isDark ? 'vs-dark' : 'vs-light'}
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
            </div>

            {/* Right Panel - Schema Documentation */}
            <div className="w-96 flex flex-col bg-gray-50">
              <div className="flex-1 overflow-y-auto p-4">
                <div className="text-xs text-gray-500 mb-4">
                  <div className="font-mono mb-2">{'{'}</div>
                  <div className="pl-4">
                    <div className="mb-2">
                      <span className="text-gray-700">/* Configure how steps are executed within a run. */</span>
                      <div className="mt-1">
                        <span className="text-blue-600">execution</span>
                        <span>: {'{'}</span>
                      </div>
                      <div className="pl-4">
                        <span className="text-blue-600">config</span>: Any
                      </div>
                      <div>{'}'}</div>
                    </div>

                    <div className="mb-2">
                      <span className="text-gray-700">/* Configure how loggers emit messages within a run. */</span>
                      <div className="mt-1">
                        <span className="text-blue-600">loggers</span>
                        <span>: {'{'}</span>
                      </div>
                      <div className="pl-4">
                        <span className="text-blue-600">console</span>: ...
                      </div>
                      <div>{'}'}</div>
                    </div>

                    <div className="mb-2">
                      <span className="text-gray-700">/* Configure runtime parameters for ops or assets. */</span>
                      <div className="mt-1">
                        <span className="text-blue-600">ops</span>
                        <span>: {'{'}</span>
                      </div>
                      <div className="pl-4 text-gray-500">
                        /* Asset-specific configuration */
                      </div>
                      <div>{'}'}</div>
                    </div>
                  </div>
                  <div className="font-mono">{'}'}</div>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom Section */}
          <div className="border-t border-gray-200">
            <Tabs.Root defaultValue="errors" className="w-full">
              <div className="flex items-center justify-between px-6 py-2 border-b border-gray-200">
                <Tabs.List className="flex gap-4">
                  <Tabs.Trigger
                    value="errors"
                    className="px-3 py-1.5 text-sm font-medium text-gray-600 hover:text-gray-900 data-[state=active]:text-blue-600 data-[state=active]:border-b-2 data-[state=active]:border-blue-600"
                  >
                    ERRORS
                  </Tabs.Trigger>
                  <Tabs.Trigger
                    value="assets"
                    className="px-3 py-1.5 text-sm font-medium text-gray-600 hover:text-gray-900 data-[state=active]:text-blue-600 data-[state=active]:border-b-2 data-[state=active]:border-blue-600"
                  >
                    ASSETS
                  </Tabs.Trigger>
                </Tabs.List>

                <button
                  onClick={handleLaunch}
                  disabled={isLaunching || errors.length > 0 || loadingPartitions}
                  title={loadingPartitions ? 'Still checking whether this needs a partition…' : undefined}
                  className="flex items-center gap-2 px-4 py-2 bg-black text-white rounded hover:bg-gray-800 disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  <Play className="w-4 h-4" />
                  {isLaunching ? 'Launching...' : loadingPartitions ? 'Checking…' : buttonText}
                </button>
              </div>

              <Tabs.Content value="errors" className="px-6 py-3 h-24 overflow-y-auto">
                {errors.length === 0 ? (
                  <div className="flex items-center gap-2 text-sm text-green-600">
                    <CheckCircle2 className="w-4 h-4" />
                    No errors
                  </div>
                ) : (
                  <div className="space-y-2">
                    {errors.map((error, i) => (
                      <div key={i} className="flex items-start gap-2 text-sm text-red-600">
                        <AlertCircle className="w-4 h-4 mt-0.5" />
                        <span>{error}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Tabs.Content>

              <Tabs.Content value="assets" className="px-6 py-3 h-24 overflow-y-auto">
                <div className="flex flex-wrap gap-2">
                  {assetKeys.map((key) => (
                    <span
                      key={key}
                      className="px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded font-mono"
                    >
                      {key}
                    </span>
                  ))}
                  {assetKeys.length === 0 && (
                    <span className="text-sm text-gray-500">No assets selected</span>
                  )}
                </div>
              </Tabs.Content>
            </Tabs.Root>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
