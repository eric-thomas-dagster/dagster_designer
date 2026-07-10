import { useEffect, useMemo, useState } from 'react';
import { Plus, X, ArrowLeftRight } from 'lucide-react';
import { assetsApi } from '@/services/api';
import { useProjectStore } from '@/hooks/useProject';

interface JoinSidebarProps {
  /** Current attribute bag from the join component instance. Same shape
   *  the InlineAttributesForm / ComponentConfigModal manipulate. */
  attributes: Record<string, any>;
  onChange: (name: string, next: any) => void;
  /** Called when the user clicks "Advanced fields →" to escape into
   *  the full ComponentConfigModal for less-used fields (partition,
   *  freshness, retry, etc.). */
  onOpenAdvanced?: () => void;
}

type JoinHow = 'inner' | 'left' | 'right' | 'outer' | 'cross';

const HOW_ORDER: JoinHow[] = ['inner', 'left', 'right', 'outer', 'cross'];
const HOW_LABEL: Record<JoinHow, string> = {
  inner: 'Inner',
  left: 'Left',
  right: 'Right',
  outer: 'Full',
  cross: 'Cross',
};
const HOW_DESC: Record<JoinHow, string> = {
  inner: 'Only rows where the join key is in BOTH sides.',
  left: 'All left rows; matching right rows or nulls.',
  right: 'All right rows; matching left rows or nulls.',
  outer: 'All rows from both sides; nulls where either is missing.',
  cross: 'Cartesian product — every left × every right. Use with care.',
};

/**
 * Specialized right-sidebar UI for a DataFrame / Warehouse Join
 * component. Inspired by Databricks Lakeflow Designer's join panel:
 * two upstream pickers, a condition builder, a Venn-diagram-style
 * join-type switch, and per-side column-keep pickers. Everything
 * writes back to the same attribute keys the schema uses so the
 * generic form / config modal still round-trip the same YAML.
 *
 * Advanced fields (partition, freshness, retry, tags, kinds) don't
 * belong here — the "Advanced fields →" escape hatch opens the full
 * ComponentConfigModal for those.
 */
