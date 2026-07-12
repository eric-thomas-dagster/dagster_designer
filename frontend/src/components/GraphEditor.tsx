import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
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
  NodeProps,
  Handle,
  Position,
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
import { AddDataDialog } from './AddDataDialog';
import { notify } from './Notifications';
import { AutoCoverageModal } from './AssetDetailPage';
import { useProjectStore } from '@/hooks/useProject';
import { projectsApi, componentsApi } from '@/services/api';
import { Play, Plus, Layers, CheckCircle } from 'lucide-react';
import type { GraphNode, GraphEdge, ComponentSchema } from '@/types';

// Node for the "collapse to groups" mode. Fixed width (so edges hit
// consistent x-anchors), auto height (so content doesn't leave blank
// space below). The whole card is clickable to expand -- ReactFlow
// still lets the underlying drag through when the user actually
// initiates a drag gesture, so making the card the click target is
// safe and much more discoverable than a small button.
const GroupNode = memo(({ data }: NodeProps) => {
  // Click handling for group cards lives on the ReactFlow onNodeClick
  // handler in GraphEditorInner (see: node.type === 'assetGroup'). We
  // deliberately don't attach onClick here -- fighting ReactFlow's
  // pointer event system inside custom nodes made the click zone feel
  // unreliable. The whole card is a click target via cursor:pointer
  // and ReactFlow's native onNodeClick.
  const kinds: string[] = data?.kinds || [];
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} style={{ background: '#6366f1', pointerEvents: 'none' }} />
      <div
        className="rounded-lg border-2 border-indigo-300 bg-gradient-to-br from-indigo-50 to-white shadow-md p-2.5 hover:border-indigo-500 hover:shadow-lg hover:from-indigo-100 transition cursor-pointer"
        style={{ width: 220 }}
        title="Click anywhere to expand this group's assets"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <Layers className="w-4 h-4 text-indigo-600 flex-shrink-0" />
            <div className="font-semibold text-sm text-indigo-900 truncate">{data?.label || 'ungrouped'}</div>
          </div>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-800 border border-indigo-200 flex-shrink-0">
            {data?.assetCount || 0}
          </span>
        </div>
        {kinds.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {kinds.slice(0, 4).map((k) => (
              <span key={k} className="text-[9px] font-mono px-1 py-0.5 rounded bg-white border border-indigo-200 text-indigo-700">{k}</span>
            ))}
            {kinds.length > 4 && (
              <span className="text-[9px] text-indigo-600 self-center">+{kinds.length - 4}</span>
            )}
          </div>
        )}
        {(data?.withChecks || 0) > 0 && (
          <div className="text-[10px] text-emerald-700 mt-1 flex items-center gap-1">
            <CheckCircle className="w-3 h-3" />
            {data.withChecks} with checks
          </div>
        )}
        <div className="text-[10px] text-indigo-700 mt-1.5 font-medium">
          Click to expand →
        </div>
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} style={{ background: '#6366f1', pointerEvents: 'none' }} />
    </>
  );
});

const nodeTypes: NodeTypes = {
  component: ComponentNode,
  asset: AssetNode,
  // ReactFlow reserves 'group' as a subflow-container node type and
  // wraps it in a default dashed outer container -- register under a
  // custom name so our card renders alone.
  assetGroup: GroupNode,
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
  /** Callback fired when the user picks a data source from the "+ Add data"
   *  dialog after the CLI install completes. Wire the same way ComponentPalette
   *  passes the component_type up so App can open the config modal. */
  onAddDataSource?: (componentType: string) => void;
  /** Notifies parent when the user toggles between graph / catalog view.
   *  App uses this to hide the Project Components sidebar when the
   *  catalog is showing (no per-asset editing surface for a table). */
  onViewModeChange?: (mode: 'graph' | 'catalog') => void;
  /** Open the full-screen AssetDetailPage for the given node id. Called
   *  from catalog rows and (indirectly) from PropertyPanel. */
  onOpenAssetDetail?: (nodeId: string) => void;
}

