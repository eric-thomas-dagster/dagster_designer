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
  Panel,
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
import { useProjectStore } from '@/hooks/useProject';
import { projectsApi, componentsApi } from '@/services/api';
import { Play, Trash2 } from 'lucide-react';
import type { GraphNode, GraphEdge, ComponentSchema } from '@/types';

const nodeTypes: NodeTypes = {
  component: ComponentNode,
  asset: AssetNode,
};

// Custom edge component that shows delete button when clicked for custom edges
function CustomEdge({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd, selected }: EdgeProps) {
  const { currentProject, setCurrentProject } = useProjectStore();
  const { setEdges, setNodes, getNodes } = useReactFlow();

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
      const customLineage = updatedProject.custom_lineage || [];
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
      alert('Failed to delete custom lineage. See console for details.');

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

// Helper to calculate smart edge routing based on node positions
function calculateEdgeHandles(sourceNode: Node | undefined, targetNode: Node | undefined): {
  sourceHandle: string | undefined;
  targetHandle: string | undefined;
} {
  if (!sourceNode || !targetNode) {
    return { sourceHandle: undefined, targetHandle: undefined };
  }

  // Calculate center positions
  const sourceCenterX = sourceNode.position.x + 140; // Approximate node width / 2
  const sourceCenterY = sourceNode.position.y + 60;  // Approximate node height / 2
  const targetCenterX = targetNode.position.x + 140;
  const targetCenterY = targetNode.position.y + 60;

  // Calculate delta
  const deltaX = targetCenterX - sourceCenterX;
  const deltaY = targetCenterY - sourceCenterY;

  // Determine primary direction based on which delta is larger
  const absX = Math.abs(deltaX);
  const absY = Math.abs(deltaY);

  let sourceHandle: string;
  let targetHandle: string;

  if (absX > absY) {
    // Horizontal connection is dominant
    if (deltaX > 0) {
      // Target is to the right of source
      sourceHandle = 'right';
      targetHandle = 'left';
    } else {
      // Target is to the left of source
      sourceHandle = 'left-source';
      targetHandle = 'right-target';
    }
  } else {
    // Vertical connection is dominant
    if (deltaY > 0) {
      // Target is below source
      sourceHandle = 'bottom-source';
      targetHandle = 'top';
    } else {
      // Target is above source
      sourceHandle = 'top-source';
      targetHandle = 'bottom';
    }
  }

  return { sourceHandle, targetHandle };
}

interface GraphEditorProps {
  onNodeSelect: (nodeId: string | null) => void;
}

function GraphEditorInner({ onNodeSelect }: GraphEditorProps) {
  const { currentProject, updateGraph, setCurrentProject } = useProjectStore();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
  const [isMaterializing, setIsMaterializing] = useState(false);
  const [schemasLoaded, setSchemasLoaded] = useState(false);
  const isInitialLoad = useRef(true);
  const hasTriggeredRegeneration = useRef(false);
  const lastSavedNodesHash = useRef<string>('');
  const { screenToFlowPosition, getNodes } = useReactFlow();

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
            .get(componentType)
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

      // Disable auto-arrange - let users manually arrange groups if needed
      // const hadNodesBeforeReload = nodes.length > 0;
      // const projectHasGroups = currentProject.graph.nodes.some((n: GraphNode) => n.data?.group_name);

      // if ((hadNodesBeforeReload || projectHasGroups) && currentProject.graph.nodes.length > 0) {
      //   shouldAutoArrange.current = true;
      //   console.log('[GraphEditor] Will auto-arrange groups after load (hadNodesBefore:', hadNodesBeforeReload, 'hasGroups:', projectHasGroups, ')');
      // }

      const flowNodes: Node[] = currentProject.graph.nodes.map((node: GraphNode) => {
        // Determine IO output type for visual indicators
        let ioOutputType: string | null = null;
        if (node.node_kind === 'asset' && node.source_component) {
          const schema = componentSchemasCache.get(node.source_component);
          if (schema) {
            const ioMetadata = getIOMetadata(schema.schema);
            if (ioMetadata?.outputs) {
              ioOutputType = ioMetadata.outputs.type;
            }
          }
        }

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
            io_output_type: ioOutputType,
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
    // Get nodes from React Flow's internal state (more up-to-date than component state)
    const currentNodes = getNodes();

    // Get asset nodes grouped by group_name
    const groupedNodes = currentNodes.reduce((acc, node) => {
      if (node.data?.node_kind === 'asset' && node.data?.group_name) {
        const groupName = node.data.group_name;
        if (!acc[groupName]) {
          acc[groupName] = [];
        }
        acc[groupName].push(node);
      }
      return acc;
    }, {} as Record<string, Node[]>);

    const groupNames = Object.keys(groupedNodes);
    console.log('[GraphEditor] arrangeGroups - found groups:', groupNames, 'from', currentNodes.length, 'nodes');

    if (groupNames.length <= 1) {
      console.log('[GraphEditor] Only one or zero groups, skipping arrange');
      return;
    }

    // Calculate bounding boxes for each group
    const groupBounds = groupNames.map((groupName) => {
      const groupNodes = groupedNodes[groupName];
      const positions = groupNodes.map((n) => ({
        x: n.position.x,
        y: n.position.y,
        width: 280,
        height: 120,
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
        nodes: groupNodes,
      };
    });

    console.log('[GraphEditor] Arranging', groupBounds.length, 'groups in grid layout');

    // Arrange groups in a grid layout
    const HORIZONTAL_SPACING = 150;
    const VERTICAL_SPACING = 150;
    const COLS = 2; // 2 columns

    let currentX = 0;
    let currentY = 0;
    let maxHeightInRow = 0;
    let col = 0;

    const newNodePositions = new Map<string, { x: number; y: number }>();

    groupBounds.forEach((group, index) => {
      // Calculate offset for this group
      const offsetX = currentX - group.x;
      const offsetY = currentY - group.y;

      // Update positions for all nodes in this group
      group.nodes.forEach((node) => {
        newNodePositions.set(node.id, {
          x: node.position.x + offsetX,
          y: node.position.y + offsetY,
        });
      });

      // Update for next group
      maxHeightInRow = Math.max(maxHeightInRow, group.height);
      col++;

      if (col >= COLS) {
        // Move to next row
        currentX = 0;
        currentY += maxHeightInRow + VERTICAL_SPACING;
        maxHeightInRow = 0;
        col = 0;
      } else {
        // Move to next column
        currentX += group.width + HORIZONTAL_SPACING;
      }
    });

    // Apply new positions
    setNodes((nds) =>
      nds.map((node) => {
        const newPos = newNodePositions.get(node.id);
        if (newPos) {
          return {
            ...node,
            position: newPos,
          };
        }
        return node;
      })
    );
  }, [setNodes, getNodes]);

  // Auto-regenerate assets if project has components but no assets
  useEffect(() => {
    if (!currentProject || hasTriggeredRegeneration.current) {
      return;
    }

    const hasAssetFactories = currentProject.components.some((c) => c.is_asset_factory);
    const hasAssets = nodes.some((n) => n.data.node_kind === 'asset');

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
            let ioOutputType: string | null = null;
            if (node.node_kind === 'asset' && node.source_component) {
              const schema = componentSchemasCache.get(node.source_component);
              if (schema) {
                const ioMetadata = getIOMetadata(schema.schema);
                if (ioMetadata?.outputs) {
                  ioOutputType = ioMetadata.outputs.type;
                }
              }
            }

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
                io_output_type: ioOutputType,
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
        console.log('[GraphEditor] Both nodes are assets - custom lineage allowed');
        // Custom lineage between assets
        // Only check IO types if target is from a component that requires specific inputs
        if (targetNode.data?.source_component) {
          const targetSchema = componentSchemasCache.get(targetNode.data.source_component);
          if (targetSchema) {
            const targetIOMetadata = getIOMetadata(targetSchema.schema);
            if (targetIOMetadata?.inputs && targetIOMetadata.inputs.required) {
              // Target requires input - check if source produces output
              const sourceHasOutput = sourceNode.data?.io_output_type != null;

              if (!sourceHasOutput) {
                console.warn(
                  '[GraphEditor] Connection validation failed: ' +
                  `Source asset "${sourceNode.data?.label || sourceNode.id}" does not produce output, ` +
                  `but target asset "${targetNode.data?.label || targetNode.id}" requires input (${targetIOMetadata.inputs.type})`
                );

                alert(
                  `⚠️ Cannot Connect These Assets\n\n` +
                  `Source: "${sourceNode.data?.label || sourceNode.id}"\n` +
                  `• This asset does not produce output\n\n` +
                  `Target: "${targetNode.data?.label || targetNode.id}"\n` +
                  `• Requires ${targetIOMetadata.inputs.type} input\n\n` +
                  `To fix: Connect an asset that produces output to the target.`
                );

                return false;
              }

              // Both have IO metadata - check type compatibility
              const sourceOutputType = sourceNode.data.io_output_type;
              const targetInputType = targetIOMetadata.inputs.type;

              if (sourceOutputType !== targetInputType) {
                console.warn(
                  '[GraphEditor] Connection validation warning: ' +
                  `Source outputs "${sourceOutputType}" but target expects "${targetInputType}"`
                );

                alert(
                  `⚠️ Type Mismatch Warning\n\n` +
                  `Source: "${sourceNode.data?.label || sourceNode.id}"\n` +
                  `• Produces: ${sourceOutputType}\n\n` +
                  `Target: "${targetNode.data?.label || targetNode.id}"\n` +
                  `• Requires: ${targetInputType}\n\n` +
                  `These types may not be compatible.`
                );

                return false;
              }
            }
          }
        }

        // Custom lineage allowed
        console.log('[GraphEditor] Custom lineage validation passed');
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
      const isValid = sourceOutputType === targetInputType;

      if (!isValid) {
        console.warn(
          `[GraphEditor] Connection validation failed: ` +
            `Source outputs '${sourceOutputType}' but target requires '${targetInputType}'`
        );

        // Show user-friendly error message
        alert(
          `⚠️ Connection Type Mismatch\n\n` +
            `Cannot connect these assets:\n\n` +
            `• Source "${sourceNode.data?.label || sourceNode.id}" produces: ${sourceOutputType}\n` +
            `• Target "${targetNode.data?.label || targetNode.id}" requires: ${targetInputType}\n\n` +
            `To fix this:\n` +
            `- Connect a ${targetInputType}-producing asset to the target\n` +
            `- Or use a different target component that accepts ${sourceOutputType}`
        );
      }

      return isValid;
    },
    [nodes, edges]
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
            let ioOutputType: string | null = null;
            if (node.node_kind === 'asset' && node.source_component) {
              const schema = componentSchemasCache.get(node.source_component);
              if (schema) {
                const ioMetadata = getIOMetadata(schema.schema);
                if (ioMetadata?.outputs) {
                  ioOutputType = ioMetadata.outputs.type;
                }
              }
            }

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
                io_output_type: ioOutputType,
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
          alert('Failed to add custom lineage. See console for details.');
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
        alert(`✅ Successfully materialized ${assetKeys.length} asset(s)!\n\nOutput:\n${result.stdout.slice(0, 500)}`);
        console.log('Materialization output:', result.stdout);
      } else {
        const errorMsg = result.stderr || result.message || 'Unknown error';
        alert(`❌ Materialization failed:\n\n${errorMsg.slice(0, 500)}`);
        console.error('Materialization failed - stderr:', result.stderr);
        console.error('Materialization failed - stdout:', result.stdout);
        console.error('Materialization failed - message:', result.message);
      }
    } catch (error: any) {
      console.error('Materialize selected failed:', error);
      const errorMsg = error?.response?.data?.detail || error?.message || String(error);
      alert(`❌ Failed to materialize assets:\n\n${errorMsg}`);
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
    <div className="w-full h-full">
      <ReactFlow
        nodes={displayNodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
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
        {selectedAssets.length > 0 && (
          <Panel position="top-right" className="bg-white rounded-lg shadow-lg p-3 border border-gray-200">
            <div className="flex flex-col items-center space-y-2">
              <div className="text-sm font-medium text-gray-700">
                {selectedAssets.length} asset{selectedAssets.length > 1 ? 's' : ''} selected
              </div>
              <button
                onClick={handleMaterializeSelected}
                disabled={isMaterializing}
                className="flex items-center space-x-2 px-4 py-2 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
              >
                <Play className="w-4 h-4" />
                <span>{isMaterializing ? 'Materializing...' : 'Materialize Selected'}</span>
              </button>
            </div>
          </Panel>
        )}
        <Panel position="top-left" className="bg-white rounded-lg shadow-lg p-2 border border-gray-200">
          <div className="flex flex-col space-y-2">
            <button
              onClick={arrangeGroups}
              className="flex items-center space-x-2 px-3 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700"
              title="Arrange groups in a grid to prevent overlaps (preserves positions within groups)"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
              </svg>
              <span>Arrange Groups</span>
            </button>
          </div>
        </Panel>
        <GroupOverlay nodes={nodes} setNodes={setNodes} />
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls />
        <MiniMap />
      </ReactFlow>
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
                  fill={isGroupSelected ? "rgba(59, 130, 246, 0.15)" : "rgba(59, 130, 246, 0.05)"}
                  stroke={isGroupSelected ? "rgba(59, 130, 246, 0.6)" : "rgba(59, 130, 246, 0.3)"}
                  strokeWidth={2 / zoom}
                  strokeDasharray={`${5 / zoom},${5 / zoom}`}
                  rx="8"
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
              background: isGroupSelected ? "rgba(59, 130, 246, 0.8)" : "rgba(59, 130, 246, 0.6)",
              border: "1px solid rgba(59, 130, 246, 0.9)",
              borderRadius: '8px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'white',
              fontSize: '12px',
              fontWeight: '600',
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
            <span style={{ marginRight: '4px' }}>📦</span>
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
  if (type.includes('dbt')) return 'dbt';
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
