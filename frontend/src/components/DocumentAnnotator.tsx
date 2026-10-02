import { useRef, useState } from 'react';
import { X, Trash2, Check } from 'lucide-react';

export interface FieldRegion {
  x: number;      // fraction of image width, 0-1
  y: number;      // fraction of image height, 0-1
  width: number;  // fraction of image width, 0-1
  height: number; // fraction of image height, 0-1
}

const BOX_COLORS = ['#8b5cf6', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#ef4444', '#6366f1', '#14b8a6'];
function colorFor(field: string, fields: string[]): string {
  const idx = fields.indexOf(field);
  return BOX_COLORS[(idx >= 0 ? idx : 0) % BOX_COLORS.length];
}

/**
 * Draw-a-box-and-tag-it annotation tool for a single sample document --
 * the "point at where on the page a field actually is" feature, distinct
 * from DocumentExtractorConfigStep's field CHIPS (which only name fields,
 * not locate them). Stores fractional (0-1) coordinates so a region drawn
 * on this preview image still lines up regardless of the real document's
 * resolution or aspect ratio. Scoped to image documents for now -- a PDF
 * page has no single fixed pixel geometry to draw against without first
 * rendering a specific page to an image, which is a separate lift.
 */
export function DocumentAnnotator({
  imageUrl,
  fields,
  initialRegions,
  onSave,
  onClose,
}: {
  imageUrl: string;
  fields: string[];
  initialRegions?: Record<string, FieldRegion>;
  onSave: (regions: Record<string, FieldRegion>) => void;
  onClose: () => void;
}) {
  const [regions, setRegions] = useState<Record<string, FieldRegion>>(initialRegions || {});
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [pendingBox, setPendingBox] = useState<FieldRegion | null>(null);
  const [assignField, setAssignField] = useState('');
  // Which field the next drawn box goes to -- picked from the persistent
  // field list BEFORE drawing, so you know what's left to place instead
  // of only finding out via the dropdown after a box already exists.
  // Defaults to the first not-yet-placed field so there's always
  // something sensible pre-selected.
  const [activeField, setActiveField] = useState<string | null>(() => fields.find((f) => !(initialRegions || {})[f]) || fields[0] || null);
  const containerRef = useRef<HTMLDivElement>(null);

  const toFraction = (clientX: number, clientY: number) => {
    const rect = containerRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
    };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (pendingBox) return; // finish/cancel the current pending box first
    const { x, y } = toFraction(e.clientX, e.clientY);
    setDrag({ x0: x, y0: y, x1: x, y1: y });
  };
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!drag) return;
    const { x, y } = toFraction(e.clientX, e.clientY);
    setDrag((prev) => (prev ? { ...prev, x1: x, y1: y } : prev));
  };
  const handleMouseUp = () => {
    if (!drag) return;
    const x = Math.min(drag.x0, drag.x1);
    const y = Math.min(drag.y0, drag.y1);
    const width = Math.abs(drag.x1 - drag.x0);
    const height = Math.abs(drag.y1 - drag.y0);
    setDrag(null);
    if (width < 0.01 || height < 0.01) return; // too small -- treat as an accidental click
    setPendingBox({ x, y, width, height });
    // Pre-fill with whichever field was actively selected before drawing;
    // fall back to the old "first unassigned" guess if none was picked.
    setAssignField(activeField || fields.find((f) => !regions[f]) || fields[0] || '');
  };

  const confirmPendingBox = () => {
    if (!pendingBox || !assignField.trim()) return;
    const justPlaced = assignField.trim();
    setRegions((prev) => ({ ...prev, [justPlaced]: pendingBox }));
    setPendingBox(null);
    // Auto-advance to the next unplaced field so placing a run of fields
    // is pick-draw, pick-draw, ... instead of re-opening the dropdown
    // and re-guessing every time.
    setActiveField(fields.find((f) => f !== justPlaced && !regions[f]) || null);
  };
  const removeRegion = (field: string) => {
    setRegions((prev) => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const liveBox = drag && {
    x: Math.min(drag.x0, drag.x1),
    y: Math.min(drag.y0, drag.y1),
    width: Math.abs(drag.x1 - drag.x0),
    height: Math.abs(drag.y1 - drag.y0),
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-[70]">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div>
            <h2 className="text-lg font-semibold">Field locations</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {activeField
                ? <>Drag a box where <span className="font-mono font-medium text-gray-700">{activeField}</span> appears — or pick a different field on the right first.</>
                : 'Pick a field on the right, then drag a box around where it appears.'}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>

        <div className="flex-1 overflow-hidden grid grid-cols-1 sm:grid-cols-[1fr_260px]">
          <div className="flex items-center justify-center p-6 bg-gray-50 overflow-auto">
            <div
              ref={containerRef}
              className="relative inline-block cursor-crosshair select-none"
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={() => drag && handleMouseUp()}
            >
              <img src={imageUrl} alt="Document" className="max-w-full max-h-[calc(90vh-160px)] block pointer-events-none" draggable={false} />
              {Object.entries(regions).map(([field, r]) => (
                <div
                  key={field}
                  className="absolute border-2 group"
                  style={{
                    left: `${r.x * 100}%`, top: `${r.y * 100}%`,
                    width: `${r.width * 100}%`, height: `${r.height * 100}%`,
                    borderColor: colorFor(field, fields),
                    backgroundColor: `${colorFor(field, fields)}1a`,
                  }}
                >
                  <span
                    className="absolute -top-5 left-0 text-[10px] font-mono px-1 rounded text-white whitespace-nowrap"
                    style={{ backgroundColor: colorFor(field, fields) }}
                  >
                    {field}
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); removeRegion(field); }}
                    className="absolute -top-5 right-0 opacity-0 group-hover:opacity-100 bg-white rounded-full p-0.5 shadow"
                    title="Remove"
                  >
                    <Trash2 className="w-3 h-3 text-rose-500" />
                  </button>
                </div>
              ))}
              {liveBox && (
                <div
                  className="absolute border-2 border-dashed border-primary bg-primary/10 pointer-events-none"
                  style={{ left: `${liveBox.x * 100}%`, top: `${liveBox.y * 100}%`, width: `${liveBox.width * 100}%`, height: `${liveBox.height * 100}%` }}
                />
              )}
              {pendingBox && (
                <div
                  className="absolute border-2 border-dashed pointer-events-none"
                  style={{
                    left: `${pendingBox.x * 100}%`, top: `${pendingBox.y * 100}%`,
                    width: `${pendingBox.width * 100}%`, height: `${pendingBox.height * 100}%`,
                    borderColor: colorFor(assignField, fields),
                  }}
                />
              )}
            </div>
          </div>

          <div className="border-l border-gray-100 overflow-y-auto p-4 space-y-4">
            <div>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                Fields ({Object.keys(regions).length}/{fields.length} placed)
              </h3>
              {fields.length === 0 ? (
                <p className="text-xs text-gray-400 italic">No fields defined yet — add some first, then come back to mark their locations.</p>
              ) : (
                <div className="space-y-1">
                  {fields.map((f) => {
                    const placed = !!regions[f];
                    const isActive = activeField === f;
                    return (
                      <button
                        key={f}
                        onClick={() => setActiveField(f)}
                        disabled={!!pendingBox}
                        className={`w-full flex items-center justify-between px-2 py-1.5 rounded-md border text-left disabled:opacity-50 disabled:cursor-not-allowed ${
                          isActive ? 'border-primary bg-primary/5' : 'border-gray-100 bg-gray-50 hover:bg-gray-100'
                        }`}
                      >
                        <span className="text-xs font-mono flex items-center gap-1.5 min-w-0">
                          <span
                            className="w-2.5 h-2.5 rounded-sm inline-block flex-shrink-0"
                            style={{ backgroundColor: placed ? colorFor(f, fields) : 'transparent', border: placed ? 'none' : '1.5px solid #d1d5db' }}
                          />
                          <span className="truncate">{f}</span>
                        </span>
                        {placed ? (
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(e) => { e.stopPropagation(); removeRegion(f); }}
                            className="text-gray-300 hover:text-rose-500 flex-shrink-0"
                            title="Remove this field's location"
                          >
                            <Trash2 className="w-3 h-3" />
                          </span>
                        ) : (
                          <span className="text-[10px] text-gray-400 flex-shrink-0">not placed</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {pendingBox ? (
              <div className="space-y-2 bg-violet-50 border border-violet-200 rounded-md p-3">
                <label className="block text-xs font-medium text-gray-700">Assign this region to</label>
                <select
                  value={assignField}
                  onChange={(e) => setAssignField(e.target.value)}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md bg-white"
                >
                  {fields.length === 0 && <option value="">(no fields defined yet)</option>}
                  {fields.map((f) => (
                    <option key={f} value={f}>{f}{regions[f] ? ' (replaces existing)' : ''}</option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <button onClick={() => setPendingBox(null)} className="flex-1 px-2 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded-md border border-gray-200">
                    Cancel
                  </button>
                  <button
                    onClick={confirmPendingBox}
                    disabled={!assignField.trim()}
                    className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50"
                  >
                    <Check className="w-3.5 h-3.5" /> Assign
                  </button>
                </div>
              </div>
            ) : null}

            <p className="text-[10px] text-gray-400">
              Marked regions are sent to the LLM as close-up crops alongside the full document — a hint, not a hard constraint, so extraction still works if a real document's layout shifts slightly.
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-200">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-md">
            Cancel
          </button>
          <button
            onClick={() => onSave(regions)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent"
          >
            <Check className="w-3.5 h-3.5" /> Save {Object.keys(regions).length} region{Object.keys(regions).length === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}