function GraphEditorInner({ onNodeSelect, onPrimitiveClick, onAddDataSource, onViewModeChange, onOpenAssetDetail }: GraphEditorProps) {
  const [addDataOpen, setAddDataOpen] = useState(false);
  // Group-collapse toggle -- folds assets by group_name into one node
  // per group, edges aggregated. Auto-on for large cloud graphs
  // (>60 assets) so users see manageable structure by default.
  const [collapseToGroups, setCollapseToGroups] = useState(false);
  // Per-group opt-out from collapse. When collapseToGroups=true,
  // groups in this Set render their individual assets in place while
  // the rest remain aggregated. Cleared whenever the global collapse
  // toggle flips so users don't get stuck with a mixed view they
  // didn't expect.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  // Groups whose expanded-view layout has already been applied. When a
  // group is freshly expanded we lay out its assets via the mixed-DAG
  // longest-path layout; after that first placement, subsequent renders
  // must keep whatever position the user has dragged the asset to. If
  // we re-applied the layout every render, drags would snap right back.
  const laidOutGroupsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    // Only mutate the ref *after* the render has consumed its previous
    // value (see groupedView memo). Sync-add newly-expanded groups so
    // the next render treats them as "already placed"; drop groups that
    // aren't expanded any more so they get fresh layout on re-expand.
    const next = new Set<string>();
    for (const g of expandedGroups) next.add(g);
    laidOutGroupsRef.current = next;
  }, [expandedGroups]);
  // Stable callbacks so memoized GroupNode / AssetNode instances aren't
  // forced to re-render each time `groupedView` recomputes (the memo
  // creates fresh closures otherwise, defeating React.memo).
  const handleExpandGroup = useCallback((g: string) => {
    setExpandedGroups(prev => {
      if (prev.has(g)) return prev;
      const next = new Set(prev);
      next.add(g);
      return next;
    });
  }, []);
  const handleCollapseGroup = useCallback((g: string) => {
    setExpandedGroups(prev => {
      if (!prev.has(g)) return prev;
      const next = new Set(prev);
      next.delete(g);
      return next;
    });
  }, []);
  // Lineage filters — apply to both graph + catalog views. Kept
  // client-side so filtering is instant on large clouds without
  // roundtripping the whole graph.
  const [assetSearch, setAssetSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [kindFilter, setKindFilter] = useState<string>('all');
  // View toggle — the Assets tab flips between the graph editor and
  // a searchable / filterable table (catalog). Catalog is a huge win
  // for wide cloud orgs where the graph is hard to scan.
  const [viewMode, setViewModeInternal] = useState<'graph' | 'catalog'>('graph');
  // Auto Coverage modal state -- opened from the per-row lightning
  // bolt in the catalog. Same modal component the detail page uses.
  const [autoCoverageAssetKey, setAutoCoverageAssetKey] = useState<string | null>(null);
  const setViewMode = useCallback((mode: 'graph' | 'catalog') => {
    setViewModeInternal(mode);
    onViewModeChange?.(mode);
  }, [onViewModeChange]);
  // Fire once on mount so the parent starts in sync (matters when the
  // cloud-defaults effect flips to catalog before any user click).
  useEffect(() => {
    onViewModeChange?.(viewMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode]);
  // Lineage graph hides "external leaves" by default -- any is_external
  // node with no downstream edge inside this project. That covers both
  // warehouse-connection scrapes (Databricks/BigQuery info_schema) AND
  // orphaned external Dagster refs that nothing here consumes. Content-
  // agnostic rule (no tag/path guessing). Users can flip this off to
  // see everything. The catalog view ignores this -- it shows all
  // assets with connections grouped into their own sections.
  const [showAllInGraph, setShowAllInGraph] = useState(false);
  const { currentProject, updateGraph, setCurrentProject, isLoading } = useProjectStore();
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
  const [previewInitialMode, setPreviewInitialMode] = useState<'view' | 'transform' | 'profile'>('view');

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
      // Cloud projects are read-only -- keyboard delete would remove
      // the node from the local graph copy but the next hydrate would
      // bring it back. Cleaner to no-op the shortcut entirely.
      if ((currentProject as any)?.is_dagster_plus) return;
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

      // Dagster+ (cloud) projects come in with a naive longest-path
      // layout on the backend; that stacks large layers vertically and
      // looks bad. Schedule an auto-arrange on first render so users
      // see a properly grouped graph without clicking Arrange manually.
      if ((currentProject as any).is_dagster_plus) {
        shouldAutoArrange.current = true;
      }
      // Wide graphs (local OR cloud) default to collapsed-to-groups
      // so the first paint isn't a hundred-node wall. Users can hit
      // "Expand assets" in the ribbon to see individuals, or click a
      // single group card to expand just that one.
      const assetCount = currentProject.graph.nodes.filter((n: GraphNode) => n.node_kind === 'asset').length;
      if (assetCount > 60 && !collapseToGroups) {
        setCollapseToGroups(true);
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
            // Add context menu handlers for asset nodes. Skip for
            // Dagster+ (cloud) projects — those actions all require
            // a local .venv/dg CLI which cloud projects don't have,
            // so clicking them 500s. AssetNode inspects data.onX
            // presence to decide whether to render menu items;
            // omitting the handlers hides the entries entirely.
            ...(node.node_kind === 'asset' && !(currentProject as any).is_dagster_plus ? {
              onMaterialize: handleMaterializeAsset,
              onOpenLaunchpad: handleOpenLaunchpad,
              onPrimitiveClick,
              onRunToHere: handleRunToHere,
            } : {}),
            is_dagster_plus: (currentProject as any).is_dagster_plus,
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
      // Group aggregate cards -- clicking anywhere expands that group.
      // Handled here at the ReactFlow level (instead of in GroupNode's
      // own onClick) so we don't fight ReactFlow's internal pointer
      // event system, which was making the in-node click zone feel
      // unreliable.
      if (node.type === 'assetGroup') {
        node.data?.onExpand?.();
        return;
      }
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
          {isLoading ? (
            <>
              <div className="inline-block w-8 h-8 border-4 border-gray-200 border-t-indigo-500 rounded-full animate-spin mb-3" />
              <p className="text-lg font-medium">Loading project…</p>
              <p className="text-sm mt-1 text-gray-400">Fetching assets and lineage.</p>
            </>
          ) : (
            <>
              <p className="text-lg font-medium">No project selected</p>
              <p className="text-sm mt-2">Create or open a project to get started</p>
            </>
          )}
        </div>
      </div>
    );
  }

  // Available group / kind options across ALL assets — power the
  // dropdowns and stay stable as filters narrow the visible set.
  const allGroups = React.useMemo(() => {
    const s = new Set<string>();
    for (const n of nodes) {
      if (n.data?.node_kind === 'asset' && n.data?.group_name) s.add(n.data.group_name);
    }
    return Array.from(s).sort();
  }, [nodes]);
  const allKinds = React.useMemo(() => {
    const s = new Set<string>();
    for (const n of nodes) {
      for (const k of (n.data?.kinds || [])) if (k) s.add(k);
    }
    return Array.from(s).sort();
  }, [nodes]);

  // Set of node IDs that have at least one outgoing edge -- used to
  // detect "external leaves" (external + no downstream in this project).
  const nodesWithDownstream = React.useMemo(() => {
    const s = new Set<string>();
    for (const e of edges) s.add(e.source);
    return s;
  }, [edges]);

  // Common filters (search + group + kind). Applied in both views.
  const matchesUserFilters = (node: Node): boolean => {
    if (node.data?.node_kind !== 'asset') return true;
    if (groupFilter !== 'all' && (node.data?.group_name || '') !== groupFilter) return false;
    if (kindFilter !== 'all' && !(node.data?.kinds || []).includes(kindFilter)) return false;
    if (assetSearch.trim()) {
      const q = assetSearch.trim().toLowerCase();
      const hay = `${node.data?.asset_key || ''} ${node.data?.label || ''} ${node.data?.description || ''} ${(node.data?.tags || []).join(' ')} ${(node.data?.owners || []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  };

  // Graph-only additional filter: hide external leaves unless the
  // user explicitly opts into showing everything.
  const matchesFilters = (node: Node): boolean => {
    if (!matchesUserFilters(node)) return false;
    if (node.data?.node_kind !== 'asset') return true;
    if (!showAllInGraph && node.data?.is_external && !nodesWithDownstream.has(node.id)) return false;
    return true;
  };

  const isFiltering = assetSearch.trim() !== '' || groupFilter !== 'all' || kindFilter !== 'all' || showAllInGraph;

  // First-load defaults for Dagster+ projects: catalog view + hide
  // externals + collapse-to-groups (already handled above). Fire
  // once per project id so the user's toggles stick after that.
  const didSetCloudDefaults = useRef<string | null>(null);
  useEffect(() => {
    if (!currentProject || !(currentProject as any).is_dagster_plus) return;
    if (didSetCloudDefaults.current === currentProject.id) return;
    didSetCloudDefaults.current = currentProject.id;
    setViewMode('catalog');
    // showAllInGraph defaults to false already -- lineage graph hides
    // external leaves out of the box on cloud projects.
  }, [currentProject?.id]);

  // Update nodes to show selection. When filtering, hide non-matching
  // assets entirely so the layout compresses to what's relevant.
  const perAssetDisplay = nodes
    .filter(matchesFilters)
    .map((node) => {
      const isSelected = node.selected !== undefined ? node.selected : selectedAssets.includes(node.id);
      return {
        ...node,
        selected: isSelected,
        data: {
          ...node.data,
          isSelected,
        },
      };
    });

  // Group-collapse mode: replace individual assets with one node per
  // group_name (default: "ungrouped"). Edges collapse to inter-group
  // links with counts. Great for wide cloud projects with hundreds of
  // assets — users see the shape of the DAG first, then drill in.
  const groupedView = React.useMemo(() => {
    if (!collapseToGroups) return null;
    const assets = perAssetDisplay.filter((n) => n.data?.node_kind === 'asset');
    if (assets.length === 0) return null;
    const groupOf = (n: Node): string => (n.data?.group_name || 'ungrouped');
    const nodeToGroup = new Map<string, string>();
    for (const n of assets) nodeToGroup.set(n.id, groupOf(n));

    // Group summaries -- collected for every group so the aggregated
    // node knows its member count / kinds even after some groups get
    // expanded individually.
    const groupInfo: Record<string, { assets: Node[]; kinds: Set<string>; hasChecks: number }> = {};
    for (const n of assets) {
      const g = groupOf(n);
      const info = groupInfo[g] ||= { assets: [], kinds: new Set(), hasChecks: 0 };
      info.assets.push(n);
      for (const k of (n.data?.kinds || [])) info.kinds.add(k);
      if ((n.data?.checks || []).length > 0) info.hasChecks += 1;
    }

    // idToOutputId: each individual asset maps to either its own id
    // (when the group is expanded) or its aggregated __group__:: id
    // (when the group is collapsed). Used to rewrite edges below.
    const isGroupExpanded = (g: string) => expandedGroups.has(g);
    const idToOutputId = new Map<string, string>();
    for (const n of assets) {
      const g = groupOf(n);
      idToOutputId.set(n.id, isGroupExpanded(g) ? n.id : `__group__::${g}`);
    }

    // Aggregate edges. Between two nodes in the same collapsed group
    // this becomes a self-loop, which we drop. Between two expanded
    // assets it stays direct. Between one expanded + one collapsed
    // it becomes an asset→group or group→asset edge, which just works.
    const seen = new Map<string, number>();
    for (const e of edges) {
      const s = idToOutputId.get(e.source);
      const t = idToOutputId.get(e.target);
      if (!s || !t || s === t) continue;
      const k = `${s}||${t}`;
      seen.set(k, (seen.get(k) || 0) + 1);
    }

    // Longest-path DAG layout across the mixed node set (aggregated
    // group placeholders + expanded individual assets). Every asset
    // shows up as its "output id", so this handles the mixed case
    // uniformly without special-casing.
    const outputIds = new Set(idToOutputId.values());
    const outAdj: Record<string, string[]> = Object.fromEntries(Array.from(outputIds).map(id => [id, []]));
    const inDeg: Record<string, number> = Object.fromEntries(Array.from(outputIds).map(id => [id, 0]));
    for (const k of seen.keys()) {
      const [s, t] = k.split('||');
      if (outAdj[s]) outAdj[s].push(t);
      if (t in inDeg) inDeg[t] = (inDeg[t] || 0) + 1;
    }
    const layer: Record<string, number> = Object.fromEntries(Array.from(outputIds).map(id => [id, 0]));
    const remaining = { ...inDeg };
    const queue: string[] = Array.from(outputIds).filter(id => remaining[id] === 0);
    while (queue.length) {
      const id = queue.shift()!;
      for (const t of outAdj[id] || []) {
        layer[t] = Math.max(layer[t], layer[id] + 1);
        remaining[t]--;
        if (remaining[t] === 0) queue.push(t);
      }
    }
    const byLayer: Record<number, string[]> = {};
    for (const id of outputIds) (byLayer[layer[id]] ||= []).push(id);
    // Deterministic vertical ordering by id inside each layer.
    for (const L of Object.keys(byLayer)) byLayer[+L].sort();
    const X_STEP = 380;
    const Y_STEP = 180;
    const posById: Record<string, { x: number; y: number }> = {};
    for (const [L, ids] of Object.entries(byLayer)) {
      const lyr = parseInt(L, 10);
      for (let i = 0; i < ids.length; i++) {
        posById[ids[i]] = { x: lyr * X_STEP, y: i * Y_STEP };
      }
    }

    // Build the actual React Flow nodes: aggregated group placeholders
    // for collapsed groups, individual asset nodes (with new positions)
    // for expanded ones.
    const outNodes: Node[] = [];
    const emittedGroupIds = new Set<string>();
    for (const [g, info] of Object.entries(groupInfo)) {
      if (isGroupExpanded(g)) continue;
      const id = `__group__::${g}`;
      emittedGroupIds.add(id);
      outNodes.push({
        id,
        type: 'assetGroup' as any,
        position: posById[id] || { x: 0, y: 0 },
        data: {
          label: g,
          group_name: g,
          assetCount: info.assets.length,
          kinds: Array.from(info.kinds),
          withChecks: info.hasChecks,
          node_kind: 'asset',
          isGroup: true,
          onExpand: () => handleExpandGroup(g),
        },
        draggable: true,
      });
    }
    for (const n of assets) {
      const g = groupOf(n);
      if (!isGroupExpanded(g)) continue;
      // Only apply the DAG layout position on the *first* render after
      // this group was expanded. Subsequent renders (including those
      // triggered by the user dragging an asset) trust the node's own
      // position so drags persist.
      const alreadyLaidOut = laidOutGroupsRef.current.has(g);
      outNodes.push({
        ...n,
        position: alreadyLaidOut ? n.position : (posById[n.id] || n.position),
        data: {
          ...n.data,
          // Attach a per-asset "collapse this group" callback the
          // AssetNode can surface (or a caller can wire up). We also
          // put group_name here so a future group border can bracket
          // these together visually.
          onCollapseGroup: () => handleCollapseGroup(g),
        },
      });
    }

    const outEdges: Edge[] = Array.from(seen.entries()).map(([k, count]) => {
      const [s, t] = k.split('||');
      const bothGroups = s.startsWith('__group__::') && t.startsWith('__group__::');
      return {
        id: `agg__${k}`,
        source: s,
        target: t,
        label: bothGroups && count > 1 ? `${count} deps` : undefined,
        style: { strokeWidth: Math.min(4, 1 + Math.log2(count + 1)), stroke: '#6366f1' },
      } as Edge;
    });

    return { nodes: outNodes, edges: outEdges };
  }, [collapseToGroups, expandedGroups, perAssetDisplay, edges, handleExpandGroup, handleCollapseGroup]);

  const displayNodes = groupedView ? groupedView.nodes : perAssetDisplay;
  const displayEdges = groupedView ? groupedView.edges : edges;

  return (
    <div className="w-full h-full flex flex-col">
      {/* Slim header row -- filters on the left, actions on the right.
          Graph-only controls (collapse / arrange / show-leaves) hide
          in catalog view. Icon-only buttons on the right side keep the
          horizontal budget under control for wide monitors and small ones. */}
      {(() => {
        const isCloud = !!(currentProject as any)?.is_dagster_plus;
        const inGraph = viewMode === 'graph';
        return (
      <div className="flex-shrink-0 bg-white border-b border-gray-200 px-3 py-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <div className="relative w-44 flex-shrink-0">
            <svg className="w-3.5 h-3.5 text-gray-400 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
            </svg>
            <input
              value={assetSearch}
              onChange={(e) => setAssetSearch(e.target.value)}
              placeholder="Search assets..."
              className="w-full pl-7 pr-2 py-1 text-xs border border-gray-300 rounded"
            />
          </div>
          <select
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            className="text-xs px-2 py-1 border border-gray-300 rounded bg-white max-w-[140px]"
            title="Filter by asset group"
          >
            <option value="all">All groups</option>
            {allGroups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
          {allKinds.length > 0 && (
            <select
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value)}
              className="text-xs px-2 py-1 border border-gray-300 rounded bg-white max-w-[120px]"
              title="Filter by kind (dbt / sql / python / etc.)"
            >
              <option value="all">All kinds</option>
              {allKinds.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          )}
          {isFiltering && (
            <button
              onClick={() => { setAssetSearch(''); setGroupFilter('all'); setKindFilter('all'); setShowAllInGraph(false); }}
              className="text-[11px] text-gray-500 hover:text-gray-800 underline decoration-dotted whitespace-nowrap"
            >
              Clear
            </button>
          )}
          <div className="ml-1 flex items-center bg-gray-100 rounded p-0.5">
            {(['graph', 'catalog'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setViewMode(v)}
                className={`px-2 py-1 text-xs rounded ${viewMode === v ? 'bg-white text-gray-900 shadow-sm font-medium' : 'text-gray-600'}`}
              >
                {v === 'graph' ? 'Graph' : 'Catalog'}
              </button>
            ))}
          </div>
          {inGraph && (
            <label
              className="inline-flex items-center gap-1 text-[11px] text-gray-700 cursor-pointer whitespace-nowrap"
              title="By default the lineage graph hides external assets that nothing in this project consumes (usually warehouse-catalog scrapes and orphaned observability nodes). Check to show them too."
            >
              <input
                type="checkbox"
                checked={showAllInGraph}
                onChange={(e) => setShowAllInGraph(e.target.checked)}
                className="w-3 h-3"
              />
              <span>Include orphaned externals</span>
            </label>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {selectedAssets.length > 0 && (
            <>
              <span className="text-xs text-gray-500 mr-1 whitespace-nowrap">
                {selectedAssets.length} selected
              </span>
              <button
                onClick={handleMaterializeSelected}
                disabled={isMaterializing}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Play className="w-4 h-4" />
                <span>{isMaterializing ? 'Materializing…' : 'Materialize'}</span>
              </button>
            </>
          )}
          <button
            onClick={() => setAddDataOpen(true)}
            disabled={isCloud}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-primary"
            title={isCloud ? 'Not available on Dagster+ (read-only)' : 'Connect a database, warehouse, SaaS app, file, or API'}
          >
            <Plus className="w-4 h-4" />
            <span>Add data</span>
          </button>
          {inGraph && (
            <>
              <button
                onClick={() => {
                  setCollapseToGroups(!collapseToGroups);
                  // Reset per-group expansion when toggling the global mode
                  // -- otherwise switching back to collapsed would leave
                  // stale expansions the user forgot about.
                  setExpandedGroups(new Set());
                }}
                className={`inline-flex items-center justify-center w-8 h-8 rounded ${
                  collapseToGroups ? 'bg-indigo-100 text-indigo-700 hover:bg-indigo-200' : 'text-gray-700 hover:bg-gray-100'
                }`}
                title={collapseToGroups ? 'Expand groups: show individual assets' : 'Collapse to one card per asset group. Click a card to expand just that group.'}
                aria-label={collapseToGroups ? 'Expand groups' : 'Collapse groups'}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
              <button
                onClick={arrangeGroups}
                className="inline-flex items-center justify-center w-8 h-8 text-gray-700 hover:bg-gray-100 rounded"
                title="Arrange groups in a grid to prevent overlaps (preserves positions within groups)"
                aria-label="Arrange groups"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                </svg>
              </button>
            </>
          )}
        </div>
      </div>
        );
      })()}
      {/* Catalog view — searchable/filterable table of the same
          filtered asset set. Uses the filters + search from the
          ribbon so state is shared with the graph view. */}
      {viewMode === 'catalog' && (() => {
        // Catalog shows EVERYTHING (subject only to search/group/kind
        // filters). Connection-scrape assets always land in their own
        // sections at the bottom, never mingled with the primary list.
        // The graph's "external leaves" hiding does not affect the
        // catalog -- users go there specifically to browse the full
        // asset inventory including externals.
        const allAssets = nodes.filter((n) => n.data?.node_kind === 'asset' && matchesUserFilters(n));
        const primaryAssets = allAssets.filter((n) => !n.data?.is_connection);
        const connectionAssets = allAssets.filter((n) => !!n.data?.is_connection);
        // Group connection assets by source (top-level path segment:
        // "Databricks", "GCP_SALESENG", ...).
        const connectionsBySource: Record<string, Node[]> = {};
        for (const n of connectionAssets) {
          const src = (n.data?.connection_source as string) || 'Other';
          (connectionsBySource[src] ||= []).push(n);
        }
        const connectionSources = Object.keys(connectionsBySource).sort();

        const renderTypeBadge = (n: Node) => {
          const isConnection = !!n.data?.is_connection;
          const isExternal = !!n.data?.is_external;
          const isObservable = !!n.data?.is_observable;
          if (isConnection) {
            return <span className="px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-700 font-medium" title="Warehouse connection scrape (info_schema / catalog metadata)">connection</span>;
          }
          if (isExternal) {
            return <span className="px-1.5 py-0.5 rounded bg-gray-100 border border-gray-200 text-gray-500 font-medium" title="External Dagster asset -- observed here, defined in another project">external</span>;
          }
          if (isObservable) {
            return <span className="px-1.5 py-0.5 rounded bg-blue-50 border border-blue-200 text-blue-700 font-medium">observable</span>;
          }
          return <span className="px-1.5 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-700 font-medium">materializable</span>;
        };

        const renderRow = (n: Node) => {
          const key = n.data?.asset_key || '';
          // Use raw per-asset edges here, NOT displayEdges. In
          // collapsed mode displayEdges is aggregated to group-level
          // ids (e.g. `__group__::analytics`) so filtering by an
          // individual asset id returns nothing -- which is why the
          // deps/downstream columns were showing 0 for every row.
          const upstreamEdges = edges.filter((e) => e.target === n.id);
          const downstreamEdges = edges.filter((e) => e.source === n.id);
          const checks = (n.data?.checks || []).length;
          const isExternal = !!n.data?.is_external;
          const isPartitioned = !!n.data?.is_partitioned;
          const owners = (n.data?.owners || []) as string[];
          const tags = (n.data?.tags || []) as string[];
          return (
            <tr
              key={n.id}
              className={`border-b border-gray-50 last:border-0 hover:bg-gray-50/50 cursor-pointer ${isExternal ? 'opacity-70' : ''}`}
              // Catalog rows open the full-screen detail view directly
              // -- it's the natural affordance for a table row. The
              // graph pane still uses the sidebar for quick-peek.
              onClick={() => { onNodeSelect(n.id); onOpenAssetDetail?.(n.id); }}
            >
              <td className="px-4 py-2 font-mono text-xs text-gray-900">
                {key}
                {isPartitioned && (
                  <span className="ml-1.5 text-[9px] uppercase tracking-wider text-purple-600" title="Partitioned">·part</span>
                )}
              </td>
              <td className="px-4 py-2 text-xs text-gray-700">{n.data?.group_name || '—'}</td>
              <td className="px-4 py-2 text-xs">
                <div className="flex flex-wrap gap-1">
                  {(n.data?.kinds || []).map((k: string) => (
                    <span key={k} className="px-1.5 py-0.5 rounded bg-indigo-50 border border-indigo-200 text-indigo-700 text-[10px] font-mono">{k}</span>
                  ))}
                </div>
              </td>
              <td className="px-4 py-2 text-[10px]">{renderTypeBadge(n)}</td>
              <td className="px-4 py-2 text-[11px] text-gray-700">
                {owners.length > 0 ? owners.slice(0, 2).join(', ') + (owners.length > 2 ? ` +${owners.length - 2}` : '') : <span className="text-gray-400 italic">—</span>}
              </td>
              <td className="px-4 py-2 text-[10px]">
                <div className="flex flex-wrap gap-1">
                  {tags.slice(0, 3).map((t: string) => (
                    <span key={t} className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 font-mono">{t}</span>
                  ))}
                  {tags.length > 3 && (
                    <span className="text-gray-500">+{tags.length - 3}</span>
                  )}
                </div>
              </td>
              <td className="px-4 py-2 text-xs text-gray-600 tabular-nums">{upstreamEdges.length}</td>
              <td className="px-4 py-2 text-xs text-gray-600 tabular-nums">{downstreamEdges.length}</td>
              <td className="px-4 py-2 text-xs text-gray-600 tabular-nums">
                {checks > 0 ? <span className="text-emerald-700 font-medium">{checks}</span> : '—'}
              </td>
              <td className="px-4 py-2 text-[11px] text-gray-600 truncate max-w-[300px]" title={n.data?.description || ''}>
                {n.data?.description || <span className="text-gray-400 italic">—</span>}
              </td>
              <td className="px-2 py-2 text-right whitespace-nowrap">
                {/* Auto coverage per-row shortcut. Hidden on cloud
                    (read-only). stopPropagation so the click doesn't
                    also open the detail page. */}
                {!(currentProject as any)?.is_dagster_plus && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setAutoCoverageAssetKey((n.data?.asset_key as string) || n.id);
                    }}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded hover:bg-blue-100"
                    title="Suggest a monitoring baseline (freshness / row count / uniqueness / null checks) for this asset"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    Auto coverage
                  </button>
                )}
              </td>
            </tr>
          );
        };

        const headerRow = (
          <thead className="bg-gray-50 border-b border-gray-100">
            <tr>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Asset key</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Group</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Kinds</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider" title="materializable / observable / external Dagster asset / warehouse connection scrape">Type</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Owners</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Tags</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Deps</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Downstream</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Checks</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Description</th>
              <th className="text-right px-2 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
        );

        return (
          <div className="flex-1 min-h-0 overflow-y-auto bg-gray-50 p-6 space-y-4">
            <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-900">Asset catalog</h2>
                <span className="text-xs text-gray-500">
                  {primaryAssets.length} asset{primaryAssets.length === 1 ? '' : 's'}
                </span>
              </div>
              <table className="w-full text-sm">
                {headerRow}
                <tbody>
                  {primaryAssets.map(renderRow)}
                  {primaryAssets.length === 0 && (
                    <tr><td colSpan={11} className="px-4 py-8 text-center text-xs text-gray-500 italic">No assets match the current filters.</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {connectionSources.map((src) => (
              <ConnectionSection
                key={src}
                source={src}
                assets={connectionsBySource[src]}
                renderRow={renderRow}
                headerRow={headerRow}
              />
            ))}
          </div>
        );
      })()}

      {viewMode === 'graph' && (
      <div className="flex-1 min-h-0 relative">
      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
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
        {/* Group bounding boxes:
             - Fully-expanded (collapseToGroups=false): draw boxes for
               every visible group (matches how the un-collapsed view
               has always looked).
             - Mixed collapsed (collapseToGroups=true, some expanded):
               draw boxes only for the expanded groups so their
               individual assets get the same visual grouping as when
               fully expanded. Collapsed groups already have their own
               card and don't need an outer box.
             - Fully collapsed: no boxes -- the cards ARE the groups. */}
        {(!collapseToGroups || expandedGroups.size > 0) && (
          <GroupOverlay
            nodes={displayNodes.filter((n) => !collapseToGroups || expandedGroups.has(n.data?.group_name as string))}
            setNodes={setNodes}
          />
        )}
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls />
        <MiniMap />
      </ReactFlow>
      {/* Docked at the bottom of the graph pane (above the I/O panel when
          it's open) so the AI bar never covers input/output previews.
          Suppressed for Dagster+ cloud projects -- they're read-only, so
          the AI bar's "generate / edit / create" prompts have no effect. */}
      {!(currentProject as any).is_dagster_plus && <DagsterAIBar />}
      </div>
      )}

      {/* Docked I/O preview panel — appears when the user selects an asset
          node and shows compact input/output tables. Buttons in its header
          hand off to the full DataPreviewModal.
          NOT rendered for Dagster+ projects: previewing requires spawning
          the project's local venv Python to run the asset, which doesn't
          exist for cloud-connected projects (they're read-only via GraphQL). */}
      {currentProject && ioPanelAssetKey && !(currentProject as any).is_dagster_plus && (() => {
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

      {/* + Add data — curated ingestion picker (Lakeflow-style). Falls
          through to the same setAddingComponentType path the palette
          uses so the config modal opens right after install. */}
      <AddDataDialog
        open={addDataOpen}
        onOpenChange={setAddDataOpen}
        onSourcePicked={(componentType) => {
          onAddDataSource?.(componentType);
        }}
      />

      {/* Auto coverage modal -- opened from the per-row shortcut in
          the catalog. Same component the detail page uses. */}
      {autoCoverageAssetKey && (
        <AutoCoverageModal
          assetKey={autoCoverageAssetKey}
          onClose={() => setAutoCoverageAssetKey(null)}
        />
      )}
    </div>
  );
}

// Catalog subsection for connection-scrape assets, grouped by
// their top-level source (Databricks / GCP_SALESENG / ...). Collapsed
// by default -- these lists can be huge and the user rarely needs
// them; the affordance is there when they do.
function ConnectionSection({
  source,
  assets,
  renderRow,
  headerRow,
}: {
  source: string;
  assets: Node[];
  renderRow: (n: Node) => JSX.Element;
  headerRow: JSX.Element;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="bg-white border border-amber-200 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 border-b border-amber-100 flex items-center justify-between bg-amber-50/50 hover:bg-amber-50 text-left"
      >
        <div className="flex items-center gap-2">
          <svg className={`w-3 h-3 text-amber-700 transition-transform ${expanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <h2 className="text-sm font-semibold text-amber-900">
            {source} <span className="font-normal text-amber-700">connection</span>
          </h2>
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">warehouse scrape</span>
        </div>
        <span className="text-xs text-amber-800">
          {assets.length} asset{assets.length === 1 ? '' : 's'}
        </span>
      </button>
      {expanded && (
        <table className="w-full text-sm">
          {headerRow}
          <tbody>{assets.map(renderRow)}</tbody>
        </table>
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
