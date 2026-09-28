import { Sparkles, X, Check } from 'lucide-react';
import type { TransformSuggestion } from '@/lib/transformSuggestions';

/**
 * Trifacta/Dataprep-style "Suggestions" strip -- a horizontal row of
 * dismissible cards above the transform grid, each proposing one existing
 * op (never a new capability) based on patterns found in the loaded sample
 * data. "Apply all" adds every currently-listed suggestion's op in one
 * click; each card also dismisses itself once applied (or is dismissed
 * manually), so applying doesn't leave a stale, already-done card sitting
 * there.
 */
export function SuggestionsStrip({
  suggestions,
  onApply,
  onApplyAll,
  onDismiss,
}: {
  suggestions: TransformSuggestion[];
  onApply: (s: TransformSuggestion) => void;
  onApplyAll: () => void;
  onDismiss: (id: string) => void;
}) {
  if (suggestions.length === 0) return null;

  return (
    <div className="mb-3 border border-violet-200 bg-violet-50/40 rounded-lg p-2.5">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-violet-800">
          <Sparkles className="w-3.5 h-3.5" />
          Suggestions
          <span className="text-violet-400 font-normal">{suggestions.length}</span>
        </div>
        {suggestions.length > 1 && (
          <button
            onClick={onApplyAll}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-violet-700 hover:text-violet-900"
          >
            <Check className="w-3 h-3" /> Apply all
          </button>
        )}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {suggestions.map((s) => (
          <div
            key={s.id}
            className="flex-shrink-0 w-64 bg-white border border-violet-200 rounded-md p-2.5"
          >
            <div className="flex items-start justify-between gap-1">
              <div className="text-xs font-medium text-gray-900 leading-tight">{s.title}</div>
              <button onClick={() => onDismiss(s.id)} className="text-gray-300 hover:text-gray-500 flex-shrink-0">
                <X className="w-3 h-3" />
              </button>
            </div>
            <p className="text-[11px] text-gray-500 mt-1 leading-snug">{s.description}</p>
            <button
              onClick={() => onApply(s)}
              className="mt-2 w-full px-2 py-1 text-[11px] font-medium text-violet-700 bg-violet-50 border border-violet-200 rounded hover:bg-violet-100"
            >
              Apply
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
