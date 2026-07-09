import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Cloud, MapPin, X, Loader2, Plus } from 'lucide-react';
import { notify, confirmDialog } from './Notifications';

interface DagsterCloudLocation {
  location_name: string;
  module_name?: string | null;
  package_name?: string | null;
  executable_path?: string | null;
  build_directory?: string | null;
  build_registry?: string | null;
}

interface DagsterCloudConfig {
  exists: boolean;
  path: string | null;
  locations: DagsterCloudLocation[];
  raw_yaml: string | null;
}

interface DagsterCloudChipProps {
  projectId: string;
}

export function DagsterCloudChip({ projectId }: DagsterCloudChipProps) {
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<DagsterCloudLocation[]>([]);

  const { data: config, isLoading } = useQuery({
    queryKey: ['dagster-cloud', projectId],
    queryFn: async (): Promise<DagsterCloudConfig> => {
      const res = await fetch(`/api/v1/projects/${projectId}/dagster-cloud`);
      if (!res.ok) throw new Error('Failed to load dagster_cloud.yaml');
      return res.json();
    },
    enabled: !!projectId,
    staleTime: 30_000,
  });

  const scaffoldMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v1/projects/${projectId}/dagster-cloud/scaffold`, { method: 'POST' });
      if (!res.ok) throw new Error('Scaffold failed');
      return res.json() as Promise<DagsterCloudConfig>;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['dagster-cloud', projectId], data);
      notify.success('Created dagster_cloud.yaml with defaults.');
      openEditor(data);
    },
    onError: (e: Error) => notify.error(`Scaffold failed: ${e.message}`),
  });

  const saveMutation = useMutation({
    mutationFn: async (locations: DagsterCloudLocation[]) => {
      const res = await fetch(`/api/v1/projects/${projectId}/dagster-cloud`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locations }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Save failed');
      return data as DagsterCloudConfig;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['dagster-cloud', projectId], data);
      notify.success('Saved dagster_cloud.yaml.');
      setModalOpen(false);
    },
    onError: (e: Error) => notify.error(`Save failed: ${e.message}`),
  });

  const openEditor = (c?: DagsterCloudConfig) => {
    const src = c ?? config;
    if (src && src.locations.length > 0) {
      setEditing(src.locations.map((l) => ({ ...l })));
    } else {
      setEditing([{
        location_name: '',
        module_name: null,
        package_name: null,
        executable_path: null,
        build_directory: null,
        build_registry: null,
      }]);
    }
    setModalOpen(true);
  };

  const handleScaffold = async () => {
    scaffoldMutation.mutate();
  };

  const handleSave = () => {
    // Validate.
    for (const loc of editing) {
      if (!loc.location_name.trim()) {
        notify.error('Every location needs a location_name');
        return;
      }
    }
    saveMutation.mutate(editing);
  };

  const updateLocation = (i: number, patch: Partial<DagsterCloudLocation>) => {
    setEditing((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  };

  const removeLocation = async (i: number) => {
    if (editing.length === 1) {
      notify.warning('You need at least one location. Delete the file entirely to remove it.');
      return;
    }
    const confirmed = await confirmDialog(
      `Remove location "${editing[i].location_name || `entry #${i + 1}`}"?`,
      { destructive: true },
    );
    if (!confirmed) return;
    setEditing((prev) => prev.filter((_, idx) => idx !== i));
  };

  const addLocation = () => {
    setEditing((prev) => [
      ...prev,
      { location_name: '', module_name: null, package_name: null, executable_path: null, build_directory: null, build_registry: null },
    ]);
  };

  // Chip UI
  const label = isLoading
    ? '…'
    : !config?.exists
    ? 'No code location'
    : config.locations.length === 1
    ? config.locations[0].location_name || '(unnamed)'
    : `${config.locations.length} locations`;

  return (
    <>
      <button
        onClick={() => (config?.exists ? openEditor() : handleScaffold())}
        disabled={isLoading || scaffoldMutation.isPending}
        className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-gray-200 bg-white text-gray-700 hover:border-primary/40 hover:bg-primary/5 disabled:opacity-50"
        title={
          !config?.exists
            ? 'No dagster_cloud.yaml. Click to scaffold one.'
            : `Edit dagster_cloud.yaml (${config.path})`
        }
      >
        {config?.exists ? <MapPin className="w-3.5 h-3.5 text-primary" /> : <Cloud className="w-3.5 h-3.5 text-gray-400" />}
        <span>{label}</span>
      </button>

      {modalOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-6"
          onClick={() => !saveMutation.isPending && setModalOpen(false)}
        >
          <div
            className="bg-white rounded-lg shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
              <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <Cloud className="w-4 h-4 text-primary" />
                dagster_cloud.yaml
                {config?.path && (
                  <span className="text-xs text-gray-400 font-normal font-mono">{config.path}</span>
                )}
              </h2>
              <button
                onClick={() => setModalOpen(false)}
                disabled={saveMutation.isPending}
                className="p-1 text-gray-400 hover:text-gray-600 rounded"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              <p className="text-xs text-gray-600">
                Each location tells Dagster+ where to find your code. See{' '}
                <a
                  href="https://docs.dagster.io/deployment/dagster-plus/full-deployments/code-locations"
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:no-underline text-primary"
                >
                  code locations docs
                </a>.
              </p>

              {editing.map((loc, i) => (
                <div key={i} className="border border-gray-200 rounded-lg p-4 space-y-2 bg-gray-50">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-gray-600 uppercase tracking-wider">Location #{i + 1}</label>
                    <button
                      onClick={() => removeLocation(i)}
                      className="text-xs text-red-600 hover:underline"
                    >
                      Remove
                    </button>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">location_name <span className="text-red-500">*</span></label>
                    <input
                      type="text"
                      value={loc.location_name}
                      onChange={(e) => updateLocation(i, { location_name: e.target.value })}
                      placeholder="my_project"
                      className="w-full px-3 py-1.5 text-sm font-mono border border-gray-300 rounded"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">module_name</label>
                      <input
                        type="text"
                        value={loc.module_name || ''}
                        onChange={(e) => updateLocation(i, { module_name: e.target.value || null })}
                        placeholder="my_project.definitions"
                        className="w-full px-3 py-1.5 text-sm font-mono border border-gray-300 rounded"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">package_name</label>
                      <input
                        type="text"
                        value={loc.package_name || ''}
                        onChange={(e) => updateLocation(i, { package_name: e.target.value || null })}
                        placeholder="my_project"
                        className="w-full px-3 py-1.5 text-sm font-mono border border-gray-300 rounded"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">build.directory</label>
                      <input
                        type="text"
                        value={loc.build_directory || ''}
                        onChange={(e) => updateLocation(i, { build_directory: e.target.value || null })}
                        placeholder="."
                        className="w-full px-3 py-1.5 text-sm font-mono border border-gray-300 rounded"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">build.registry</label>
                      <input
                        type="text"
                        value={loc.build_registry || ''}
                        onChange={(e) => updateLocation(i, { build_registry: e.target.value || null })}
                        placeholder="my-registry"
                        className="w-full px-3 py-1.5 text-sm font-mono border border-gray-300 rounded"
                      />
                    </div>
                  </div>
                </div>
              ))}

              <button
                onClick={addLocation}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-sm text-primary hover:bg-primary/5 rounded"
              >
                <Plus className="w-4 h-4" />
                Add another location
              </button>
            </div>

            <div className="flex-shrink-0 px-5 py-3 border-t border-gray-200 flex justify-end gap-2">
              <button
                onClick={() => setModalOpen(false)}
                disabled={saveMutation.isPending}
                className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saveMutation.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded hover:bg-accent disabled:opacity-50"
              >
                {saveMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
