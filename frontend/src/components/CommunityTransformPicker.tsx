import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Search, Package, Loader2, Download, Info } from 'lucide-react';
import { notify } from './Notifications';

interface ManifestComponent {
  id: string;
  name: string;
  category: string;
  description?: string;
  tags?: string[];
}

interface CommunityTransformPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** The upstream asset this transform will chain onto. */
  upstreamAssetKey: string;
  /** Called after a successful install with the new component's canonical
      type + suggested instance name so the caller can refresh the graph
      and (optionally) open the config modal. */
  onInstalled: (result: { componentType: string; instanceName: string }) => void;
}

/**
 * A focused picker for community "transformation" components. Opens over the
 * DataPreviewModal (or wherever) to let the user pick a transform that isn't
 * already covered by the built-in visual builder — one of the ~124 items in
 * the community manifest. Picking one installs it via the CLI with the
 * current asset pre-wired as its upstream.
 */
export function CommunityTransformPicker({
  open,
  onOpenChange,
  projectId,
  upstreamAssetKey,
  onInstalled,
}: CommunityTransformPickerProps) {
  const [query, setQuery] = useState('');
  const [installingId, setInstallingId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: manifest, isLoading } = useQuery({
    queryKey: ['community-templates-manifest'],
    queryFn: async () => {
      const res = await fetch('/api/v1/templates/manifest');
      if (!res.ok) throw new Error('Failed to load manifest');
      return res.json() as Promise<{ components: ManifestComponent[] }>;
    },
    staleTime: 15 * 60 * 1000,
    enabled: open,
  });

  const filtered = useMemo<ManifestComponent[]>(() => {
    if (!manifest?.components) return [];
    const q = query.toLowerCase().trim();
    return manifest.components
      .filter((c) => c.category === 'transformation')
      .filter((c) => {
        if (!q) return true;
        const hay = `${c.name} ${c.description || ''} ${(c.tags || []).join(' ')}`.toLowerCase();
        return hay.includes(q);
      });
  }, [manifest, query]);

  const installMutation = useMutation({
    mutationFn: async (componentId: string) => {
      setInstallingId(componentId);
      // Derive a sensible default instance name from the component id + the
      // upstream key (last segment). e.g. "unique_dedup__stg_customers".
      const upstreamShort = upstreamAssetKey.split('/').pop() || 'input';
      const instanceName = `${componentId}__${upstreamShort}`.replace(/[^a-zA-Z0-9_]/g, '_');
      const res = await fetch(`/api/v1/templates/install-via-cli/${componentId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          config: {},
          instance_name: instanceName,
          attributes: {
            asset_name: instanceName,
            upstream_asset_keys: upstreamAssetKey,
          },
        }),
      });
      const body = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(body.detail || 'Install failed');
      return { componentType: body.component_type as string, instanceName };
    },
    onSuccess: async (result) => {
      notify.success(`Installed. New asset "${result.instanceName}" chained onto ${upstreamAssetKey}.`);
      await queryClient.invalidateQueries({ queryKey: ['installed-components', projectId] });
      onInstalled(result);
      onOpenChange(false);
    },
    onError: (e: Error) => notify.error(`Install failed: ${e.message}`),
    onSettled: () => setInstallingId(null),
  });

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-[60]" />
        <Dialog.Content
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="fixed left-1/2 top-1/2 z-[60] -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl max-h-[80vh] bg-white rounded-lg shadow-2xl flex flex-col overflow-hidden"
        >
          <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-gray-200">
            <div>
              <Dialog.Title className="text-base font-semibold text-gray-900">
                Add community transform
              </Dialog.Title>
              <Dialog.Description className="text-xs text-gray-500 mt-0.5">
                Pick one of 124+ community transformation components. Installs
                via the CLI and chains onto{' '}
                <span className="font-mono text-gray-700">{upstreamAssetKey}</span>.
              </Dialog.Description>
            </div>
            <button
              onClick={() => onOpenChange(false)}
              className="p-1 text-gray-400 hover:text-gray-600 rounded"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex-shrink-0 px-4 py-2 border-b border-gray-200">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by name, description, or tag…"
                className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                autoFocus
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto min-h-0 p-2 space-y-1">
            {isLoading && (
              <div className="flex items-center justify-center py-8 text-gray-500 text-sm gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading catalog…
              </div>
            )}

            {!isLoading && filtered.length === 0 && (
              <div className="text-center py-8 text-gray-400 text-sm">
                No transformations match "{query}".
              </div>
            )}

            {filtered.map((c) => {
              const isInstalling = installingId === c.id;
              return (
                <button
                  key={c.id}
                  onClick={() => !isInstalling && installMutation.mutate(c.id)}
                  disabled={isInstalling}
                  className="w-full flex items-start gap-3 px-3 py-2.5 text-left rounded-md hover:bg-gray-50 disabled:opacity-60 group border border-transparent hover:border-gray-200"
                >
                  <div className="w-8 h-8 rounded bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
                    <Package className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-semibold text-gray-900 truncate">
                        {c.name}
                      </span>
                      <span className="text-[10px] text-gray-400 font-mono truncate">
                        {c.id}
                      </span>
                    </div>
                    {c.description && (
                      <div className="text-xs text-gray-500 mt-0.5 line-clamp-2">
                        {c.description}
                      </div>
                    )}
                    {c.tags && c.tags.length > 0 && (
                      <div className="flex items-center gap-1 mt-1 flex-wrap">
                        {c.tags.slice(0, 4).map((t) => (
                          <span
                            key={t}
                            className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {isInstalling ? (
                    <Loader2 className="w-4 h-4 text-primary animate-spin flex-shrink-0" />
                  ) : (
                    <Download className="w-4 h-4 text-gray-300 group-hover:text-primary flex-shrink-0" />
                  )}
                </button>
              );
            })}
          </div>

          <div className="flex-shrink-0 border-t border-gray-200 px-4 py-2 bg-gray-50 flex items-center gap-2 text-[11px] text-gray-500">
            <Info className="w-3.5 h-3.5" />
            <span>
              Install takes ~5–30 seconds. You'll configure the new asset's
              attributes from the graph after install.
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
