import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import ReactFlow, {
  Node,
  Edge,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  NodeTypes,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { AssetNode } from './nodes/AssetNode';
import { CronBuilder } from './CronBuilder';
import { useProjectStore } from '@/hooks/useProject';
import { pipelinesApi, primitivesApi, templatesApi, projectsApi } from '@/services/api';
import {
  Workflow, Plus, Save, Clock, Radar, Play, Trash2, X, Grid, List,
  Layers, Database, Users, CheckCircle, Tag, Edit2, Code, Download, Upload, AlertTriangle
} from 'lucide-react';

const nodeTypes: NodeTypes = {
  asset: AssetNode,
};

interface Trigger {
  id: string;
  type: 'schedule' | 'sensor';
  name: string;
  cronSchedule?: string;
  sensorConfig?: any;
  isExisting?: boolean; // Whether this is an existing trigger being reused
}

interface Pipeline {
  id: string;
  name: string;
  description: string;
  assetSelection: string[];
  triggers: Trigger[];
}

type SidePanelMode = 'trigger' | 'asset' | null;

export function PipelineBuilder() {
  const { currentProject } = useProjectStore();
  const queryClient = useQueryClient();
  const [selectedPipeline, setSelectedPipeline] = useState<Pipeline | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [viewMode, setViewMode] = useState<'graph' | 'list'>('graph');

  // Side panel state
  const [sidePanelMode, setSidePanelMode] = useState<SidePanelMode>(null);
  const [selectedTrigger, setSelectedTrigger] = useState<Trigger | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [showAddTriggerMenu, setShowAddTriggerMenu] = useState(false);

  // Asset creation state
  const [showCreateAsset, setShowCreateAsset] = useState(false);
  const [showAddExistingAsset, setShowAddExistingAsset] = useState(false);
  const [showInferredDepsWarning, setShowInferredDepsWarning] = useState(false);
  const [inferredDepsCount, setInferredDepsCount] = useState(0);
  const [newAssetType, setNewAssetType] = useState<'python' | 'rest_api' | 'database_query' | 'dataframe_transformer' | 'file_transformer'>('python');
  const [newAssetName, setNewAssetName] = useState('');
  const [newAssetGroup, setNewAssetGroup] = useState('');
  const [newAssetDescription, setNewAssetDescription] = useState('');
  const [newAssetDeps, setNewAssetDeps] = useState<string[]>([]);
  const [isCreatingAsset, setIsCreatingAsset] = useState(false);

  // Component-specific fields
  const [apiUrl, setApiUrl] = useState('https://api.example.com/data');
  const [apiMethod, setApiMethod] = useState<'GET' | 'POST' | 'PUT' | 'DELETE'>('GET');
  const [dbConnectionString, setDbConnectionString] = useState('');
  const [dbQuery, setDbQuery] = useState('');
  const [inputAsset, setInputAsset] = useState('');
  const [transformCode, setTransformCode] = useState('');
  const [inputPath, setInputPath] = useState('');
  const [outputPath, setOutputPath] = useState('');

  // Fetch existing pipelines from backend - always needed
  const { data: pipelinesData } = useQuery({
    queryKey: ['pipelines', currentProject?.id],
    queryFn: () => currentProject ? pipelinesApi.list(currentProject.id) : Promise.reject('No project'),
    enabled: !!currentProject,
  });

  // Only fetch definitions when creating/editing a pipeline (for existing schedule/sensor selection)
  const needsDefinitions = isCreating || !!selectedPipeline;
  const { data: allDefinitions } = useQuery({
    queryKey: ['definitions', currentProject?.id],
    queryFn: () => currentProject ? primitivesApi.getAllDefinitions(currentProject.id) : Promise.reject('No project'),
    enabled: !!currentProject && needsDefinitions,
  });

  // Only fetch sensor types when actually configuring a new sensor trigger
  const needsSensorTypes = isCreating && sidePanelMode === 'trigger' && selectedTrigger?.type === 'sensor' && !selectedTrigger.isExisting;
  const { data: sensorTypesData } = useQuery({
    queryKey: ['sensor-types', currentProject?.id],
    queryFn: () => currentProject ? pipelinesApi.getSensorTypes(currentProject.id) : Promise.reject('No project'),
    enabled: !!currentProject && needsSensorTypes,
  });

  const pipelines = pipelinesData?.pipelines || [];
  const sensorTypes = sensorTypesData?.sensor_types || [];

  // Pipeline configuration state
  const [pipelineName, setPipelineName] = useState('');
  const [pipelineDescription, setPipelineDescription] = useState('');
  const [selectedAssets, setSelectedAssets] = useState<Set<string>>(new Set());
  const [triggers, setTriggers] = useState<Trigger[]>([]);

  // Sensor configuration state
  const [selectedSensorType, setSelectedSensorType] = useState<any>(null);
  const [sensorConfig, setSensorConfig] = useState<any>({});

  // Get all assets from the project graph
  const allAssets = useMemo(() => {
    if (!currentProject?.graph?.nodes) return [];
    return currentProject.graph.nodes.filter(node => node.type === 'asset');
  }, [currentProject]);

  // Build graph with ONLY selected assets (not all assets)
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // Handler to remove asset from pipeline
  const handleDeleteAsset = (assetId: string) => {
    const newSelection = new Set(selectedAssets);
    newSelection.delete(assetId);
    setSelectedAssets(newSelection);
  };

  // Layout nodes vertically using topological sort
  const layoutNodesVertically = (nodes: Node[], edges: Edge[]) => {
    if (nodes.length === 0) return nodes;

    // Build adjacency list and in-degree map
    const adjacency = new Map<string, string[]>();
    const inDegree = new Map<string, number>();

    nodes.forEach(node => {
      adjacency.set(node.id, []);
      inDegree.set(node.id, 0);
    });

    edges.forEach(edge => {
      adjacency.get(edge.source)?.push(edge.target);
      inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
    });

    // Topological sort to determine vertical levels
    const levels = new Map<string, number>();
    const queue: string[] = [];

    // Start with nodes that have no dependencies
    nodes.forEach(node => {
      if (inDegree.get(node.id) === 0) {
        queue.push(node.id);
        levels.set(node.id, 0);
      }
    });

    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentLevel = levels.get(current)!;

      adjacency.get(current)?.forEach(neighbor => {
        const newInDegree = (inDegree.get(neighbor) || 0) - 1;
        inDegree.set(neighbor, newInDegree);

        // Update level to be max of current level + 1
        const neighborLevel = levels.get(neighbor) ?? 0;
        levels.set(neighbor, Math.max(neighborLevel, currentLevel + 1));

        if (newInDegree === 0) {
          queue.push(neighbor);
        }
      });
    }

    // Handle nodes not reached by topological sort (cycles or disconnected)
    nodes.forEach(node => {
      if (!levels.has(node.id)) {
        levels.set(node.id, 0);
      }
    });

    // Group nodes by level
    const nodesByLevel = new Map<number, string[]>();
    levels.forEach((level, nodeId) => {
      if (!nodesByLevel.has(level)) {
        nodesByLevel.set(level, []);
      }
      nodesByLevel.get(level)!.push(nodeId);
    });

    // Layout parameters
    const verticalSpacing = 150;
    const horizontalSpacing = 250;
    const nodeWidth = 200;

    // Position nodes
    const positionedNodes = nodes.map(node => {
      const level = levels.get(node.id)!;
      const nodesAtLevel = nodesByLevel.get(level)!;
      const indexInLevel = nodesAtLevel.indexOf(node.id);
      const totalAtLevel = nodesAtLevel.length;

      // Center nodes at each level
      const totalWidth = (totalAtLevel - 1) * horizontalSpacing;
      const startX = -totalWidth / 2;

      return {
        ...node,
        position: {
          x: startX + indexInLevel * horizontalSpacing,
          y: level * verticalSpacing,
        },
        data: {
          ...node.data,
          selected: true,
          onDelete: handleDeleteAsset,
        },
        style: {
          ...node.style,
          border: '2px solid #3b82f6',
        },
      };
    });

    return positionedNodes;
  };

  // Compute pipeline-specific lineage (transitive edges) and layout nodes
  useEffect(() => {
    const currentNodes = allAssets.filter((node) => selectedAssets.has(node.id));

    if (!currentProject?.graph?.edges || currentNodes.length === 0) {
      setEdges([]);
      setNodes([]);
      return;
    }

    // Build adjacency list from all project edges
    const adjacencyList = new Map<string, Set<string>>();
    for (const edge of currentProject.graph.edges) {
      if (!adjacencyList.has(edge.source)) {
        adjacencyList.set(edge.source, new Set());
      }
      adjacencyList.get(edge.source)!.add(edge.target);
    }

    // For each selected asset, find which other selected assets it can reach
    const pipelineEdges = new Map<string, Set<string>>();
    const selectedArray = Array.from(selectedAssets);
    let inferredCount = 0;

    for (const source of selectedArray) {
      // BFS to find all reachable selected assets
      const queue = [source];
      const visited = new Set<string>();
      const reachableSelected = new Set<string>();
      const pathsToTargets = new Map<string, number>(); // Track path length to each target
      pathsToTargets.set(source, 0); // Initialize source with path length 0

      while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);

        // If this is a selected asset (and not the source), record it
        if (current !== source && selectedAssets.has(current)) {
          reachableSelected.add(current);
          // Calculate path length (number of edges in original graph)
          // If path length > 1, this is an inferred dependency
          const pathLength = pathsToTargets.get(current) || 0;
          if (pathLength > 1) {
            inferredCount++;
          }
          // Don't explore further from this selected asset (we want direct pipeline edges)
          continue;
        }

        // Explore neighbors
        const neighbors = adjacencyList.get(current);
        if (neighbors) {
          for (const neighbor of neighbors) {
            if (!visited.has(neighbor)) {
              queue.push(neighbor);
              // Track the path length to this neighbor
              const currentPathLength = pathsToTargets.get(current) || 0;
              pathsToTargets.set(neighbor, currentPathLength + 1);
            }
          }
        }
      }

      // Add edges from source to all directly reachable selected assets
      if (reachableSelected.size > 0) {
        pipelineEdges.set(source, reachableSelected);
      }
    }

    // Show warning if we have inferred dependencies
    if (inferredCount > 0) {
      setInferredDepsCount(inferredCount);
      setShowInferredDepsWarning(true);
      // Auto-hide after 8 seconds
      setTimeout(() => setShowInferredDepsWarning(false), 8000);
    } else {
      setShowInferredDepsWarning(false);
      setInferredDepsCount(0);
    }

    // Convert to edge format
    const newEdges: Edge[] = [];
    for (const [source, targets] of pipelineEdges) {
      for (const target of targets) {
        newEdges.push({
          id: `${source}_to_${target}`,
          source,
          target,
          sourceHandle: 'bottom-source', // Connect from bottom of source node
          targetHandle: 'top', // Connect to top of target node
          type: 'smoothstep',
          animated: false,
          style: {
            stroke: '#3b82f6',
            strokeWidth: 2,
          },
        });
      }
    }

    setEdges(newEdges);

    // Re-layout nodes with the new edges
    const layoutedNodes = layoutNodesVertically(currentNodes, newEdges);
    setNodes(layoutedNodes);
  }, [currentProject, selectedAssets, allAssets, setEdges, setNodes]);

  const handleNodeClick = (event: React.MouseEvent, node: Node) => {
    const newSelection = new Set(selectedAssets);
    if (newSelection.has(node.id)) {
      newSelection.delete(node.id);
    } else {
      newSelection.add(node.id);
    }
    setSelectedAssets(newSelection);
  };

  const handleNewPipeline = () => {
    setIsCreating(true);
    setSelectedPipeline(null);
    setPipelineName('');
    setPipelineDescription('');
    setSelectedAssets(new Set());
    setTriggers([]);
    setSidePanelMode(null);
    setSelectedTrigger(null);
    setSelectedAssetId(null);
  };

  const handleCreateTrigger = (type: 'schedule' | 'sensor') => {
    const newTrigger: Trigger = {
      id: `trigger_${Date.now()}`,
      type,
      name: type === 'schedule' ? `${pipelineName || 'job'}_schedule` : `${pipelineName || 'job'}_sensor`,
      cronSchedule: type === 'schedule' ? '0 0 * * *' : undefined,
      isExisting: false,
    };
    setTriggers([...triggers, newTrigger]);
    setShowAddTriggerMenu(false);
    // Open side panel to edit the new trigger
    setSelectedTrigger(newTrigger);
    setSidePanelMode('trigger');
  };

  const handleSelectExistingTrigger = (triggerType: 'schedule' | 'sensor', existingTrigger: any) => {
    const newTrigger: Trigger = {
      id: `trigger_${Date.now()}`,
      type: triggerType,
      name: existingTrigger.name,
      cronSchedule: triggerType === 'schedule' ? existingTrigger.cron_schedule : undefined,
      isExisting: true,
    };
    setTriggers([...triggers, newTrigger]);
    setShowAddTriggerMenu(false);
  };

  const handleRemoveTrigger = (triggerId: string) => {
    setTriggers(triggers.filter(t => t.id !== triggerId));
    if (selectedTrigger?.id === triggerId) {
      setSidePanelMode(null);
      setSelectedTrigger(null);
    }
  };

  const handleUpdateTrigger = (triggerId: string, updates: Partial<Trigger>) => {
    setTriggers(triggers.map(t => t.id === triggerId ? { ...t, ...updates } : t));
    if (selectedTrigger?.id === triggerId) {
      setSelectedTrigger({ ...selectedTrigger, ...updates });
    }
  };

  const handleTriggerClick = (trigger: Trigger) => {
    setSelectedTrigger(trigger);
    setSidePanelMode('trigger');
    setSelectedAssetId(null);
  };

  const handleSavePipeline = async () => {
    if (!currentProject) return;

    setIsSaving(true);

    try {
      // For now, we'll save with the first schedule trigger (backwards compatible)
      const firstSchedule = triggers.find(t => t.type === 'schedule');
      const firstSensor = triggers.find(t => t.type === 'sensor');

      const response = await pipelinesApi.create(currentProject.id, {
        name: pipelineName,
        description: pipelineDescription,
        asset_selection: Array.from(selectedAssets),
        trigger_type: triggers.length === 0 ? 'manual' : firstSchedule ? 'schedule' : 'sensor',
        cron_schedule: firstSchedule?.cronSchedule,
        sensor_config: firstSensor?.sensorConfig || sensorConfig,
      });

      alert(`Pipeline created successfully!\n\nFiles created:\n${response.files_created.join('\n')}`);

      queryClient.invalidateQueries({ queryKey: ['pipelines', currentProject.id] });
      queryClient.invalidateQueries({ queryKey: ['definitions', currentProject.id] });

      const pipeline: Pipeline = {
        id: response.id,
        name: response.name,
        description: response.description,
        assetSelection: response.asset_selection,
        triggers: triggers,
      };

      setIsCreating(false);
      setSelectedPipeline(pipeline);
    } catch (error) {
      console.error('Failed to create pipeline:', error);
      alert('Failed to create pipeline. Check console for details.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSelectPipeline = async (pipelineItem: any) => {
    if (!currentProject) return;

    try {
      // Fetch pipeline details from backend
      const details = await pipelinesApi.getDetails(currentProject.id, pipelineItem.name);

      // Build triggers array from the details
      const triggers: Trigger[] = [];
      if (details.trigger_type === 'schedule' && details.cron_schedule) {
        triggers.push({
          type: 'schedule',
          cronSchedule: details.cron_schedule,
        });
      }

      const pipeline: Pipeline = {
        id: pipelineItem.id,
        name: details.name,
        description: details.description || '',
        assetSelection: details.asset_selection || [],
        triggers: triggers,
      };

      setSelectedPipeline(pipeline);
      setIsCreating(false);
      setPipelineName(pipeline.name);
      setPipelineDescription(pipeline.description);
      setSelectedAssets(new Set(pipeline.assetSelection));
      setTriggers(pipeline.triggers);
      setSidePanelMode(null);
      setSelectedTrigger(null);
      setSelectedAssetId(null);
    } catch (error) {
      console.error('Failed to load pipeline details:', error);
      alert('Failed to load pipeline details. Check console for details.');
    }
  };

  const handleDeletePipeline = (pipelineId: string) => {
    alert('To delete a pipeline, remove its files from the project using the Code tab or your IDE.');
  };

  const handleToggleAsset = (assetId: string) => {
    const newSelection = new Set(selectedAssets);
    if (newSelection.has(assetId)) {
      newSelection.delete(assetId);
    } else {
      newSelection.add(assetId);
    }
    setSelectedAssets(newSelection);
  };

  const handleAssetClick = (assetId: string) => {
    setSelectedAssetId(assetId);
    setSidePanelMode('asset');
    setSelectedTrigger(null);
  };

  const getAssetById = (assetId: string) => {
    return allAssets.find(a => a.id === assetId);
  };

  // Check if the create asset form is valid
  const isCreateAssetFormValid = () => {
    if (!newAssetName) return false;

    // Component-specific validations
    if (newAssetType === 'rest_api') {
      return !!apiUrl;
    } else if (newAssetType === 'database_query') {
      return !!dbConnectionString && !!dbQuery;
    } else if (newAssetType === 'dataframe_transformer') {
      return !!inputAsset && !!transformCode;
    } else if (newAssetType === 'file_transformer') {
      return !!inputPath && !!outputPath && !!transformCode;
    }

    return true; // Python asset only needs name
  };

  const handleCreateAsset = async () => {
    if (!currentProject || !newAssetName) return;

    setIsCreatingAsset(true);

    try {
      if (newAssetType === 'python') {
        // Create Python asset using templates API
        const response = await templatesApi.createPythonAsset({
          project_id: currentProject.id,
          asset_name: newAssetName,
          group_name: newAssetGroup || undefined,
          description: newAssetDescription || undefined,
          deps: newAssetDeps.length > 0 ? newAssetDeps : undefined,
        });

        alert(`Asset created successfully!\n\nFile: ${response.file_path}`);
      } else {
        // Create component-based asset
        const componentTypeMap: Record<string, string> = {
          rest_api: 'rest_api_fetcher',
          database_query: 'database_query',
          dataframe_transformer: 'dataframe_transformer',
          file_transformer: 'file_transformer',
        };

        const componentId = componentTypeMap[newAssetType];

        // Build config based on component type
        const config: Record<string, any> = {
          name: newAssetName,
          asset_name: newAssetName,
        };

        if (newAssetGroup) config.group_name = newAssetGroup;
        if (newAssetDescription) config.description = newAssetDescription;

        // Add component-specific fields
        if (newAssetType === 'rest_api') {
          config.api_url = apiUrl;
          config.method = apiMethod;
          config.output_format = 'json';
        } else if (newAssetType === 'database_query') {
          config.connection_string = dbConnectionString;
          config.query = dbQuery;
        } else if (newAssetType === 'dataframe_transformer') {
          if (!inputAsset) {
            alert('Please select an input asset');
            setIsCreatingAsset(false);
            return;
          }
          config.input_asset = inputAsset;
          config.transform_code = transformCode;
        } else if (newAssetType === 'file_transformer') {
          config.input_path = inputPath;
          config.output_path = outputPath;
          config.transform_code = transformCode;
        }

        // Call install endpoint which will handle both installing the component and creating the instance
        const response = await api.post(`/templates-registry/install/${componentId}`, {
          project_id: currentProject.id,
          config: config,
        });

        alert(`Component asset created successfully!`);
      }

      // Reload the project to get the new asset
      const { loadProject } = useProjectStore.getState();
      await loadProject(currentProject.id);

      // Add the new asset to the selection
      setSelectedAssets(prev => new Set([...prev, newAssetName]));

      // Reset form and close modal
      setNewAssetName('');
      setNewAssetType('python');
      setNewAssetGroup('');
      setNewAssetDescription('');
      setNewAssetDeps([]);
      setApiUrl('https://api.example.com/data');
      setApiMethod('GET');
      setDbConnectionString('');
      setDbQuery('');
      setInputAsset('');
      setTransformCode('');
      setInputPath('');
      setOutputPath('');
      setShowCreateAsset(false);
    } catch (error) {
      console.error('Failed to create asset:', error);
      alert('Failed to create asset. Check console for details.');
    } finally {
      setIsCreatingAsset(false);
    }
  };

  const handleExportYAML = async () => {
    if (!currentProject) return;

    try {
      const response = await projectsApi.exportYAML(currentProject.id);
      const blob = new Blob([response.yaml_content], { type: 'text/yaml' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = response.filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export YAML:', error);
      alert('Failed to export YAML. Check console for details.');
    }
  };

  const handleImportYAML = async () => {
    if (!currentProject) return;

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.yaml,.yml';

    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        const content = await file.text();
        await projectsApi.importYAML(currentProject.id, content);
        alert('YAML imported successfully! Reloading project...');

        // Reload the project to reflect the imported components
        const { loadProject } = useProjectStore.getState();
        await loadProject(currentProject.id);
      } catch (error) {
        console.error('Failed to import YAML:', error);
        alert('Failed to import YAML. Check console for details.');
      }
    };

    input.click();
  };

  if (!currentProject) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        <div className="text-center">
          <Workflow className="w-12 h-12 mx-auto mb-2 text-gray-400" />
          <p className="text-sm">Select a project to build pipelines</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-gray-900 flex items-center space-x-2">
              <Workflow className="w-6 h-6" />
              <span>Pipeline Builder</span>
            </h2>
            <p className="text-sm text-gray-600 mt-1">
              Create jobs with triggers and asset selections
            </p>
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={handleExportYAML}
              className="flex items-center space-x-2 px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50"
              title="Export pipeline as YAML"
            >
              <Download className="w-4 h-4" />
              <span>Export YAML</span>
            </button>
            <button
              onClick={handleImportYAML}
              className="flex items-center space-x-2 px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50"
              title="Import pipeline from YAML"
            >
              <Upload className="w-4 h-4" />
              <span>Import YAML</span>
            </button>
            <button
              onClick={handleNewPipeline}
              className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
            >
              <Plus className="w-4 h-4" />
              <span>New Pipeline</span>
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar - Pipeline List */}
        <aside className="w-64 bg-white border-r border-gray-200 flex flex-col">
          <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
            <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">
              Your Pipelines
            </h3>
          </div>
          <div className="flex-1 overflow-y-auto">
            {pipelines.length === 0 ? (
              <div className="p-4 text-center text-gray-500 text-sm">
                No pipelines yet. Create one to get started!
              </div>
            ) : (
              <div className="divide-y divide-gray-200">
                {pipelines.map((pipeline) => (
                  <div
                    key={pipeline.id}
                    className={`p-4 cursor-pointer hover:bg-gray-50 transition-colors ${
                      selectedPipeline?.id === pipeline.id ? 'bg-blue-50' : ''
                    }`}
                    onClick={() => handleSelectPipeline(pipeline)}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <h4 className="text-sm font-medium text-gray-900">{pipeline.name}</h4>
                        {pipeline.description && (
                          <p className="text-xs text-gray-600 mt-1">{pipeline.description}</p>
                        )}
                        {(pipeline as any).file && (
                          <p className="text-xs text-gray-500 mt-1">
                            {((pipeline as any).file as string).split('/').pop()}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeletePipeline(pipeline.id);
                        }}
                        className="p-1 text-gray-400 hover:bg-gray-100 rounded"
                        title="To delete, remove files manually"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* Center - Pipeline Builder */}
        <main className="flex-1 flex flex-col overflow-hidden bg-white">
          {(isCreating || selectedPipeline) ? (
            <>
              {/* Pipeline Header */}
              <div className="border-b border-gray-200 p-4 space-y-4">
                {/* Name and Description */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Pipeline Name
                    </label>
                    <input
                      type="text"
                      value={pipelineName}
                      onChange={(e) => setPipelineName(e.target.value)}
                      placeholder="e.g., daily_analytics"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Description
                    </label>
                    <input
                      type="text"
                      value={pipelineDescription}
                      onChange={(e) => setPipelineDescription(e.target.value)}
                      placeholder="What does this pipeline do?"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>

                {/* Triggers Section */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium text-gray-700">
                      Triggers {triggers.length > 0 && <span className="text-gray-500">({triggers.length})</span>}
                    </label>
                    <div className="relative">
                      <button
                        onClick={() => setShowAddTriggerMenu(!showAddTriggerMenu)}
                        className="flex items-center space-x-1 px-2 py-1 text-sm text-blue-600 hover:bg-blue-50 rounded"
                      >
                        <Plus className="w-4 h-4" />
                        <span>Add Trigger</span>
                      </button>

                      {/* Add Trigger Dropdown */}
                      {showAddTriggerMenu && (
                        <div className="absolute right-0 mt-1 w-64 bg-white border border-gray-200 rounded-md shadow-lg z-10">
                          <div className="p-2 space-y-1">
                            <div className="text-xs font-semibold text-gray-700 px-2 py-1">Create New</div>
                            <button
                              onClick={() => handleCreateTrigger('schedule')}
                              className="w-full flex items-center space-x-2 px-3 py-2 text-sm text-left hover:bg-gray-50 rounded"
                            >
                              <Clock className="w-4 h-4 text-blue-600" />
                              <span>New Schedule</span>
                            </button>
                            <button
                              onClick={() => handleCreateTrigger('sensor')}
                              className="w-full flex items-center space-x-2 px-3 py-2 text-sm text-left hover:bg-gray-50 rounded"
                            >
                              <Radar className="w-4 h-4 text-green-600" />
                              <span>New Sensor</span>
                            </button>

                            {/* Existing Schedules */}
                            {allDefinitions?.schedules && allDefinitions.schedules.length > 0 && (
                              <>
                                <div className="text-xs font-semibold text-gray-700 px-2 py-1 mt-2 border-t pt-2">
                                  Use Existing Schedule
                                </div>
                                {allDefinitions.schedules.slice(0, 5).map((schedule) => (
                                  <button
                                    key={schedule.name}
                                    onClick={() => handleSelectExistingTrigger('schedule', schedule)}
                                    className="w-full flex items-center justify-between px-3 py-2 text-sm text-left hover:bg-gray-50 rounded"
                                  >
                                    <div className="flex items-center space-x-2">
                                      <Clock className="w-3 h-3 text-blue-600" />
                                      <span className="truncate">{schedule.name}</span>
                                    </div>
                                    <span className="text-xs text-gray-500 font-mono">
                                      {schedule.cron_schedule}
                                    </span>
                                  </button>
                                ))}
                              </>
                            )}

                            {/* Existing Sensors */}
                            {allDefinitions?.sensors && allDefinitions.sensors.length > 0 && (
                              <>
                                <div className="text-xs font-semibold text-gray-700 px-2 py-1 mt-2 border-t pt-2">
                                  Use Existing Sensor
                                </div>
                                {allDefinitions.sensors.slice(0, 5).map((sensor) => (
                                  <button
                                    key={sensor.name}
                                    onClick={() => handleSelectExistingTrigger('sensor', sensor)}
                                    className="w-full flex items-center space-x-2 px-3 py-2 text-sm text-left hover:bg-gray-50 rounded"
                                  >
                                    <Radar className="w-3 h-3 text-green-600" />
                                    <span className="truncate">{sensor.name}</span>
                                  </button>
                                ))}
                              </>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Triggers Display */}
                  {triggers.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {triggers.map((trigger) => (
                        <div
                          key={trigger.id}
                          onClick={() => handleTriggerClick(trigger)}
                          className={`flex items-center space-x-2 px-3 py-2 rounded-md cursor-pointer transition-all ${
                            selectedTrigger?.id === trigger.id
                              ? 'bg-gradient-to-r from-blue-100 to-blue-200 border-2 border-blue-500'
                              : 'bg-gradient-to-r from-blue-50 to-blue-100 border border-blue-200 hover:border-blue-300'
                          }`}
                        >
                          {trigger.type === 'schedule' ? (
                            <Clock className="w-4 h-4 text-blue-600" />
                          ) : (
                            <Radar className="w-4 h-4 text-green-600" />
                          )}
                          <div className="flex-1">
                            <div className="text-sm font-medium text-gray-900">
                              {trigger.name}
                            </div>
                            {trigger.type === 'schedule' && trigger.cronSchedule && (
                              <div className="text-xs text-gray-600 font-mono">
                                {trigger.cronSchedule}
                              </div>
                            )}
                            {trigger.isExisting && (
                              <div className="text-xs text-gray-500">
                                (reusing existing)
                              </div>
                            )}
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRemoveTrigger(trigger.id);
                            }}
                            className="p-1 hover:bg-blue-300 rounded"
                          >
                            <X className="w-3 h-3 text-blue-600" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-gray-500 italic">
                      No triggers - this will be a manual job
                    </p>
                  )}
                </div>
              </div>

              {/* Asset Selection */}
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 bg-gray-50">
                  <div className="flex items-center space-x-4">
                    <h3 className="text-sm font-semibold text-gray-700">
                      Assets {selectedAssets.size > 0 && <span className="text-gray-500">({selectedAssets.size} selected)</span>}
                    </h3>
                    <div className="flex items-center space-x-1 bg-white rounded-md border border-gray-300">
                      <button
                        onClick={() => setViewMode('graph')}
                        className={`p-1.5 rounded ${viewMode === 'graph' ? 'bg-blue-100 text-blue-600' : 'text-gray-600 hover:bg-gray-100'}`}
                        title="Graph view"
                      >
                        <Grid className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setViewMode('list')}
                        className={`p-1.5 rounded ${viewMode === 'list' ? 'bg-blue-100 text-blue-600' : 'text-gray-600 hover:bg-gray-100'}`}
                        title="List view"
                      >
                        <List className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => setShowAddExistingAsset(true)}
                      className="flex items-center space-x-1 px-3 py-1.5 text-sm bg-green-600 text-white rounded-md hover:bg-green-700"
                    >
                      <Plus className="w-4 h-4" />
                      <span>Add Existing</span>
                    </button>
                    <button
                      onClick={() => {
                        setShowCreateAsset(true);
                        // Reset form when opening modal
                        setNewAssetName('');
                        setNewAssetGroup('');
                        setNewAssetDescription('');
                        setNewAssetDeps([]);
                      }}
                      className="flex items-center space-x-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700"
                    >
                      <Plus className="w-4 h-4" />
                      <span>Create New</span>
                    </button>
                  </div>
                </div>

                {viewMode === 'graph' ? (
                  <div className="flex-1 relative bg-gray-100">
                    {selectedAssets.size === 0 ? (
                      <div className="flex items-center justify-center h-full">
                        <div className="text-center max-w-md">
                          <Database className="w-16 h-16 text-gray-400 mx-auto mb-4" />
                          <h3 className="text-lg font-semibold text-gray-700 mb-2">No Assets in Pipeline</h3>
                          <p className="text-sm text-gray-500 mb-4">
                            Add existing assets from your project or create new ones to build your pipeline
                          </p>
                          <div className="flex justify-center space-x-3">
                            <button
                              onClick={() => setShowAddExistingAsset(true)}
                              className="flex items-center space-x-2 px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700"
                            >
                              <Plus className="w-4 h-4" />
                              <span>Add Existing Asset</span>
                            </button>
                            <button
                              onClick={() => setShowCreateAsset(true)}
                              className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
                            >
                              <Plus className="w-4 h-4" />
                              <span>Create New Asset</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <ReactFlow
                        nodes={nodes}
                        edges={edges}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        nodeTypes={nodeTypes}
                        fitView
                        fitViewOptions={{
                          padding: 0.3,
                          minZoom: 0.5,
                          maxZoom: 1.5,
                        }}
                        attributionPosition="bottom-left"
                        edgesUpdatable={false}
                        edgesFocusable={false}
                        nodesDraggable={true}
                        nodesConnectable={false}
                        elementsSelectable={true}
                      >
                        <Background />
                        <Controls />
                        <MiniMap />
                      </ReactFlow>
                    )}
                  </div>
                ) : (
                  <div className="flex-1 overflow-y-auto p-4">
                    {selectedAssets.size === 0 ? (
                      <div className="flex items-center justify-center h-full">
                        <div className="text-center max-w-md">
                          <Database className="w-16 h-16 text-gray-400 mx-auto mb-4" />
                          <h3 className="text-lg font-semibold text-gray-700 mb-2">No Assets in Pipeline</h3>
                          <p className="text-sm text-gray-500 mb-4">
                            Add existing assets from your project or create new ones to build your pipeline
                          </p>
                          <div className="flex justify-center space-x-3">
                            <button
                              onClick={() => setShowAddExistingAsset(true)}
                              className="flex items-center space-x-2 px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700"
                            >
                              <Plus className="w-4 h-4" />
                              <span>Add Existing Asset</span>
                            </button>
                            <button
                              onClick={() => setShowCreateAsset(true)}
                              className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
                            >
                              <Plus className="w-4 h-4" />
                              <span>Create New Asset</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="max-w-3xl mx-auto space-y-2">
                        {allAssets.filter((asset) => selectedAssets.has(asset.id)).map((asset) => (
                        <div
                          key={asset.id}
                          className={`rounded-lg cursor-pointer transition-all ${
                            selectedAssets.has(asset.id)
                              ? 'border-2 border-purple-500 shadow-lg'
                              : 'border border-gray-200 hover:border-purple-300 shadow'
                          }`}
                        >
                          {/* Asset Header - Purple/Blue gradient like AssetNode */}
                          <div
                            onClick={() => handleToggleAsset(asset.id)}
                            className="px-3 py-2 bg-gradient-to-r from-purple-500 to-blue-500 rounded-t-lg flex items-center justify-between"
                          >
                            <div className="flex items-center space-x-2 flex-1 min-w-0">
                              <div
                                className="w-4 h-4 rounded border-2 border-white flex items-center justify-center flex-shrink-0"
                                style={{
                                  backgroundColor: selectedAssets.has(asset.id) ? 'white' : 'transparent'
                                }}
                              >
                                {selectedAssets.has(asset.id) && (
                                  <svg className="w-3 h-3 text-purple-600" fill="currentColor" viewBox="0 0 20 20">
                                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                  </svg>
                                )}
                              </div>
                              <Layers className="w-4 h-4 text-white flex-shrink-0" />
                              <span className="text-sm font-semibold text-white truncate">
                                {asset.data?.asset_key || asset.data?.label || asset.id}
                              </span>
                            </div>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleAssetClick(asset.id);
                              }}
                              className="p-1 hover:bg-purple-600 rounded transition-colors"
                              title="View details"
                            >
                              <Edit2 className="w-3 h-3 text-white" />
                            </button>
                          </div>

                          {/* Asset Body - Purple/Blue gradient background like AssetNode */}
                          <div
                            onClick={() => handleToggleAsset(asset.id)}
                            className="px-3 py-2 bg-gradient-to-br from-purple-50 to-blue-50"
                          >
                            {asset.data?.description && (
                              <p className="text-xs text-gray-600 mb-2">
                                {asset.data.description}
                              </p>
                            )}

                            {/* Metadata badges */}
                            <div className="flex flex-wrap gap-1.5">
                              {asset.data?.group_name && (
                                <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 border border-blue-300">
                                  <Database className="w-3 h-3" />
                                  <span>{asset.data.group_name}</span>
                                </div>
                              )}
                              {asset.data?.owners && asset.data.owners.length > 0 && (
                                <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700 border border-purple-300">
                                  <Users className="w-3 h-3" />
                                  <span>{asset.data.owners.length}</span>
                                </div>
                              )}
                              {asset.data?.source_component && (
                                <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 border border-green-300">
                                  <Tag className="w-3 h-3" />
                                  <span>Generated</span>
                                </div>
                              )}
                              {asset.data?.checks && asset.data.checks.length > 0 && (
                                <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-700 border border-orange-300">
                                  <CheckCircle className="w-3 h-3" />
                                  <span>{asset.data.checks.length}</span>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    )}
                  </div>
                )}
              </div>

              {/* Save Button */}
              <div className="border-t border-gray-200 p-4 bg-white">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-gray-600">
                    {selectedAssets.size > 0 ? (
                      <>
                        {selectedAssets.size} asset{selectedAssets.size !== 1 ? 's' : ''} selected
                        {triggers.length > 0 && ` • ${triggers.length} trigger${triggers.length !== 1 ? 's' : ''}`}
                      </>
                    ) : (
                      'Select assets to include in your pipeline'
                    )}
                  </p>
                  <button
                    onClick={handleSavePipeline}
                    disabled={!pipelineName || selectedAssets.size === 0 || isSaving}
                    className="flex items-center space-x-2 px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Save className="w-4 h-4" />
                    <span>{isSaving ? 'Saving...' : 'Save Pipeline'}</span>
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-500">
              <div className="text-center">
                <Workflow className="w-16 h-16 mx-auto mb-4 text-gray-400" />
                <p className="text-lg font-medium">No pipeline selected</p>
                <p className="text-sm mt-2">Create a new pipeline or select one from the list</p>
              </div>
            </div>
          )}
        </main>

        {/* Right Side Panel - Trigger/Asset Details */}
        {sidePanelMode && (isCreating || selectedPipeline) && (
          <aside className="w-96 bg-white border-l border-gray-200 overflow-y-auto">
            <div className="p-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900">
                  {sidePanelMode === 'trigger' ? 'Trigger Configuration' : 'Asset Details'}
                </h3>
                <button
                  onClick={() => {
                    setSidePanelMode(null);
                    setSelectedTrigger(null);
                    setSelectedAssetId(null);
                  }}
                  className="p-1 hover:bg-gray-100 rounded"
                >
                  <X className="w-5 h-5 text-gray-500" />
                </button>
              </div>

              {sidePanelMode === 'trigger' && selectedTrigger && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Trigger Name
                    </label>
                    <input
                      type="text"
                      value={selectedTrigger.name}
                      onChange={(e) => handleUpdateTrigger(selectedTrigger.id, { name: e.target.value })}
                      disabled={selectedTrigger.isExisting}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Type
                    </label>
                    <div className="flex items-center space-x-2 px-3 py-2 border border-gray-300 rounded-md bg-gray-50">
                      {selectedTrigger.type === 'schedule' ? (
                        <>
                          <Clock className="w-4 h-4 text-blue-600" />
                          <span className="text-sm">Schedule</span>
                        </>
                      ) : (
                        <>
                          <Radar className="w-4 h-4 text-green-600" />
                          <span className="text-sm">Sensor</span>
                        </>
                      )}
                    </div>
                  </div>

                  {selectedTrigger.type === 'schedule' && !selectedTrigger.isExisting && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Cron Schedule
                      </label>
                      <CronBuilder
                        value={selectedTrigger.cronSchedule || '0 0 * * *'}
                        onChange={(cron) => handleUpdateTrigger(selectedTrigger.id, { cronSchedule: cron })}
                      />
                    </div>
                  )}

                  {selectedTrigger.type === 'schedule' && selectedTrigger.isExisting && (
                    <div className="p-3 bg-gray-50 border border-gray-200 rounded-md">
                      <p className="text-sm font-medium text-gray-700 mb-1">Cron Schedule</p>
                      <p className="text-sm text-gray-600 font-mono">{selectedTrigger.cronSchedule}</p>
                      <p className="text-xs text-gray-500 mt-1">This schedule is managed by the existing schedule definition.</p>
                    </div>
                  )}

                  {selectedTrigger.isExisting && (
                    <div className="p-3 bg-blue-50 border border-blue-200 rounded-md">
                      <p className="text-sm text-blue-800">
                        This is an existing {selectedTrigger.type}. The pipeline will reference it without modifying its configuration.
                      </p>
                    </div>
                  )}

                  {selectedTrigger.type === 'sensor' && !selectedTrigger.isExisting && (
                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Sensor Type
                        </label>
                        <select
                          value={selectedSensorType?.id || ''}
                          onChange={(e) => {
                            const sensorType = sensorTypes.find((st: any) => st.id === e.target.value);
                            setSelectedSensorType(sensorType);
                            setSensorConfig({
                              component_type: sensorType?.type === 'component' ? 'component' : 'primitive',
                              sensor_type: sensorType?.sensor_type,
                              component_id: sensorType?.id,
                              component_type_full: sensorType?.component_type,
                            });
                          }}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          <option value="">Select sensor type...</option>
                          {sensorTypes.map((sensorType: any) => (
                            <option key={sensorType.id} value={sensorType.id}>
                              {sensorType.name}
                            </option>
                          ))}
                        </select>
                        {selectedSensorType && (
                          <p className="mt-1 text-xs text-gray-500">{selectedSensorType.description}</p>
                        )}
                      </div>

                      {selectedSensorType && selectedSensorType.config_schema && Object.keys(selectedSensorType.config_schema).length > 0 && (
                        <div className="space-y-3 pt-2 border-t border-gray-200">
                          <p className="text-sm font-medium text-gray-700">Configuration</p>
                          {Object.entries(selectedSensorType.config_schema).map(([key, schema]: [string, any]) => (
                            <div key={key}>
                              <label className="block text-sm font-medium text-gray-700 mb-1">
                                {key.split('_').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
                                {schema.required && <span className="text-red-500 ml-1">*</span>}
                              </label>
                              {schema.type === 'select' ? (
                                <select
                                  value={sensorConfig[key] || ''}
                                  onChange={(e) => setSensorConfig({ ...sensorConfig, [key]: e.target.value })}
                                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                                >
                                  <option value="">Select...</option>
                                  {schema.options.map((opt: string) => (
                                    <option key={opt} value={opt}>{opt}</option>
                                  ))}
                                </select>
                              ) : (
                                <input
                                  type="text"
                                  value={sensorConfig[key] || ''}
                                  onChange={(e) => setSensorConfig({ ...sensorConfig, [key]: e.target.value })}
                                  placeholder={schema.description}
                                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                              )}
                              {schema.description && (
                                <p className="mt-1 text-xs text-gray-500">{schema.description}</p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {sidePanelMode === 'asset' && selectedAssetId && (() => {
                const asset = getAssetById(selectedAssetId);
                if (!asset) return null;

                return (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Asset Key
                      </label>
                      <div className="px-3 py-2 bg-gray-50 border border-gray-300 rounded-md text-sm font-mono">
                        {asset.data?.asset_key || asset.id}
                      </div>
                    </div>

                    {asset.data?.label && asset.data.label !== asset.data.asset_key && (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Label
                        </label>
                        <div className="px-3 py-2 bg-gray-50 border border-gray-300 rounded-md text-sm">
                          {asset.data.label}
                        </div>
                      </div>
                    )}

                    {asset.data?.description && (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Description
                        </label>
                        <div className="px-3 py-2 bg-gray-50 border border-gray-300 rounded-md text-sm">
                          {asset.data.description}
                        </div>
                      </div>
                    )}

                    {asset.data?.group_name && (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Group
                        </label>
                        <div className="inline-flex items-center gap-2 px-3 py-2 bg-blue-50 border border-blue-200 rounded-md text-sm">
                          <Database className="w-4 h-4 text-blue-600" />
                          <span>{asset.data.group_name}</span>
                        </div>
                      </div>
                    )}

                    {asset.data?.owners && asset.data.owners.length > 0 && (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Owners
                        </label>
                        <div className="flex flex-wrap gap-2">
                          {asset.data.owners.map((owner: string) => (
                            <div
                              key={owner}
                              className="inline-flex items-center gap-1 px-3 py-1 bg-purple-50 border border-purple-200 rounded-full text-sm"
                            >
                              <Users className="w-3 h-3 text-purple-600" />
                              <span>{owner}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {asset.data?.source_component && (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Source
                        </label>
                        <div className="inline-flex items-center gap-2 px-3 py-2 bg-green-50 border border-green-200 rounded-md text-sm">
                          <Tag className="w-4 h-4 text-green-600" />
                          <span>Generated Asset</span>
                        </div>
                      </div>
                    )}

                    {asset.data?.checks && asset.data.checks.length > 0 && (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Asset Checks ({asset.data.checks.length})
                        </label>
                        <div className="space-y-1">
                          {asset.data.checks.slice(0, 10).map((check: any) => (
                            <div
                              key={check.name || check}
                              className="px-3 py-2 bg-orange-50 border border-orange-200 rounded-md text-sm flex items-center gap-2"
                            >
                              <CheckCircle className="w-4 h-4 text-orange-600 flex-shrink-0" />
                              <span className="truncate">{typeof check === 'string' ? check : check.name}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="pt-4 border-t border-gray-200">
                      <p className="text-xs text-gray-600">
                        {selectedAssets.has(selectedAssetId)
                          ? '✓ This asset is included in the pipeline'
                          : 'This asset is not included in the pipeline'}
                      </p>
                    </div>
                  </div>
                );
              })()}
            </div>
          </aside>
        )}
      </div>

      {/* Add Existing Asset Modal */}
      {showAddExistingAsset && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between p-6 border-b">
              <h3 className="text-lg font-semibold text-gray-900 flex items-center space-x-2">
                <Database className="w-5 h-5 text-green-600" />
                <span>Add Existing Assets to Pipeline</span>
              </h3>
              <button
                onClick={() => setShowAddExistingAsset(false)}
                className="p-1 hover:bg-gray-100 rounded"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              <p className="text-sm text-gray-600 mb-4">
                Select assets from your project to include in this pipeline:
              </p>
              <div className="space-y-2">
                {allAssets.filter((asset) => !selectedAssets.has(asset.id)).map((asset) => (
                  <div
                    key={asset.id}
                    onClick={() => {
                      const newSelection = new Set(selectedAssets);
                      newSelection.add(asset.id);
                      setSelectedAssets(newSelection);
                    }}
                    className="p-4 border border-gray-200 rounded-lg hover:border-green-500 hover:bg-green-50 cursor-pointer transition-all"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center space-x-2 mb-2">
                          <Layers className="w-4 h-4 text-gray-600" />
                          <h4 className="text-sm font-semibold text-gray-900">
                            {asset.data?.asset_key || asset.data?.label || asset.id}
                          </h4>
                        </div>
                        {asset.data?.description && (
                          <p className="text-xs text-gray-600 mb-2">{asset.data.description}</p>
                        )}
                        <div className="flex flex-wrap gap-2">
                          {asset.data?.group && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-700 border border-purple-300">
                              {asset.data.group}
                            </span>
                          )}
                          {asset.data?.compute_kind && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700 border border-blue-300">
                              {asset.data.compute_kind}
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const newSelection = new Set(selectedAssets);
                          newSelection.add(asset.id);
                          setSelectedAssets(newSelection);
                        }}
                        className="ml-4 px-3 py-1.5 text-sm bg-green-600 text-white rounded-md hover:bg-green-700"
                      >
                        Add
                      </button>
                    </div>
                  </div>
                ))}
                {allAssets.filter((asset) => !selectedAssets.has(asset.id)).length === 0 && (
                  <div className="text-center py-8 text-gray-500">
                    <Database className="w-12 h-12 text-gray-400 mx-auto mb-3" />
                    <p className="text-sm">All assets are already in this pipeline</p>
                  </div>
                )}
              </div>
            </div>

            <div className="border-t p-6">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-600">
                  {selectedAssets.size} asset{selectedAssets.size !== 1 ? 's' : ''} in pipeline
                </p>
                <button
                  onClick={() => setShowAddExistingAsset(false)}
                  className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create Asset Modal */}
      {showCreateAsset && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900 flex items-center space-x-2">
                <Code className="w-5 h-5 text-blue-600" />
                <span>Create New Asset</span>
              </h3>
              <button
                onClick={() => setShowCreateAsset(false)}
                className="p-1 hover:bg-gray-100 rounded"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Asset Type <span className="text-red-500">*</span>
                </label>
                <select
                  value={newAssetType}
                  onChange={(e) => setNewAssetType(e.target.value as any)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="python">Python Asset</option>
                  <option value="rest_api">REST API Fetcher</option>
                  <option value="database_query">Database Query</option>
                  <option value="dataframe_transformer">DataFrame Transformer</option>
                  <option value="file_transformer">File Transformer</option>
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  Select the type of asset to create
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Asset Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={newAssetName}
                  onChange={(e) => setNewAssetName(e.target.value)}
                  placeholder="e.g., my_new_asset"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                />
                <p className="text-xs text-gray-500 mt-1">
                  Use snake_case for asset names
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Group
                </label>
                <input
                  type="text"
                  value={newAssetGroup}
                  onChange={(e) => setNewAssetGroup(e.target.value)}
                  placeholder="e.g., analytics"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description
                </label>
                <textarea
                  value={newAssetDescription}
                  onChange={(e) => setNewAssetDescription(e.target.value)}
                  placeholder="What does this asset do?"
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Dependencies (Optional)
                </label>
                <select
                  multiple
                  value={newAssetDeps}
                  onChange={(e) => {
                    const selected = Array.from(e.target.selectedOptions, option => option.value);
                    setNewAssetDeps(selected);
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  size={5}
                >
                  {allAssets.map((asset) => (
                    <option key={asset.id} value={asset.data?.asset_key || asset.id}>
                      {asset.data?.asset_key || asset.id}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  Hold Ctrl/Cmd to select multiple assets
                </p>
              </div>

              {/* Component-specific fields */}
              {newAssetType === 'rest_api' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      API URL <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={apiUrl}
                      onChange={(e) => setApiUrl(e.target.value)}
                      placeholder="https://api.example.com/data"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      HTTP Method
                    </label>
                    <select
                      value={apiMethod}
                      onChange={(e) => setApiMethod(e.target.value as any)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="GET">GET</option>
                      <option value="POST">POST</option>
                      <option value="PUT">PUT</option>
                      <option value="DELETE">DELETE</option>
                    </select>
                  </div>
                </>
              )}

              {newAssetType === 'database_query' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Connection String <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={dbConnectionString}
                      onChange={(e) => setDbConnectionString(e.target.value)}
                      placeholder="postgresql://user:pass@localhost:5432/db"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      SQL Query <span className="text-red-500">*</span>
                    </label>
                    <textarea
                      value={dbQuery}
                      onChange={(e) => setDbQuery(e.target.value)}
                      placeholder="SELECT * FROM table_name"
                      rows={4}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                    />
                  </div>
                </>
              )}

              {newAssetType === 'dataframe_transformer' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Input Asset <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={inputAsset}
                      onChange={(e) => setInputAsset(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Select an asset...</option>
                      {allAssets.map((asset) => (
                        <option key={asset.id} value={asset.data?.asset_key || asset.id}>
                          {asset.data?.asset_key || asset.id}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Transform Code <span className="text-red-500">*</span>
                    </label>
                    <textarea
                      value={transformCode}
                      onChange={(e) => setTransformCode(e.target.value)}
                      placeholder="# Transform function&#10;df['new_column'] = df['old_column'] * 2&#10;return df"
                      rows={4}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                    />
                  </div>
                </>
              )}

              {newAssetType === 'file_transformer' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Input File Path <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={inputPath}
                      onChange={(e) => setInputPath(e.target.value)}
                      placeholder="/path/to/input/file.csv"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Output File Path <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={outputPath}
                      onChange={(e) => setOutputPath(e.target.value)}
                      placeholder="/path/to/output/file.parquet"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Transform Code <span className="text-red-500">*</span>
                    </label>
                    <textarea
                      value={transformCode}
                      onChange={(e) => setTransformCode(e.target.value)}
                      placeholder="# Transform function&#10;data = json.load(f)&#10;return data"
                      rows={4}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                    />
                  </div>
                </>
              )}

              <div className="pt-4 border-t border-gray-200">
                <div className="flex items-center space-x-3">
                  <button
                    onClick={handleCreateAsset}
                    disabled={!isCreateAssetFormValid() || isCreatingAsset}
                    className="flex-1 flex items-center justify-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Plus className="w-4 h-4" />
                    <span>{isCreatingAsset ? 'Creating...' : 'Create Asset'}</span>
                  </button>
                  <button
                    onClick={() => setShowCreateAsset(false)}
                    className="px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>

              <div className="p-3 bg-blue-50 border border-blue-200 rounded-md">
                {newAssetType === 'python' ? (
                  <p className="text-xs text-blue-800">
                    This will create a Python file with an @asset decorator. The asset will be automatically included in this pipeline.
                  </p>
                ) : (
                  <p className="text-xs text-blue-800">
                    This will install the {newAssetType.replace('_', ' ')} component and create a configured instance for your asset.
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Inferred Dependencies Warning Toast - Only show on main pipeline screen, not in modals */}
      {showInferredDepsWarning && !showAddExistingAsset && !showCreateAsset && (
        <div className="fixed bottom-6 left-6 right-6 z-50 transition-all duration-300 ease-out">
          <div className="bg-amber-50 border-l-4 border-amber-500 rounded-lg shadow-xl p-3 mx-auto max-w-5xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-3 flex-1">
                <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0" />
                <p className="text-sm text-amber-900">
                  <span className="font-semibold">Warning:</span> {inferredDepsCount} {inferredDepsCount === 1 ? 'dependency skips' : 'dependencies skip'} intermediate assets, which may cause stale data. Consider including all assets in the dependency chain or using asset selection syntax (e.g., "asset_name*").
                </p>
              </div>
              <button
                onClick={() => setShowInferredDepsWarning(false)}
                className="text-amber-600 hover:text-amber-800 flex-shrink-0 ml-3"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
