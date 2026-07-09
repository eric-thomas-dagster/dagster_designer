import { useMemo, useState } from 'react';
import { useComponentRegistry } from '@/hooks/useComponentRegistry';
import { Database, ArrowRight, Download, RefreshCw, Box, Search, Plus, Code, FileText, Play, Clock, Radar, CheckCircle, FileCode, Package, Loader2, Cloud } from 'lucide-react';
import { CreatePythonAssetDialog } from './CreatePythonAssetDialog';
import { useProjectStore } from '@/hooks/useProject';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notify } from './Notifications';

const iconMap: Record<string, React.ComponentType<any>> = {
  database: Database,
  'arrow-right': ArrowRight,
  download: Download,
  sync: RefreshCw,
  cube: Box,
  code: Code,
  'file-text': FileText,
  play: Play,
  clock: Clock,
  radar: Radar,
  'check-circle': CheckCircle,
};

interface ComponentPaletteProps {
  onComponentClick: (componentType: string) => void;
}

interface ManifestComponent {
  id: string;
  name: string;
  category: string;
  description: string;
  tags?: string[];
}

export function ComponentPalette({ onComponentClick }: ComponentPaletteProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | undefined>();
  const [showCreateAssetDialog, setShowCreateAssetDialog] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const { data, isLoading } = useComponentRegistry(selectedCategory);
  const { currentProject, loadProject } = useProjectStore();
  const queryClient = useQueryClient();

  // Fetch installed community components
  const { data: installedComponents } = useQuery({
    queryKey: ['installed-components', currentProject?.id],
    queryFn: async () => {
      if (!currentProject) return { components: [] };
      const response = await fetch(`/api/v1/templates/installed/${currentProject.id}`);
      if (!response.ok) return { components: [] };
      return response.json() as Promise<{ components: Array<{ id: string; name: string; description: string; component_type: string; category: string }> }>;
    },
    enabled: !!currentProject,
  });

  // Fetch the full community-templates manifest up-front — the palette
  // browses ALL of it (grouped by category), not just search results.
  // ~900 items but it's a single JSON blob and react-query caches it.
  const searchActive = searchQuery.trim().length > 0;
  const { data: manifest, isLoading: isLoadingManifest } = useQuery({
    queryKey: ['community-templates-manifest'],
    queryFn: async () => {
      const res = await fetch('/api/v1/templates/manifest');
      if (!res.ok) throw new Error('Failed to load community manifest');
      return res.json() as Promise<{ components: ManifestComponent[] }>;
    },
    staleTime: 15 * 60 * 1000,
  });

  // Uses the official dagster-community-components-cli (via `uvx`). The CLI
  // owns file layout + dependency install; the backend returns the canonical
  // `component_type` it wrote into defs.yaml so we can drop the node.
  const installMutation = useMutation({
    mutationFn: async (componentId: string) => {
      if (!currentProject) throw new Error('No project selected');
      setInstallingId(componentId);
      const res = await fetch(`/api/v1/templates/install-via-cli/${componentId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: currentProject.id, config: {} }),
      });
      const body = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(body.detail || 'Install failed');
      return body as { component_type: string };
    },
    onSuccess: async (data) => {
      notify.success('Component installed. Adding to graph…');
      if (currentProject) {
        await queryClient.invalidateQueries({ queryKey: ['installed-components', currentProject.id] });
        await loadProject(currentProject.id);
      }
      onComponentClick(data.component_type);
    },
    onError: (e: Error) => notify.error(`Install failed: ${e.message}`),
    onSettled: () => setInstallingId(null),
  });

  // The palette is for asset-producing components only. Anything that returns
  // a non-asset primitive (resource, io manager, sensor, schedule, job, asset
  // check, infra utility) is managed in the Resources or Automation tabs, so
  // exclude those categories here. Category names come straight from each
  // source's manifest — we filter by the category field rather than by
  // substring on `type`, which is unreliable for community components.
  const NON_ASSET_CATEGORIES = new Set([
    'resource', 'resources',
    'sensor', 'sensors',
    'schedule', 'schedules',
    'job', 'jobs',
    'io_manager', 'io_managers',
    'check', 'checks', 'asset_check', 'asset_checks',
    'infrastructure',
  ]);
  const isAssetProducing = (category: string | undefined) =>
    !NON_ASSET_CATEGORIES.has((category || '').toLowerCase());

  const assetComponents = (data?.components || []).filter((comp) => isAssetProducing(comp.category));

  const q = searchQuery.toLowerCase().trim();
  const matchesQuery = (name: string, description?: string, category?: string) => {
    if (!q) return true;
    return (
      name.toLowerCase().includes(q) ||
      (description || '').toLowerCase().includes(q) ||
      (category || '').toLowerCase().includes(q)
    );
  };

  const filteredComponents = assetComponents.filter((comp) =>
    matchesQuery(comp.name, comp.description, comp.category),
  );

  // Filter Python Asset button based on search
  const showPythonAsset = q === '' || 'python asset'.includes(q) || 'python'.includes(q);

  // Filter installed community components — asset-producing only, and match search.
  const filteredInstalledComponents = (installedComponents?.components || []).filter(
    (comp) => isAssetProducing(comp.category) && matchesQuery(comp.name, comp.description, comp.category),
  );

  // Every uninstalled manifest component that matches the current search
  // (empty search matches all). We surface these in the palette alongside
  // installed + registry entries, grouped into the same category buckets, so
  // users can browse the full catalog by category without needing to search.
  const installedIds = useMemo(
    () => new Set((installedComponents?.components || []).map((c) => c.id)),
    [installedComponents],
  );
  const filteredAvailableComponents = useMemo<ManifestComponent[]>(() => {
    if (!manifest?.components) return [];
    return manifest.components.filter(
      (c) =>
        !installedIds.has(c.id) &&
        isAssetProducing(c.category) &&
        matchesQuery(c.name, c.description, c.category),
    );
  }, [manifest, installedIds, q]);

  // Unified category buckets across registry + installed community components.
  // Category strings come straight from each source's own manifest — we do
  // not invent our own taxonomy. When a category chip is selected, we filter
  // to just that bucket; otherwise we render every bucket as its own section
  // with a header + count, ordered by size descending.
  type PaletteEntry =
    | { kind: 'registry'; component: (typeof filteredComponents)[number] }
    | { kind: 'installed'; component: (typeof filteredInstalledComponents)[number] }
    | { kind: 'available'; component: ManifestComponent };

  const groupedByCategory = useMemo(() => {
    const buckets = new Map<string, PaletteEntry[]>();
    const push = (cat: string, entry: PaletteEntry) => {
      const key = cat || 'other';
      const arr = buckets.get(key) ?? [];
      arr.push(entry);
      buckets.set(key, arr);
    };
    // Order: registry first (built-in), then installed community, then
    // available-to-install. Within each source we keep manifest order so the
    // ranking stays stable across renders.
    for (const c of filteredComponents) push(c.category, { kind: 'registry', component: c });
    for (const c of filteredInstalledComponents) push(c.category, { kind: 'installed', component: c });
    for (const c of filteredAvailableComponents) push(c.category, { kind: 'available', component: c });
    return buckets;
  }, [filteredComponents, filteredInstalledComponents, filteredAvailableComponents]);

  const categoriesSorted = useMemo(
    () =>
      Array.from(groupedByCategory.entries())
        .sort(([, a], [, b]) => b.length - a.length || 0)
        .map(([cat]) => cat),
    [groupedByCategory],
  );

  const formatCategoryLabel = (cat: string) =>
    cat === 'io_manager'
      ? 'IO Managers'
      : cat.split(/[_-]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  const handleAssetCreated = async () => {
    // Reload the project to pick up the new asset
    if (currentProject) {
      await loadProject(currentProject.id);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header with Search */}
      <div className="p-3 border-b border-gray-200 bg-white">
        {/* Search */}
        <div className="relative mb-2">
          <Search className="absolute left-2.5 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Category filter — chips reflect the categories present in the
             current data (registry + installed), sorted by count desc. */}
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setSelectedCategory(undefined)}
            className={`px-2.5 py-1 text-xs rounded-full ${
              !selectedCategory
                ? 'bg-primary text-primary-foreground'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            All
          </button>
          {categoriesSorted.map((category) => (
            <button
              key={category}
              onClick={() => setSelectedCategory(category)}
              className={`px-2.5 py-1 text-xs rounded-full ${
                selectedCategory === category
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {formatCategoryLabel(category)}
              <span className={`ml-1 ${selectedCategory === category ? 'text-white/70' : 'text-gray-400'}`}>
                {groupedByCategory.get(category)?.length ?? 0}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Component list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
        {isLoading && (
          <div className="text-center text-sm text-gray-500 py-8">
            Loading components...
          </div>
        )}

        {!isLoading && (
          <>
            {/* Python Asset — always at the top; not tied to any manifest category. */}
            {showPythonAsset && !selectedCategory && (
              <button
                onClick={() => setShowCreateAssetDialog(true)}
                className="w-full flex items-center space-x-2 px-2.5 py-2 bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-md hover:border-blue-400 transition-all group"
              >
                <FileCode className="w-4 h-4 text-blue-600" />
                <span className="text-sm font-medium text-gray-900">Python Asset</span>
                <Plus className="w-3.5 h-3.5 text-blue-400 ml-auto group-hover:text-blue-600" />
              </button>
            )}

            {/* Community-manifest still loading? Show a subtle inline note so
                users know more will appear soon; registry + installed keep
                rendering immediately below. */}
            {isLoadingManifest && !selectedCategory && !searchActive && (
              <div className="text-xs text-gray-400 px-1 py-1 flex items-center gap-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Loading community catalog…
              </div>
            )}

            {/* Category sections — one per bucket, headers sorted by count desc.
                In the "All" view we cap each section at PER_SECTION_CAP entries
                and offer a "Show all N" affordance that jumps to that category
                filter. When a category is already selected, all entries show. */}
            {categoriesSorted
              .filter((cat) => !selectedCategory || cat === selectedCategory)
              .map((cat) => {
                const entries = groupedByCategory.get(cat) ?? [];
                if (entries.length === 0) return null;
                const isFocused = selectedCategory === cat || searchActive;
                const PER_SECTION_CAP = 8;
                const visible = isFocused ? entries : entries.slice(0, PER_SECTION_CAP);
                const hiddenCount = entries.length - visible.length;
                return (
                  <div key={cat} className="space-y-1.5">
                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider px-1 pt-2 flex items-center justify-between">
                      <span>{formatCategoryLabel(cat)}</span>
                      <span className="text-gray-400 font-normal">{entries.length}</span>
                    </div>
                    {visible.map((entry, i) => {
                      if (entry.kind === 'installed') {
                        const comp = entry.component;
                        return (
                          <button
                            key={`inst-${comp.id}-${i}`}
                            onClick={() => onComponentClick(comp.component_type)}
                            draggable
                            onDragStart={(e) => {
                              // Match registry drag payload shape so GraphEditor's
                              // onDrop handler doesn't need special-casing.
                              e.dataTransfer.setData(
                                'application/reactflow',
                                JSON.stringify({
                                  type: comp.component_type,
                                  name: comp.name,
                                  category: comp.category,
                                  description: comp.description,
                                }),
                              );
                              e.dataTransfer.effectAllowed = 'move';
                            }}
                            title={comp.description || comp.name}
                            className="w-full flex items-center space-x-2 px-2.5 py-2 bg-gradient-to-br from-purple-50 to-pink-50 border border-purple-200 rounded-md hover:border-purple-400 transition-all group text-left cursor-move"
                          >
                            <Package className="w-4 h-4 text-purple-600 flex-shrink-0" />
                            <span className="text-sm font-medium text-gray-900 truncate flex-1">{comp.name}</span>
                            <Plus className="w-3.5 h-3.5 text-purple-400 ml-auto group-hover:text-purple-600 flex-shrink-0" />
                          </button>
                        );
                      }
                      if (entry.kind === 'available') {
                        const comp = entry.component;
                        const isInstalling = installingId === comp.id;
                        return (
                          <button
                            key={`avail-${comp.id}-${i}`}
                            onClick={() => !isInstalling && installMutation.mutate(comp.id)}
                            disabled={isInstalling}
                            title={comp.description || comp.name}
                            className="w-full flex items-center space-x-2 px-2.5 py-2 border border-dashed border-gray-300 bg-white rounded-md hover:border-primary/50 hover:bg-primary/5 transition-all group text-left disabled:opacity-60"
                          >
                            <Cloud className="w-4 h-4 text-gray-400 group-hover:text-primary flex-shrink-0" />
                            <span className="text-sm text-gray-900 truncate flex-1">{comp.name}</span>
                            {isInstalling ? (
                              <Loader2 className="w-3.5 h-3.5 text-primary animate-spin flex-shrink-0" />
                            ) : (
                              <Download className="w-3.5 h-3.5 text-gray-400 group-hover:text-primary flex-shrink-0" />
                            )}
                          </button>
                        );
                      }
                      const component = entry.component;
                      const Icon = iconMap[component.icon || 'cube'] || Box;
                      const isPrimitive = component.category === 'primitives';
                      return (
                        <button
                          key={`reg-${component.type}-${i}`}
                          onClick={() => onComponentClick(component.type)}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData('application/reactflow', JSON.stringify(component));
                            e.dataTransfer.effectAllowed = 'move';
                          }}
                          title={component.description || component.name}
                          className={`w-full flex items-center space-x-2 px-2.5 py-2 ${
                            isPrimitive
                              ? 'bg-gradient-to-br from-purple-50 to-blue-50 border border-purple-200 hover:border-purple-400'
                              : 'bg-gradient-to-br from-green-50 to-teal-50 border border-green-200 hover:border-green-400'
                          } rounded-md transition-all group cursor-move text-left`}
                        >
                          <Icon className={`w-4 h-4 flex-shrink-0 ${isPrimitive ? 'text-purple-600' : 'text-green-600'}`} />
                          <span className="text-sm font-medium text-gray-900 truncate flex-1">{component.name}</span>
                          <Plus className={`w-3.5 h-3.5 flex-shrink-0 ml-auto ${isPrimitive ? 'text-purple-400 group-hover:text-purple-600' : 'text-green-400 group-hover:text-green-600'}`} />
                        </button>
                      );
                    })}
                    {hiddenCount > 0 && (
                      <button
                        onClick={() => setSelectedCategory(cat)}
                        className="w-full text-left text-xs text-primary hover:underline px-1 py-1"
                      >
                        Show all {entries.length} in {formatCategoryLabel(cat)} →
                      </button>
                    )}
                  </div>
                );
              })}

            {/* No results message */}
            {!showPythonAsset && categoriesSorted.length === 0 && !isLoadingManifest && (
              <div className="text-center text-sm text-gray-500 py-8">
                No components found
              </div>
            )}
          </>
        )}
      </div>

      {/* Create Python Asset Dialog */}
      {showCreateAssetDialog && currentProject && (
        <CreatePythonAssetDialog
          projectId={currentProject.id}
          onClose={() => setShowCreateAssetDialog(false)}
          onSuccess={handleAssetCreated}
        />
      )}
    </div>
  );
}
