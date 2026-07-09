import { Filter, ArrowDownUp, SortAsc, Sigma, Trash2, RotateCw, Wand2, Group, Calculator, Columns3, Package, PackageOpen, Play, X } from 'lucide-react';

/**
 * Right-side "recipe" panel — shows every op currently applied to the
 * transform, in the fixed order they're applied. Each row has a delete
 * button that mutates the underlying state.
 *
 * Step-view (walking data up/down each step) is a follow-up: it needs the
 * transform useMemo to become step-aware (a step counter that gates each
 * op) which is a larger refactor. This v1 focuses on visibility + delete.
 */

export interface RecipeStep {
  id: string;
  icon: 'filter' | 'sort' | 'rank' | 'sigma' | 'rotate' | 'wand' | 'group' | 'calc' | 'cols' | 'package' | 'packageOpen' | 'play' | 'arrows';
  label: string;
  detail?: string;
  onRemove: () => void;
}

const ICONS = {
  filter: Filter,
  sort: SortAsc,
  rank: SortAsc,
  sigma: Sigma,
  rotate: RotateCw,
  wand: Wand2,
  group: Group,
  calc: Calculator,
  cols: Columns3,
  package: Package,
  packageOpen: PackageOpen,
  play: Play,
  arrows: ArrowDownUp,
};

interface RecipePanelProps {
  steps: RecipeStep[];
  onClearAll?: () => void;
  /** Click a step → preview shows data as of that step. null = show final result. */
  previewAtStep?: number | null;
  onSelectStep?: (index: number | null) => void;
}

export function RecipePanel({ steps, onClearAll, previewAtStep = null, onSelectStep }: RecipePanelProps) {
  return (
    <div className="w-72 border-l border-gray-200 bg-gray-50 flex flex-col overflow-hidden">
      <div className="flex-shrink-0 px-3 py-2 border-b border-gray-200 bg-white flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <PackageOpen className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold text-gray-900">Recipe</span>
          {steps.length > 0 && (
            <span className="text-xs text-gray-400">{steps.length} step{steps.length === 1 ? '' : 's'}</span>
          )}
        </div>
        {steps.length > 0 && onClearAll && (
          <button
            onClick={onClearAll}
            className="text-[11px] text-gray-500 hover:text-red-600 flex items-center gap-0.5"
            title="Remove all steps"
          >
            <X className="w-3 h-3" />
            Clear
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {steps.length === 0 && (
          <div className="text-center py-8 px-3 text-xs text-gray-400">
            No transforms yet. Configure ops on the left — they'll appear here in the order they're applied.
          </div>
        )}
        {steps.map((step, i) => {
          const Icon = ICONS[step.icon] ?? Filter;
          const isSelected = previewAtStep === i;
          const isPast = previewAtStep !== null && i > previewAtStep;
          return (
            <div
              key={step.id}
              onClick={onSelectStep ? () => onSelectStep(isSelected ? null : i) : undefined}
              className={`group flex items-start gap-2 px-2 py-1.5 border rounded ${
                isSelected
                  ? 'bg-primary/5 border-primary'
                  : isPast
                  ? 'bg-gray-50 border-gray-200 opacity-50'
                  : 'bg-white border-gray-200 hover:border-primary/30'
              } ${onSelectStep ? 'cursor-pointer' : ''}`}
              title={onSelectStep ? 'Click to preview data at this step' : undefined}
            >
              <div
                className={`flex-shrink-0 w-5 h-5 rounded flex items-center justify-center text-[10px] font-semibold tabular-nums ${
                  isSelected ? 'bg-primary text-white' : 'bg-primary/10 text-primary'
                }`}
              >
                {i + 1}
              </div>
              <Icon className="w-3.5 h-3.5 text-gray-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-gray-900 truncate" title={step.label}>
                  {step.label}
                </div>
                {step.detail && (
                  <div className="text-[10px] text-gray-500 truncate font-mono" title={step.detail}>
                    {step.detail}
                  </div>
                )}
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); step.onRemove(); }}
                className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded flex-shrink-0"
                title="Remove step"
                aria-label="Remove step"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
        {previewAtStep !== null && onSelectStep && (
          <button
            onClick={() => onSelectStep(null)}
            className="w-full mt-2 py-1 text-[11px] text-primary hover:underline"
          >
            ← Show final result (all steps applied)
          </button>
        )}
      </div>

      {steps.length > 0 && (
        <div className="flex-shrink-0 px-3 py-2 border-t border-gray-200 bg-white text-[10px] text-gray-500">
          Steps apply top-to-bottom. Order matters for downstream ops.
        </div>
      )}
    </div>
  );
}
