import { X } from 'lucide-react';
import type { TransformSuggestion } from '@/lib/transformSuggestions';

/**
 * Trifacta's "Transformation by Example" -- appears near wherever the user
 * just selected text inside a table cell, offering 1-3 candidate transforms
 * inferred from that selection (see computeSelectionSuggestions). Purely
 * positioned via fixed top/left (viewport coordinates from the selection's
 * own bounding rect) rather than being anchored in normal flow, since it
 * has to float over the table regardless of scroll position.
 */
export function SelectionSuggestionPopover({
  x,
  y,
  selectedText,
  suggestions,
  onApply,
  onClose,
}: {
  x: number;
  y: number;
  selectedText: string;
  suggestions: TransformSuggestion[];
  onApply: (s: TransformSuggestion) => void;
  onClose: () => void;
}) {
  if (suggestions.length === 0) return null;

  return (
    <div
      className="fixed z-[200] w-72 bg-white border border-violet-200 rounded-lg shadow-lg"
      style={{ top: y, left: x }}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
        <div className="text-xs text-gray-500">
          You selected <span className="font-mono font-medium text-gray-800">"{selectedText}"</span>
        </div>
        <button onClick={onClose} className="text-gray-300 hover:text-gray-500 flex-shrink-0">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="p-1.5 space-y-1">
        {suggestions.map((s) => (
          <button
            key={s.id}
            onClick={() => onApply(s)}
            className="w-full text-left px-2.5 py-2 rounded-md hover:bg-violet-50"
          >
            <div className="text-xs font-medium text-gray-900">{s.title}</div>
            <div className="text-[11px] text-gray-500 mt-0.5">{s.description}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
