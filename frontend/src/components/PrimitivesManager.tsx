import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Tabs from '@radix-ui/react-tabs';
import * as Dialog from '@radix-ui/react-dialog';
import Editor from '@monaco-editor/react';
import {
  Clock,
  Play,
  Radar,
  CheckCircle,
  Trash2,
  Eye,
  RefreshCw,
  X,
  FileCode,
} from 'lucide-react';
import { primitivesApi, type PrimitiveCategory, type PrimitiveItem } from '@/services/api';
import { useProjectStore } from '@/hooks/useProject';

interface PrimitivesManagerProps {
  onNavigateToTemplates?: () => void;
  onOpenFile?: (filePath: string) => void;
}

export function PrimitivesManager({ onNavigateToTemplates, onOpenFile }: PrimitivesManagerProps = {}) {
  const { currentProject } = useProjectStore();
  const [activeTab, setActiveTab] = useState<PrimitiveCategory>('schedule');
  const [selectedPrimitive, setSelectedPrimitive] = useState<PrimitiveItem | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const queryClient = useQueryClient();

  // Fetch all primitives (template-created only)
  const { data: allPrimitives, refetch: refetchPrimitives } = useQuery({
    queryKey: ['primitives', currentProject?.id],
    queryFn: () => currentProject ? primitivesApi.listAll(currentProject.id) : Promise.reject('No project'),
    enabled: !!currentProject,
  });

  // Fetch all definitions (from dg list defs - includes everything)
  const { data: allDefinitions, refetch: refetchDefinitions } = useQuery({
    queryKey: ['definitions', currentProject?.id],
    queryFn: () => currentProject ? primitivesApi.getAllDefinitions(currentProject.id) : Promise.reject('No project'),
    enabled: !!currentProject,
  });

  // Combine refetch functions
  const refetch = () => {
    refetchPrimitives();
    refetchDefinitions();
  };

  // Fetch primitive details
  const { data: primitiveDetails } = useQuery({
    queryKey: ['primitive-details', currentProject?.id, activeTab, selectedPrimitive?.name],
    queryFn: () =>
      currentProject && selectedPrimitive
        ? primitivesApi.getDetails(currentProject.id, activeTab, selectedPrimitive.name)
        : Promise.reject('No selection'),
    enabled: !!currentProject && !!selectedPrimitive && detailsOpen,
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: ({ category, name }: { category: PrimitiveCategory; name: string }) =>
      currentProject
        ? primitivesApi.delete(currentProject.id, category, name)
        : Promise.reject('No project'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['primitives', currentProject?.id] });
      queryClient.invalidateQueries({ queryKey: ['definitions', currentProject?.id] });
      setSelectedPrimitive(null);
      setDetailsOpen(false);
    },
  });

  const handleViewDetails = (primitive: PrimitiveItem) => {
    setSelectedPrimitive(primitive);
    setDetailsOpen(true);
  };

  const handleDelete = (category: PrimitiveCategory, name: string) => {
    if (confirm(`Are you sure you want to delete ${category} "${name}"?`)) {
      deleteMutation.mutate({ category, name });
    }
  };

  // Search for a discovered primitive's source file or open YAML file directly
  const handleSearchAndOpen = async (primitiveType: string, name: string, filePath?: string) => {
    if (!currentProject) return;

    // If the primitive is defined in a YAML file (e.g., defs.yaml), open it directly
    // The file path from dg list defs is relative to the project directory
    if (filePath && (filePath.includes('.yaml') || filePath.includes('.yml'))) {
      if (onOpenFile) {
        // Pass relative path to onOpenFile - the backend will resolve it
        onOpenFile(filePath);
      }
      return;
    }

    // For Python-based primitives, search for the definition
    try {
      const result = await primitivesApi.searchPrimitiveDefinition(
        currentProject.id,
        primitiveType,
        name
      );

      if (result.found && result.file_path && onOpenFile) {
        // Include line number if available
        const fullFilePath = result.line_number
          ? `${result.file_path}:${result.line_number}`
          : result.file_path;
        onOpenFile(fullFilePath);
      } else {
        alert(`Could not find source code for ${name}`);
      }
    } catch (error) {
      console.error('Failed to search for primitive:', error);
      alert('Failed to search for source code');
    }
  };

  // Merge template-created primitives with discovered definitions
  const getMergedPrimitives = (category: PrimitiveCategory): Array<PrimitiveItem & { isManaged: boolean }> => {
    const templatePrimitives = allPrimitives?.primitives?.[category === 'schedule' ? 'schedules' : category === 'job' ? 'jobs' : category === 'sensor' ? 'sensors' : 'asset_checks'] || [];
    const definitionPrimitives = allDefinitions?.[category === 'schedule' ? 'schedules' : category === 'job' ? 'jobs' : category === 'sensor' ? 'sensors' : 'asset_checks'] || [];

    // Mark template primitives as managed
    const managed = templatePrimitives.map(p => ({ ...p, isManaged: true }));

    // Add discovered primitives that aren't already in template primitives
    const managedNames = new Set(managed.map(p => p.name));
    const discovered = definitionPrimitives
      .filter(d => !managedNames.has(d.name))
      .map(d => ({
        name: d.name,
        description: (d as any).description || '',
        file: (d as any).source || 'N/A',
        cron_schedule: (d as any).cron_schedule,
        asset: (d as any).asset_key, // For asset checks
        isManaged: false,
      } as PrimitiveItem & { isManaged: boolean }));

    return [...managed, ...discovered];
  };

  const renderPrimitivesList = (primitives: Array<PrimitiveItem & { isManaged: boolean }>, category: PrimitiveCategory) => {
    if (!primitives || primitives.length === 0) {
      return (
        <div className="flex items-center justify-center h-64 text-gray-500">
          <div className="text-center">
            <p className="text-sm font-medium mb-2">No {category}s found</p>
            <p className="text-xs text-gray-600 mb-4">Create a new {category} to get started</p>
            <button
              onClick={() => onNavigateToTemplates?.()}
              className="inline-flex items-center px-3 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700"
            >
              Go to Templates Tab →
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="divide-y divide-gray-200">
        {primitives.map((primitive) => (
          <div
            key={primitive.name}
            className="p-4 hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-gray-900">{primitive.name}</h3>
                  {!primitive.isManaged && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
                      Discovered
                    </span>
                  )}
                </div>
                {primitive.description && (
                  <p className="text-xs text-gray-600 mt-1">{primitive.description}</p>
                )}
                <div className="flex items-center space-x-4 mt-2">
                  {primitive.file && primitive.file !== 'N/A' && (
                    <span className="text-xs text-gray-500">
                      File: {primitive.file.split('/').pop()}
                    </span>
                  )}
                  {category === 'schedule' && primitive.cron_schedule && (
                    <span className="text-xs text-gray-500">
                      Cron: {primitive.cron_schedule}
                    </span>
                  )}
                  {category === 'schedule' && primitive.job_name && (
                    <span className="text-xs text-gray-500">
                      Job: {primitive.job_name}
                    </span>
                  )}
                  {category === 'job' && primitive.selection && (
                    <span className="text-xs text-gray-500">
                      Assets: {primitive.selection.length}
                    </span>
                  )}
                  {category === 'sensor' && primitive.job_name && (
                    <span className="text-xs text-gray-500">
                      Triggers: {primitive.job_name}
                    </span>
                  )}
                  {category === 'asset_check' && primitive.asset && (
                    <span className="text-xs text-gray-500">
                      Asset: {primitive.asset}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center space-x-2 ml-4">
                {primitive.isManaged && primitive.file && primitive.file !== 'N/A' && (
                  <button
                    onClick={() => handleViewDetails(primitive)}
                    className="p-1.5 text-blue-600 hover:bg-blue-50 rounded"
                    title="View code"
                  >
                    <Eye className="w-4 h-4" />
                  </button>
                )}
                {!primitive.isManaged && (
                  <button
                    onClick={() => handleSearchAndOpen(
                      category === 'schedule' ? 'schedule' : category === 'job' ? 'job' : category === 'sensor' ? 'sensor' : 'asset_check',
                      primitive.name,
                      primitive.file !== 'N/A' ? primitive.file : undefined
                    )}
                    className="p-1.5 text-blue-600 hover:bg-blue-50 rounded"
                    title="Find and open source code"
                  >
                    <FileCode className="w-4 h-4" />
                  </button>
                )}
                {primitive.isManaged && (
                  <button
                    onClick={() => handleDelete(category, primitive.name)}
                    className="p-1.5 text-red-600 hover:bg-red-50 rounded"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  if (!currentProject) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        <div className="text-center">
          <Clock className="w-12 h-12 mx-auto mb-2 text-gray-400" />
          <p className="text-sm">Select a project to manage automation</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-white">
      <Tabs.Root
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as PrimitiveCategory)}
        className="flex-1 flex flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between border-b border-gray-200 bg-white">
          <Tabs.List className="flex">
          <Tabs.Trigger
            value="schedule"
            className="flex items-center space-x-2 px-4 py-3 text-sm text-gray-600 hover:text-gray-900 border-b-2 border-transparent data-[state=active]:border-blue-600 data-[state=active]:text-blue-600"
          >
            <Clock className="w-4 h-4" />
            <span>Schedules</span>
          </Tabs.Trigger>
          <Tabs.Trigger
            value="job"
            className="flex items-center space-x-2 px-4 py-3 text-sm text-gray-600 hover:text-gray-900 border-b-2 border-transparent data-[state=active]:border-blue-600 data-[state=active]:text-blue-600"
          >
            <Play className="w-4 h-4" />
            <span>Jobs</span>
          </Tabs.Trigger>
          <Tabs.Trigger
            value="sensor"
            className="flex items-center space-x-2 px-4 py-3 text-sm text-gray-600 hover:text-gray-900 border-b-2 border-transparent data-[state=active]:border-blue-600 data-[state=active]:text-blue-600"
          >
            <Radar className="w-4 h-4" />
            <span>Sensors</span>
          </Tabs.Trigger>
          <Tabs.Trigger
            value="asset_check"
            className="flex items-center space-x-2 px-4 py-3 text-sm text-gray-600 hover:text-gray-900 border-b-2 border-transparent data-[state=active]:border-blue-600 data-[state=active]:text-blue-600"
          >
            <CheckCircle className="w-4 h-4" />
            <span>Asset Checks</span>
          </Tabs.Trigger>
        </Tabs.List>
          <button
            onClick={() => refetch()}
            className="flex items-center space-x-1 px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
      </div>

        <Tabs.Content value="schedule" className="flex-1 overflow-y-auto">
          {renderPrimitivesList(getMergedPrimitives('schedule'), 'schedule')}
        </Tabs.Content>

        <Tabs.Content value="job" className="flex-1 overflow-y-auto">
          {renderPrimitivesList(getMergedPrimitives('job'), 'job')}
        </Tabs.Content>

        <Tabs.Content value="sensor" className="flex-1 overflow-y-auto">
          {renderPrimitivesList(getMergedPrimitives('sensor'), 'sensor')}
        </Tabs.Content>

        <Tabs.Content value="asset_check" className="flex-1 overflow-y-auto">
          {renderPrimitivesList(getMergedPrimitives('asset_check'), 'asset_check')}
        </Tabs.Content>
      </Tabs.Root>

      {/* Details Dialog */}
      <Dialog.Root open={detailsOpen} onOpenChange={setDetailsOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50" />
          <Dialog.Content className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-xl w-[90vw] h-[80vh] flex flex-col">
            <div className="p-4 border-b border-gray-200 flex items-center justify-between">
              <Dialog.Title className="text-lg font-semibold text-gray-900">
                {selectedPrimitive?.name}
              </Dialog.Title>
              <Dialog.Close className="p-1 hover:bg-gray-100 rounded">
                <X className="w-5 h-5 text-gray-500" />
              </Dialog.Close>
            </div>

            <div className="flex-1 overflow-hidden">
              {primitiveDetails ? (
                <Editor
                  height="100%"
                  language="python"
                  value={primitiveDetails.primitive.code}
                  theme="vs-light"
                  options={{
                    readOnly: true,
                    minimap: { enabled: true },
                    fontSize: 13,
                    lineNumbers: 'on',
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                  }}
                />
              ) : (
                <div className="flex items-center justify-center h-full">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                </div>
              )}
            </div>

            <div className="p-4 border-t border-gray-200 flex justify-between items-center">
              <div className="text-sm text-gray-600">
                File: {selectedPrimitive?.file}
              </div>
              <div className="flex items-center space-x-2">
                <Dialog.Close className="px-4 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50">
                  Close
                </Dialog.Close>
                <button
                  onClick={() =>
                    selectedPrimitive && handleDelete(activeTab, selectedPrimitive.name)
                  }
                  className="px-4 py-2 text-sm bg-red-600 text-white rounded-md hover:bg-red-700"
                >
                  Delete
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
