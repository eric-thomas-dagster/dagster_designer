import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronDown, Check } from 'lucide-react';

interface MultiColumnSelectProps {
  columns: string[];
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  allowFreeText?: boolean;
  /** Preserve pick order (default true). Split's `into` uses this. */
  preserveOrder?: boolean;
  /** Columns to hide from the picker (e.g. Split's source column shouldn't
   *  be a destination). Free-text entries are unaffected. */
  excludeColumns?: string[];
}

/**
 * Chip-based multi-column picker. Replaces error-prone comma-separated text
 * inputs anywhere the user needs to pick 1..N columns. The dropdown is
 * portaled to document.body so it can escape parent overflow-hidden /
 * overflow-y-auto containers (like the transform sidebar).
 */
export function MultiColumnSelect({
  columns,
  value,
  onChange,
  placeholder = 'Select columns…',
  allowFreeText = false,
  preserveOrder = true,
  excludeColumns = [],
}: MultiColumnSelectProps) {
  const [open, setOpen] = useState(false);
  const [freeText, setFreeText] = useState('');
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  // Position the dropdown just below the trigger; recompute on scroll/resize.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = triggerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setPos({
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
      });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (dropdownRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const toggle = (col: string) => {
    if (value.includes(col)) {
      onChange(value.filter((c) => c !== col));
    } else {
      onChange(
        preserveOrder
          ? [...value, col]
          : [...columns.filter((c) => value.includes(c) || c === col)],
      );
    }
  };

  const addFreeText = () => {
    const trimmed = freeText.trim();
    if (!trimmed || value.includes(trimmed)) return;
    onChange([...value, trimmed]);
    setFreeText('');
  };

  const excludedSet = new Set(excludeColumns);
  const availableCols = columns.filter((c) => !excludedSet.has(c));

  return (
    <>
      <div
        ref={triggerRef}
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

      {open && pos && createPortal(
        <div
          ref={dropdownRef}
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            width: Math.max(pos.width, 200),
            zIndex: 10000,
          }}
          className="bg-white border border-gray-200 rounded-md shadow-xl max-h-64 overflow-y-auto"
        >
          {availableCols.length === 0 && !allowFreeText && (
            <div className="px-2 py-1.5 text-xs text-gray-400">No columns available</div>
          )}
          {availableCols.map((col) => {
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
            <div className="border-t border-gray-100 px-2 py-1.5 bg-gray-50 sticky bottom-0">
              <div className="text-[10px] text-gray-500 mb-1">Or type a new column name:</div>
              <div className="flex items-center gap-1">
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
                  placeholder="e.g. first_name"
                  className="flex-1 text-xs border border-gray-300 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-primary"
                  onClick={(e) => e.stopPropagation()}
                  autoFocus={value.length === 0}
                />
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    addFreeText();
                  }}
                  disabled={!freeText.trim()}
                  className="text-xs px-2 py-1 bg-primary text-primary-foreground rounded disabled:opacity-40"
                >
                  Add
                </button>
              </div>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
