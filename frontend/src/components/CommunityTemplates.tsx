import { useState, useMemo, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Download, ExternalLink, X, ChevronRight, Package } from 'lucide-react';
import { List, type RowComponentProps } from 'react-window';
import { useProjectStore } from '@/hooks/useProject';
import { notify } from './Notifications';

interface ComponentTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  version: string;
  author: string;
  path: string;
  tags: string[];
  dependencies: {
    pip: string[];
  };
  icon?: string;
  supports_partitions?: boolean;
  readme_url: string;
  component_url: string;
  schema_url: string;
  example_url: string;
  requirements_url?: string;
  manifest_url?: string;
}

interface TemplateManifest {
  version: string;
  repository: string;
  last_updated: string;
  components: ComponentTemplate[];
}

interface ComponentDetails {
  component: ComponentTemplate;
  readme: string;
  schema: any;
  example: string;
}

interface RowExtraProps {
  components: ComponentTemplate[];
  onSelect: (c: ComponentTemplate) => void;
}

function TemplateRow({ index, style, components, onSelect }: RowComponentProps<RowExtraProps>) {
  const c = components[index];
  if (!c) return null;
  return (
    <div style={style} className="px-3">
      <button
        onClick={() => onSelect(c)}
        className="w-full h-full flex items-center gap-3 px-3 my-1 rounded-md border border-gray-200 bg-white hover:border-primary/40 hover:shadow-sm transition-colors text-left group"
      >
        <div className="w-8 h-8 rounded bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
          <Package className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold text-gray-900 truncate">{c.name}</span>
            <span className="text-[10px] uppercase tracking-wide bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded flex-shrink-0">
              {c.category}
            </span>
          </div>
          <div className="text-xs text-gray-500 truncate mt-0.5">{c.description}</div>
          {c.tags && c.tags.length > 0 && (
            <div className="flex items-center gap-1 mt-1 overflow-hidden">
              {c.tags.slice(0, 4).map((tag) => (
                <span key={tag} className="text-[10px] text-gray-400 bg-gray-50 px-1.5 py-0.5 rounded flex-shrink-0">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
        <ChevronRight className="w-4 h-4 text-gray-300 group-hover:text-gray-600 flex-shrink-0" />
      </button>
    </div>
  );
}

interface VirtualComponentListProps {
  components: ComponentTemplate[];
  rowHeight: number;
  onSelect: (c: ComponentTemplate) => void;
}

function VirtualComponentList({ components, rowHeight, onSelect }: VirtualComponentListProps) {
  // Measure the parent container so we can hand react-window an explicit pixel
  // height. Relying on `h-full` inside nested flex-1/min-h-0 chains has been
  // flaky (list rendered a scrollbar but wouldn't actually scroll).
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setHeight(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={containerRef} className="w-full h-full">
      {height > 0 && (
        <List
          style={{ height, width: '100%' }}
          rowComponent={TemplateRow}
          rowCount={components.length}
          rowHeight={rowHeight}
          rowProps={{ components, onSelect }}
          overscanCount={6}
        />
      )}
    </div>
  );
}

export function CommunityTemplates() {
  const { currentProject, loadProject } = useProjectStore();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedComponent, setSelectedComponent] = useState<ComponentTemplate | null>(null);

  const { data: manifest, isLoading, error } = useQuery({
    queryKey: ['community-templates-manifest'],
    queryFn: async () => {
      const response = await fetch('/api/v1/templates/manifest', {
        cache: 'no-store', // Disable browser caching
      });
      if (!response.ok) {
        throw new Error('Failed to fetch manifest');
      }
      return response.json() as Promise<TemplateManifest>;
    },
    staleTime: 0, // Always fetch fresh data
    gcTime: 0, // Don't keep old data in cache (formerly cacheTime)
  });

  const { data: componentDetails, isLoading: isLoadingDetails } = useQuery({
    queryKey: ['component-details', selectedComponent?.id],
    queryFn: async () => {
      if (!selectedComponent) return null;
      const response = await fetch(`/api/v1/templates/component/${selectedComponent.id}`);
      if (!response.ok) {
        throw new Error('Failed to fetch component details');
      }
      return response.json() as Promise<ComponentDetails>;
    },
    enabled: !!selectedComponent,
  });

  const installMutation = useMutation({
    mutationFn: async (component: ComponentTemplate) => {
      if (!currentProject) throw new Error('No project selected');

      const response = await fetch(`/api/v1/templates/install/${component.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: currentProject.id,
          config: {}, // Empty config for now
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: 'Unknown error' }));
        throw new Error(errorData.detail || 'Failed to install component');
      }

      return response.json();
    },
    onSuccess: (data) => {
      notify.success(`Component installed successfully!\n\nComponent: ${data.component_type}\nInstance: ${data.instance_name}\n\nFiles:\n${data.files_created.join('\n')}`);
      setSelectedComponent(null);
      // Invalidate installed components cache to refresh dropdowns
      if (currentProject) {
        queryClient.invalidateQueries({ queryKey: ['installed-components', currentProject.id] });
        loadProject(currentProject.id);
      }
    },
    onError: (error: Error) => {
      console.error('Installation error:', error);
      notify.error(`Failed to install component:\n\n${error.message}`);
    },
  });

  // Match a component against the current search query (independent of category).
  const searchMatches = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!manifest?.components) return () => false;
    if (!q) return () => true;
    return (c: ComponentTemplate) =>
      c.name.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q) ||
      c.tags.some((t) => t.toLowerCase().includes(q));
  }, [manifest, searchQuery]);

  // Category list + per-category counts that reflect the current search.
  // Sorted by count desc so the most useful categories are always leftmost
  // when the row is horizontally scrollable.
  const { categories, categoryCounts } = useMemo(() => {
    if (!manifest?.components) return { categories: ['all'], categoryCounts: {} as Record<string, number> };
    const counts: Record<string, number> = {};
    let allMatching = 0;
    manifest.components.forEach((c) => {
      if (searchMatches(c)) {
        counts[c.category] = (counts[c.category] || 0) + 1;
        allMatching++;
      }
    });
    const sorted = Object.keys(counts).sort((a, b) => (counts[b] - counts[a]) || a.localeCompare(b));
    return {
      categories: ['all', ...sorted],
      categoryCounts: { ...counts, all: allMatching },
    };
  }, [manifest, searchMatches]);

  const filteredComponents = useMemo(() => {
    if (!manifest?.components) return [];
    return manifest.components.filter((c) => {
      const matchesCategory = selectedCategory === 'all' || c.category === selectedCategory;
      return matchesCategory && searchMatches(c);
    });
  }, [manifest, searchMatches, selectedCategory]);

  const totalCount = manifest?.components.length ?? 0;

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-center">
        <Package className="w-16 h-16 text-gray-300 mb-4" />
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Failed to Load Components</h3>
        <p className="text-sm text-gray-600 mb-4">
          Could not fetch the community component manifest.
        </p>
        <p className="text-xs text-gray-500">
          Make sure the repository is accessible at:
          <br />
          <code className="bg-gray-100 px-2 py-1 rounded mt-1 inline-block">
            https://github.com/eric-thomas-dagster/dagster-component-templates
          </code>
        </p>
      </div>
    );
  }

  const formatCategoryLabel = (cat: string) =>
    cat === 'all'
      ? 'All'
      : cat === 'asset_checks'
      ? 'Asset Checks'
      : cat.split(/[_-]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  const ROW_HEIGHT = 88;

  return (
    <div className="h-full flex flex-col min-h-0 bg-gray-50">
      {/* Search and Filter — count sits inline; page title lives in the app header */}
      <div className="px-4 py-3 border-b bg-white space-y-2.5 flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search templates by name, description, or tag…"
              className="w-full pl-10 pr-4 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            />
          </div>
          <div className="flex-shrink-0 text-xs text-gray-500 tabular-nums">
            {isLoading
              ? 'Loading…'
              : `${filteredComponents.length.toLocaleString()} of ${totalCount.toLocaleString()}`}
          </div>
        </div>

        <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1" style={{ scrollbarWidth: 'thin' }}>
          {categories.map((cat) => {
            const active = selectedCategory === cat;
            const count = categoryCounts[cat] ?? 0;
            // Hide empty categories under the current search (except 'all').
            if (cat !== 'all' && count === 0) return null;
            return (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`flex-shrink-0 px-2.5 py-1 rounded-md text-xs font-medium transition-colors border whitespace-nowrap ${
                  active
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                }`}
              >
                {formatCategoryLabel(cat)}
                <span className={`ml-1.5 ${active ? 'text-white/70' : 'text-gray-400'}`}>{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Virtualized list */}
      <div className="flex-1 min-h-0">
        {isLoading ? (
          <div className="text-center py-8 text-gray-500">
            <div className="animate-pulse text-sm">Loading components…</div>
          </div>
        ) : filteredComponents.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <Package className="w-10 h-10 mx-auto mb-3 text-gray-300" />
            <p className="text-sm">No components match your search.</p>
          </div>
        ) : (
          <VirtualComponentList
            components={filteredComponents}
            rowHeight={ROW_HEIGHT}
            onSelect={setSelectedComponent}
          />
        )}
      </div>

      {/* Component Detail Modal */}
      {selectedComponent && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] flex flex-col">
            {/* Modal Header */}
            <div className="p-6 border-b flex-shrink-0">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <h2 className="text-2xl font-bold">{selectedComponent.name}</h2>
                    <span className="text-sm bg-blue-100 text-blue-800 px-2 py-1 rounded">
                      {selectedComponent.category}
                    </span>
                  </div>
                  <p className="text-gray-600">{selectedComponent.description}</p>
                  <div className="flex items-center gap-4 mt-2 text-sm text-gray-500">
                    <span>v{selectedComponent.version}</span>
                    <span>by {selectedComponent.author}</span>
                  </div>
                </div>
                <button
                  onClick={() => setSelectedComponent(null)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-6 min-h-0">
              {isLoadingDetails ? (
                <div className="text-center py-8">
                  <div className="animate-pulse">Loading details...</div>
                </div>
              ) : componentDetails ? (
                <div className="space-y-6">
                  {/* Dependencies */}
                  {selectedComponent.dependencies.pip.length > 0 && (
                    <div>
                      <h3 className="text-lg font-semibold mb-2">Dependencies</h3>
                      <div className="bg-gray-50 rounded-lg p-3">
                        <code className="text-sm">
                          {selectedComponent.dependencies.pip.join('\n')}
                        </code>
                      </div>
                    </div>
                  )}

                  {/* Tags */}
                  <div>
                    <h3 className="text-lg font-semibold mb-2">Tags</h3>
                    <div className="flex flex-wrap gap-2">
                      {selectedComponent.tags.map((tag) => (
                        <span
                          key={tag}
                          className="text-sm bg-gray-100 text-gray-700 px-3 py-1 rounded-full"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Example Configuration */}
                  <div>
                    <h3 className="text-lg font-semibold mb-2">Example Configuration</h3>
                    <div className="bg-gray-50 rounded-lg p-4 overflow-x-auto">
                      <pre className="text-sm">
                        <code>{componentDetails.example}</code>
                      </pre>
                    </div>
                  </div>

                  {/* README */}
                  <div>
                    <h3 className="text-lg font-semibold mb-2">Documentation</h3>
                    <div className="prose prose-sm max-w-none bg-gray-50 rounded-lg p-4">
                      <pre className="whitespace-pre-wrap text-sm">
                        {componentDetails.readme}
                      </pre>
                    </div>
                  </div>

                  {/* Links */}
                  <div>
                    <h3 className="text-lg font-semibold mb-2">Resources</h3>
                    <div className="flex flex-wrap gap-2">
                      <a
                        href={selectedComponent.component_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700"
                      >
                        <ExternalLink className="w-4 h-4" />
                        View Source Code
                      </a>
                      <a
                        href={manifest?.repository}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700"
                      >
                        <ExternalLink className="w-4 h-4" />
                        View Repository
                      </a>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            {/* Modal Footer */}
            <div className="p-6 border-t flex justify-end gap-3 bg-gray-50 flex-shrink-0">
              <button
                onClick={() => setSelectedComponent(null)}
                className="px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
              >
                Close
              </button>
              <button
                onClick={() => installMutation.mutate(selectedComponent)}
                disabled={installMutation.isPending || !currentProject}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Download className="w-4 h-4" />
                {installMutation.isPending ? 'Installing...' : 'Install Component'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
