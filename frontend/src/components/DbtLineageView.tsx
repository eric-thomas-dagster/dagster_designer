import { useMemo } from 'react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  ReactFlowProvider,
  type Edge,
  type Node,
  Position,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { projectsApi } from '@/services/api';
import { classifyStatus, type StatusBucket } from '@/lib/status';
import { Database, Table as TableIcon, Layers as LayersIcon, TestTube2, Camera } from 'lucide-react';

// dbt Cloud calls this "Lenses" -- coloring the DAG by a chosen dimension
// instead of (or alongside) resource type. "freshness" isn't here: dbt
// models don't carry a per-model freshness status today (only sources do,
// via a separate dbt-source-freshness endpoint/FreshnessPill elsewhere) --
// adding it as a lens would mean fabricating a signal, not surfacing one.
export type Lens = 'status' | 'materialization' | 'tests';
export const LENS_OPTIONS: { value: Lens; label: string }[] = [
  { value: 'status', label: 'Last run status' },
  { value: 'materialization', label: 'Materialization' },
  { value: 'tests', label: 'Test status' },
];

const MATERIALIZATION_COLORS: Record<string, string> = {
  view: '#60a5fa',
  table: '#10b981',
  incremental: '#a78bfa',
  ephemeral: '#9ca3af',
  materialized_view: '#14b8a6',
};

/** Worst-first so one failing test flags the whole model even if nine
 *  others passed. */
const TEST_STATUS_PRIORITY: StatusBucket[] = ['failure', 'warning', 'skipped', 'success', 'unknown'];

function worstTestStatus(model: any): StatusBucket | null {
  const tests = model?.tests_detail as Array<{ last_run_status?: string | null }> | undefined;
  if (!tests || tests.length === 0) return null;
  const buckets = tests.map((t) => classifyStatus(t.last_run_status));
  for (const p of TEST_STATUS_PRIORITY) {
    if (buckets.includes(p)) return p;
  }
  return null;
}

const STATUS_DOT_COLOR: Record<StatusBucket, string> = {
  success: '#10b981',
  failure: '#f43f5e',
  warning: '#f59e0b',
  skipped: '#94a3b8',
  unknown: '',
};

/** Returns the lens dot's color + tooltip for one node, or null when the
 *  active lens has nothing to show for this node (e.g. materialization
 *  lens on a source). */
function lensDot(lens: Lens, model: any): { color: string; title: string } | null {
  if (lens === 'materialization') {
    const mat = model?.materialization as string | undefined;
    if (!mat) return null;
    return { color: MATERIALIZATION_COLORS[mat] || '#cbd5e1', title: `Materialization: ${mat}` };
  }
  if (lens === 'tests') {
    const bucket = worstTestStatus(model);
    if (!bucket || !STATUS_DOT_COLOR[bucket]) return null;
    return { color: STATUS_DOT_COLOR[bucket], title: `Worst test status: ${bucket}` };
  }
  // 'status'
  const bucket = classifyStatus(model?.last_run_status);
  if (!STATUS_DOT_COLOR[bucket]) return null;
  return { color: STATUS_DOT_COLOR[bucket], title: `Last run: ${model?.last_run_status}` };
}

interface DbtLineageViewProps {
  models: Awaited<ReturnType<typeof projectsApi.listDbtModels>>['models'];
  onModelClick?: (uniqueId: string) => void;
  selectedUniqueId?: string | null;
  /** Owned by the caller (DbtPanel's tab-bar row), not this component --
   * matches the main Asset Graph's toolbar-dropdown pattern instead of a
   * floating-in-canvas control. Defaults to 'status' for any caller that
   * doesn't care about lenses. */
  lens?: Lens;
}

/**
 * dbt-only DAG view — every model + source + snapshot + seed in the
 * chosen dbt project, laid out left-to-right by longest-path layer.
 * Rendered with React Flow so users get pan / zoom / minimap for free
 * without our full graph editor's asset-editing machinery.
 *
 * Nodes are colored by resource_type (model/source/snapshot/seed) via a
 * small accent dot, plus a second dot colored by whichever "lens" is
 * selected (last run status / materialization / test status — see the
 * Lens type above). Click a node → caller-supplied handler opens the
 * same detail drawer used in the table view, keeping "select in one
 * place, edit in the other" one clean pattern.
 */