export function JoinSidebar({ attributes, onChange, onOpenAdvanced }: JoinSidebarProps) {
  const { currentProject } = useProjectStore();

  const [schemas, setSchemas] = useState<Record<string, { columns: string[]; dtypes: Record<string, string> }>>({});
  useEffect(() => {
    if (!currentProject) return;
    let cancelled = false;
    assetsApi.knownSchemas(currentProject.id).then((s) => {
      if (!cancelled) setSchemas(s || {});
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [currentProject?.id]);

  // Available DataFrame-producing assets in the graph. We can't perfectly
  // detect this without deep introspection, so fall back to "all assets
  // in the project"; the picker still filters out the current asset to
  // avoid self-joins.
  const currentAssetName = (attributes.asset_name as string) || '';
  const availableAssets = useMemo(() => {
    if (!currentProject) return [];
    return currentProject.graph.nodes
      .filter((n: any) => n.node_kind === 'asset' || n.type === 'asset')
      .map((n: any) => (n.data?.asset_key || n.data?.label || n.id) as string)
      .filter((k: string) => k && k !== currentAssetName)
      .filter((k: string, i: number, arr: string[]) => arr.indexOf(k) === i);
  }, [currentProject, currentAssetName]);

  const leftKey = (attributes.left_asset_key as string) || '';
  const rightKey = (attributes.right_asset_key as string) || '';
  const how = ((attributes.how as string) || 'inner') as JoinHow;

  const leftCols = schemas[leftKey]?.columns ?? [];
  const rightCols = schemas[rightKey]?.columns ?? [];

  // The schema exposes THREE column-condition fields — `on` (same name
  // on both), or `left_on` + `right_on` (asymmetric). We collapse those
  // into a unified UI: rows of { left, right }. Both sides same string
  // → single `on` list; otherwise → `left_on` / `right_on` arrays.
  const conditions = useMemo(() => {
    const on = normalizeArr(attributes.on);
    const left_on = normalizeArr(attributes.left_on);
    const right_on = normalizeArr(attributes.right_on);
    if (on.length > 0) {
      return on.map((c: string) => ({ left: c, right: c }));
    }
    const len = Math.max(left_on.length, right_on.length);
    const rows: { left: string; right: string }[] = [];
    for (let i = 0; i < len; i++) {
      rows.push({ left: left_on[i] ?? '', right: right_on[i] ?? '' });
    }
    return rows;
  }, [attributes.on, attributes.left_on, attributes.right_on]);

  const writeConditions = (rows: { left: string; right: string }[]) => {
    const filtered = rows.filter((r) => r.left || r.right);
    // If every row has left === right, prefer the concise `on` form.
    const symmetric = filtered.length > 0 && filtered.every((r) => r.left && r.left === r.right);
    if (symmetric) {
      onChange('on', filtered.map((r) => r.left));
      onChange('left_on', null);
      onChange('right_on', null);
    } else {
      onChange('on', null);
      onChange('left_on', filtered.map((r) => r.left));
      onChange('right_on', filtered.map((r) => r.right));
    }
  };

  const setCondition = (i: number, patch: Partial<{ left: string; right: string }>) => {
    const next = conditions.map((c, idx) => (idx === i ? { ...c, ...patch } : c));
    writeConditions(next);
  };
  const addCondition = () => writeConditions([...conditions, { left: '', right: '' }]);
  const removeCondition = (i: number) => writeConditions(conditions.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">Join</h3>
        <p className="text-[11px] text-gray-500 mt-0.5">
          Combine two DataFrame or warehouse tables into one. Configure the two inputs, how they match, and the join type.
        </p>
      </div>

      {/* Join inputs — left + right asset pickers. */}
      <section>
        <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wider mb-2">Join inputs</h4>
        <div className="grid grid-cols-2 gap-2">
          <AssetPicker
            label="Left"
            value={leftKey}
            options={availableAssets.filter((k) => k !== rightKey)}
            onChange={(v) => onChange('left_asset_key', v)}
            columnCount={leftCols.length}
          />
          <AssetPicker
            label="Right"
            value={rightKey}
            options={availableAssets.filter((k) => k !== leftKey)}
            onChange={(v) => onChange('right_asset_key', v)}
            columnCount={rightCols.length}
          />
        </div>
        {leftKey && rightKey && leftKey === rightKey && (
          <p className="mt-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
            ⚠ Left and Right point at the same asset — that's a self-join, which the component will reject.
          </p>
        )}
      </section>

      {/* Join conditions — column ↔ column rows. */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Join conditions</h4>
          {leftKey && rightKey && leftCols.length === 0 && rightCols.length === 0 && (
            <span className="text-[10px] text-gray-400">preview inputs to enable column pickers</span>
          )}
        </div>
        <div className="space-y-1.5">
          {conditions.length === 0 && (
            <p className="text-[11px] text-gray-500 italic">
              No conditions yet — the join will match on any columns with the same name on both sides.
            </p>
          )}
          {conditions.map((c, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <ColumnCombo
                value={c.left}
                options={leftCols}
                onChange={(v) => setCondition(i, { left: v })}
                placeholder="left column"
              />
              <ArrowLeftRight className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
              <ColumnCombo
                value={c.right}
                options={rightCols}
                onChange={(v) => setCondition(i, { right: v })}
                placeholder="right column"
              />
              <button
                type="button"
                onClick={() => removeCondition(i)}
                className="p-1 text-gray-400 hover:text-gray-700 rounded"
                title="Remove condition"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addCondition}
            className="inline-flex items-center gap-1 mt-1 px-2 py-1 text-xs text-primary hover:bg-primary/5 rounded"
          >
            <Plus className="w-3 h-3" /> Add condition
          </button>
        </div>
      </section>

      {/* Join type — Venn diagrams for visual clarity. */}
      <section>
        <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wider mb-2">Join type</h4>
        <div className="grid grid-cols-5 gap-1.5">
          {HOW_ORDER.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => onChange('how', h)}
              className={`flex flex-col items-center gap-1 p-2 rounded-md border text-[11px] transition-colors ${
                how === h
                  ? 'border-primary bg-primary/5 text-primary font-medium'
                  : 'border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50'
              }`}
              title={HOW_DESC[h]}
            >
              <VennGlyph kind={h} active={how === h} />
              <span>{HOW_LABEL[h]}</span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-gray-500">{HOW_DESC[how] ?? ''}</p>
      </section>

      {/* Suffixes — overlap-column disambiguation. Kept compact. */}
      <section>
        <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wider mb-2">Overlap suffixes</h4>
        <SuffixEditor
          suffixes={normalizeArr(attributes.suffixes)}
          onChange={(v) => onChange('suffixes', v)}
        />
        <p className="mt-1 text-[11px] text-gray-500">
          When both sides have a column with the same name, these suffixes disambiguate them (e.g. <code>_x</code> / <code>_y</code>).
        </p>
      </section>

      {/* Escape hatch to Advanced (partition, freshness, retry, tags…). */}
      {onOpenAdvanced && (
        <button
          type="button"
          onClick={onOpenAdvanced}
          className="w-full text-left text-xs px-3 py-2 border border-dashed border-gray-300 rounded-md text-gray-600 hover:bg-gray-50"
        >
          Advanced fields → (partition, freshness, tags, retry policy, …)
        </button>
      )}
    </div>
  );
}

// --- Sub-components ------------------------------------------------

function AssetPicker({
  label,
  value,
  options,
  onChange,
  columnCount,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  columnCount: number;
}) {
  return (
    <div className="flex flex-col">
      <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
      >
        <option value="">— pick asset —</option>
        {options.map((k) => (
          <option key={k} value={k}>{k}</option>
        ))}
      </select>
      <p className="text-[10px] text-gray-400 mt-0.5">
        {value
          ? columnCount > 0
            ? `${columnCount} columns known`
            : 'preview to see columns'
          : ''}
      </p>
    </div>
  );
}

/** A select with `options` OR a raw text input if the asset hasn't
 *  been previewed. Falls back gracefully — user still types the column
 *  name and it goes into left_on / right_on. */
function ColumnCombo({
  value,
  options,
  onChange,
  placeholder,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  placeholder: string;
}) {
  if (options.length > 0) {
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 min-w-0 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
      >
        <option value="">{placeholder}</option>
        {options.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
    );
  }
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="flex-1 min-w-0 px-2 py-1 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
    />
  );
}

function SuffixEditor({
  suffixes,
  onChange,
}: {
  suffixes: string[];
  onChange: (v: string[]) => void;
}) {
  const l = suffixes[0] ?? '';
  const r = suffixes[1] ?? '';
  return (
    <div className="grid grid-cols-2 gap-2">
      <input
        type="text"
        value={l}
        onChange={(e) => onChange([e.target.value, r])}
        placeholder="_x"
        className="w-full px-2 py-1 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <input
        type="text"
        value={r}
        onChange={(e) => onChange([l, e.target.value])}
        placeholder="_y"
        className="w-full px-2 py-1 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  );
}

/** Tiny Venn diagram — two circles, filled regions communicate which
 *  rows the join keeps. Deliberately hand-drawn SVG so it stays crisp
 *  and doesn't pull in a lib. */
function VennGlyph({ kind, active }: { kind: JoinHow; active: boolean }) {
  const stroke = active ? 'stroke-primary' : 'stroke-gray-400';
  // Filled fill / empty fill by region for each kind.
  //  Regions: L (left-only), R (right-only), M (middle overlap).
  const fills: Record<JoinHow, { L: string; M: string; R: string }> = {
    inner: { L: 'transparent',  M: 'fill-current',   R: 'transparent' },
    left:  { L: 'fill-current', M: 'fill-current',   R: 'transparent' },
    right: { L: 'transparent',  M: 'fill-current',   R: 'fill-current' },
    outer: { L: 'fill-current', M: 'fill-current',   R: 'fill-current' },
    cross: { L: 'fill-current', M: 'fill-current',   R: 'fill-current' },
  };
  const f = fills[kind];
  return (
    <svg
      viewBox="0 0 44 22"
      width="36"
      height="18"
      className={`${active ? 'text-primary' : 'text-gray-500'}`}
    >
      {/* Left circle whole outline */}
      <circle cx="15" cy="11" r="9" className={`fill-none ${stroke}`} strokeWidth="1.2" />
      {/* Right circle whole outline */}
      <circle cx="29" cy="11" r="9" className={`fill-none ${stroke}`} strokeWidth="1.2" />
      {/* Fill regions using clip paths — cheapest visual for a 44x22 glyph */}
      <defs>
        <clipPath id={`clip-l-${kind}`}>
          <circle cx="15" cy="11" r="9" />
        </clipPath>
        <clipPath id={`clip-r-${kind}`}>
          <circle cx="29" cy="11" r="9" />
        </clipPath>
      </defs>
      {/* L-only = left circle minus right circle */}
      {f.L !== 'transparent' && (
        <g clipPath={`url(#clip-l-${kind})`}>
          <rect x="0" y="0" width="44" height="22" className={f.L} />
          <circle cx="29" cy="11" r="9" fill="white" />
        </g>
      )}
      {/* R-only */}
      {f.R !== 'transparent' && (
        <g clipPath={`url(#clip-r-${kind})`}>
          <rect x="0" y="0" width="44" height="22" className={f.R} />
          <circle cx="15" cy="11" r="9" fill="white" />
        </g>
      )}
      {/* Middle overlap */}
      {f.M !== 'transparent' && (
        <g clipPath={`url(#clip-l-${kind})`}>
          <circle cx="29" cy="11" r="9" className={f.M} />
        </g>
      )}
      {/* Cross = ⨯ symbol overlay */}
      {kind === 'cross' && (
        <text x="22" y="14" textAnchor="middle" className="text-[9px] fill-white font-bold" style={{ fontSize: 9 }}>
          ⨯
        </text>
      )}
    </svg>
  );
}

// --- Helpers -------------------------------------------------------

function normalizeArr(v: any): string[] {
  if (Array.isArray(v)) return v.filter(Boolean).map(String);
  if (typeof v === 'string' && v.trim() !== '') {
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}
