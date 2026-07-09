import { useCallback, useEffect, useRef, useState } from 'react';
import ReactFlow, {
  Node,
  Edge,
  addEdge,
  Connection,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  Controls,
  Background,
  BackgroundVariant,
  MiniMap,
  NodeTypes,
  EdgeTypes,
  useViewport,
  EdgeProps,
  getBezierPath,
  BaseEdge,
  EdgeLabelRenderer,
  ConnectionMode,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { ComponentNode } from './nodes/ComponentNode';
import { AssetNode } from './nodes/AssetNode';
import { Launchpad } from './Launchpad';
import { DataPreviewModal } from './DataPreviewModal';
import { AssetIOPanel } from './AssetIOPanel';
import { DagsterAIBar } from './DagsterAIBar';
import { notify } from './Notifications';
import { useProjectStore } from '@/hooks/useProject';
import { projectsApi, componentsApi } from '@/services/api';
import { Play } from 'lucide-react';
import type { GraphNode, GraphEdge, ComponentSchema } from '@/types';

const nodeTypes: NodeTypes = {
  component: ComponentNode,
  asset: AssetNode,
};

// Custom edge component that shows delete button when clicked for custom edges
function CustomEdge({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd, selected }: EdgeProps) {
  const { currentProject, setCurrentProject } = useProjectStore();
  const { setEdges, getNodes } = useReactFlow();

  console.log('[CustomEdge] Component called for edge:', id, 'source:', source, 'target:', target, 'data.is_custom:', data?.is_custom, 'selected:', selected);

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

    if (!currentProject || !data?.is_custom) return;

    // Get the actual asset keys from the nodes
    const nodes = getNodes();
    const sourceNode = nodes.find(n => n.id === source);
    const targetNode = nodes.find(n => n.id === target);

    if (!sourceNode || !targetNode) {
      console.error('[CustomEdge] Could not find source or target node');
      return;
    }

    // Get asset keys from node data
    const sourceAssetKey = sourceNode.data?.asset_key || source;
    const targetAssetKey = targetNode.data?.asset_key || target;

    console.log('[CustomEdge] Deleting custom lineage:', sourceAssetKey, '->', targetAssetKey);

    // Immediately remove the edge from the UI for instant feedback
    setEdges((edges) => edges.filter((edge) => edge.id !== id));

    try {
      // Call API to remove custom lineage in the background
      await projectsApi.removeCustomLineage(currentProject.id, sourceAssetKey, targetAssetKey);

      console.log('[CustomEdge] Custom lineage removed successfully');

      // Regenerate to refresh the graph and ensure saved state is correct
      console.log('[CustomEdge] Regenerating assets to refresh graph state');
      const response = await fetch(`/api/v1/projects/${currentProject.id}/regenerate-assets`, {
        method: 'POST',
      });
      const updatedProject = await response.json();
      console.log('[CustomEdge] Regenerated project has', updatedProject.graph.edges.length, 'edges,', updatedProject.custom_lineage.length, 'custom lineage entries');

      // Update edges from backend with smart routing
      const currentNodes = getNodes();
      const flowEdges: Edge[] = updatedProject.graph.edges.map((edge: GraphEdge) => {
        const isCustom = edge.is_custom === true;

        // Calculate smart edge routing
        const sourceNode = currentNodes.find(n => n.id === edge.source);
        const targetNode = currentNodes.find(n => n.id === edge.target);
        const { sourceHandle, targetHandle } = calculateEdgeHandles(sourceNode, targetNode);

        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: sourceHandle,
          targetHandle: targetHandle,
          data: { is_custom: isCustom },
          style: isCustom ? { strokeDasharray: '5,5', stroke: '#f59e0b', strokeWidth: 2 } : {},
          type: isCustom ? 'custom' : 'default',
        };
      });
      setEdges(flowEdges);

      // Update project state
      setCurrentProject(updatedProject);

      console.log('[CustomEdge] Graph regenerated successfully');
    } catch (error) {
      console.error('[CustomEdge] Failed to delete custom lineage:', error);
      notify.error('Failed to delete custom lineage. See console for details.');

      // On error, trigger regeneration to restore the correct state
      try {
        const response = await fetch(`/api/v1/projects/${currentProject.id}/regenerate-assets`, {
          method: 'POST',
        });
        const updatedProject = await response.json();

        // Restore edges from backend with smart routing
        const currentNodes = getNodes();
        const flowEdges: Edge[] = updatedProject.graph.edges.map((edge: GraphEdge) => {
          // Calculate smart edge routing
          const sourceNode = currentNodes.find(n => n.id === edge.source);
          const targetNode = currentNodes.find(n => n.id === edge.target);
          const { sourceHandle, targetHandle } = calculateEdgeHandles(sourceNode, targetNode);

          return {
            id: edge.id,
            source: edge.source,
            target: edge.target,
            sourceHandle: sourceHandle,
            targetHandle: targetHandle,
            data: { is_custom: edge.is_custom },
            style: edge.is_custom ? { strokeDasharray: '5,5', stroke: '#f59e0b', strokeWidth: 2 } : {},
            type: edge.is_custom ? 'custom' : 'default',
          };
        });
        setEdges(flowEdges);
      } catch (regenError) {
        console.error('[CustomEdge] Failed to restore state:', regenError);
      }
    }
  };

  const isCustom = data?.is_custom === true;

  // For non-custom edges, just render a simple edge
  if (!isCustom) {
    return <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} />;
  }

  console.log('[CustomEdge]', id, '- selected:', selected, 'isCustom:', isCustom);

  return (
    <>
      {/* Invisible wider path for easier clicking - 20px hit area */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        style={{
          cursor: 'pointer',
        }}
      />

      {/* Visible edge line - thicker when selected */}
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: '#f59e0b',
          strokeWidth: selected ? 4 : 2,
          strokeDasharray: '5,5',
          transition: 'stroke-width 0.15s',
          cursor: 'pointer',
          pointerEvents: 'none', // Let the invisible path handle clicks
        }}
      />

      {/* Delete button at center of path - only shown when edge is selected */}
      {selected && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: 'all',
              zIndex: 1000,
            }}
            className="nodrag nopan"
          >
            <button
              onClick={handleDelete}
              title="Delete custom lineage"
              style={{
                width: '44px',
                height: '44px',
                borderRadius: '50%',
                backgroundColor: '#dc2626',
                color: 'white',
                border: '4px solid white',
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '24px',
                fontWeight: 'bold',
                transition: 'transform 0.1s',
              }}
              onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.1)'}
              onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
            >
              ×
            </button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes: EdgeTypes = {
  custom: CustomEdge,
};

// Cache for component schemas
const componentSchemasCache = new Map<string, ComponentSchema>();

// Helper to get IO metadata from component schema
interface IOMetadata {
  inputs?: {
    type: string;
    required?: boolean;
    accepts_multiple?: boolean;
    conditional?: boolean;
    condition?: string;
  };
  outputs?: {
    type: string;
    conditional?: boolean;
    condition?: string;
  };
}

function getIOMetadata(schema: any): IOMetadata | null {
  return schema?.['x-dagster-io'] || null;
}

// Helper to extract all IO metadata for a node
function extractNodeIOMetadata(sourceComponent: string | null | undefined): {
  io_output_type: string | null;
  io_input_type: string | null;
  io_input_required: boolean;
} {
  if (!sourceComponent) {
    return {
      io_output_type: null,
      io_input_type: null,
      io_input_required: false,
    };
  }

  const schema = componentSchemasCache.get(sourceComponent);
  if (!schema) {
    return {
      io_output_type: null,
      io_input_type: null,
      io_input_required: false,
    };
  }

  const ioMetadata = getIOMetadata(schema.schema);
  return {
    io_output_type: ioMetadata?.outputs?.type || null,
    io_input_type: ioMetadata?.inputs?.type || null,
    io_input_required: ioMetadata?.inputs?.required || false,
  };
}

// Helper to get output type from a node
function getNodeOutputType(node: Node): string | null {
  if (!node) return null;

  // For asset nodes, check if they're generated from components with IO metadata
  if (node.data?.node_kind === 'asset' && node.data?.source_component) {
    const sourceComponentType = node.data.source_component;
    const schema = componentSchemasCache.get(sourceComponentType);
    if (schema) {
      const ioMetadata = getIOMetadata(schema.schema);
      if (ioMetadata?.outputs) {
        // Handle conditional outputs
        if (ioMetadata.outputs.conditional && ioMetadata.outputs.condition) {
          // For now, we'll assume conditional outputs might be present
          // TODO: Evaluate condition against node attributes
          return ioMetadata.outputs.type;
        }
        return ioMetadata.outputs.type;
      }
    }
  }

  // For component nodes, check schema directly
  if (node.type === 'component' && node.data?.component_type) {
    const schema = componentSchemasCache.get(node.data.component_type);
    if (schema) {
      const ioMetadata = getIOMetadata(schema.schema);
      if (ioMetadata?.outputs) {
        return ioMetadata.outputs.type;
      }
    }
  }

  return null;
}

// Helper to get input type from a node
function getNodeInputType(node: Node): string | null {
  if (!node) return null;

  // Only component nodes can have input requirements
  if (node.type === 'component' && node.data?.component_type) {
    const schema = componentSchemasCache.get(node.data.component_type);
    if (schema) {
      const ioMetadata = getIOMetadata(schema.schema);
      if (ioMetadata?.inputs) {
        return ioMetadata.inputs.type;
      }
    }
  }

  return null;
}

