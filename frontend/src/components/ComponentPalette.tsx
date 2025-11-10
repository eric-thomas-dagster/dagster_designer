import { useState } from 'react';
import { useComponentRegistry } from '@/hooks/useComponentRegistry';
import { Database, ArrowRight, Download, RefreshCw, Box, Search, Plus, Code, FileText, Play, Clock, Radar, CheckCircle, FileCode, Zap, Package } from 'lucide-react';
import { CreatePythonAssetDialog } from './CreatePythonAssetDialog';
import { useProjectStore } from '@/hooks/useProject';
import { useQuery } from '@tanstack/react-query';

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

export function ComponentPalette({ onComponentClick }: ComponentPaletteProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | undefined>();
  const [showCreateAssetDialog, setShowCreateAssetDialog] = useState(false);
  const { data, isLoading } = useComponentRegistry(selectedCategory);
  const { currentProject, loadProject } = useProjectStore();

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

  // Filter out jobs, schedules, sensors - these shouldn't be on the lineage diagram
  const assetComponents = data?.components.filter((comp) =>
    !comp.type.toLowerCase().includes('job') &&
    !comp.type.toLowerCase().includes('schedule') &&
    !comp.type.toLowerCase().includes('sensor')
  ) || [];

  const filteredComponents = assetComponents.filter((comp) =>
    comp.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    comp.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Separate single-asset components from asset factories
  // Asset factories generate multiple assets (dbt, dlt, fivetran, sling, airbyte, etc.)
  // Single-asset components generate one asset at a time
  const assetFactoryKeywords = ['dbt', 'dlt', 'fivetran', 'sling', 'airbyte', 'factory'];

  const singleAssetComponents = filteredComponents.filter((comp) => {
    const nameOrType = `${comp.name} ${comp.type}`.toLowerCase();
    return !assetFactoryKeywords.some(keyword => nameOrType.includes(keyword));
  });

  const assetFactoryComponents = filteredComponents.filter((comp) => {
    const nameOrType = `${comp.name} ${comp.type}`.toLowerCase();
    return assetFactoryKeywords.some(keyword => nameOrType.includes(keyword));
  });

  // Filter Python Asset button based on search
  const showPythonAsset = searchQuery === '' ||
    'python asset'.includes(searchQuery.toLowerCase()) ||
    'python'.includes(searchQuery.toLowerCase());

  // Filter installed community components based on search
  const filteredInstalledComponents = (installedComponents?.components || []).filter((comp) =>
    searchQuery === '' ||
    comp.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    comp.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Dynamically determine available categories based on installed components
  const availableCategories = Array.from(
    new Set(assetComponents.map((comp) => comp.category))
  ).sort();

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

        {/* Category filter */}
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setSelectedCategory(undefined)}
            className={`px-2.5 py-1 text-xs rounded-full ${
              !selectedCategory
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            All
          </button>
          {availableCategories.map((category) => (
            <button
              key={category}
              onClick={() => setSelectedCategory(category)}
              className={`px-2.5 py-1 text-xs rounded-full ${
                selectedCategory === category
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {category}
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
            {/* Single Asset Components - Compact button style */}
            {/* Create Python Asset */}
            {showPythonAsset && (
              <button
                onClick={() => setShowCreateAssetDialog(true)}
                className="w-full flex items-center space-x-2 px-2.5 py-2 bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-md hover:border-blue-400 transition-all group"
              >
                <FileCode className="w-4 h-4 text-blue-600" />
                <span className="text-sm font-medium text-gray-900">Python Asset</span>
                <Plus className="w-3.5 h-3.5 text-blue-400 ml-auto group-hover:text-blue-600" />
              </button>
            )}

            {/* Installed Community Components */}
            {filteredInstalledComponents.map((comp) => (
              <button
                key={comp.id}
                onClick={() => onComponentClick(comp.component_type)}
                className="w-full flex items-center space-x-2 px-2.5 py-2 bg-gradient-to-br from-purple-50 to-pink-50 border border-purple-200 rounded-md hover:border-purple-400 transition-all group"
              >
                <Package className="w-4 h-4 text-purple-600" />
                <span className="text-sm font-medium text-gray-900 truncate">{comp.name}</span>
                <Plus className="w-3.5 h-3.5 text-purple-400 ml-auto group-hover:text-purple-600" />
              </button>
            ))}

            {/* Single-Asset Components from catalog */}
            {singleAssetComponents.map((component) => {
              const Icon = iconMap[component.icon || 'cube'] || Box;
              const isPrimitive = component.category === 'primitives';

              return (
                <button
                  key={component.type}
                  onClick={() => onComponentClick(component.type)}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(
                      'application/reactflow',
                      JSON.stringify(component)
                    );
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  className={`w-full flex items-center space-x-2 px-2.5 py-2 ${
                    isPrimitive
                      ? 'bg-gradient-to-br from-purple-50 to-blue-50 border border-purple-200 hover:border-purple-400'
                      : 'bg-gradient-to-br from-green-50 to-teal-50 border border-green-200 hover:border-green-400'
                  } rounded-md transition-all group cursor-move`}
                >
                  <Icon className={`w-4 h-4 ${
                    isPrimitive ? 'text-purple-600' : 'text-green-600'
                  }`} />
                  <span className="text-sm font-medium text-gray-900 truncate">{component.name}</span>
                  <Plus className={`w-3.5 h-3.5 ${
                    isPrimitive ? 'text-purple-400' : 'text-green-400'
                  } ml-auto group-hover:${isPrimitive ? 'text-purple-600' : 'text-green-600'}`} />
                </button>
              );
            })}

            {/* Divider between single assets and asset factories */}
            {assetFactoryComponents.length > 0 && (
              <>
                <div className="border-t border-gray-200 my-2"></div>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider px-1">
                  Asset Factories
                </div>
              </>
            )}

            {/* Asset Factory Components - Detailed card style */}
            {assetFactoryComponents.map((component) => {
              const Icon = iconMap[component.icon || 'cube'] || Box;
              const isPrimitive = component.category === 'primitives';

              return (
                <button
                  key={component.type}
                  onClick={() => onComponentClick(component.type)}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(
                      'application/reactflow',
                      JSON.stringify(component)
                    );
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  className={`w-full text-left p-2 ${
                    isPrimitive
                      ? 'bg-gradient-to-br from-purple-50 to-blue-50 border border-purple-200 hover:border-purple-400'
                      : 'bg-white border border-gray-200 hover:border-blue-300'
                  } rounded-md hover:shadow-sm transition-all group cursor-move`}
                >
                  <div className="flex items-start space-x-2">
                    <div className="flex-shrink-0 mt-0.5">
                      <Icon className={`w-4 h-4 ${
                        isPrimitive
                          ? 'text-purple-600 group-hover:text-purple-700'
                          : 'text-gray-600 group-hover:text-blue-600'
                      }`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900 truncate">
                        {component.name}
                      </div>
                      {component.description && (
                        <div className="text-xs text-gray-500 mt-0.5 line-clamp-2">
                          {component.description}
                        </div>
                      )}
                      <div className={`text-xs mt-0.5 font-medium ${
                        isPrimitive ? 'text-purple-600' : 'text-blue-600'
                      }`}>
                        {component.category}
                      </div>
                    </div>
                    <div className="flex-shrink-0">
                      <Plus className={`w-4 h-4 ${
                        isPrimitive
                          ? 'text-purple-400 group-hover:text-purple-600'
                          : 'text-gray-400 group-hover:text-blue-600'
                      }`} />
                    </div>
                  </div>
                </button>
              );
            })}

            {/* No results message */}
            {!showPythonAsset && filteredInstalledComponents.length === 0 && singleAssetComponents.length === 0 && assetFactoryComponents.length === 0 && (
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
