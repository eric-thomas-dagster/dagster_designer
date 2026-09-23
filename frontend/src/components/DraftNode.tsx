import { memo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { FileEdit, CheckCircle2, GitPullRequest, Radio, ExternalLink } from 'lucide-react';
import type { Draft } from '@/services/api';

/**
 * DraftNode — a react-flow node representing a pending component
 * authored against a customer Dagster+ code location.
 *
 * Two visual states, driven by `data.previewMode`:
 *   - Prod view (default): amber dashed card, "DRAFT" badge. Reads
 *     "not yet in prod."
 *   - Preview view: emerald solid card, "PREVIEW" badge. Reads "this
 *     is what your graph would look like after promoting all drafts."
 *
 * Handles are inert — draft nodes don't connect to real assets until
 * promotion + Dagster+ re-hydration.
 */
interface DraftNodeData {
  draft: Draft;
  previewMode?: boolean;
  // True when the preview subprocess for this draft's (deployment,
  // location) is currently running (M6.2).
  previewLive?: boolean;
  previewUrl?: string | null;
}

function DraftNodeInner({ data, selected }: NodeProps<DraftNodeData>) {
  const { draft, previewMode, previewLive, previewUrl } = data;
  const shortType = draft.component_type.split('.').pop() || draft.component_type;

  const preview = !!previewMode;
  const containerCls = preview
    ? `px-3 py-2 rounded-md border-2 bg-emerald-50 shadow-sm min-w-[200px] ${selected ? 'ring-2 ring-emerald-500 ring-offset-1' : ''}`
    : `px-3 py-2 rounded-md border-2 border-dashed bg-amber-50 shadow-sm min-w-[200px] ${selected ? 'ring-2 ring-amber-500 ring-offset-1' : ''}`;
  const borderColor = preview ? '#10b981' : '#f59e0b';
  const handleCls = preview ? '!bg-emerald-400 !border-emerald-500' : '!bg-amber-400 !border-amber-500';
  const badgeCls = preview ? 'text-emerald-800' : 'text-amber-800';
  const chipCls = preview
    ? 'inline-block px-1.5 py-0.5 rounded bg-white border border-emerald-200 text-emerald-800 truncate max-w-[130px]'
    : 'inline-block px-1.5 py-0.5 rounded bg-white border border-amber-200 text-amber-800 truncate max-w-[130px]';

  return (
    <div className={containerCls} style={{ borderColor }}>
      <Handle type="target" position={Position.Left} className={handleCls} />
      <div className="flex items-center gap-1.5 mb-1">
        {preview ? (
          <CheckCircle2 className="w-3 h-3 text-emerald-700" />
        ) : (
          <FileEdit className="w-3 h-3 text-amber-700" />
        )}
        <span className={`text-[9px] font-semibold uppercase tracking-wider ${badgeCls}`}>
          {preview ? 'Preview · promoted' : 'Draft'}
        </span>
        {draft.status === 'promoted' && (
          <GitPullRequest className="w-3 h-3 text-emerald-700" />
        )}
      </div>
      <div className="text-xs font-medium text-gray-900 truncate" title={draft.component_type}>
        {shortType}
      </div>
      <div className="text-[10px] text-gray-600 truncate mt-0.5">
        {draft.component_id}
      </div>
      <div className="mt-1.5 flex items-center gap-1 text-[10px]">
        <span className={chipCls}>
          {draft.deployment_name ? `${draft.deployment_name}/` : ''}{draft.location_name}
        </span>
      </div>
      {previewLive && (
        <a
          href={previewUrl ?? undefined}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="mt-1.5 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-300 hover:bg-emerald-200"
          title="Preview `dagster dev` is running against a git clone of the target repo"
        >
          <Radio className="w-2.5 h-2.5 animate-pulse" />
          <span className="font-semibold uppercase tracking-wider">Live</span>
          <ExternalLink className="w-2.5 h-2.5" />
        </a>
      )}
      <Handle type="source" position={Position.Right} className={handleCls} />
    </div>
  );
}

export const DraftNode = memo(DraftNodeInner);
