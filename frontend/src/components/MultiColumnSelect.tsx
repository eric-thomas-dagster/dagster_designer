import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronDown, Check } from 'lucide-react';

interface MultiColumnSelectProps {
  columns: string[];
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  allowFreeText?: boolean;
  /** Preserve pick order (default true). */
  preserveOrder?: boolean;
  /** Columns to hide from the picker. */
  excludeColumns?: string[];
  /** Hide the existing-columns checkbox list. Use with allowFreeText for
   *  "new columns only" pickers like Split's into. */
  hideExistingColumns?: boolean;
}

/**
 * Chip-based multi-column picker.
 *
 * Positioning: portaled to document.body with `position: fixed` so it
 * escapes both `overflow: hidden/auto` ancestors AND any CSS `transform`
 * ancestors that would rebase `position: fixed` (Radix Dialog.Content uses
 * transforms for centering, which broke plain-child fixed positioning).
 *
 * Focus: the dropdown carries `data-column-picker-dropdown` so parent
 * Dialogs can whitelist it via `onInteractOutside` / `onFocusOutside`.
 */
export function MultiColumnSelect({
  columns,
  value,
  onChange,
  placeholder = 'Select columns…',
  allowFreeText = false,
  preserveOrder = true,
  excludeColumns = [],
  hideExistingColumns = false,
}: MultiColumnSelectProps) {
  const [open, setOpen] = useState(false);
  const [freeText, setFreeText] = useState('');
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const measure = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { top: rect.bottom + 4, left: rect.left, width: rect.width };
  }, []);

  const openDropdown = useCallback(() => {
    const p = measure();
    if (p) setPos(p);
    setOpen(true);
  }, [measure]);

  const closeDropdown = useCallback(() => {
    setOpen(false);
    setFreeText('');
  }, []);

  useEffect(() => {
    if (!open) return;
    const reposition = () => {
      const p = measure();
      if (p) setPos(p);
    };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (dropdownRef.current?.contains(t)) return;
      closeDropdown();
    }
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, closeDropdown]);

  const toggle = (col: string) => {
    if (value.includes(col)) {
      onChange(value.filter((c) => c !== col));
    } else {
      onChange(
        preserveOrder
          ? [...value, col]
          : columns.filter((c) => value.includes(c) || c === col),
      );
    }
  };

  const addFreeText = () => {
    const trimmed = freeText.trim();
    if (!trimmed || value.includes(trimmed)) return;
    onChange([...value, trimmed]);
    setFreeText('');
    inputRef.current?.focus();
  };

  const excludedSet = new Set(excludeColumns);
  const availableCols = hideExistingColumns
    ? []
    : columns.filter((c) => !excludedSet.has(c));

  return (
    <>
      <div
        ref={triggerRef}
        onClick={() => (open ? closeDropdown() : openDropdown())}
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
              type="button"
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
          data-column-picker-dropdown="true"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            width: Math.max(pos.width, 220),
            zIndex: 10000,
          }}
          className="bg-white border border-gray-200 rounded-md shadow-xl flex flex-col overflow-hidden"
        >
          {allowFreeText && (
            <div className="border-b border-gray-100 p-2 bg-gray-50">
              <div className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider mb-1">
                {hideExistingColumns ? 'Type new column names' : 'Or type a new column'}
              </div>
              <div className="flex items-center gap-1">
                <input
                  ref={inputRef}
                  type="text"
                  value={freeText}
                  onChange={(e) => setFreeText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addFreeText();
                    } else if (e.key === 'Escape') {
                      closeDropdown();
                    }
                  }}
                  placeholder="e.g. first_name"
                  className="flex-1 text-xs border border-gray-300 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-primary bg-white"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={addFreeText}
                  disabled={!freeText.trim()}
                  className="text-xs px-2 py-1 bg-primary text-primary-foreground rounded disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Add
                </button>
              </div>
              {hideExistingColumns && value.length > 0 && (
                <div className="text-[10px] text-gray-500 mt-1">
                  {value.length} added — click X on a chip to remove.
                </div>
              )}
            </div>
          )}

          {!hideExistingColumns && (
            <div className="max-h-56 overflow-y-auto">
              {availableCols.length === 0 && (
                <div className="px-2 py-1.5 text-xs text-gray-400">No columns available</div>
              )}
              {availableCols.map((col) => {
                const checked = value.includes(col);
                return (
                  <button
                    key={col}
                    type="button"
                    onClick={() => toggle(col)}
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
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
