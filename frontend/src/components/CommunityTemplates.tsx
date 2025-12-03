import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Download, ExternalLink, Tag, X, ChevronRight, Package } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';

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
      alert(`Component installed successfully!\n\nComponent: ${data.component_type}\nInstance: ${data.instance_name}\n\nFiles:\n${data.files_created.join('\n')}`);
      setSelectedComponent(null);
      // Invalidate installed components cache to refresh dropdowns
      if (currentProject) {
        queryClient.invalidateQueries({ queryKey: ['installed-components', currentProject.id] });
        loadProject(currentProject.id);
      }
    },
    onError: (error: Error) => {
      console.error('Installation error:', error);
      alert(`Failed to install component:\n\n${error.message}`);
    },
  });

  // Dynamically extract unique categories from manifest
  const categories = ['all', ...(manifest?.components
    ? Array.from(new Set(manifest.components.map(c => c.category))).sort()
    : [])];

  const filteredComponents = manifest?.components.filter((c) => {
    const matchesSearch =
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.tags.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()));
    const matchesCategory = selectedCategory === 'all' || c.category === selectedCategory;
    return matchesSearch && matchesCategory;
  }) || [];

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

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="p-4 border-b bg-white flex-shrink-0">
        <h2 className="text-xl font-semibold mb-2">Community Component Templates</h2>
        <p className="text-sm text-gray-600">
          Browse and install reusable Dagster components from the community
        </p>
      </div>

      {/* Search and Filter */}
      <div className="p-4 border-b bg-white space-y-3 flex-shrink-0">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search components..."
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="flex gap-2 flex-wrap">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
                selectedCategory === cat
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {cat === 'asset_checks'
                ? 'Asset Checks'
                : cat.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')}
            </button>
          ))}
        </div>
      </div>

      {/* Component Grid */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 bg-gray-50">
        {isLoading ? (
          <div className="text-center py-8 text-gray-500">
            <div className="animate-pulse">Loading components...</div>
          </div>
        ) : filteredComponents.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <Package className="w-12 h-12 mx-auto mb-3 text-gray-300" />
            <p>No components found matching your search</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
            {filteredComponents.map((component) => (
              <div
                key={component.id}
                className="border border-gray-200 rounded-lg p-4 bg-white hover:shadow-lg transition-shadow cursor-pointer flex flex-col"
                onClick={() => setSelectedComponent(component)}
              >
                <div className="flex items-start justify-between mb-2">
                  <h3 className="font-semibold text-lg">{component.name}</h3>
                  <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                    {component.category}
                  </span>
                </div>

                <p className="text-sm text-gray-600 mb-3 line-clamp-2">{component.description}</p>

                <div className="flex flex-wrap gap-1 mb-3">
                  {component.tags.slice(0, 3).map((tag) => (
                    <span
                      key={tag}
                      className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded flex items-center gap-1"
                    >
                      <Tag className="w-3 h-3" />
                      {tag}
                    </span>
                  ))}
                </div>

                <div className="flex items-center justify-between text-xs text-gray-500 mb-3">
                  <span>v{component.version}</span>
                  <span>by {component.author}</span>
                </div>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedComponent(component);
                  }}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors mt-auto"
                >
                  <ChevronRight className="w-4 h-4" />
                  View Details
                </button>
              </div>
            ))}
          </div>
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