export function DbtLineageView({ models, onModelClick, selectedUniqueId, lens = 'status' }: DbtLineageViewProps) {
  // Build a set of unique_ids we have full data for, plus a lightweight
  // "just seen as a dep" stub set. Sources / seeds we don't fetch full
  // records for still deserve a node so cross-project deps show.
  const { nodes, edges } = useMemo(() => {
    const nodeByUid = new Map<string, Node>();
    const modelByUid = new Map(models.map((m) => [m.unique_id, m]));

    // Longest-path layering — depth = 1 + max(depth(deps)). Cycle
    // guard because manifests occasionally have odd shapes.
    const depth = new Map<string, number>();
    const visiting = new Set<string>();
    const compute = (uid: string): number => {
      if (depth.has(uid)) return depth.get(uid)!;
      if (visiting.has(uid)) return 0;
      visiting.add(uid);
      const m = modelByUid.get(uid);
      const deps = m?.depends_on_nodes || [];
      const d = deps.length === 0 ? 0 : Math.max(...deps.map(compute)) + 1;
      visiting.delete(uid);
      depth.set(uid, d);
      return d;
    };
    for (const m of models) compute(m.unique_id);
    // Also give any dep-only uids a depth of one less than the min
    // consumer so pure sources sit at layer 0.
    const allUids = new Set<string>();
    for (const m of models) {
      allUids.add(m.unique_id);
      for (const dep of m.depends_on_nodes) allUids.add(dep);
    }
    for (const uid of allUids) {
      if (!depth.has(uid)) depth.set(uid, 0);
    }

    // Bucket by layer, then position in a grid.
    const byLayer = new Map<number, string[]>();
    for (const uid of allUids) {
      const l = depth.get(uid) ?? 0;
      if (!byLayer.has(l)) byLayer.set(l, []);
      byLayer.get(l)!.push(uid);
    }
    for (const arr of byLayer.values()) arr.sort();

    const X_STEP = 260;
    const Y_STEP = 90;
    const layers = [...byLayer.keys()].sort((a, b) => a - b);
    for (const l of layers) {
      const uids = byLayer.get(l)!;
      uids.forEach((uid, i) => {
        const m = modelByUid.get(uid);
        const rt = m?.resource_type || (uid.startsWith('source.') ? 'source' : 'model');
        nodeByUid.set(uid, {
          id: uid,
          data: {
            label: uid.replace(/^(model|source|seed|snapshot)\./, ''),
            resource_type: rt,
            model: m,
            selected: uid === selectedUniqueId,
            lens,
          },
          position: { x: l * X_STEP, y: i * Y_STEP },
          type: 'dbtNode',
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
        } as Node);
      });
    }

    const edgeList: Edge[] = [];
    for (const m of models) {
      for (const dep of m.depends_on_nodes) {
        if (!allUids.has(dep)) continue;
        edgeList.push({
          id: `${dep}__${m.unique_id}`,
          source: dep,
          target: m.unique_id,
          type: 'default',
          animated: false,
          style: { stroke: '#9ca3af', strokeWidth: 1 },
        });
      }
    }
    return { nodes: Array.from(nodeByUid.values()), edges: edgeList };
  }, [models, selectedUniqueId, lens]);

  const nodeTypes = useMemo(() => ({ dbtNode: DbtGraphNode }), []);

  if (models.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-gray-500">
        No dbt models yet — the lineage view lights up once the project has models.
      </div>
    );
  }

  return (
    <div className="w-full h-full relative" style={{ minHeight: 500 }}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          nodesDraggable={false}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, node) => {
            // Sources aren't dbt models -- clicking them opens a detail
            // drawer that has no data, which looks broken. Only forward
            // clicks for uids we actually have a model for.
            if (node.data?.model) onModelClick?.(node.id);
          }}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => resourceColorForMini(n.data?.resource_type)}
          />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}