// Helper to calculate edge routing - always use left/right handles for clarity
function calculateEdgeHandles(sourceNode: Node | undefined, targetNode: Node | undefined): {
  sourceHandle: string | undefined;
  targetHandle: string | undefined;
} {
  if (!sourceNode || !targetNode) {
    return { sourceHandle: undefined, targetHandle: undefined };
  }

  // Always use right handle for source and left handle for target
  // This maintains clear left-to-right data flow regardless of node positions
  return {
    sourceHandle: 'right',
    targetHandle: 'left'
  };
}

interface GraphEditorProps {
  onNodeSelect: (nodeId: string | null) => void;
  onPrimitiveClick?: (category: 'job' | 'schedule' | 'sensor' | 'asset_check', name: string) => void;
}

function GraphEditorInner({ onNodeSelect, onPrimitiveClick }: GraphEditorProps) {
  const { currentProject, updateGraph, setCurrentProject } = useProjectStore();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
  const [isMaterializing, setIsMaterializing] = useState(false);
  const [, setSchemasLoaded] = useState(false);
  const isInitialLoad = useRef(true);
  const hasTriggeredRegeneration = useRef(false);
  const lastSavedNodesHash = useRef<string>('');
  const { screenToFlowPosition, getNodes } = useReactFlow();

  // Launchpad state
  const [showLaunchpad, setShowLaunchpad] = useState(false);
  const [launchpadAssetKey, setLaunchpadAssetKey] = useState<string>('');

  // "Run to here" — materializes an asset + all upstream (via `+asset` selection)
  // and then auto-opens the DataPreviewModal on that asset. Simple Alteryx/Lakeflow
  // style ergonomic loop.
  const [previewAssetKey, setPreviewAssetKey] = useState<string | null>(null);
  const [previewInitialMode, setPreviewInitialMode] = useState<'view' | 'transform'>('view');

  // AssetIOPanel — Lakeflow-style docked bottom pane showing input/output
  // previews for the currently-selected asset. Tracks the asset key
  // independently of the react-flow selection state so we can keep the panel
  // open across non-asset clicks (rubber-band selections, etc.).
  const [ioPanelAssetKey, setIoPanelAssetKey] = useState<string | null>(null);

  // Clear the docked panel if its selected asset vanishes from the graph
  // (typically because the user deleted the component).
  useEffect(() => {
    if (!ioPanelAssetKey || !currentProject) return;
    const stillExists = currentProject.graph.nodes.some(
      (n) => n.id === ioPanelAssetKey || (n.data as any)?.asset_key === ioPanelAssetKey,
    );
    if (!stillExists) setIoPanelAssetKey(null);
  }, [currentProject, ioPanelAssetKey]);

  const handleRunToHere = useCallback(
    async (assetKey: string) => {
      if (!currentProject) return;
      // Flip the running flag on just this node so its Play button spins.
      setNodes((nds) =>
        nds.map((n) =>
          n.id === assetKey || n.data?.asset_key === assetKey
            ? { ...n, data: { ...n.data, isRunningToHere: true } }
            : n,
        ),
      );
      try {
        // `+asset_key` in dg's selection syntax = "this asset and everything upstream."
        const result = await projectsApi.materialize(currentProject.id, [`+${assetKey}`]);
        if (result.success) {
          notify.success(`Materialized ${assetKey} + upstream. Opening preview…`);
          setPreviewAssetKey(assetKey);
        } else {
          const tail = (result.stderr || result.stdout || '').split('\n').slice(-4).join(' | ');
          notify.error(`Materialize failed: ${tail || 'unknown error'}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        notify.error(`Materialize failed: ${msg}`);
      } finally {
        setNodes((nds) =>
          nds.map((n) =>
            n.id === assetKey || n.data?.asset_key === assetKey
              ? { ...n, data: { ...n.data, isRunningToHere: false } }
              : n,
          ),
        );
      }
    },
    [currentProject],
  );

  // Handlers for asset context menu
  const handleMaterializeAsset = useCallback(async (assetKey: string) => {
    if (!currentProject) return;
    try {
      const result = await projectsApi.materialize(currentProject.id, [assetKey]);
      if (result.success) {
        notify.success(`Asset ${assetKey} materialized successfully!`);
      } else {
        notify.error(`Failed to materialize asset ${assetKey}`);
      }
    } catch (error) {
      console.error('Materialize failed:', error);
      notify.error(`Failed to materialize asset ${assetKey}`);
    }
  }, [currentProject]);

  const handleOpenLaunchpad = useCallback((assetKey: string) => {
    setLaunchpadAssetKey(assetKey);
    setShowLaunchpad(true);
  }, []);

  const handleLaunchpadSubmit = useCallback(async (config?: Record<string, any>, tags?: Record<string, string>, partition?: string) => {
    if (!currentProject || !launchpadAssetKey) return;
    try {
      const result = await projectsApi.materialize(currentProject.id, [launchpadAssetKey], config, tags, partition);
      if (result.success) {
        const partitionMsg = partition ? ` (partition: ${partition})` : '';
        notify.success(`Asset ${launchpadAssetKey}${partitionMsg} materialized successfully!`);
      } else {
        notify.error(`Failed to materialize asset ${launchpadAssetKey}`);
      }
    } catch (error) {
      console.error('Materialize failed:', error);
      throw error;
    }
  }, [currentProject, launchpadAssetKey]);

  // Load component schemas for IO validation
  useEffect(() => {
    if (!currentProject) return;

    // Get unique component types from nodes
    const componentTypes = new Set<string>();
    currentProject.graph.nodes.forEach((node: GraphNode) => {
      if (node.data.component_type) {
        componentTypes.add(node.data.component_type);
      }
      if (node.data.source_component) {
        componentTypes.add(node.data.source_component);
      }
    });

    console.log('[GraphEditor] Loading schemas for', componentTypes.size, 'component types');

    // Load schemas that aren't already cached
    const loadPromises: Promise<void>[] = [];
    componentTypes.forEach((componentType) => {
      if (!componentSchemasCache.has(componentType)) {
        loadPromises.push(
          componentsApi
            .get(componentType, currentProject.id)
            .then((schema) => {
              componentSchemasCache.set(componentType, schema);
              console.log(
                '[GraphEditor] Loaded schema for',
                componentType,
                '- IO metadata:',
                getIOMetadata(schema.schema)
              );
            })
            .catch((error) => {
              console.warn(
                '[GraphEditor] Failed to load schema for',
                componentType,
                ':',
                error
              );
            })
        );
      }
    });

    if (loadPromises.length > 0) {
      Promise.all(loadPromises).then(() => {
        console.log('[GraphEditor] All schemas loaded');
        setSchemasLoaded(true);
      });
    } else {
      setSchemasLoaded(true);
    }
  }, [currentProject?.id]);

  // Helper function to sync edges with DependencyGraphComponent
  const syncDependencyGraph = useCallback(async (updatedEdges: Edge[]) => {
    if (!currentProject) return;

    try {
      // Extract asset edges (exclude custom lineage edges)
      const assetEdges = updatedEdges
        .filter(e => !e.data?.is_custom)
        .map(e => ({
          source: e.source,
          target: e.target
        }));

      // Find DependencyGraphComponent in project
      const depGraphComponent = currentProject.components.find(
        c => c.component_type === 'dagster_component_templates.DependencyGraphComponent'
      );

      if (assetEdges.length > 0) {
        if (!depGraphComponent) {
          // Create new DependencyGraphComponent
          console.log('[GraphEditor] Creating DependencyGraphComponent with', assetEdges.length, 'edges');
          const newComponents = [
            ...currentProject.components,
            {
              id: `dep_graph_${Date.now()}`,
              component_type: 'dagster_component_templates.DependencyGraphComponent',
              label: 'Dependency Graph',
              attributes: {
                edges: assetEdges
              },
              translation: null,
              post_processing: null,
              is_asset_factory: false
            }
          ];

          await projectsApi.update(currentProject.id, { components: newComponents });
        } else {
          // Update existing DependencyGraphComponent
          console.log('[GraphEditor] Updating DependencyGraphComponent with', assetEdges.length, 'edges');
          const updatedComponents = currentProject.components.map(c =>
            c.id === depGraphComponent.id
              ? { ...c, attributes: { ...c.attributes, edges: assetEdges } }
              : c
          );

          await projectsApi.update(currentProject.id, { components: updatedComponents });
        }
      } else if (depGraphComponent) {
        // Remove DependencyGraphComponent if no edges
        console.log('[GraphEditor] Removing DependencyGraphComponent (no edges)');
        const updatedComponents = currentProject.components.filter(
          c => c.id !== depGraphComponent.id
        );

        await projectsApi.update(currentProject.id, { components: updatedComponents });
      }
    } catch (error) {
      console.error('[GraphEditor] Failed to sync DependencyGraphComponent:', error);
    }
  }, [currentProject]);

  // Handle node deletion (used for keyboard shortcuts)
  const handleDeleteNode = useCallback((nodeId: string) => {
    console.log('[GraphEditor] Deleting node:', nodeId);

    // Remove the node
    setNodes((nds) => nds.filter((node) => node.id !== nodeId));

    // Remove all edges connected to this node
    setEdges((eds) => eds.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));

    // Deselect if this was the selected node
    onNodeSelect(null);
  }, [setNodes, setEdges, onNodeSelect]);

  // Handle keyboard delete
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Only handle Delete or Backspace when a component node is selected
      if ((event.key === 'Delete' || event.key === 'Backspace') && !event.repeat) {
        // Find selected component nodes (not asset nodes, those shouldn't be deleted)
        const selectedComponentNodes = nodes.filter((node) =>
          node.selected && node.type === 'component'
        );

        if (selectedComponentNodes.length > 0) {
          event.preventDefault();
          selectedComponentNodes.forEach((node) => {
            handleDeleteNode(node.id);
          });
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [nodes, handleDeleteNode]);

  // Track if we should auto-arrange groups after load
  const shouldAutoArrange = useRef(false);

  // Load project graph (when project ID changes OR graph data changes)
  useEffect(() => {
    console.log('[GraphEditor] Loading graph for project:', currentProject?.id);
    isInitialLoad.current = true;

    if (currentProject?.graph) {
      console.log('[GraphEditor] Graph has', currentProject.graph.nodes.length, 'nodes');

      // Auto-arrange only when the incoming layout is actually broken —
      // i.e., group bounding boxes overlap. Users who've manually arranged
      // nodes keep their arrangement; users opening a fresh project with
      // the backend's naive layer-based layout get a clean layout.
      // NB: backend GraphNode carries `node_kind` at the top level (not
      // under `data`), unlike the React-Flow node shape used elsewhere in
      // this file. Filtering on `n.data.node_kind` here returned no assets
      // and the auto-arrange never fired.
      const assetNodes = currentProject.graph.nodes.filter((n: GraphNode) => n.node_kind === 'asset');
      const groupBoxes: Record<string, { minX: number; minY: number; maxX: number; maxY: number }> = {};
      const NODE_W = 220;
      const NODE_H = 100;
      for (const n of assetNodes) {
        const g = (n.data?.group_name as string) || '_ungrouped';
        const x = n.position?.x ?? 0;
        const y = n.position?.y ?? 0;
        const box = groupBoxes[g] ?? { minX: x, minY: y, maxX: x + NODE_W, maxY: y + NODE_H };
        box.minX = Math.min(box.minX, x);
        box.minY = Math.min(box.minY, y);
        box.maxX = Math.max(box.maxX, x + NODE_W);
        box.maxY = Math.max(box.maxY, y + NODE_H);
        groupBoxes[g] = box;
      }
      const names = Object.keys(groupBoxes);
      let hasOverlap = false;
      for (let i = 0; i < names.length && !hasOverlap; i++) {
        for (let j = i + 1; j < names.length && !hasOverlap; j++) {
          const a = groupBoxes[names[i]];
          const b = groupBoxes[names[j]];
          if (a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY) {
            hasOverlap = true;
          }
        }
      }
      if (hasOverlap && names.length > 1) {
        console.log('[GraphEditor] Group boxes overlap — scheduling auto-arrange');
        shouldAutoArrange.current = true;
      }

      const flowNodes: Node[] = currentProject.graph.nodes.map((node: GraphNode) => {
        // Use IO metadata from node.data if available (from backend), otherwise extract from schema cache
        const ioMetadata = (node.data.io_output_type || node.data.io_input_type)
          ? {
              io_output_type: node.data.io_output_type,
              io_input_type: node.data.io_input_type,
              io_input_required: node.data.io_input_required || false,
            }
          : (node.node_kind === 'asset'
              ? extractNodeIOMetadata(node.source_component)
              : { io_output_type: null, io_input_type: null, io_input_required: false });

        return {
          id: node.id,
          type: node.node_kind === 'asset' ? 'asset' : 'component',
          position: node.position,
          data: {
            ...node.data,
            icon: getIconForCategory(node.data.component_type || ''),
            category: getCategoryFromType(node.data.component_type || ''),
            node_kind: node.node_kind,
            source_component: node.source_component,
            ...ioMetadata,
            // Add context menu handlers for asset nodes
            ...(node.node_kind === 'asset' ? {
              onMaterialize: handleMaterializeAsset,
              onOpenLaunchpad: handleOpenLaunchpad,
              onPrimitiveClick,
              onRunToHere: handleRunToHere,
            } : {}),
          },
        };
      });

      // Apply custom lineage to edges
      const customLineage = currentProject.custom_lineage || [];
      console.log('[GraphEditor] Loading edges, custom lineage entries:', customLineage.length);

      // Mark edges as custom if they exist in custom_lineage
      // IMPORTANT: Also normalize edge source/target to replace slashes with underscores
      const edgesWithCustom = currentProject.graph.edges.map((edge: GraphEdge) => {
        // Normalize source and target (replace / with _)
        const normalizedSource = edge.source.replace(/\//g, '_');
        const normalizedTarget = edge.target.replace(/\//g, '_');

        const isCustomLineage = customLineage.some(
          (cl: { source: string; target: string }) => {
            // Convert asset keys to node IDs for comparison
            const sourceNodeId = cl.source.replace(/\//g, '_');
            const targetNodeId = cl.target.replace(/\//g, '_');
            return sourceNodeId === normalizedSource && targetNodeId === normalizedTarget;
          }
        );
        return {
          ...edge,
          source: normalizedSource,
          target: normalizedTarget,
          is_custom: isCustomLineage || edge.is_custom === true,
        };
      });

      // Add any custom lineage edges that don't exist yet
      customLineage.forEach((cl: { source: string; target: string }) => {
        // Convert asset keys to node IDs (replace / with _)
        const sourceNodeId = cl.source.replace(/\//g, '_');
        const targetNodeId = cl.target.replace(/\//g, '_');

        const edgeExists = edgesWithCustom.some(
          (e: GraphEdge) => e.source === sourceNodeId && e.target === targetNodeId
        );
        if (!edgeExists) {
          edgesWithCustom.push({
            id: `${sourceNodeId}_to_${targetNodeId}`,
            source: sourceNodeId,
            target: targetNodeId,
            sourceHandle: null,
            targetHandle: null,
            is_custom: true,
          });
        }
      });

      // Deduplicate edges by ID (in case saved graph has duplicates from previous bugs)
      const edgeMap = new Map<string, GraphEdge>();
      edgesWithCustom.forEach((edge: GraphEdge) => {
        if (!edgeMap.has(edge.id)) {
          edgeMap.set(edge.id, edge);
        } else {
          console.log(`[GraphEditor] Removed duplicate edge: ${edge.id}`);
        }
      });
      const deduplicatedEdges = Array.from(edgeMap.values());

      console.log('[GraphEditor] Edges after deduplication:', deduplicatedEdges.length);
      console.log('[GraphEditor] Edges with custom lineage:', deduplicatedEdges.filter((e: GraphEdge) => e.is_custom).length);

      // Preserve selection state from current edges
      const currentSelectedEdgeIds = new Set(edges.filter(e => e.selected).map(e => e.id));

      const flowEdges: Edge[] = deduplicatedEdges.map((edge: GraphEdge) => {
        const isCustom = edge.is_custom === true;
        console.log(`[GraphEditor] Edge ${edge.id}: is_custom=${edge.is_custom}, source=${edge.source}, target=${edge.target}, will use type=${isCustom ? 'custom' : 'default'}`);

        // Calculate smart edge routing based on node positions
        const sourceNode = flowNodes.find(n => n.id === edge.source);
        const targetNode = flowNodes.find(n => n.id === edge.target);
        const { sourceHandle, targetHandle } = calculateEdgeHandles(sourceNode, targetNode);

        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: sourceHandle,
          targetHandle: targetHandle,
          data: { is_custom: isCustom },
          type: isCustom ? 'custom' : 'default',
          style: isCustom ? { strokeDasharray: '5,5', stroke: '#f59e0b', strokeWidth: 2 } : {},
          selected: currentSelectedEdgeIds.has(edge.id), // Preserve selection
        };
      });

      console.log('[GraphEditor] Total flow edges created:', flowEdges.length);
      console.log('[GraphEditor] Custom edges (type=custom):', flowEdges.filter(e => e.type === 'custom').length);
      console.log('[GraphEditor] Custom edge IDs:', flowEdges.filter(e => e.type === 'custom').map(e => e.id));

      // Check if all edges have valid source/target nodes
      const nodeIds = new Set(flowNodes.map(n => n.id));
      const invalidEdges = flowEdges.filter(e => !nodeIds.has(e.source) || !nodeIds.has(e.target));
      if (invalidEdges.length > 0) {
        console.warn('[GraphEditor] Found edges with invalid source/target nodes:', invalidEdges.map(e => ({
          id: e.id,
          source: e.source,
          target: e.target,
          sourceExists: nodeIds.has(e.source),
          targetExists: nodeIds.has(e.target),
        })));
      }

      setNodes(flowNodes);
      setEdges(flowEdges);
    }

    // Mark initial load as complete after rendering
    const timer = setTimeout(() => {
      console.log('[GraphEditor] Initial load complete');
      isInitialLoad.current = false;

      // Auto-arrange groups if flag is set (e.g., after regeneration)
      if (shouldAutoArrange.current) {
        console.log('[GraphEditor] Auto-arranging groups after load');
        shouldAutoArrange.current = false;
        // Wait for React Flow to fully process nodes (use getNodes() which accesses React Flow's internal state)
        setTimeout(() => {
          arrangeGroups();
        }, 800);
      }
    }, 100);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.id, currentProject?.graph]); // Re-run when project ID or graph data changes


  // Function to arrange groups in a grid to avoid overlaps
  const arrangeGroups = useCallback(() => {
    // Proper two-level layout:
    //   1) Intra-group: topologically layer each group's assets left-to-right
    //      using only edges internal to the group. Within a layer, sort by
    //      indegree then stable order so parallel branches line up.
    //   2) Inter-group: topologically layer the GROUPS themselves using
    //      cross-group edges (source group → target group). Place groups in
    //      columns by layer, rows by order within layer.
    const currentNodes = getNodes();
    const currentEdges = edges;

    const NODE_W = 220;
    const NODE_H = 100;
    const NODE_H_GAP = 80;      // horizontal gap between layers within a group
    const NODE_V_GAP = 40;      // vertical gap between siblings within a layer
    const GROUP_H_GAP = 200;    // horizontal gap between group columns
    const GROUP_V_GAP = 200;    // vertical gap between group rows within a column
    const GROUP_PADDING = 60;   // padding inside each group's bounding box

    // 1) Bucket assets by group_name (ungrouped assets get a synthetic "_" group).
    const buckets = new Map<string, Node[]>();
    for (const n of currentNodes) {
      if (n.data?.node_kind !== 'asset') continue;
      const g = (n.data?.group_name as string) || '_';
      if (!buckets.has(g)) buckets.set(g, []);
      buckets.get(g)!.push(n);
    }
    if (buckets.size === 0) return;

    // Index nodes → group so we can classify edges as intra/inter-group.
    const nodeToGroup = new Map<string, string>();
    for (const [g, ns] of buckets) for (const n of ns) nodeToGroup.set(n.id, g);

    // 2) For each group, run a longest-path topological layering on the
    //    subgraph induced by intra-group edges. Node's layer = 1 + max(layer
    //    of intra-group predecessors), or 0 if none.
    const nodePos = new Map<string, { x: number; y: number }>();
    const groupBoxes = new Map<string, { w: number; h: number }>();

    for (const [g, ns] of buckets) {
      const idsInGroup = new Set(ns.map((n) => n.id));
      const intraPreds = new Map<string, string[]>();
      for (const e of currentEdges) {
        if (idsInGroup.has(e.source) && idsInGroup.has(e.target)) {
          const arr = intraPreds.get(e.target) ?? [];
          arr.push(e.source);
          intraPreds.set(e.target, arr);
        }
      }
      // Longest-path layer assignment (memoized DFS with cycle guard).
      const layer = new Map<string, number>();
      const visiting = new Set<string>();
      const compute = (id: string): number => {
        if (layer.has(id)) return layer.get(id)!;
        if (visiting.has(id)) return 0; // cycle — bail
        visiting.add(id);
        const preds = intraPreds.get(id) ?? [];
        const l = preds.length === 0 ? 0 : Math.max(...preds.map(compute)) + 1;
        visiting.delete(id);
        layer.set(id, l);
        return l;
      };
      ns.forEach((n) => compute(n.id));

      // Bucket nodes by layer for stable within-layer ordering.
      const byLayer = new Map<number, Node[]>();
      ns.forEach((n) => {
        const l = layer.get(n.id) ?? 0;
        if (!byLayer.has(l)) byLayer.set(l, []);
        byLayer.get(l)!.push(n);
      });
      // Sort within-layer by predecessor count (single-parent nodes first)
      // then id for determinism.
      for (const arr of byLayer.values()) {
        arr.sort((a, b) => {
          const pa = intraPreds.get(a.id)?.length ?? 0;
          const pb = intraPreds.get(b.id)?.length ?? 0;
          return pa - pb || a.id.localeCompare(b.id);
        });
      }

      // Assign positions relative to the group's local origin.
      const sortedLayers = Array.from(byLayer.keys()).sort((a, b) => a - b);
      let groupW = 0;
      let groupH = 0;
      sortedLayers.forEach((l, li) => {
        const rows = byLayer.get(l)!;
        rows.forEach((n, ri) => {
          nodePos.set(n.id, {
            x: li * (NODE_W + NODE_H_GAP),
            y: ri * (NODE_H + NODE_V_GAP),
          });
        });
        groupW = Math.max(groupW, li * (NODE_W + NODE_H_GAP) + NODE_W);
        groupH = Math.max(groupH, rows.length * (NODE_H + NODE_V_GAP) - NODE_V_GAP);
      });
      groupBoxes.set(g, {
        w: groupW + GROUP_PADDING * 2,
        h: Math.max(groupH, NODE_H) + GROUP_PADDING * 2,
      });
    }

    // 3) Inter-group topological layering: same longest-path idea, but on
    //    cross-group edges. Groups with no cross-group predecessors go in
    //    column 0. Columns are laid out left-to-right.
    const groupPreds = new Map<string, Set<string>>();
    for (const e of currentEdges) {
      const sg = nodeToGroup.get(e.source);
      const tg = nodeToGroup.get(e.target);
      if (!sg || !tg || sg === tg) continue;
      if (!groupPreds.has(tg)) groupPreds.set(tg, new Set());
      groupPreds.get(tg)!.add(sg);
    }
    const groupLayer = new Map<string, number>();
    const groupVisiting = new Set<string>();
    const computeGroup = (g: string): number => {
      if (groupLayer.has(g)) return groupLayer.get(g)!;
      if (groupVisiting.has(g)) return 0;
      groupVisiting.add(g);
      const preds = groupPreds.get(g);
      const l = !preds || preds.size === 0 ? 0 : Math.max(...Array.from(preds).map(computeGroup)) + 1;
      groupVisiting.delete(g);
      groupLayer.set(g, l);
      return l;
    };
    Array.from(buckets.keys()).forEach(computeGroup);

    // Bucket groups by column (layer).
    const groupsByCol = new Map<number, string[]>();
    for (const g of buckets.keys()) {
      const l = groupLayer.get(g) ?? 0;
      if (!groupsByCol.has(l)) groupsByCol.set(l, []);
      groupsByCol.get(l)!.push(g);
    }
    const cols = Array.from(groupsByCol.keys()).sort((a, b) => a - b);
    // Groups with a downstream cross-group edge come first — this preserves
    // dependency alignment across columns so an edge from col N's last group
    // doesn't have to cross col N's first group to reach col N+1.
    for (const arr of groupsByCol.values()) {
      arr.sort((a, b) => {
        const aHasDown = Array.from(groupPreds.entries()).some(([_g, preds]) => preds.has(a));
        const bHasDown = Array.from(groupPreds.entries()).some(([_g, preds]) => preds.has(b));
        if (aHasDown !== bHasDown) return aHasDown ? -1 : 1;
        return a.localeCompare(b);
      });
    }

    // Equalize width across each column: every group in column N is padded
    // to the widest group in that column. Ensures every source node's right
    // edge sits at the same X as the column's boundary, so edges to N+1 exit
    // cleanly into inter-column empty space instead of clipping through a
    // wider neighbor group's box.
    const colWidths = new Map<number, number>();
    for (const c of cols) {
      const maxW = Math.max(...groupsByCol.get(c)!.map((g) => groupBoxes.get(g)!.w));
      colWidths.set(c, maxW);
      // Extend each narrow group's box to the column's max width so their
      // right edge lines up (visual GroupOverlay will match).
      for (const g of groupsByCol.get(c)!) {
        const box = groupBoxes.get(g)!;
        groupBoxes.set(g, { w: maxW, h: box.h });
      }
    }
    const colX = new Map<number, number>();
    let runX = 0;
    for (const c of cols) {
      colX.set(c, runX);
      runX += (colWidths.get(c) ?? 0) + GROUP_H_GAP;
    }

    // Initial anchor placement — top-down within each column.
    const groupAnchor = new Map<string, { x: number; y: number }>();
    for (const c of cols) {
      let y = 0;
      for (const g of groupsByCol.get(c)!) {
        groupAnchor.set(g, { x: colX.get(c) ?? 0, y });
        y += (groupBoxes.get(g)!.h) + GROUP_V_GAP;
      }
    }

    // Barycenter refinement: for each column (right-to-left then left-to-
    // right, a few passes), sort groups by the mean Y of their neighbors in
    // the adjacent column. This aligns each group vertically with its
    // upstream/downstream group so cross-group edges travel roughly
    // horizontally instead of cutting diagonally across other groups.
    const groupsDownstream = (g: string): string[] => {
      const out: string[] = [];
      for (const [target, preds] of groupPreds) {
        if (preds.has(g)) out.push(target);
      }
      return out;
    };
    const relayoutCol = (c: number, list: string[]) => {
      let y = 0;
      for (const g of list) {
        groupAnchor.set(g, { x: colX.get(c) ?? 0, y });
        y += (groupBoxes.get(g)!.h) + GROUP_V_GAP;
      }
    };
    for (let pass = 0; pass < 3; pass++) {
      // Right-to-left: order each col by mean Y of DOWNSTREAM groups.
      for (let i = cols.length - 1; i >= 0; i--) {
        const c = cols[i];
        const list = groupsByCol.get(c)!;
        list.sort((a, b) => {
          const yA = groupsDownstream(a).map((d) => groupAnchor.get(d)?.y ?? 0);
          const yB = groupsDownstream(b).map((d) => groupAnchor.get(d)?.y ?? 0);
          const ba = yA.length ? yA.reduce((x, y) => x + y, 0) / yA.length : Infinity;
          const bb = yB.length ? yB.reduce((x, y) => x + y, 0) / yB.length : Infinity;
          if (ba !== bb) return ba - bb;
          return a.localeCompare(b);
        });
        relayoutCol(c, list);
      }
      // Left-to-right: order each col by mean Y of UPSTREAM groups.
      for (const c of cols) {
        const list = groupsByCol.get(c)!;
        list.sort((a, b) => {
          const upA = Array.from(groupPreds.get(a) ?? []);
          const upB = Array.from(groupPreds.get(b) ?? []);
          const yA = upA.map((u) => groupAnchor.get(u)?.y ?? 0);
          const yB = upB.map((u) => groupAnchor.get(u)?.y ?? 0);
          const ba = yA.length ? yA.reduce((x, y) => x + y, 0) / yA.length : Infinity;
          const bb = yB.length ? yB.reduce((x, y) => x + y, 0) / yB.length : Infinity;
          if (ba !== bb) return ba - bb;
          return a.localeCompare(b);
        });
        relayoutCol(c, list);
      }
    }

    // 4) Final positions = group anchor + intra-group offset (with padding).
    const finalPos = new Map<string, { x: number; y: number }>();
    for (const n of currentNodes) {
      if (n.data?.node_kind !== 'asset') continue;
      const g = (n.data?.group_name as string) || '_';
      const anchor = groupAnchor.get(g);
      const local = nodePos.get(n.id);
      if (!anchor || !local) continue;
      finalPos.set(n.id, {
        x: anchor.x + GROUP_PADDING + local.x,
        y: anchor.y + GROUP_PADDING + local.y,
      });
    }

    setNodes((nds) =>
      nds.map((n) => (finalPos.has(n.id) ? { ...n, position: finalPos.get(n.id)! } : n)),
    );
  }, [setNodes, getNodes, edges]);

  // Auto-regenerate assets if project has components but no assets
  // Only triggers if dependencies are installed to avoid premature regeneration
  useEffect(() => {
    if (!currentProject || hasTriggeredRegeneration.current) {
      return;
    }

    const hasAssetFactories = currentProject.components.some((c) => c.is_asset_factory);
    const hasAssets = nodes.some((n) => n.data.node_kind === 'asset');

    // Check dependency status from project store
    const { dependencyInstallStatus } = useProjectStore.getState();

    // Don't trigger regeneration if dependencies are still installing
    if (dependencyInstallStatus === 'installing') {
      console.log('[GraphEditor] Skipping auto-regeneration - dependencies are still installing');
      return;
    }

    if (hasAssetFactories && !hasAssets) {
      console.log('[GraphEditor] Project has components but no assets - triggering regeneration');
      hasTriggeredRegeneration.current = true;

      // Trigger asset regeneration
      fetch(`/api/v1/projects/${currentProject.id}/regenerate-assets`, {
        method: 'POST',
      })
        .then((response) => response.json())
        .then((updatedProject) => {
          console.log('[GraphEditor] Assets regenerated:', updatedProject.graph.nodes.length, 'nodes');

          // Update the graph with the regenerated assets
          const flowNodes: Node[] = updatedProject.graph.nodes.map((node: GraphNode) => {
            // Use IO metadata from node.data if available (from backend), otherwise extract from schema cache
            const ioMetadata = (node.data.io_output_type || node.data.io_input_type)
              ? {
                  io_output_type: node.data.io_output_type,
                  io_input_type: node.data.io_input_type,
                  io_input_required: node.data.io_input_required || false,
                }
              : (node.node_kind === 'asset'
                  ? extractNodeIOMetadata(node.source_component)
                  : { io_output_type: null, io_input_type: null, io_input_required: false });

            return {
              id: node.id,
              type: node.node_kind === 'asset' ? 'asset' : 'component',
              position: node.position,
              data: {
                ...node.data,
                icon: getIconForCategory(node.data.component_type || ''),
                category: getCategoryFromType(node.data.component_type || ''),
                node_kind: node.node_kind,
                source_component: node.source_component,
                ...ioMetadata,
                ...(node.node_kind === 'asset' ? { onPrimitiveClick, onRunToHere: handleRunToHere } : {}),
              },
            };
          });

          const flowEdges: Edge[] = updatedProject.graph.edges.map((edge: GraphEdge) => {
            // Calculate smart edge routing
            const sourceNode = flowNodes.find(n => n.id === edge.source);
            const targetNode = flowNodes.find(n => n.id === edge.target);
            const { sourceHandle, targetHandle } = calculateEdgeHandles(sourceNode, targetNode);

            return {
              id: edge.id,
              source: edge.source,
              target: edge.target,
              sourceHandle: sourceHandle,
              targetHandle: targetHandle,
              data: { is_custom: edge.is_custom },
              type: edge.is_custom ? 'custom' : 'default',
              style: edge.is_custom ? { strokeDasharray: '5,5', stroke: '#f59e0b', strokeWidth: 2 } : {},
            };
          });

          setNodes(flowNodes);
          setEdges(flowEdges);
        })
        .catch((error) => {
          console.error('[GraphEditor] Failed to regenerate assets:', error);
        });
    }
  }, [currentProject, nodes, setNodes, setEdges]);

  // Save graph on changes (skip during initial load to prevent infinite loop)
  useEffect(() => {
    if (!currentProject || isInitialLoad.current) {
      console.log('[GraphEditor] Skipping graph save - isInitialLoad:', isInitialLoad.current);
      return;
    }

    // Create a hash of nodes and edges excluding the 'selected' property to avoid saving on selection changes
    const nodesForHash = nodes.map((node) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { selected, ...nodeWithoutSelected } = node;
      return {
        id: nodeWithoutSelected.id,
        type: nodeWithoutSelected.type,
        position: nodeWithoutSelected.position,
        data: nodeWithoutSelected.data,
      };
    });
    const edgesForHash = edges.map((edge) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { selected, ...edgeWithoutSelected } = edge;
      return edgeWithoutSelected;
    });
    const currentHash = JSON.stringify({ nodes: nodesForHash, edges: edgesForHash });

    // Only save if the hash has changed (ignoring selection changes)
    if (currentHash === lastSavedNodesHash.current) {
      console.log('[GraphEditor] Skipping graph save - no meaningful changes');
      return;
    }

    console.log('[GraphEditor] Saving graph with', nodes.length, 'nodes and', edges.length, 'edges');
    lastSavedNodesHash.current = currentHash;

    const graphNodes: GraphNode[] = nodes.map((node) => {
      // Extract node_kind and source_component from data (where we put them during load)
      // and put them back at the top level for the backend
      const { node_kind, source_component, icon, category, isSelected, ...restData } = node.data || {};

      return {
        id: node.id,
        type: node.type || 'component',
        data: restData,
        position: node.position,
        node_kind: node_kind,
        source_component: source_component,
      };
    });

    const graphEdges: GraphEdge[] = edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      is_custom: edge.data?.is_custom || false,
    }));

    console.log('[GraphEditor] Calling updateGraph');
    updateGraph(graphNodes, graphEdges);

    // Sync edges with DependencyGraphComponent
    syncDependencyGraph(edges);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, syncDependencyGraph]); // Only depend on nodes and edges - currentProject and updateGraph are stable

  // Validate column compatibility between source and target nodes
  const validateColumnCompatibility = useCallback(
    (sourceNode: GraphNode, targetNode: GraphNode): { valid: boolean; errors: string[]; warnings: string[] } => {
      const errors: string[] = [];
      const warnings: string[] = [];

      const sourceOutputColumns = sourceNode.data?.io_output_columns;
      const targetExpectedColumns = targetNode.data?.io_expected_columns;

      // If target doesn't specify expected columns, validation passes
      if (!targetExpectedColumns || targetExpectedColumns.length === 0) {
        return { valid: true, errors, warnings };
      }

      // If source doesn't specify output columns, show warning but allow (backward compatibility)
      if (!sourceOutputColumns || sourceOutputColumns.length === 0) {
        warnings.push('Source component does not declare output columns - compatibility cannot be verified');
        return { valid: true, errors, warnings };
      }

      // Build a map of source output columns (including name + alternatives)
      const sourceColumnMap = new Map<string, any>();
      sourceOutputColumns.forEach((col: any) => {
        sourceColumnMap.set(col.name.toLowerCase(), col);
      });

      // Check each required column in target
      for (const expectedCol of targetExpectedColumns) {
        if (expectedCol.required === false) {
          continue; // Skip optional columns
        }

        // Check if source provides this column (or any alternative)
        const possibleNames = [expectedCol.name, ...(expectedCol.alternatives || [])];
        const found = possibleNames.some(name => sourceColumnMap.has(name.toLowerCase()));

        if (!found) {
          errors.push(`Missing required column: "${expectedCol.name}"${expectedCol.alternatives && expectedCol.alternatives.length > 0 ? ` (alternatives: ${expectedCol.alternatives.join(', ')})` : ''}`);
        } else {
          // Found the column - optionally check type compatibility
          const sourceCol = possibleNames.map(n => sourceColumnMap.get(n.toLowerCase())).find(c => c);
          if (sourceCol && sourceCol.type && expectedCol.type && sourceCol.type !== expectedCol.type) {
            warnings.push(`Type mismatch for column "${expectedCol.name}": source provides ${sourceCol.type}, target expects ${expectedCol.type}`);
          }
        }
      }

      return { valid: errors.length === 0, errors, warnings };
    },
    []
  );

  // Validate DataFrame connections based on IO metadata
  const isValidConnection = useCallback(
    (connection: Connection): boolean => {
      console.log('[GraphEditor] isValidConnection called with:', connection);

      // Prevent self-loops
      if (connection.source === connection.target) {
        console.log('[GraphEditor] Self-loop detected - rejecting connection');
        return false;
      }

      // Check if edge already exists
      const edgeExists = edges.some(
        (edge) => edge.source === connection.source && edge.target === connection.target
      );
      console.log('[GraphEditor] Edge already exists:', edgeExists);

      // Allow duplicate edges for custom lineage
      // ReactFlow will prevent the connection from being made if we return false here
      // So we return true and handle duplicates in onConnect

      const sourceNode = nodes.find((n) => n.id === connection.source);
      const targetNode = nodes.find((n) => n.id === connection.target);

      if (!sourceNode || !targetNode) {
        console.log('[GraphEditor] Source or target node not found');
        return true; // Let it through if nodes not found
      }

      // Check both nodes are asset nodes (custom lineage - always allowed)
      const isSourceAsset = sourceNode?.data?.node_kind === 'asset';
      const isTargetAsset = targetNode?.data?.node_kind === 'asset';

      console.log('[GraphEditor] Source is asset:', isSourceAsset, 'Target is asset:', isTargetAsset);

      if (isSourceAsset && isTargetAsset) {
        console.log('[GraphEditor] Both nodes are assets - custom lineage allowed (validation will happen on release)');
        // Allow the connection attempt - validation with user feedback happens in onConnect
        return true;
      }

      // Check if target requires specific input type
      const targetInputType = getNodeInputType(targetNode);
      if (!targetInputType) {
        // Target doesn't specify input requirements - allow connection
        return true;
      }

      // Target requires specific input type - check if source provides it
      const sourceOutputType = getNodeOutputType(sourceNode);
      if (!sourceOutputType) {
        // Source doesn't declare output type - show warning but allow
        console.warn(
          '[GraphEditor] Connection validation: Source node does not declare output type'
        );
        return true; // Allow for backwards compatibility
      }

      // Check if types match
      const typesMatch = sourceOutputType === targetInputType;

      if (!typesMatch) {
        console.warn(
          `[GraphEditor] Connection validation failed: ` +
            `Source outputs '${sourceOutputType}' but target requires '${targetInputType}'`
        );

        // Show user-friendly error message
        notify.error(
          `Connection Type Mismatch\n\n` +
            `Cannot connect these assets:\n\n` +
            `• Source "${sourceNode.data?.label || sourceNode.id}" produces: ${sourceOutputType}\n` +
            `• Target "${targetNode.data?.label || targetNode.id}" requires: ${targetInputType}\n\n` +
            `To fix this:\n` +
            `- Connect a ${targetInputType}-producing asset to the target\n` +
            `- Or use a different target component that accepts ${sourceOutputType}`
        );
        return false;
      }

      // Types match - now validate column compatibility
      const columnValidation = validateColumnCompatibility(sourceNode as unknown as GraphNode, targetNode as unknown as GraphNode);

      if (!columnValidation.valid) {
        console.warn('[GraphEditor] Column validation failed:', columnValidation.errors);

        // Build detailed error message
        let errorMessage = `Column Schema Mismatch\n\n`;
        errorMessage += `Cannot connect these components:\n\n`;
        errorMessage += `• Source: "${sourceNode.data?.label || sourceNode.id}"\n`;
        errorMessage += `• Target: "${targetNode.data?.label || targetNode.id}"\n\n`;
        errorMessage += `Missing Required Columns:\n`;
        columnValidation.errors.forEach(err => {
          errorMessage += `  - ${err}\n`;
        });

        if (columnValidation.warnings.length > 0) {
          errorMessage += `\nWarnings:\n`;
          columnValidation.warnings.forEach(warn => {
            errorMessage += `  - ${warn}\n`;
          });
        }

        errorMessage += `\nTo fix this:\n`;
        errorMessage += `- Ensure the source component outputs all required columns\n`;
        errorMessage += `- Or add a transformation component to map/create missing columns\n`;
        errorMessage += `- Or connect a different source that provides the required data`;

        notify.error(errorMessage);
        return false;
      }

      // Show warnings if any (but still allow connection)
      if (columnValidation.warnings.length > 0) {
        console.warn('[GraphEditor] Column validation warnings:', columnValidation.warnings);

        let warningMessage = `Column Compatibility Warnings\n\n`;
        warningMessage += `Connecting:\n`;
        warningMessage += `• Source: "${sourceNode.data?.label || sourceNode.id}"\n`;
        warningMessage += `• Target: "${targetNode.data?.label || targetNode.id}"\n\n`;
        warningMessage += `Warnings:\n`;
        columnValidation.warnings.forEach(warn => {
          warningMessage += `  - ${warn}\n`;
        });
        warningMessage += `\nThe connection will be allowed, but you may encounter runtime issues.`;

        // Use console.warn instead of alert for warnings to not be too disruptive
        console.warn(warningMessage);
      }

      return true;
    },
    [nodes, edges, validateColumnCompatibility]
  );

  const onConnect = useCallback(
    async (connection: Connection) => {
      console.log('='.repeat(80));
      console.log('[GraphEditor] 🎯 onConnect CALLED with:', connection);
      console.log('='.repeat(80));

      // Validate connection first
      if (!isValidConnection(connection)) {
        console.log('[GraphEditor] Connection rejected by validation');
        return;
      }

      console.log('[GraphEditor] ✅ Connection passed validation');

      // Check if both nodes exist
      const sourceNode = nodes.find((n) => n.id === connection.source);
      const targetNode = nodes.find((n) => n.id === connection.target);

      if (!sourceNode || !targetNode) {
        console.log('[GraphEditor] Source or target node not found in onConnect');
        return;
      }

      // Check if both nodes are asset nodes
      const isSourceAsset = sourceNode?.data?.node_kind === 'asset';
      const isTargetAsset = targetNode?.data?.node_kind === 'asset';

      console.log('[GraphEditor] onConnect - Source is asset:', isSourceAsset, 'Target is asset:', isTargetAsset);

      // If both are assets, this is custom lineage
      if (isSourceAsset && isTargetAsset && currentProject) {
        const sourceAssetKey = sourceNode.data.asset_key || sourceNode.data.label;
        const targetAssetKey = targetNode.data.asset_key || targetNode.data.label;

        console.log('[GraphEditor] Creating custom lineage:', sourceAssetKey, '->', targetAssetKey);

        // Validate IO type compatibility and show alerts if invalid
        const targetInputType = targetNode.data?.io_input_type;
        const targetInputRequired = targetNode.data?.io_input_required;
        const sourceOutputType = sourceNode.data?.io_output_type;

        if (targetInputRequired && targetInputType) {
          // Check if source produces output
          if (!sourceOutputType) {
            notify.error(
              `Cannot Connect These Assets\n\n` +
              `Source: "${sourceNode.data?.label || sourceNode.id}"\n` +
              `• This asset does not produce output\n\n` +
              `Target: "${targetNode.data?.label || targetNode.id}"\n` +
              `• Requires ${targetInputType} input\n\n` +
              `To fix: Connect an asset that produces ${targetInputType} output to the target.`
            );
            return;
          }

          // Check type compatibility
          if (sourceOutputType !== targetInputType) {
            notify.error(
              `Type Mismatch - Connection Not Allowed\n\n` +
              `Source: "${sourceNode.data?.label || sourceNode.id}"\n` +
              `• Produces: ${sourceOutputType}\n\n` +
              `Target: "${targetNode.data?.label || targetNode.id}"\n` +
              `• Requires: ${targetInputType}\n\n` +
              `These types are incompatible. To fix:\n` +
              `• Connect a ${targetInputType}-producing asset to the target\n` +
              `• Or use a different target component that accepts ${sourceOutputType}`
            );
            return;
          }
        }

        // Optimistically add the edge immediately
        const newEdge = {
          id: `${connection.source}_to_${connection.target}`,
          source: connection.source,
          target: connection.target,
          source_handle: connection.sourceHandle,
          target_handle: connection.targetHandle,
          is_custom: true,
        };
        setEdges((eds) => addEdge({...connection, id: newEdge.id, data: { is_custom: true }}, eds));
        console.log('[GraphEditor] Optimistically added edge to UI');

        try {
          // Call API to add custom lineage (non-blocking)
          await projectsApi.addCustomLineage(currentProject.id, sourceAssetKey, targetAssetKey);

          console.log('[GraphEditor] Custom lineage saved, triggering background regeneration with layout recalculation');

          // Trigger asset regeneration in background to confirm and recalculate layout
          const response = await fetch(`/api/v1/projects/${currentProject.id}/regenerate-assets?recalculate_layout=true`, {
            method: 'POST',
          });

          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.detail || 'Failed to regenerate assets');
          }

          const updatedProject = await response.json();

          // Update the graph with regenerated assets
          const flowNodes: Node[] = updatedProject.graph.nodes.map((node: GraphNode) => {
            // Use IO metadata from node.data if available (from backend), otherwise extract from schema cache
            const ioMetadata = (node.data.io_output_type || node.data.io_input_type)
              ? {
                  io_output_type: node.data.io_output_type,
                  io_input_type: node.data.io_input_type,
                  io_input_required: node.data.io_input_required || false,
                }
              : (node.node_kind === 'asset'
                  ? extractNodeIOMetadata(node.source_component)
                  : { io_output_type: null, io_input_type: null, io_input_required: false });

            return {
              id: node.id,
              type: node.node_kind === 'asset' ? 'asset' : 'component',
              position: node.position,
              data: {
                ...node.data,
                icon: getIconForCategory(node.data.component_type || ''),
                category: getCategoryFromType(node.data.component_type || ''),
                node_kind: node.node_kind,
                source_component: node.source_component,
                ...ioMetadata,
              },
            };
          });

          // Apply custom lineage to edges (same logic as initial load)
          const customLineage = updatedProject.custom_lineage || [];
          const edgesWithCustom = updatedProject.graph.edges.map((edge: GraphEdge) => {
            const isCustomLineage = customLineage.some(
              (cl: { source: string; target: string }) => {
                // Convert asset keys to node IDs for comparison
                const sourceNodeId = cl.source.replace(/\//g, '_');
                const targetNodeId = cl.target.replace(/\//g, '_');
                return sourceNodeId === edge.source && targetNodeId === edge.target;
              }
            );
            return {
              ...edge,
              is_custom: isCustomLineage || edge.is_custom === true,
            };
          });

          // Add any custom lineage edges that don't exist yet
          customLineage.forEach((cl: { source: string; target: string }) => {
            // Convert asset keys to node IDs (replace / with _)
            const sourceNodeId = cl.source.replace(/\//g, '_');
            const targetNodeId = cl.target.replace(/\//g, '_');

            const edgeExists = edgesWithCustom.some(
              (e: GraphEdge) => e.source === sourceNodeId && e.target === targetNodeId
            );
            if (!edgeExists) {
              edgesWithCustom.push({
                id: `${sourceNodeId}_to_${targetNodeId}`,
                source: sourceNodeId,
                target: targetNodeId,
                sourceHandle: null,
                targetHandle: null,
                is_custom: true,
              });
            }
          });

          const flowEdges: Edge[] = edgesWithCustom.map((edge: GraphEdge) => {
            // Calculate smart edge routing
            const sourceNode = flowNodes.find(n => n.id === edge.source);
            const targetNode = flowNodes.find(n => n.id === edge.target);
            const { sourceHandle, targetHandle } = calculateEdgeHandles(sourceNode, targetNode);

            return {
              id: edge.id,
              source: edge.source,
              target: edge.target,
              sourceHandle: sourceHandle,
              targetHandle: targetHandle,
              data: { is_custom: edge.is_custom },
              type: edge.is_custom ? 'custom' : 'default',
              style: edge.is_custom ? { strokeDasharray: '5,5', stroke: '#f59e0b', strokeWidth: 2 } : {},
            };
          });

          setNodes(flowNodes);
          setEdges(flowEdges);

          // Update the project state with the regenerated project (including custom_lineage)
          setCurrentProject(updatedProject);

          console.log('[GraphEditor] Custom lineage applied successfully');
        } catch (error) {
          console.error('[GraphEditor] Failed to add custom lineage:', error);
          notify.error('Failed to add custom lineage. See console for details.');
        }
        return;
      }

      // For component nodes, use the old behavior
      // Add the edge
      setEdges((eds) => addEdge(connection, eds));

      // Check if target is a component node that should have dependencies
      const isTargetComponent = targetNode?.type === 'component';

      if (isTargetComponent) {
        const sourceAssetKey = sourceNode.data.asset_key || sourceNode.data.label || sourceNode.id;

        // Update the target node's deps array in the data
        setNodes((nds) =>
          nds.map((node) => {
            if (node.id === connection.target) {
              const currentDeps = node.data.deps || [];
              if (!currentDeps.includes(sourceAssetKey)) {
                console.log('[GraphEditor] Adding dependency:', sourceAssetKey, 'to', targetNode.id);
                return {
                  ...node,
                  data: {
                    ...node.data,
                    deps: [...currentDeps, sourceAssetKey],
                  },
                };
              }
            }
            return node;
          })
        );
      }
    },
    [setEdges, setNodes, nodes, currentProject, isValidConnection]
  );

  const handleMaterializeSelected = async () => {
    if (!currentProject || selectedAssets.length === 0) return;

    setIsMaterializing(true);
    try {
      // Get asset keys for selected assets
      const assetKeys = selectedAssets
        .map((id) => {
          const node = nodes.find((n) => n.id === id);
          return node?.data?.asset_key || id;
        })
        .filter(Boolean);

      console.log('[GraphEditor] Materializing assets:', assetKeys);
      const result = await projectsApi.materialize(currentProject.id, assetKeys);
      console.log('[GraphEditor] Materialization result:', result);

      if (result.success) {
        notify.success(`Successfully materialized ${assetKeys.length} asset(s)!\n\nOutput:\n${result.stdout.slice(0, 500)}`);
        console.log('Materialization output:', result.stdout);
      } else {
        const errorMsg = result.stderr || result.message || 'Unknown error';
        notify.error(`Materialization failed:\n\n${errorMsg.slice(0, 500)}`);
        console.error('Materialization failed - stderr:', result.stderr);
        console.error('Materialization failed - stdout:', result.stdout);
        console.error('Materialization failed - message:', result.message);
      }
    } catch (error: any) {
      console.error('Materialize selected failed:', error);
      const errorMsg = error?.response?.data?.detail || error?.message || String(error);
      notify.error(`Failed to materialize assets:\n\n${errorMsg}`);
    } finally {
      setIsMaterializing(false);
    }
  };

  const onNodeClick = useCallback(
    (event: React.MouseEvent, node: Node) => {
      onNodeSelect(node.id);

      // Handle multi-select for assets with Cmd/Ctrl key
      if (node.data?.node_kind === 'asset' && (event.metaKey || event.ctrlKey)) {
        setSelectedAssets((prev) => {
          if (prev.includes(node.id)) {
            return prev.filter((id) => id !== node.id);
          } else {
            return [...prev, node.id];
          }
        });
      } else if (node.data?.node_kind === 'asset') {
        // Single asset click without Cmd/Ctrl - select only this asset
        setSelectedAssets([node.id]);
        // Populate the docked I/O panel with this asset's data. Use the
        // asset's real key (from data), not the react-flow node id, because
        // dbt asset keys have slashes we replace for graph safety.
        const key = node.data?.asset_key || node.id;
        setIoPanelAssetKey(key);
      } else {
        // Clear selection when clicking non-asset nodes
        setSelectedAssets([]);
      }
    },
    [onNodeSelect]
  );

  const onPaneClick = useCallback(() => {
    onNodeSelect(null);
    setSelectedAssets([]);
    // Clear group selections
    setNodes((nds) =>
      nds.map((node) => ({
        ...node,
        selected: false,
      }))
    );
  }, [onNodeSelect, setNodes]);

  // Handle drag and drop from palette
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      console.log('[GraphEditor] Drop event triggered');
      event.preventDefault();

      const componentData = event.dataTransfer.getData('application/reactflow');
      if (!componentData) {
        console.log('[GraphEditor] No component data found');
        return;
      }

      const component = JSON.parse(componentData);
      console.log('[GraphEditor] Dropping component:', component);

      // Convert screen coordinates to flow coordinates
      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      console.log('[GraphEditor] Position:', position);

      const newNode: Node = {
        id: `${component.type}-${Date.now()}`,
        type: 'component',
        position,
        data: {
          label: component.name,
          componentType: component.type, // PropertyPanel expects camelCase
          component_type: component.type, // Keep for consistency
          deps: [], // Initialize empty deps array for edge connections
          attributes: {},
          icon: component.icon,
          category: component.category,
        },
      };

      console.log('[GraphEditor] Adding new node:', newNode.id);
      setNodes((nds) => [...nds, newNode]);

      // Trigger layout recalculation after adding a new asset
      if (currentProject) {
        console.log('[GraphEditor] Triggering layout recalculation after adding component');
        fetch(`/api/v1/projects/${currentProject.id}/regenerate-assets?recalculate_layout=true`, {
          method: 'POST',
        }).then(async (response) => {
          if (response.ok) {
            const updatedProject = await response.json();
            // Update the graph with regenerated layout
            if (updatedProject.graph && updatedProject.graph.nodes) {
              const flowNodes: Node[] = updatedProject.graph.nodes.map((node: any) => ({
                id: node.id,
                type: node.node_kind === 'asset' ? 'asset' : 'component',
                position: node.position,
                data: node.data,
              }));
              setNodes(flowNodes);
              setEdges(updatedProject.graph.edges);
            }
          }
        }).catch((error) => {
          console.error('[GraphEditor] Failed to recalculate layout:', error);
        });
      }
    },
    [setNodes, screenToFlowPosition, currentProject, setEdges]
  );

  if (!currentProject) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        <div className="text-center">
          <p className="text-lg font-medium">No project selected</p>
          <p className="text-sm mt-2">Create or open a project to get started</p>
        </div>
      </div>
    );
  }

  // Update nodes to show selection
  const displayNodes = nodes.map((node) => {
    // Use node.selected if it's explicitly set (e.g., by group selection), otherwise check selectedAssets
    const isSelected = node.selected !== undefined ? node.selected : selectedAssets.includes(node.id);

    return {
      ...node,
      selected: isSelected, // ReactFlow uses this for visual highlighting
      data: {
        ...node.data,
        isSelected: isSelected, // Also set in data for node component
      },
    };
  });

  return (
    <div className="w-full h-full flex flex-col">
      {/* Slim header row — actions on the right, matches Automation/Pipelines */}
      <div className="flex-shrink-0 bg-white border-b border-gray-200 px-4 py-2 flex items-center justify-between gap-2">
        <div className="text-xs text-gray-400">
          Tip: shift+drag to box-select, or ⌘+click to add assets
        </div>
        <div className="flex items-center gap-2">
        {selectedAssets.length > 0 && (
          <>
            <span className="text-xs text-gray-500 mr-1">
              {selectedAssets.length} selected
            </span>
            <button
              onClick={handleMaterializeSelected}
              disabled={isMaterializing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Play className="w-4 h-4" />
              <span>{isMaterializing ? 'Materializing…' : 'Materialize selected'}</span>
            </button>
          </>
        )}
        <button
          onClick={arrangeGroups}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded"
          title="Arrange groups in a grid to prevent overlaps (preserves positions within groups)"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
          </svg>
          <span>Arrange Groups</span>
        </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 relative">
      <ReactFlow
        nodes={displayNodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onSelectionChange={({ nodes: sel }) => {
          const assetIds = sel
            .filter((n) => n.data?.node_kind === 'asset')
            .map((n) => n.id);
          if (assetIds.length > 0) {
            setSelectedAssets(assetIds);
          }
        }}
        onDrop={onDrop}
        onDragOver={onDragOver}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        isValidConnection={isValidConnection}
        connectionMode={ConnectionMode.Loose}
        fitView
        defaultEdgeOptions={{
          type: 'default',
        }}
        nodesDraggable={true}
        nodesConnectable={true}
        elementsSelectable={true}
        selectNodesOnDrag={false}
        minZoom={0.2}
        maxZoom={2}
      >
        <GroupOverlay nodes={nodes} setNodes={setNodes} />
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls />
        <MiniMap />
      </ReactFlow>
      {/* Docked at the bottom of the graph pane (above the I/O panel when
          it's open) so the AI bar never covers input/output previews. */}
      <DagsterAIBar />
      </div>

      {/* Docked I/O preview panel — appears when the user selects an asset
          node and shows compact input/output tables. Buttons in its header
          hand off to the full DataPreviewModal. */}
      {currentProject && ioPanelAssetKey && (() => {
        // Upstream keys = source data of every edge ending at this node.
        // We match on both node.id and node.data.asset_key because the two
        // can differ for assets whose key has slashes (react-flow ids don't
        // allow slashes so they get normalized).
        const targetIds = new Set(
          nodes
            .filter((n) => n.id === ioPanelAssetKey || n.data?.asset_key === ioPanelAssetKey)
            .map((n) => n.id),
        );
        const upstream = edges
          .filter((e) => targetIds.has(e.target))
          .map((e) => {
            const sourceNode = nodes.find((n) => n.id === e.source);
            return (sourceNode?.data?.asset_key as string) || e.source;
          })
          .filter((k, i, arr) => arr.indexOf(k) === i);
        return (
          <AssetIOPanel
            projectId={currentProject.id}
            selectedAssetKey={ioPanelAssetKey}
            upstreamKeys={upstream}
            onOpenPreview={(assetKey, mode) => {
              setPreviewInitialMode(mode);
              setPreviewAssetKey(assetKey);
            }}
            onClose={() => setIoPanelAssetKey(null)}
          />
        );
      })()}

      {/* Launchpad for single asset materialization */}
      {currentProject && launchpadAssetKey && (
        <Launchpad
          open={showLaunchpad}
          onOpenChange={setShowLaunchpad}
          projectId={currentProject.id}
          mode="materialize"
          assetKeys={[launchpadAssetKey]}
          onLaunch={handleLaunchpadSubmit}
          defaultConfig={{}}
          configSchema={{}}
        />
      )}

      {/* Data preview — opened automatically by "Run to here" once the
          materialize completes; also opened by the I/O panel's Transform /
          Preview more buttons (with initialMode set accordingly). */}
      {currentProject && previewAssetKey && (
        <DataPreviewModal
          isOpen={!!previewAssetKey}
          onClose={() => {
            setPreviewAssetKey(null);
            setPreviewInitialMode('view');
          }}
          projectId={currentProject.id}
          assetKey={previewAssetKey}
          assetName={previewAssetKey}
          initialMode={previewInitialMode}
          onTransformerCreated={(updatedProject) => {
            // Response from create-transformer includes the freshly-generated
            // nodes/edges. Sync into the graph store so the new node appears
            // immediately without a manual refresh.
            if (updatedProject?.graph) {
              updateGraph(updatedProject.graph.nodes, updatedProject.graph.edges);
            }
          }}
        />
      )}
    </div>
  );
}

// Component to render group bounding boxes with proper viewport transformation
function GroupOverlay({ nodes, setNodes }: { nodes: Node[]; setNodes: React.Dispatch<React.SetStateAction<Node[]>> }) {
  const { x, y, zoom } = useViewport();

  // Handler to select all nodes in a group when clicking the header
  const handleGroupHeaderClick = useCallback((groupName: string, event: React.MouseEvent) => {
    event.stopPropagation();

    console.log('[GroupOverlay] Group header clicked - selecting nodes in:', groupName);
    console.log('[GroupOverlay] 💡 TIP: After selection, drag any of the selected asset nodes to move the entire group');

    // Select all nodes in this group
    setNodes((nds) =>
      nds.map((node) => {
        const nodeGroupName = node.data?.group_name;
        const isAsset = node.data?.node_kind === 'asset';
        const isInGroup = nodeGroupName && nodeGroupName === groupName && isAsset;

        console.log('[GroupOverlay] Node:', node.id, '- nodeGroup:', nodeGroupName, '- targetGroup:', groupName, '- isAsset:', isAsset, '- selected:', isInGroup);

        return {
          ...node,
          selected: isInGroup,
        };
      })
    );
  }, [setNodes]);

  // Compute asset groups for visualization
  const assetGroups = nodes.reduce((groups, node) => {
    if (node.data?.node_kind === 'asset' && node.data?.group_name) {
      const groupName = node.data.group_name;
      if (!groups[groupName]) {
        groups[groupName] = [];
      }
      groups[groupName].push(node);
    }
    return groups;
  }, {} as Record<string, typeof nodes>);

  // Compute bounding boxes for each group
  const groupBounds = Object.entries(assetGroups)
    .filter(([_, groupNodes]) => groupNodes.length > 0)
    .map(([groupName, groupNodes]) => {
      const positions = groupNodes.map((n) => ({
        x: n.position.x,
        y: n.position.y,
        width: 280, // AssetNode max-width
        height: 120, // Approximate height
      }));

      const minX = Math.min(...positions.map((p) => p.x)) - 60;
      const minY = Math.min(...positions.map((p) => p.y)) - 80;
      const maxX = Math.max(...positions.map((p) => p.x + p.width)) + 60;
      const maxY = Math.max(...positions.map((p) => p.y + p.height)) + 60;

      return {
        groupName,
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      };
    });

  if (groupBounds.length === 0) return null;

  // Check which groups have selected nodes
  const groupsWithSelection = new Set(
    nodes.filter((n) => n.selected && n.data?.node_kind === 'asset' && n.data?.group_name)
      .map((n) => n.data.group_name)
  );

  return (
    <>
      {/* Background SVG for group boxes */}
      <svg
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          zIndex: 0,
        }}
      >
        <g transform={`translate(${x}, ${y}) scale(${zoom})`}>
          {groupBounds.map((bound) => {
            const isGroupSelected = groupsWithSelection.has(bound.groupName);

            return (
              <g key={bound.groupName}>
                {/* Background rectangle */}
                <rect
                  x={bound.x}
                  y={bound.y}
                  width={bound.width}
                  height={bound.height}
                  fill={isGroupSelected ? 'hsl(246, 68%, 96%)' : 'hsl(246, 68%, 98%)'}
                  stroke={isGroupSelected ? 'hsl(246, 68%, 56%)' : 'hsl(246, 60%, 80%)'}
                  strokeWidth={1.5 / zoom}
                  rx="6"
                  style={{ pointerEvents: 'none' }}
                />
              </g>
            );
          })}
        </g>
      </svg>

      {/* Clickable HTML header bars */}
      {groupBounds.map((bound) => {
        const isGroupSelected = groupsWithSelection.has(bound.groupName);
        const handleHeight = 30;

        // Convert flow coordinates to screen coordinates
        const screenX = bound.x * zoom + x;
        const screenY = bound.y * zoom + y;
        const screenWidth = bound.width * zoom;

        return (
          <div
            key={`header-${bound.groupName}`}
            style={{
              position: 'absolute',
              left: `${screenX}px`,
              top: `${screenY}px`,
              width: `${screenWidth}px`,
              height: `${handleHeight}px`,
              background: isGroupSelected ? 'hsl(246, 68%, 56%)' : 'hsl(246, 68%, 56%, 0.85)',
              border: '1px solid hsl(246, 60%, 41%)',
              borderRadius: '6px 6px 0 0',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-start',
              paddingLeft: '10px',
              color: 'white',
              fontSize: '11px',
              fontWeight: '600',
              letterSpacing: '0.02em',
              textTransform: 'uppercase',
              userSelect: 'none',
              zIndex: 10,
              pointerEvents: 'auto',
            }}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              console.log('[GroupOverlay] Group header clicked!', bound.groupName);
              handleGroupHeaderClick(bound.groupName, e);
            }}
          >
            {bound.groupName}
          </div>
        );
      })}
    </>
  );
}

function getCategoryFromType(type: string): string {
  if (type === 'dagster.PythonScriptComponent') return 'primitives';
  if (type === 'dagster.TemplatedSqlComponent') return 'primitives';
  // Check for dbt components (not duckdb - use word boundary)
  if (/\bdbt[_\.]|^dbt/i.test(type)) return 'dbt';
  if (type.includes('fivetran')) return 'fivetran';
  if (type.includes('sling')) return 'sling';
  if (type.includes('dlt')) return 'dlt';
  return 'custom';
}

function getIconForCategory(type: string): string {
  // Handle Dagster built-in components first
  if (type === 'dagster.PythonScriptComponent') return 'code';
  if (type === 'dagster.TemplatedSqlComponent') return 'database';

  // Handle other component types by category
  const category = getCategoryFromType(type);
  const iconMap: Record<string, string> = {
    dbt: 'database',
    fivetran: 'sync',
    sling: 'arrow-right',
    dlt: 'download',
  };
  return iconMap[category] || 'cube';
}

// Wrapper component to provide ReactFlow context
export function GraphEditor(props: GraphEditorProps) {
  return (
    <ReactFlowProvider>
      <GraphEditorInner {...props} />
    </ReactFlowProvider>
  );
}
