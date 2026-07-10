import { X } from 'lucide-react';

interface InlineAttributesFormProps {
  /** JSON-Schema `properties` object from the component's schema. */
  properties: Record<string, any>;
  /** Ordered list of required field names for label styling. */
  required?: string[];
  /** Current attribute values. */
  values: Record<string, any>;
  onChange: (fieldName: string, newValue: any) => void;
  /** `{asset_key: {columns, dtypes}}` — from GET /assets/{id}/known-schemas.
   *  Powers column-picker dropdowns for `*_column` fields when the
   *  upstream has been previewed at least once. */
  knownSchemas?: Record<string, { columns: string[]; dtypes: Record<string, string> }>;
  /** Field names to hide (usually because there's a dedicated UI for
   *  them elsewhere — upstream_asset_keys, sql_template, deps). */
  hideFields?: string[];
}

/**
 * A stripped-down attribute editor that renders the "easy" fields of a
 * component schema inline (side panel, not a modal). It reuses the same
 * name-based widget heuristics as ComponentConfigModal — column pickers
 * for `*_column`, date inputs for `partition_start`, etc. — but skips
 * the heavy special cases (sql_template, dbt adapter state, translation
 * config, etc.) that only make sense in the full modal.
 *
 * Users always keep the "Configure →" button as an escape hatch for the
 * advanced flows.
 */
export function InlineAttributesForm({
  properties,
  required,
  values,
  onChange,
  knownSchemas = {},
  hideFields,
}: InlineAttributesFormProps) {
  const hiddenSet = new Set([
    // Always-hidden in the inline form because they need the modal's
    // richer UI (multiline SQL editor, DataFrame-filtered asset picker,
    // per-key translation editor, etc.). The main "Configure →" button
    // is the way to reach these.
    'sql_template',
    'upstream_asset_keys',
    'upstream_asset_key',
    'translation',
    'post_processing',
    ...(hideFields ?? []),
  ]);

  const requiredSet = new Set(required ?? []);

  const entries = Object.entries(properties).filter(([name]) => !hiddenSet.has(name));
  if (entries.length === 0) return null;

  const upstreamColumns = (): string[] => {
    const raw = values['upstream_asset_keys'] ?? values['upstream_asset_key'] ?? '';
    const keys = String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const cols = new Set<string>();
    for (const k of keys) {
      const s = knownSchemas[k];
      if (s?.columns) s.columns.forEach((c) => cols.add(c));
    }
    return Array.from(cols);
  };

  return (
    <div className="space-y-3">
      {entries.map(([fieldName, fieldSchema]) => (
        <div key={fieldName}>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            {fieldName}
            {requiredSet.has(fieldName) && <span className="text-red-500 ml-0.5">*</span>}
          </label>
          {renderField(fieldName, fieldSchema, values[fieldName], onChange, upstreamColumns())}
          {fieldSchema.description && (
            <p className="text-[11px] text-gray-500 mt-0.5">{fieldSchema.description}</p>
          )}
        </div>
      ))}
    </div>
  );
}

type Widget = 'column' | 'columns' | 'date' | 'default';

function pickWidget(fieldName: string, fieldSchema: any): Widget {
  const hint = (fieldSchema?.['x-dagster-widget'] || '').toString().toLowerCase();
  if (hint === 'column' || hint === 'column-single') return 'column';
  if (hint === 'columns' || hint === 'column-multi' || hint === 'column-list') return 'columns';
  if (hint === 'date' || hint === 'datetime') return 'date';

  const lower = fieldName.toLowerCase();
  if (
    lower === 'columns' ||
    lower.endsWith('_columns') ||
    lower === 'group_by' ||
    lower === 'sort_by' ||
    lower === 'partition_by' ||
    lower === 'order_by' ||
    lower.endsWith('_columns_to_keep') ||
    lower.endsWith('_columns_to_drop')
  ) return 'columns';
  if (lower.endsWith('_column') || lower.endsWith('_col') || lower === 'column' || lower === 'col') return 'column';
  if (
    lower === 'partition_start' ||
    lower === 'partition_end' ||
    lower.endsWith('_date') ||
    lower.endsWith('_datetime') ||
    lower.endsWith('_timestamp') ||
    lower === 'start_date' ||
    lower === 'end_date'
  ) return 'date';
  return 'default';
}

function renderField(
  fieldName: string,
  fieldSchema: any,
  value: any,
  onChange: (name: string, next: any) => void,
  upstreamCols: string[],
) {
  const widget = pickWidget(fieldName, fieldSchema);
  const fieldType = fieldSchema.type;

  if (widget === 'column' && upstreamCols.length > 0) {
    return (
      <select
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(fieldName, e.target.value)}
        className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <option value="">— pick a column —</option>
        {upstreamCols.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
    );
  }

  if (widget === 'columns' && upstreamCols.length > 0) {
    const selected = String(value ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return (
      <div>
        <div className="flex flex-wrap gap-1 mb-1">
          {selected.map((c) => (
            <span key={c} className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] bg-blue-50 border border-blue-200 rounded text-blue-700">
              {c}
              <button
                type="button"
                onClick={() => onChange(fieldName, selected.filter((x) => x !== c).join(', '))}
                className="hover:text-blue-900"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
        <select
          value=""
          onChange={(e) => {
            const c = e.target.value;
            if (!c || selected.includes(c)) return;
            onChange(fieldName, [...selected, c].join(', '));
          }}
          className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">+ add a column…</option>
          {upstreamCols.filter((c) => !selected.includes(c)).map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>
    );
  }

  if (widget === 'date') {
    return (
      <input
        type="date"
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(fieldName, e.target.value)}
        className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    );
  }

  if (fieldType === 'boolean') {
    return (
      <label className="inline-flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => onChange(fieldName, e.target.checked)}
          className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
        />
        <span className="text-xs text-gray-600">Enable</span>
      </label>
    );
  }

  if (fieldType === 'number' || fieldType === 'integer') {
    return (
      <input
        type="number"
        value={value ?? ''}
        onChange={(e) => onChange(fieldName, e.target.value === '' ? null : Number(e.target.value))}
        className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    );
  }

  if (fieldSchema.enum && Array.isArray(fieldSchema.enum)) {
    return (
      <select
        value={value ?? ''}
        onChange={(e) => onChange(fieldName, e.target.value)}
        className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <option value=""></option>
        {fieldSchema.enum.map((v: string) => (
          <option key={v} value={v}>{v}</option>
        ))}
      </select>
    );
  }

  // Fall through to text input. Special placeholder when this looked
  // like a column field but no upstream schema is cached yet.
  const columnPending = (widget === 'column' || widget === 'columns') && upstreamCols.length === 0;
  const placeholder = columnPending
    ? 'preview upstream to enable column picker'
    : fieldSchema.description || fieldName;
  return (
    <input
      type="text"
      value={value ?? ''}
      onChange={(e) => onChange(fieldName, e.target.value)}
      className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
      placeholder={placeholder}
    />
  );
}
