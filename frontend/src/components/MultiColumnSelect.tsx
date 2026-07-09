import { useState, useRef, useEffect } from 'react';
import { X, ChevronDown, Check } from 'lucide-react';

interface MultiColumnSelectProps {
  columns: string[];
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  allowFreeText?: boolean;
  /** Optional: preserve order (default true — user's picking order is meaningful for e.g. split.into) */
  preserveOrder?: boolean;
}

/**
 * Chip-based multi-column picker. Replaces text inputs where the user needs
 * to pick 1..N columns — comma-separated typing is error-prone (typos,
 * whitespace, wrong casing). Renders selected columns as removable chips,
 * with a dropdown to add more from the available list.
 *
 * Order-preserving by default because some ops care about pick order
 * (Split's `into` columns map left-to-right onto the split parts).
 */
export function MultiColumnSelect({
  columns,
  value,
  onChange,
  placeholder = 'Select columns…',
  allowFreeText = false,
  preserveOrder = true,
}: MultiColumnSelectProps) {
  const [open, setOpen] = useState(false);
  const [freeText, setFreeText] = useState('');
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) {
      document.addEventListener('mousedown', onDocClick);
      return () => document.removeEventListener('mousedown', onDocClick);
    }
  }, [open]);

  const toggle = (col: string) => {
    if (value.includes(col)) {
      onChange(value.filter((c) => c !== col));
    } else {
      onChange(preserveOrder ? [...value, col] : [...columns.filter((c) => value.includes(c) || c === col)]);
    }
  };

  const addFreeText = () => {
    const trimmed = freeText.trim();
    if (!trimmed || value.includes(trimmed)) return;
    onChange([...value, trimmed]);
    setFreeText('');
  };

  return (
    <div ref={ref} className="relative">
      <div
        onClick={() => setOpen((v) => !v)}
        className="min-h-[30px] w-full flex flex-wrap items-center gap-1 border border-gray-300 rounded px-1.5 py-1 bg-white cursor-pointer text-xs focus-within:ring-2 focus-within:ring-primary/30 focus-within:border-primary"
      >
        {value.length === 0 && <span className="text-gray-400 px-1">{placeholder}</span>}
        {value.map((col, i) => (
          <span
            key={`${col}-${i}`}
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-primary/10 text-primary rounded"
          >
            <span className="font-mono max-w-[100px] truncate" title={col}>
              {col}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onChange(value.filter((_, j) => j !== i));
              }}
              className="hover:text-primary/70"
              title="Remove"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        <ChevronDown className="w-3 h-3 text-gray-400 ml-auto flex-shrink-0" />
      </div>

      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-20 bg-white border border-gray-200 rounded-md shadow-lg max-h-56 overflow-y-auto">
          {columns.length === 0 && !allowFreeText && (
            <div className="px-2 py-1.5 text-xs text-gray-400">No columns available</div>
          )}
          {columns.map((col) => {
            const checked = value.includes(col);
            return (
              <button
                key={col}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(col);
                }}
                className="w-full flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-gray-50 text-left"
              >
                <div
                  className={`w-3 h-3 border rounded-sm flex-shrink-0 flex items-center justify-center ${
                    checked ? 'bg-primary border-primary' : 'border-gray-300'
                  }`}
                >
                  {checked && <Check className="w-2.5 h-2.5 text-white" />}
                </div>
                <span className="font-mono truncate">{col}</span>
              </button>
            );
          })}
          {allowFreeText && (
            <div className="border-t border-gray-100 px-2 py-1.5 flex items-center gap-1">
              <input
                type="text"
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addFreeText();
                  }
                }}
                placeholder="Or type a name…"
                className="flex-1 text-xs border border-gray-300 rounded px-1.5 py-1"
                onClick={(e) => e.stopPropagation()}
              />
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  addFreeText();
                }}
                className="text-xs text-primary hover:underline"
              >
                Add
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
