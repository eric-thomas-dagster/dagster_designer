import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Workflow, X, ChevronRight, TrendingUp, DollarSign, Target, Package } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';

interface PipelineComponent {
  component_id: string;
  instance_name: string;
  config_mapping: Record<string, any>;
  depends_on: string[];
}

interface PipelineTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  use_case: string;
  business_outcome: string;
  estimated_savings?: string;
  icon?: string;
  readme_url: string;
  yaml_url: string;
  components: PipelineComponent[];
  pipeline_params: Record<string, {
    type: string;
    default?: any;
    description: string;
    required: boolean;
    items?: {
      type: string;
      enum?: string[];
    };
  }>;
}

interface PipelineManifest {
  version: string;
  repository: string;
  last_updated: string;
  pipelines: PipelineTemplate[];
}

interface PipelineDetails {
  pipeline: PipelineTemplate;
  readme: string;
  yaml_content: string;
}

export function PipelineTemplates() {
  const { currentProject, loadProject } = useProjectStore();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedPipeline, setSelectedPipeline] = useState<PipelineTemplate | null>(null);
  const [pipelineConfig, setPipelineConfig] = useState<Record<string, any>>({});

  const { data: manifest, isLoading, error } = useQuery({
    queryKey: ['pipeline-templates-manifest'],
    queryFn: async () => {
      const response = await fetch('/api/v1/pipeline-templates/manifest');
      if (!response.ok) {
        throw new Error('Failed to fetch pipeline manifest');
      }
      return response.json() as Promise<PipelineManifest>;
    },
  });

  const { data: pipelineDetails, isLoading: isLoadingDetails } = useQuery({
    queryKey: ['pipeline-details', selectedPipeline?.id],
    queryFn: async () => {
      if (!selectedPipeline) return null;
      const response = await fetch(`/api/v1/pipeline-templates/pipeline/${selectedPipeline.id}`);
      if (!response.ok) {
        throw new Error('Failed to fetch pipeline details');
      }
      return response.json() as Promise<PipelineDetails>;
    },
    enabled: !!selectedPipeline,
  });

  const installMutation = useMutation({
    mutationFn: async ({ pipeline, config }: { pipeline: PipelineTemplate; config: Record<string, any> }) => {
      if (!currentProject) throw new Error('No project selected');

      const response = await fetch(`/api/v1/pipeline-templates/install/${pipeline.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: currentProject.id,
          config: config,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: 'Unknown error' }));
        throw new Error(errorData.detail || 'Failed to install pipeline');
      }

      return response.json();
    },
    onSuccess: (data) => {
      alert(`Pipeline installed successfully!\n\nPipeline: ${data.pipeline_name}\nComponents: ${data.total_instances}\n\nInstances created:\n${data.instances_created.map((i: any) => `- ${i.instance_name} (${i.component_type})`).join('\n')}`);
      setSelectedPipeline(null);
      setPipelineConfig({});
      // Invalidate installed components cache to refresh dropdowns
      if (currentProject) {
        queryClient.invalidateQueries({ queryKey: ['installed-components', currentProject.id] });
        loadProject(currentProject.id);
      }
    },
    onError: (error: Error) => {
      console.error('Installation error:', error);
      alert(`Failed to install pipeline:\n\n${error.message}`);
    },
  });

  // Initialize config with default values when pipeline is selected
  const handlePipelineSelect = (pipeline: PipelineTemplate) => {
    setSelectedPipeline(pipeline);
    const defaultConfig: Record<string, any> = {};
    Object.entries(pipeline.pipeline_params).forEach(([key, param]) => {
      if (param.default !== undefined) {
        defaultConfig[key] = param.default;
      }
    });
    setPipelineConfig(defaultConfig);
  };

  // Dynamically extract unique categories from manifest
  const categories = ['all', ...(manifest?.pipelines
    ? Array.from(new Set(manifest.pipelines.map(p => p.category))).sort()
    : [])];

  const filteredPipelines = manifest?.pipelines.filter((p) => {
    const matchesSearch =
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.use_case.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = selectedCategory === 'all' || p.category === selectedCategory;
    return matchesSearch && matchesCategory;
  }) || [];

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-center">
        <Workflow className="w-16 h-16 text-gray-300 mb-4" />
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Failed to Load Pipeline Templates</h3>
        <p className="text-sm text-gray-600 mb-4">
          Could not fetch the pipeline templates manifest.
        </p>
        <p className="text-xs text-gray-500">
          Make sure the repository is accessible and the manifest exists.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="p-4 border-b bg-white flex-shrink-0">
        <h2 className="text-xl font-semibold mb-2">Pipeline Templates</h2>
        <p className="text-sm text-gray-600">
          Pre-built multi-component pipelines for common use cases. Install complete workflows in one click.
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
            placeholder="Search pipeline templates..."
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
              {cat.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')}
            </button>
          ))}
        </div>
      </div>

      {/* Pipeline Grid */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 bg-gray-50">
        {isLoading ? (
          <div className="text-center py-8 text-gray-500">
            <div className="animate-pulse">Loading pipeline templates...</div>
          </div>
        ) : filteredPipelines.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <Workflow className="w-12 h-12 mx-auto mb-3 text-gray-300" />
            <p>No pipeline templates found matching your search</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredPipelines.map((pipeline) => (
              <div
                key={pipeline.id}
                className="border border-gray-200 rounded-lg p-5 bg-white hover:shadow-lg transition-shadow cursor-pointer flex flex-col"
                onClick={() => handlePipelineSelect(pipeline)}
              >
                {/* Header */}
                <div className="flex items-start justify-between mb-3">
                  <div className="flex-1">
                    <h3 className="font-semibold text-lg mb-1">{pipeline.name}</h3>
                    <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded inline-block">
                      {pipeline.category.replace('_', ' ')}
                    </span>
                  </div>
                </div>

                {/* Description */}
                <p className="text-sm text-gray-600 mb-3">{pipeline.description}</p>

                {/* Use Case */}
                <div className="flex items-start gap-2 mb-2 text-sm">
                  <Target className="w-4 h-4 text-purple-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium text-gray-700">Use Case</div>
                    <div className="text-gray-600">{pipeline.use_case}</div>
                  </div>
                </div>

                {/* Business Outcome */}
                <div className="flex items-start gap-2 mb-3 text-sm">
                  <TrendingUp className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium text-gray-700">Outcome</div>
                    <div className="text-gray-600">{pipeline.business_outcome}</div>
                  </div>
                </div>

                {/* Savings */}
                {pipeline.estimated_savings && (
                  <div className="flex items-center gap-2 mb-3 text-sm font-medium text-green-700 bg-green-50 px-3 py-2 rounded">
                    <DollarSign className="w-4 h-4" />
                    <span>{pipeline.estimated_savings}</span>
                  </div>
                )}

                {/* Component Count */}
                <div className="flex items-center gap-2 text-xs text-gray-500 mb-3">
                  <Package className="w-3 h-3" />
                  <span>{pipeline.components.length} components</span>
                </div>

                {/* View Details Button */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handlePipelineSelect(pipeline);
                  }}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors mt-auto"
                >
                  <ChevronRight className="w-4 h-4" />
                  Configure & Install
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pipeline Detail Modal */}
      {selectedPipeline && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-5xl w-full max-h-[90vh] flex flex-col">
            {/* Modal Header */}
            <div className="p-6 border-b flex-shrink-0">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <h2 className="text-2xl font-bold">{selectedPipeline.name}</h2>
                    <span className="text-sm bg-blue-100 text-blue-800 px-2 py-1 rounded">
                      {selectedPipeline.category}
                    </span>
                  </div>
                  <p className="text-gray-600 mb-2">{selectedPipeline.description}</p>
                  {selectedPipeline.estimated_savings && (
                    <div className="flex items-center gap-2 text-sm font-medium text-green-700">
                      <DollarSign className="w-4 h-4" />
                      <span>{selectedPipeline.estimated_savings}</span>
                    </div>
                  )}
                </div>
                <button
                  onClick={() => {
                    setSelectedPipeline(null);
                    setPipelineConfig({});
                  }}
                  className="text-gray-400 hover:text-gray-600 ml-4"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-6 min-h-0">
              {isLoadingDetails ? (
                <div className="text-center py-8">
                  <div className="animate-pulse">Loading pipeline details...</div>
                </div>
              ) : pipelineDetails ? (
                <div className="space-y-6">
                  {/* Configuration Form */}
                  <div>
                    <h3 className="text-lg font-semibold mb-3">Configuration</h3>
                    <div className="bg-gray-50 rounded-lg p-4 space-y-4">
                      {Object.entries(selectedPipeline.pipeline_params).map(([key, param]) => (
                        <div key={key}>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            {key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
                            {param.required && <span className="text-red-500 ml-1">*</span>}
                          </label>
                          {param.type === 'array' && param.items?.enum ? (
                            <div className="space-y-2">
                              {param.items.enum.map((option) => {
                                const currentValue = (pipelineConfig[key] || param.default || []) as string[];
                                const isChecked = currentValue.includes(option);
                                return (
                                  <label key={option} className="flex items-center gap-2 cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={isChecked}
                                      onChange={(e) => {
                                        const newValue = e.target.checked
                                          ? [...currentValue, option]
                                          : currentValue.filter(v => v !== option);
                                        setPipelineConfig({ ...pipelineConfig, [key]: newValue });
                                      }}
                                      className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                                    />
                                    <span className="text-sm capitalize">{option.replace('_', ' ')}</span>
                                  </label>
                                );
                              })}
                            </div>
                          ) : param.type === 'string' ? (
                            <input
                              type="text"
                              value={pipelineConfig[key] || param.default || ''}
                              onChange={(e) => setPipelineConfig({ ...pipelineConfig, [key]: e.target.value })}
                              placeholder={param.description}
                              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                          ) : param.type === 'integer' ? (
                            <input
                              type="number"
                              value={pipelineConfig[key] || param.default || 0}
                              onChange={(e) => setPipelineConfig({ ...pipelineConfig, [key]: parseInt(e.target.value) })}
                              placeholder={param.description}
                              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                          ) : param.type === 'number' ? (
                            <input
                              type="number"
                              step="0.01"
                              value={pipelineConfig[key] || param.default || 0}
                              onChange={(e) => setPipelineConfig({ ...pipelineConfig, [key]: parseFloat(e.target.value) })}
                              placeholder={param.description}
                              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                          ) : null}
                          <p className="text-xs text-gray-500 mt-1">{param.description}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Components */}
                  <div>
                    <h3 className="text-lg font-semibold mb-2">Pipeline Components ({selectedPipeline.components.length})</h3>
                    <div className="bg-gray-50 rounded-lg p-4">
                      <div className="space-y-2">
                        {selectedPipeline.components.map((component, idx) => (
                          <div key={idx} className="flex items-center gap-3 text-sm">
                            <span className="bg-blue-100 text-blue-800 px-2 py-1 rounded font-mono text-xs">
                              {idx + 1}
                            </span>
                            <div>
                              <div className="font-medium">{component.instance_name}</div>
                              <div className="text-gray-600 text-xs">{component.component_id}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* README */}
                  <div>
                    <h3 className="text-lg font-semibold mb-2">Documentation</h3>
                    <div className="bg-gray-50 rounded-lg p-4 max-h-96 overflow-y-auto">
                      <pre className="whitespace-pre-wrap text-sm text-gray-700">
                        {pipelineDetails.readme}
                      </pre>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            {/* Modal Footer */}
            <div className="p-6 border-t flex justify-between items-center bg-gray-50 flex-shrink-0">
              <div className="text-sm text-gray-600">
                <Package className="w-4 h-4 inline mr-1" />
                {selectedPipeline.components.length} components will be installed
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setSelectedPipeline(null);
                    setPipelineConfig({});
                  }}
                  className="px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => installMutation.mutate({ pipeline: selectedPipeline, config: pipelineConfig })}
                  disabled={installMutation.isPending || !currentProject}
                  className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <Workflow className="w-4 h-4" />
                  {installMutation.isPending ? 'Installing...' : 'Install Pipeline'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