export function LensLegend({ lens }: { lens: Lens }) {
  const entries: { color: string; label: string }[] =
    lens === 'materialization'
      ? Object.entries(MATERIALIZATION_COLORS).map(([label, color]) => ({ color, label }))
      : [
          { color: STATUS_DOT_COLOR.success, label: lens === 'tests' ? 'all passing' : 'success' },
          { color: STATUS_DOT_COLOR.failure, label: lens === 'tests' ? 'any failing' : 'failure' },
          { color: STATUS_DOT_COLOR.warning, label: lens === 'tests' ? 'any warning' : 'warning' },
          { color: STATUS_DOT_COLOR.skipped, label: lens === 'tests' ? 'any skipped' : 'skipped' },
        ];
  return (
    <div className="px-2 py-1.5 text-[10px] bg-white/95 border border-gray-200 rounded shadow-sm pointer-events-none space-y-0.5">
      {entries.map((e) => (
        <div key={e.label} className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: e.color }} />
          <span className="text-gray-600">{e.label}</span>
        </div>
      ))}
    </div>
  );
}

function resourceAccent(rt: string): { icon: any; label: string; dot: string; iconColor: string } {
  // Matches the AssetNode aesthetic: neutral white card, subtle
  // gray border, and a small colored dot / icon that carries the
  // resource-type semantics without dominating the card.
  switch (rt) {
    case 'source':   return { icon: Database, label: 'source', dot: 'bg-blue-400', iconColor: 'text-blue-500' };
    case 'seed':     return { icon: TableIcon, label: 'seed', dot: 'bg-amber-400', iconColor: 'text-amber-500' };
    case 'snapshot': return { icon: Camera, label: 'snapshot', dot: 'bg-purple-400', iconColor: 'text-purple-500' };
    case 'test':     return { icon: TestTube2, label: 'test', dot: 'bg-gray-400', iconColor: 'text-gray-500' };
    case 'model':
    default:         return { icon: LayersIcon, label: 'model', dot: 'bg-indigo-400', iconColor: 'text-indigo-500' };
  }
}

function resourceColorForMini(rt: string): string {
  switch (rt) {
    case 'source':   return '#60a5fa';
    case 'seed':     return '#fbbf24';
    case 'snapshot': return '#a78bfa';
    case 'test':     return '#9ca3af';
    default:         return '#818cf8';
  }
}

const HANDLE_STYLE: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: '50%',
  border: '1.5px solid #6366f1',
  background: '#ffffff',
};

function DbtGraphNode({ data }: { data: any }) {
  const accent = resourceAccent(data.resource_type || 'model');
  const Icon = accent.icon;
  const isSelected = !!data.selected;
  const dot = lensDot((data.lens as Lens) || 'status', data.model);
  // Selected → primary border + ring, matching AssetNode. Otherwise, a
  // full-width colored top band (not just a small dot) when the active
  // lens has something to show for this node -- a thin dot was too easy
  // to miss; this reads at a glance the same way a tinted node does in
  // dbt Cloud's own Lenses feature. This card has no header strip to
  // recolor wholesale (unlike AssetNode's), so a band is the equivalent.
  const borderClass = isSelected
    ? 'border-2 border-primary ring-2 ring-primary/20'
    : 'border border-gray-200';
  return (
    <div
      className={`relative shadow-sm hover:shadow-md transition-shadow rounded-md bg-white ${borderClass} min-w-[180px] max-w-[220px] overflow-hidden`}
      title={dot ? dot.title : undefined}
    >
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />
      {dot && <div className="h-1.5 w-full" style={{ backgroundColor: dot.color }} />}
      <div className="px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${accent.iconColor}`} />
          <div className="text-xs font-mono font-medium text-gray-900 truncate flex-1 min-w-0" title={data.label}>{data.label}</div>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className={`w-1 h-1 rounded-full ${accent.dot} flex-shrink-0`} />
          <span className="text-[9px] uppercase tracking-wider text-gray-500">{accent.label}</span>
          {data.model?.materialization && (
            <span className="text-[9px] text-gray-500">· {data.model.materialization}</span>
          )}
          {data.model?.tests?.length ? (
            <span className="inline-flex items-center gap-0.5 text-[9px] text-gray-500 ml-auto">
              <TestTube2 className="w-2.5 h-2.5" />
              {data.model.tests.length}
            </span>
          ) : null}
        </div>
      </div>
      <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
    </div>
  );
}
