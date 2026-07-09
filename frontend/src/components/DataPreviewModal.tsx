import React, { useState, useMemo } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { X, AlertCircle, Table as TableIcon, Wand2, Save, Filter, Columns3, Trash2, Eye, EyeOff, ChevronDown, ChevronRight, SortAsc, SortDesc, Sigma, Group, Calculator, ArrowDownUp, RotateCw, Play, Loader2, Plus, Package } from 'lucide-react';
import { assetsApi, projectsApi, type AssetDataPreview } from '@/services/api';
import { notify } from './Notifications';
import { CommunityTransformPicker } from './CommunityTransformPicker';
import { ColumnProfileStrip } from './ColumnProfileStrip';
import { MultiColumnSelect } from './MultiColumnSelect';
import { RecipePanel, type RecipeStep } from './RecipePanel';

interface DataPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  assetKey: string;
  assetName: string;
  onTransformerCreated?: (updatedProject: any) => void;
  hasTransformerComponent?: boolean;
  existingComponentAttributes?: Record<string, any>;
  existingComponentId?: string; // ID of component being edited (if editing)
  /** Optional initial mode. AssetIOPanel's "Transform" button opens the modal
      pre-flipped to transform mode instead of view. */
  initialMode?: 'view' | 'transform';
}

interface FilterCondition {
  column: string;
  operator: 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'greater_than' | 'less_than';
  value: string;
}

interface TransformConfig {
  columnsToKeep: string[] | null; // null means keep all
  columnsToDrop: string[] | null;
  columnRenames: Record<string, string> | null; // {"old_name": "new_name"}
  filters: FilterCondition[];
  dropDuplicates: boolean;
  dropNA: boolean;
  fillNAValue: string | null;
  sortBy: string[] | null;
  sortAscending: boolean;
  groupBy: string[] | null;
  aggregations: Record<string, string> | null;
  stringOperations: Array<{column: string, operation: string}> | null;
  stringReplace: Record<string, Record<string, string>> | null;
  calculatedColumns: Record<string, string> | null;
  pivotConfig: {index: string, columns: string, values: string, aggfunc: string} | null;
  unpivotConfig: {id_vars: string[], value_vars: string[], var_name: string, value_name: string} | null;
  limitRows: number | null;
  replaceOps: Array<{column: string; find: string; replace: string}> | null;
  splitOps: Array<{column: string; delimiter: string; into: string}> | null;
  windowOps: Array<{kind: string; orderBy: string; partitionBy: string; orderAsc: boolean; into: string}> | null;
}

export function DataPreviewModal({
  isOpen,
  onClose,
  projectId,
  assetKey,
  assetName,
  onTransformerCreated,
  hasTransformerComponent = true, // Default to true for backward compatibility
  existingComponentAttributes,
  existingComponentId,
  initialMode = 'view',
}: DataPreviewModalProps) {
  const [data, setData] = useState<AssetDataPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'transform'>(initialMode);
  const [saving, setSaving] = useState(false);

  // Transform configuration
  const [selectedColumns, setSelectedColumns] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<FilterCondition[]>([]);
  const [newAssetName, setNewAssetName] = useState('');

  // Additional transform options
  const [dropDuplicates, setDropDuplicates] = useState(false);
  const [dropNA, setDropNA] = useState(false);
  const [fillNAValue, setFillNAValue] = useState('');
  const [sortColumns, setSortColumns] = useState<string[]>([]);
  const [sortAscending, setSortAscending] = useState(true);
  const [groupByColumns, setGroupByColumns] = useState<string[]>([]);
  const [aggregations, setAggregations] = useState<Record<string, string>>({});
  const [columnRenames, setColumnRenames] = useState<Record<string, string>>({});
  const [columnsToDrop, setColumnsToDrop] = useState<Set<string>>(new Set());
  const [openColumnMenu, setOpenColumnMenu] = useState<string | null>(null);
  const [columnOrder, setColumnOrder] = useState<string[]>([]);

  // New advanced features
  const [stringOperations, setStringOperations] = useState<Array<{column: string, operation: string}>>([]);
  const [calculatedColumns, setCalculatedColumns] = useState<Record<string, string>>({});
  const [newCalcColName, setNewCalcColName] = useState('');
  const [newCalcColExpr, setNewCalcColExpr] = useState('');
  const [pivotConfig, setPivotConfig] = useState<Record<string, any> | null>(null);
  const [unpivotConfig, setUnpivotConfig] = useState<Record<string, any> | null>(null);
  const [limitRows, setLimitRows] = useState<number | null>(null);
  // Replace: {column, find, replace} — applied per row.
  const [replaceOps, setReplaceOps] = useState<Array<{column: string; find: string; replace: string}>>([]);
  // Split: {column, delimiter, into[]} — splits values on delimiter and
  // assigns each part to one of the `into` column names, left-to-right.
  const [splitOps, setSplitOps] = useState<Array<{column: string; delimiter: string; into: string}>>([]);
  // Window: {kind, orderBy, partitionBy, into} — adds one column per op.
  const [windowOps, setWindowOps] = useState<Array<{
    kind: 'rank' | 'row_number' | 'dense_rank';
    orderBy: string;
    partitionBy: string;
    orderAsc: boolean;
    into: string;
  }>>([]);
  // Count Matching: {column, operator, value, into, partitionBy} — emits a
  // new column whose value is COUNT of rows matching the condition,
  // optionally within a partition. e.g. count of orders where status =
  // 'completed' per customer_id.
  const [countMatchOps, setCountMatchOps] = useState<Array<{
    column: string;
    operator: 'equals' | 'not_equals' | 'greater_than' | 'less_than' | 'contains';
    value: string;
    into: string;
    partitionBy: string;
  }>>([]);
  // Case-When: {branches: [{condition, then}], else, into}. Universal
  // conditional column. Preview evaluates the condition as a pandas-query-
  // style expression; backend compiles to SQL CASE WHEN … END.
  const [caseWhenOps, setCaseWhenOps] = useState<Array<{
    branches: Array<{ column: string; operator: string; value: string; then: string }>;
    else: string;
    into: string;
  }>>([]);
  // Concat: {columns[], separator, into}. Joins multiple columns into one
  // string column with a separator.
  const [concatOps, setConcatOps] = useState<Array<{
    columns: string;  // comma-separated column names, order-preserving
    separator: string;
    into: string;
  }>>([]);
  // Date Extract: {column, part, into}. EXTRACT(YEAR/MONTH/DAY/DAYOFWEEK/HOUR
  // FROM col). part ∈ {year, month, day, dayofweek, hour}.
  const [dateExtractOps, setDateExtractOps] = useState<Array<{
    column: string;
    part: 'year' | 'month' | 'day' | 'dayofweek' | 'hour';
    into: string;
  }>>([]);
  // Substring: {column, start (1-based), length, into}
  const [substringOps, setSubstringOps] = useState<Array<{
    column: string;
    start: number;
    length: number | null;
    into: string;
  }>>([]);
  // Numeric: {column, op: 'round'|'floor'|'ceil'|'abs', digits, into}
  const [numericOps, setNumericOps] = useState<Array<{
    column: string;
    op: 'round' | 'floor' | 'ceil' | 'abs';
    digits: number;
    into: string;
  }>>([]);
  // Sample: {n or fraction, random}. n takes precedence if > 0.
  const [sampleConfig, setSampleConfig] = useState<{
    n: number | null;
    fraction: number | null;
    random: boolean;
  } | null>(null);

  // Step-view: when set, applies only the first N ops (0-indexed) and shows
  // that partial snapshot in the preview table. RecipePanel highlights the
  // corresponding step. Null = show final result (apply everything).
  const [previewAtStep, setPreviewAtStep] = useState<number | null>(null);

  // Accordion state for transform sections
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['columns', 'filters']));

  // Track if a filter_expression exists that can't be edited in the visual editor
  const [hasFilterExpression, setHasFilterExpression] = useState(false);
  const [filterExpressionValue, setFilterExpressionValue] = useState<string>('');

  // Load data when modal opens
  React.useEffect(() => {
    if (isOpen && !data && !loading) {
      loadData();
    }
  }, [isOpen]);

  // Initialize selected columns when data loads
  React.useEffect(() => {
    if (data && data.columns && selectedColumns.size === 0 && !existingComponentAttributes) {
      setSelectedColumns(new Set(data.columns));
    }
  }, [data]);

  // Load existing component configuration for editing
  React.useEffect(() => {
    if (existingComponentAttributes && data) {
      console.log('[DataPreviewModal] Loading existing config:', existingComponentAttributes);

      // Set the mode to transform so user can see/edit transformations
      setMode('transform');

      // Set the asset name from existing config (for editing mode)
      if (existingComponentAttributes.asset_name && existingComponentId) {
        setNewAssetName(existingComponentAttributes.asset_name);
      }

      // Load filter_columns (columns to keep)
      if (existingComponentAttributes.filter_columns) {
        const columns = existingComponentAttributes.filter_columns.split(',').map((c: string) => c.trim());
        setSelectedColumns(new Set(columns));
      }

      // Load rename_columns
      if (existingComponentAttributes.rename_columns) {
        try {
          const renames = JSON.parse(existingComponentAttributes.rename_columns);
          setColumnRenames(renames);
        } catch (e) {
          console.error('[DataPreviewModal] Failed to parse rename_columns:', e);
        }
      }

      // Load calculated_columns
      if (existingComponentAttributes.calculated_columns) {
        try {
          const calcs = JSON.parse(existingComponentAttributes.calculated_columns);
          setCalculatedColumns(calcs);
        } catch (e) {
          console.error('[DataPreviewModal] Failed to parse calculated_columns:', e);
        }
      }

      // Load drop_duplicates
      if (existingComponentAttributes.drop_duplicates !== undefined) {
        setDropDuplicates(existingComponentAttributes.drop_duplicates);
      }

      // Load filter_expression (pandas query)
      // Note: filter_expression is a pandas query string, which is different from our FilterCondition[]
      // We can't automatically convert complex pandas queries back to FilterCondition objects
      // But we should at least log that it exists so the user knows
      if (existingComponentAttributes.filter_expression) {
        setHasFilterExpression(true);
        setFilterExpressionValue(existingComponentAttributes.filter_expression);
        console.warn('[DataPreviewModal] filter_expression exists but cannot be loaded into visual editor:',
                     existingComponentAttributes.filter_expression);
        console.warn('[DataPreviewModal] To edit filter expressions, use the component config modal or create new filters in the visual editor');
      }

      // Load string_operations
      if (existingComponentAttributes.string_operations) {
        try {
          const ops = JSON.parse(existingComponentAttributes.string_operations);
          setStringOperations(ops);
        } catch (e) {
          console.error('[DataPreviewModal] Failed to parse string_operations:', e);
        }
      }

      // Load pivot_config
      if (existingComponentAttributes.pivot_config) {
        try {
          const pivot = JSON.parse(existingComponentAttributes.pivot_config);
          setPivotConfig(pivot);
        } catch (e) {
          console.error('[DataPreviewModal] Failed to parse pivot_config:', e);
        }
      }

      // Load unpivot_config
      if (existingComponentAttributes.unpivot_config) {
        try {
          const unpivot = JSON.parse(existingComponentAttributes.unpivot_config);
          setUnpivotConfig(unpivot);
        } catch (e) {
          console.error('[DataPreviewModal] Failed to parse unpivot_config:', e);
        }
      }

      // Load sort_by
      if (existingComponentAttributes.sort_by) {
        const sortCols = existingComponentAttributes.sort_by.split(',').map((c: string) => c.trim());
        setSortColumns(sortCols);
      }

      // Load limit_rows
      if (existingComponentAttributes.limit_rows !== undefined && existingComponentAttributes.limit_rows !== null) {
        const n = parseInt(String(existingComponentAttributes.limit_rows), 10);
        if (!isNaN(n)) setLimitRows(n);
      }

      // Load sort_ascending
      if (existingComponentAttributes.sort_ascending !== undefined) {
        setSortAscending(existingComponentAttributes.sort_ascending);
      }

      // Load group_by
      if (existingComponentAttributes.group_by) {
        const groupCols = existingComponentAttributes.group_by.split(',').map((c: string) => c.trim());
        setGroupByColumns(groupCols);
      }

      // Load aggregations
      if (existingComponentAttributes.aggregations) {
        try {
          const aggs = JSON.parse(existingComponentAttributes.aggregations);
          setAggregations(aggs);
        } catch (e) {
          console.error('[DataPreviewModal] Failed to parse aggregations:', e);
        }
      }

      // Load drop_na
      if (existingComponentAttributes.drop_na !== undefined) {
        setDropNA(existingComponentAttributes.drop_na);
      }

      // Load fill_na_value
      if (existingComponentAttributes.fill_na_value) {
        setFillNAValue(existingComponentAttributes.fill_na_value);
      }

      console.log('[DataPreviewModal] Loaded existing config successfully');
    }
  }, [existingComponentAttributes, data]);

  const [runningToHere, setRunningToHere] = useState(false);
  const [showCommunityPicker, setShowCommunityPicker] = useState(false);

  const loadData = async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await assetsApi.previewData(projectId, assetKey);

      if (!result.success) {
        setError(result.error || 'Failed to load asset data');
      } else {
        setData(result);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load asset data');
    } finally {
      setLoading(false);
    }
  };

  // Empty-state "Run to here" — same materialize + auto-preview loop as the
  // node's play button, but triggered from inside the modal when the initial
  // preview came back with "not materialized". Keeps the click count low.
  const handleRunToHere = async () => {
    setRunningToHere(true);
    try {
      const result = await projectsApi.materialize(projectId, [`+${assetKey}`]);
      if (!result.success) {
        const tail = (result.stderr || result.stdout || '').split('\n').slice(-4).join(' | ');
        notify.error(`Materialize failed: ${tail || 'unknown error'}`);
        return;
      }
      notify.success(`Materialized ${assetKey} + upstream. Loading data…`);
      // Reload the preview — the cache was just invalidated by materialize.
      await loadData();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify.error(`Materialize failed: ${msg}`);
    } finally {
      setRunningToHere(false);
    }
  };

  // Preview may return an error that hints at needing materialization first
  // (typically a dbt / multi-key group where the underlying table doesn't
  // exist yet). Detect that so we can render the Run-to-here empty state
  // instead of just showing the raw error text.
  const isNotMaterializedError = !!error && (
    /run to here/i.test(error) ||
    /not materialized/i.test(error) ||
    /couldn.?t find materialized/i.test(error) ||
    /does not exist/i.test(error)
  );

  // Apply transformations to preview data
  const transformedData = useMemo(() => {
    if (!data || !data.data || mode !== 'transform') {
      return data;
    }

    let result = [...data.data];

    // Step counter — increments once per op that ACTIVATES (matches
    // recipeSteps.length exactly). previewAtStep=null → apply all; else
    // apply only ops 0..previewAtStep (inclusive).
    let stepIdx = -1;
    const gate = () => {
      stepIdx++;
      return previewAtStep === null || stepIdx <= previewAtStep;
    };

    // 1. filters
    filters.forEach(filter => {
      const filterValue = (filter.value ?? '').trim();
      if (!filter.column || !filterValue) return;
      if (!gate()) return;
      result = result.filter(row => {
        const value = row[filter.column];
        switch (filter.operator) {
          case 'equals':
            return String(value).toLowerCase() === filterValue.toLowerCase();
          case 'not_equals':
            return String(value).toLowerCase() !== filterValue.toLowerCase();
          case 'contains':
            return String(value).toLowerCase().includes(filterValue.toLowerCase());
          case 'not_contains':
            return !String(value).toLowerCase().includes(filterValue.toLowerCase());
          case 'greater_than':
            return Number(value) > Number(filterValue);
          case 'less_than':
            return Number(value) < Number(filterValue);
          default:
            return true;
        }
      });
    });

    // 2. Drop duplicates
    if (dropDuplicates && gate()) {
      const seen = new Set();
      result = result.filter(row => {
        const key = JSON.stringify(row);
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
    }

    // 3. Drop NA
    if (dropNA && gate()) {
      result = result.filter(row => {
        return Object.values(row).every(val => val !== null && val !== undefined && val !== '');
      });
    }

    // 4. Fill NA
    if (fillNAValue && gate()) {
      result = result.map(row => {
        const newRow: any = {};
        Object.keys(row).forEach(key => {
          const val = row[key];
          newRow[key] = (val === null || val === undefined || val === '') ? fillNAValue : val;
        });
        return newRow;
      });
    }

    // 5. Group by and aggregate
    if (groupByColumns.length > 0 && Object.keys(aggregations).length > 0 && gate()) {
      const groups: Record<string, any[]> = {};

      // Group rows
      result.forEach(row => {
        const groupKey = groupByColumns.map(col => row[col]).join('|');
        if (!groups[groupKey]) {
          groups[groupKey] = [];
        }
        groups[groupKey].push(row);
      });

      // Aggregate
      result = Object.entries(groups).map(([groupKey, rows]) => {
        const newRow: any = {};

        // Add group by columns
        groupByColumns.forEach((col, idx) => {
          newRow[col] = groupKey.split('|')[idx];
        });

        // Add aggregated columns
        Object.entries(aggregations).forEach(([col, func]) => {
          const values = rows.map(r => Number(r[col])).filter(v => !isNaN(v));

          switch (func) {
            case 'sum':
              newRow[col] = values.reduce((a, b) => a + b, 0);
              break;
            case 'count':
              newRow[col] = rows.length;
              break;
            case 'mean':
              newRow[col] = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
              break;
            case 'min':
              newRow[col] = values.length > 0 ? Math.min(...values) : null;
              break;
            case 'max':
              newRow[col] = values.length > 0 ? Math.max(...values) : null;
              break;
            default:
              newRow[col] = null;
          }
        });

        return newRow;
      });
    }

    // 6. Sorting
    if (sortColumns.length > 0 && gate()) {
      result = [...result].sort((a, b) => {
        for (const col of sortColumns) {
          const aVal = a[col];
          const bVal = b[col];

          // Try numeric comparison first
          const aNum = Number(aVal);
          const bNum = Number(bVal);

          let comparison = 0;
          if (!isNaN(aNum) && !isNaN(bNum)) {
            comparison = aNum - bNum;
          } else {
            comparison = String(aVal).localeCompare(String(bVal));
          }

          if (comparison !== 0) {
            return sortAscending ? comparison : -comparison;
          }
        }
        return 0;
      });
    }

    // 7. Apply column renames
    if (Object.keys(columnRenames).length > 0 && gate()) {
      result = result.map(row => {
        const newRow: any = {};
        Object.keys(row).forEach(key => {
          const newKey = columnRenames[key] || key;
          newRow[newKey] = row[key];
        });
        return newRow;
      });
    }

    // 8. Apply column-level Replace ops
    // Per-op iteration so the step counter matches recipeSteps 1:1.
    replaceOps.forEach(op => {
      if (!op.column || !op.find) return;
      if (!gate()) return;
      result = result.map(row => {
        const newRow = { ...row };
        const v = newRow[op.column];
        if (v === null || v === undefined) return newRow;
        const s = String(v);
        const isRegex = op.find.startsWith('/') && op.find.lastIndexOf('/') > 0;
        if (isRegex) {
          const last = op.find.lastIndexOf('/');
          try {
            const re = new RegExp(op.find.slice(1, last), op.find.slice(last + 1) || 'g');
            newRow[op.column] = s.replace(re, op.replace);
          } catch {
            newRow[op.column] = s.split(op.find).join(op.replace);
          }
        } else {
          newRow[op.column] = s.split(op.find).join(op.replace);
        }
        return newRow;
      });
    });

    // 9. Split ops
    splitOps.forEach(op => {
      if (!op.column || !op.delimiter || !op.into) return;
      if (!gate()) return;
      const targets = op.into.split(',').map(s => s.trim()).filter(Boolean);
      if (targets.length === 0) return;
      result = result.map(row => {
        const newRow = { ...row };
        const v = newRow[op.column];
        const s = v === null || v === undefined ? '' : String(v);
        const parts = s.split(op.delimiter);
        targets.forEach((t, i) => {
          newRow[t] = parts[i] ?? '';
        });
        return newRow;
      });
    });

    // 10. Case-When ops
    caseWhenOps.forEach(op => {
      if (!op.into) return;
      if (!gate()) return;
      result = result.map(row => {
          let out: any = op.else;
          for (const b of op.branches) {
            if (!b.column) continue;
            const v = row[b.column];
            const bv = b.value ?? '';
            const matches = (() => {
              const s = String(v ?? '').toLowerCase();
              const fv = bv.toLowerCase();
              switch (b.operator) {
                case 'equals': return s === fv;
                case 'not_equals': return s !== fv;
                case 'contains': return s.includes(fv);
                case 'greater_than': return Number(v) > Number(bv);
                case 'less_than': return Number(v) < Number(bv);
                default: return false;
              }
            })();
            if (matches) {
              out = b.then;
              break;
            }
          }
          return { ...row, [op.into]: out };
        });
    });

    // 11. Concat ops
    concatOps.forEach(op => {
      if (!op.into || !op.columns) return;
      if (!gate()) return;
      const cols = op.columns.split(',').map(s => s.trim()).filter(Boolean);
      if (cols.length === 0) return;
      result = result.map(row => {
        const parts = cols.map(c => String(row[c] ?? ''));
        return { ...row, [op.into]: parts.join(op.separator ?? '') };
      });
    });

    // 12. Date Extract ops
    dateExtractOps.forEach(op => {
      if (!op.column || !op.into) return;
      if (!gate()) return;
      result = result.map(row => {
        const raw = row[op.column];
        if (raw === null || raw === undefined || raw === '') {
          return { ...row, [op.into]: null };
        }
        const d = new Date(raw);
        if (isNaN(d.getTime())) return { ...row, [op.into]: null };
        let out: number | null = null;
        switch (op.part) {
          case 'year': out = d.getUTCFullYear(); break;
          case 'month': out = d.getUTCMonth() + 1; break;
          case 'day': out = d.getUTCDate(); break;
          case 'dayofweek': out = d.getUTCDay(); break;
          case 'hour': out = d.getUTCHours(); break;
        }
        return { ...row, [op.into]: out };
      });
    });

    // 13. Substring ops
    substringOps.forEach(op => {
      if (!op.column || !op.into) return;
      if (!gate()) return;
      result = result.map(row => {
        const raw = row[op.column];
        if (raw === null || raw === undefined) return { ...row, [op.into]: null };
        const s = String(raw);
        const start = Math.max(0, (op.start || 1) - 1);  // 1-based → 0-based
        const end = op.length === null || op.length === undefined ? s.length : start + op.length;
        return { ...row, [op.into]: s.substring(start, end) };
      });
    });

    // 14. Numeric ops (round / floor / ceil / abs)
    numericOps.forEach(op => {
      if (!op.column || !op.into) return;
      if (!gate()) return;
      result = result.map(row => {
        const v = Number(row[op.column]);
        if (isNaN(v)) return { ...row, [op.into]: null };
        let out: number;
        switch (op.op) {
          case 'floor': out = Math.floor(v); break;
          case 'ceil': out = Math.ceil(v); break;
          case 'abs': out = Math.abs(v); break;
          case 'round':
          default: {
            const digits = Math.max(0, op.digits ?? 0);
            const factor = Math.pow(10, digits);
            out = Math.round(v * factor) / factor;
          }
        }
        return { ...row, [op.into]: out };
      });
    });

    // 15. Count Matching ops
    countMatchOps.forEach(op => {
      if (!op.column || !op.into || !op.value.trim()) return;
      if (!gate()) return;
      {
        const partKeys = op.partitionBy
          ? op.partitionBy.split(',').map(s => s.trim()).filter(Boolean)
          : [];
        // Group rows by partition; count matching within each group.
        const groups = new Map<string, number[]>();
        result.forEach((row, i) => {
          const key = partKeys.length > 0 ? partKeys.map(k => String(row[k])).join('|') : '__all__';
          const arr = groups.get(key) ?? [];
          arr.push(i);
          groups.set(key, arr);
        });
        for (const [, indices] of groups) {
          let count = 0;
          for (const idx of indices) {
            const v = result[idx][op.column];
            const s = String(v ?? '').toLowerCase();
            const fv = op.value.toLowerCase();
            switch (op.operator) {
              case 'equals': if (s === fv) count++; break;
              case 'not_equals': if (s !== fv) count++; break;
              case 'contains': if (s.includes(fv)) count++; break;
              case 'greater_than': if (Number(v) > Number(op.value)) count++; break;
              case 'less_than': if (Number(v) < Number(op.value)) count++; break;
            }
          }
          for (const idx of indices) {
            result[idx] = { ...result[idx], [op.into]: count };
          }
        }
      }
    });

    // 16. Window ops — rank / row_number / dense_rank
    windowOps.forEach(op => {
      if (!op.orderBy || !op.into) return;
      if (!gate()) return;
      const partKeys = op.partitionBy
        ? op.partitionBy.split(',').map(s => s.trim()).filter(Boolean)
        : [];
      const groups = new Map<string, number[]>();
      result.forEach((row, i) => {
        const key = partKeys.length > 0 ? partKeys.map(k => String(row[k])).join('|') : '__all__';
        const arr = groups.get(key) ?? [];
        arr.push(i);
        groups.set(key, arr);
      });
      for (const [, indices] of groups) {
        const sorted = [...indices].sort((a, b) => {
          const av = result[a][op.orderBy];
          const bv = result[b][op.orderBy];
          const cmp = av > bv ? 1 : av < bv ? -1 : 0;
          return op.orderAsc ? cmp : -cmp;
        });
        if (op.kind === 'row_number') {
          sorted.forEach((idx, r) => {
            result[idx] = { ...result[idx], [op.into]: r + 1 };
          });
        } else {
          let rank = 0;
          let denseRank = 0;
          let prevVal: any = Symbol('none');
          sorted.forEach((idx, r) => {
            const v = result[idx][op.orderBy];
            if (v !== prevVal) {
              rank = r + 1;
              denseRank++;
              prevVal = v;
            }
            result[idx] = { ...result[idx], [op.into]: op.kind === 'dense_rank' ? denseRank : rank };
          });
        }
      }
    });

    // 17. Apply string operations — one step per op
    stringOperations.forEach(op => {
      if (!gate()) return;
      result = result.map(row => {
        const newRow = { ...row };
        if (newRow[op.column] !== undefined && newRow[op.column] !== null) {
          const val = String(newRow[op.column]);
          switch (op.operation) {
            case 'upper': newRow[op.column] = val.toUpperCase(); break;
            case 'lower': newRow[op.column] = val.toLowerCase(); break;
            case 'title':
              newRow[op.column] = val.replace(/\w\S*/g, txt =>
                txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
              );
              break;
            case 'trim': newRow[op.column] = val.trim(); break;
          }
        }
        return newRow;
      });
    });

    // 18. Apply calculated columns — one step per column
    Object.entries(calculatedColumns).forEach(([colName, expression]) => {
      if (!gate()) return;
      result = result.map(row => {
        const newRow = { ...row };
        try {
          let expr = expression;
          Object.keys(row).forEach(key => {
            const value = Number(row[key]);
            if (!isNaN(value)) {
              expr = expr.replace(new RegExp(`\\b${key}\\b`, 'g'), String(value));
            }
          });
          newRow[colName] = eval(expr);
        } catch {
          newRow[colName] = null;
        }
        return newRow;
      });
    });

    // 19. Drop columns
    if (columnsToDrop.size > 0 && gate()) {
      result = result.map(row => {
        const newRow: any = {};
        Object.keys(row).forEach(key => {
          if (!columnsToDrop.has(key)) {
            newRow[key] = row[key];
          }
        });
        return newRow;
      });
    }

    // Apply column selection (do this last to respect grouped columns)
    let finalColumns = data.columns || [];
    const columnsArray = Array.from(selectedColumns);

    if (groupByColumns.length > 0 && Object.keys(aggregations).length > 0) {
      // If grouping, show group columns + aggregated columns
      finalColumns = [...groupByColumns, ...Object.keys(aggregations)];
      // Apply renames to column names
      finalColumns = finalColumns.map(col => columnRenames[col] || col);
    } else {
      // Start with all columns
      finalColumns = data.columns || [];

      // Apply renames
      finalColumns = finalColumns.map(col => columnRenames[col] || col);

      // Remove dropped columns
      finalColumns = finalColumns.filter(col => {
        // Check against original names
        const originalName = Object.keys(columnRenames).find(k => columnRenames[k] === col);
        return !columnsToDrop.has(originalName || col);
      });

      // Add calculated columns
      if (Object.keys(calculatedColumns).length > 0) {
        finalColumns = [...finalColumns, ...Object.keys(calculatedColumns)];
      }

      // Apply column selection if any
      if (columnsArray.length > 0 && columnsArray.length < (data.columns?.length || 0)) {
        const renamedSelected = columnsArray.map(col => columnRenames[col] || col);
        // Always include calculated columns even if not explicitly selected
        const calcColNames = Object.keys(calculatedColumns);
        finalColumns = finalColumns.filter(col => renamedSelected.includes(col) || calcColNames.includes(col));

        result = result.map(row => {
          const newRow: any = {};
          // Include both selected columns and calculated columns
          [...renamedSelected, ...calcColNames].forEach(col => {
            if (row.hasOwnProperty(col)) {
              newRow[col] = row[col];
            }
          });
          return newRow;
        });
      }
    }

    // Apply column ordering if specified
    if (columnOrder.length > 0) {
      // Reorder finalColumns based on columnOrder
      const orderedColumns = columnOrder.filter(col => finalColumns.includes(col));
      // Add any columns that weren't in columnOrder at the end
      const remainingColumns = finalColumns.filter(col => !columnOrder.includes(col));
      finalColumns = [...orderedColumns, ...remainingColumns];
    }

    // 21. Sample rows (before limit)
    if (sampleConfig && (sampleConfig.n || sampleConfig.fraction) && gate()) {
      const target = sampleConfig.n
        ? Math.min(sampleConfig.n, result.length)
        : Math.floor(result.length * (sampleConfig.fraction ?? 0));
      if (sampleConfig.random) {
        const arr = [...result];
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        result = arr.slice(0, target);
      } else {
        result = result.slice(0, target);
      }
    }

    // 22. Apply row limit
    if (limitRows !== null && limitRows > 0 && result.length > limitRows && gate()) {
      result = result.slice(0, limitRows);
    }

    return {
      ...data,
      data: result,
      columns: finalColumns,
      row_count: result.length,
      column_count: finalColumns.length,
    };
  }, [data, mode, previewAtStep, filters, selectedColumns, dropDuplicates, dropNA, fillNAValue, sortColumns, sortAscending, groupByColumns, aggregations, columnRenames, columnsToDrop, stringOperations, calculatedColumns, columnOrder, limitRows, replaceOps, splitOps, windowOps, countMatchOps, caseWhenOps, concatOps, dateExtractOps, substringOps, numericOps, sampleConfig]);

  const toggleColumn = (column: string) => {
    const newSelected = new Set(selectedColumns);
    if (newSelected.has(column)) {
      newSelected.delete(column);
    } else {
      newSelected.add(column);
    }
    setSelectedColumns(newSelected);
  };

  const addFilter = () => {
    if (data && data.columns && data.columns.length > 0) {
      setFilters([...filters, { column: data.columns[0], operator: 'equals', value: '' }]);
    }
  };

  const updateFilter = (index: number, updates: Partial<FilterCondition>) => {
    const newFilters = [...filters];
    newFilters[index] = { ...newFilters[index], ...updates };
    setFilters(newFilters);
  };

  const removeFilter = (index: number) => {
    setFilters(filters.filter((_, i) => i !== index));
  };

  // Column menu actions
  const handleSortByColumn = (column: string, ascending: boolean) => {
    setSortColumns([column]);
    setSortAscending(ascending);
    setOpenColumnMenu(null);
  };

  const handleFilterColumn = (column: string) => {
    addFilter();
    // Update the last filter with this column
    setTimeout(() => {
      const lastFilterIndex = filters.length;
      if (lastFilterIndex >= 0) {
        updateFilter(lastFilterIndex, { column });
      }
    }, 0);
    setOpenColumnMenu(null);
  };

  const handleGroupByColumn = (column: string) => {
    if (!groupByColumns.includes(column)) {
      setGroupByColumns([...groupByColumns, column]);
    }
    setOpenColumnMenu(null);
  };

  const handleAggregateColumn = (column: string, func: string) => {
    setAggregations({ ...aggregations, [column]: func });
    setOpenColumnMenu(null);
  };

  const handleHideColumn = (column: string) => {
    const newSelected = new Set(selectedColumns);
    if (newSelected.has(column)) {
      newSelected.delete(column);
    }
    setSelectedColumns(newSelected);
    setOpenColumnMenu(null);
  };

  const handleShowColumn = (column: string) => {
    const newSelected = new Set(selectedColumns);
    newSelected.add(column);
    setSelectedColumns(newSelected);
    setOpenColumnMenu(null);
  };

  const handleRenameColumn = (oldName: string) => {
    const newName = prompt(`Rename column "${oldName}" to:`, oldName);
    if (newName && newName !== oldName) {
      setColumnRenames({ ...columnRenames, [oldName]: newName });
    }
    setOpenColumnMenu(null);
  };

  const handleDropColumn = (column: string) => {
    const newDropped = new Set(columnsToDrop);
    newDropped.add(column);
    setColumnsToDrop(newDropped);
    setOpenColumnMenu(null);
  };

  const handleUndropColumn = (column: string) => {
    const newDropped = new Set(columnsToDrop);
    newDropped.delete(column);
    setColumnsToDrop(newDropped);
    setOpenColumnMenu(null);
  };

  const handleStringOperation = (column: string, operation: string) => {
    // Check if operation already exists for this column
    const exists = stringOperations.find(op => op.column === column && op.operation === operation);
    if (!exists) {
      setStringOperations([...stringOperations, { column, operation }]);
    }
    setOpenColumnMenu(null);
  };

  const handleAddCalculatedColumn = () => {
    if (newCalcColName && newCalcColExpr) {
      setCalculatedColumns({ ...calculatedColumns, [newCalcColName]: newCalcColExpr });
      setNewCalcColName('');
      setNewCalcColExpr('');
    }
  };

  // Column reordering handlers
  const handleMoveColumnToBeginning = (column: string) => {
    const currentOrder = columnOrder.length > 0 ? columnOrder : (data?.columns || []);
    const newOrder = [column, ...currentOrder.filter(c => c !== column)];
    setColumnOrder(newOrder);
    setOpenColumnMenu(null);
  };

  const handleMoveColumnToEnd = (column: string) => {
    const currentOrder = columnOrder.length > 0 ? columnOrder : (data?.columns || []);
    const newOrder = [...currentOrder.filter(c => c !== column), column];
    setColumnOrder(newOrder);
    setOpenColumnMenu(null);
  };

  const handleShiftColumnLeft = (column: string) => {
    const currentOrder = columnOrder.length > 0 ? columnOrder : (data?.columns || []);
    const currentIndex = currentOrder.indexOf(column);
    if (currentIndex > 0) {
      const newOrder = [...currentOrder];
      [newOrder[currentIndex - 1], newOrder[currentIndex]] = [newOrder[currentIndex], newOrder[currentIndex - 1]];
      setColumnOrder(newOrder);
    }
    setOpenColumnMenu(null);
  };

  const handleShiftColumnRight = (column: string) => {
    const currentOrder = columnOrder.length > 0 ? columnOrder : (data?.columns || []);
    const currentIndex = currentOrder.indexOf(column);
    if (currentIndex < currentOrder.length - 1 && currentIndex !== -1) {
      const newOrder = [...currentOrder];
      [newOrder[currentIndex], newOrder[currentIndex + 1]] = [newOrder[currentIndex + 1], newOrder[currentIndex]];
      setColumnOrder(newOrder);
    }
    setOpenColumnMenu(null);
  };

  const toggleSection = (sectionId: string) => {
    const newExpanded = new Set(expandedSections);
    if (newExpanded.has(sectionId)) {
      newExpanded.delete(sectionId);
    } else {
      newExpanded.add(sectionId);
    }
    setExpandedSections(newExpanded);
  };

  const handleSaveAsNewAsset = async () => {
    if (!newAssetName.trim()) {
      notify.error('Please enter a name for the new asset');
      return;
    }

    setSaving(true);
    try {
      const transformConfig: TransformConfig = {
        columnsToKeep: selectedColumns.size < (data?.columns?.length || 0) ? Array.from(selectedColumns) : null,
        columnsToDrop: columnsToDrop.size > 0 ? Array.from(columnsToDrop) : null,
        columnRenames: Object.keys(columnRenames).length > 0 ? columnRenames : null,
        filters: filters,
        dropDuplicates: dropDuplicates,
        dropNA: dropNA,
        fillNAValue: fillNAValue || null,
        sortBy: sortColumns.length > 0 ? sortColumns : null,
        sortAscending: sortAscending,
        groupBy: groupByColumns.length > 0 ? groupByColumns : null,
        aggregations: Object.keys(aggregations).length > 0 ? aggregations : null,
        stringOperations: stringOperations.length > 0 ? stringOperations : null,
        stringReplace: null, // TODO: Add UI
        calculatedColumns: Object.keys(calculatedColumns).length > 0 ? calculatedColumns : null,
        pivotConfig: pivotConfig as { index: string; columns: string; values: string; aggfunc: string } | null,
        unpivotConfig: unpivotConfig as { id_vars: string[]; value_vars: string[]; var_name: string; value_name: string } | null,
        limitRows: limitRows,
        replaceOps: replaceOps.filter((o) => o.column && o.find).length > 0
          ? replaceOps.filter((o) => o.column && o.find) : null,
        splitOps: splitOps.filter((o) => o.column && o.delimiter && o.into).length > 0
          ? splitOps.filter((o) => o.column && o.delimiter && o.into) : null,
        windowOps: windowOps.filter((o) => o.orderBy && o.into).length > 0
          ? windowOps.filter((o) => o.orderBy && o.into) : null,
        countMatchOps: countMatchOps.filter((o) => o.column && o.into && o.value).length > 0
          ? countMatchOps.filter((o) => o.column && o.into && o.value) : null,
        caseWhenOps: caseWhenOps.filter((o) => o.into && o.branches.some(b => b.column && b.value)).length > 0
          ? caseWhenOps.filter((o) => o.into && o.branches.some(b => b.column && b.value)) : null,
        concatOps: concatOps.filter((o) => o.into && o.columns).length > 0
          ? concatOps.filter((o) => o.into && o.columns) : null,
        dateExtractOps: dateExtractOps.filter((o) => o.column && o.into).length > 0
          ? dateExtractOps.filter((o) => o.column && o.into) : null,
        substringOps: substringOps.filter((o) => o.column && o.into).length > 0
          ? substringOps.filter((o) => o.column && o.into) : null,
        numericOps: numericOps.filter((o) => o.column && o.into).length > 0
          ? numericOps.filter((o) => o.column && o.into) : null,
        sampleConfig: sampleConfig && (sampleConfig.n || sampleConfig.fraction)
          ? sampleConfig : null,
      } as TransformConfig & Record<string, any>;

      // Call API to create new transformer asset
      console.log('[DataPreviewModal] Creating transformer with sourceAssetKey:', assetKey);
      console.log('[DataPreviewModal] Transform config:', transformConfig);
      const updatedProject = await assetsApi.createTransformerAsset(projectId, {
        sourceAssetKey: assetKey,
        newAssetName: newAssetName.trim(),
        transformConfig,
      });

      // Notify parent component to update project state
      if (onTransformerCreated && updatedProject) {
        onTransformerCreated(updatedProject);
      }

      notify.success(`Successfully created new asset: ${newAssetName}`);
      handleClose();
    } catch (err: any) {
      notify.error(`Failed to create asset: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    setData(null);
    setError(null);
    setMode('view');
    setSelectedColumns(new Set());
    setFilters([]);
    setNewAssetName('');
    setDropDuplicates(false);
    setDropNA(false);
    setFillNAValue('');
    setSortColumns([]);
    setSortAscending(true);
    setGroupByColumns([]);
    setAggregations({});
    setColumnRenames({});
    setColumnsToDrop(new Set());
    setStringOperations([]);
    setCalculatedColumns({});
    setNewCalcColName('');
    setNewCalcColExpr('');
    setPivotConfig(null);
    setUnpivotConfig(null);
    setExpandedSections(new Set(['columns', 'filters'])); // Reset to default expanded sections
    onClose();
  };

  const displayData = mode === 'transform' ? transformedData : data;

  // Recipe steps — flat, ordered list of every op currently configured, in
  // the order they're actually applied by the preview useMemo. Order MUST
  // match useMemo so the step counter (previewAtStep) lines up.
  const recipeSteps: RecipeStep[] = useMemo(() => {
    const steps: RecipeStep[] = [];
    // 1. filters
    filters.forEach((f, i) => {
      if (!f.column || !(f.value ?? '').trim()) return;
      const sym = { equals: '=', not_equals: '≠', contains: 'contains', not_contains: 'not contains', greater_than: '>', less_than: '<' }[f.operator] || f.operator;
      steps.push({
        id: `filter-${i}`,
        icon: 'filter',
        label: `Filter`,
        detail: `${f.column} ${sym} ${f.value}`,
        onRemove: () => setFilters((arr) => arr.filter((_, j) => j !== i)),
      });
    });
    // 2. drop duplicates
    if (dropDuplicates) {
      steps.push({ id: 'dedupe', icon: 'wand', label: 'Drop duplicates', onRemove: () => setDropDuplicates(false) });
    }
    // 3. drop NA
    if (dropNA) {
      steps.push({ id: 'dropna', icon: 'wand', label: 'Drop rows with NA', onRemove: () => setDropNA(false) });
    }
    // 4. fill NA
    if (fillNAValue) {
      steps.push({ id: 'fillna', icon: 'wand', label: 'Fill NA', detail: `with "${fillNAValue}"`, onRemove: () => setFillNAValue('') });
    }
    // 5. group by + aggregate (needs both to activate as a step)
    if (groupByColumns.length > 0 && Object.keys(aggregations).length > 0) {
      steps.push({
        id: 'group', icon: 'group', label: 'Group by',
        detail: `${groupByColumns.join(', ')} · ${Object.keys(aggregations).length} agg(s)`,
        onRemove: () => { setGroupByColumns([]); setAggregations({}); },
      });
    }
    // 6. sort
    if (sortColumns.length > 0) {
      steps.push({ id: 'sort', icon: 'sort', label: `Sort ${sortAscending ? 'ASC' : 'DESC'}`, detail: sortColumns.join(', '), onRemove: () => setSortColumns([]) });
    }
    // 7. column renames
    if (Object.keys(columnRenames).length > 0) {
      steps.push({
        id: 'rename', icon: 'cols', label: 'Rename columns',
        detail: Object.entries(columnRenames).map(([k, v]) => `${k}→${v}`).join(', '),
        onRemove: () => setColumnRenames({}),
      });
    }
    // 8. replace
    replaceOps.forEach((op, i) => {
      if (!op.column || !op.find) return;
      steps.push({ id: `replace-${i}`, icon: 'rotate', label: `Replace in ${op.column}`, detail: `"${op.find}" → "${op.replace}"`, onRemove: () => setReplaceOps((arr) => arr.filter((_, j) => j !== i)) });
    });
    // 9. split
    splitOps.forEach((op, i) => {
      if (!op.column || !op.delimiter || !op.into) return;
      steps.push({ id: `split-${i}`, icon: 'arrows', label: `Split ${op.column}`, detail: `on "${op.delimiter}" → ${op.into}`, onRemove: () => setSplitOps((arr) => arr.filter((_, j) => j !== i)) });
    });
    // 10. case-when
    caseWhenOps.forEach((op, i) => {
      if (!op.into) return;
      steps.push({ id: `case-${i}`, icon: 'filter', label: `Case-When → ${op.into}`, detail: `${op.branches.length} branch${op.branches.length === 1 ? '' : 'es'}`, onRemove: () => setCaseWhenOps((arr) => arr.filter((_, j) => j !== i)) });
    });
    // 11. concat
    concatOps.forEach((op, i) => {
      if (!op.into) return;
      steps.push({ id: `concat-${i}`, icon: 'arrows', label: `Concat → ${op.into}`, detail: op.columns.replace(/,/g, ` [${op.separator}] `), onRemove: () => setConcatOps((arr) => arr.filter((_, j) => j !== i)) });
    });
    // 12. date extract
    dateExtractOps.forEach((op, i) => {
      if (!op.column || !op.into) return;
      steps.push({ id: `date-${i}`, icon: 'calc', label: `Extract ${op.part} → ${op.into}`, detail: `from ${op.column}`, onRemove: () => setDateExtractOps((arr) => arr.filter((_, j) => j !== i)) });
    });
    // 13. substring
    substringOps.forEach((op, i) => {
      if (!op.column || !op.into) return;
      const lenPart = op.length === null || op.length === undefined ? 'to end' : `for ${op.length}`;
      steps.push({ id: `substr-${i}`, icon: 'wand', label: `Substring → ${op.into}`, detail: `from ${op.column} @ ${op.start} ${lenPart}`, onRemove: () => setSubstringOps((arr) => arr.filter((_, j) => j !== i)) });
    });
    // 14. numeric ops
    numericOps.forEach((op, i) => {
      if (!op.column || !op.into) return;
      const label = { round: 'Round', floor: 'Floor', ceil: 'Ceil', abs: 'Abs' }[op.op] || op.op;
      const detail = op.op === 'round' ? `${op.column} @ ${op.digits}dp` : op.column;
      steps.push({ id: `num-${i}`, icon: 'calc', label: `${label} → ${op.into}`, detail, onRemove: () => setNumericOps((arr) => arr.filter((_, j) => j !== i)) });
    });
    // 15. count matching
    countMatchOps.forEach((op, i) => {
      if (!op.into) return;
      steps.push({ id: `count-${i}`, icon: 'sigma', label: `Count matching → ${op.into}`, detail: `where ${op.column} ${op.operator} ${op.value}${op.partitionBy ? ` per (${op.partitionBy})` : ''}`, onRemove: () => setCountMatchOps((arr) => arr.filter((_, j) => j !== i)) });
    });
    // 16. window
    windowOps.forEach((op, i) => {
      if (!op.orderBy || !op.into) return;
      const kindLabel = { rank: 'Rank', dense_rank: 'Dense rank', row_number: 'Row number' }[op.kind] || op.kind;
      steps.push({ id: `window-${i}`, icon: 'rank', label: `${kindLabel} → ${op.into}`, detail: `by ${op.orderBy} ${op.orderAsc ? 'ASC' : 'DESC'}${op.partitionBy ? ` per (${op.partitionBy})` : ''}`, onRemove: () => setWindowOps((arr) => arr.filter((_, j) => j !== i)) });
    });
    // 17. string ops
    stringOperations.forEach((op, i) => {
      steps.push({ id: `strop-${i}`, icon: 'wand', label: `${op.operation} ${op.column}`, onRemove: () => setStringOperations((arr) => arr.filter((_, j) => j !== i)) });
    });
    // 18. calculated columns
    Object.entries(calculatedColumns).forEach(([name, expr]) => {
      steps.push({
        id: `calc-${name}`, icon: 'calc', label: `Calc → ${name}`, detail: expr,
        onRemove: () => setCalculatedColumns((prev) => { const next = { ...prev }; delete next[name]; return next; }),
      });
    });
    // 19. drop columns
    if (columnsToDrop.size > 0) {
      steps.push({ id: 'dropcols', icon: 'cols', label: 'Drop columns', detail: Array.from(columnsToDrop).join(', '), onRemove: () => setColumnsToDrop(new Set()) });
    }
    // 20. pivot / unpivot
    if (pivotConfig) {
      steps.push({ id: 'pivot', icon: 'arrows', label: 'Pivot', onRemove: () => setPivotConfig(null) });
    }
    if (unpivotConfig) {
      steps.push({ id: 'unpivot', icon: 'arrows', label: 'Unpivot', onRemove: () => setUnpivotConfig(null) });
    }
    // 21. sample
    if (sampleConfig && (sampleConfig.n || sampleConfig.fraction)) {
      steps.push({
        id: 'sample', icon: 'wand', label: 'Sample',
        detail: sampleConfig.n ? `${sampleConfig.n} rows` : `${(sampleConfig.fraction ?? 0) * 100}%`,
        onRemove: () => setSampleConfig(null),
      });
    }
    // 22. limit
    if (limitRows !== null && limitRows > 0) {
      steps.push({ id: 'limit', icon: 'play', label: 'Limit', detail: `${limitRows} rows`, onRemove: () => setLimitRows(null) });
    }
    return steps;
  }, [filters, dropDuplicates, dropNA, fillNAValue, groupByColumns, aggregations, sortColumns, sortAscending, columnRenames, replaceOps, splitOps, caseWhenOps, concatOps, dateExtractOps, substringOps, numericOps, countMatchOps, windowOps, stringOperations, calculatedColumns, columnsToDrop, pivotConfig, unpivotConfig, sampleConfig, limitRows]);

  return (
    <Dialog.Root open={isOpen} onOpenChange={handleClose}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-xl z-50 w-[95vw] h-[90vh] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
            <div className="flex items-center space-x-3">
              <TableIcon className="w-5 h-5 text-blue-600" />
              <div>
                <Dialog.Title className="text-lg font-semibold text-gray-900">
                  {mode === 'view' ? 'Data Preview' : 'Transform Data'}: {assetName}
                </Dialog.Title>
                {displayData && displayData.success && (
                  <div className="text-sm text-gray-500 mt-1">
                    {displayData.row_count?.toLocaleString()} rows × {displayData.column_count} columns
                    {displayData.sample_limit && data?.row_count && data.row_count > displayData.sample_limit && (
                      <span className="ml-2 text-amber-600">
                        (showing first {displayData.sample_limit.toLocaleString()} rows)
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center space-x-2">
              {/* Mode Toggle */}
              <div className="flex items-center space-x-1 bg-gray-100 p-1 rounded-lg">
                <button
                  onClick={() => setMode('view')}
                  className={`px-3 py-1.5 text-sm font-medium rounded transition-colors ${
                    mode === 'view'
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  <Eye className="w-4 h-4 inline mr-1.5" />
                  View
                </button>
                {hasTransformerComponent && (
                  <button
                    onClick={() => setMode('transform')}
                    className={`px-3 py-1.5 text-sm font-medium rounded transition-colors ${
                      mode === 'transform'
                        ? 'bg-white text-gray-900 shadow-sm'
                        : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    <Wand2 className="w-4 h-4 inline mr-1.5" />
                    Transform
                  </button>
                )}
              </div>

              <Dialog.Close asChild>
                <button
                  className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                  aria-label="Close"
                >
                  <X className="w-5 h-5 text-gray-500" />
                </button>
              </Dialog.Close>
            </div>
          </div>

          <div className="flex-1 flex overflow-hidden">
            {/* Transform Controls Sidebar */}
            {mode === 'transform' && (
              <div className="w-80 border-r border-gray-200 overflow-y-auto p-4 bg-gray-50 flex flex-col">
                {/* Escape hatch to the community catalog: 124+ transformation
                    components that go beyond the built-in visual ops. Installs
                    via CLI, chains onto this asset. User configures the new
                    node's specific attributes from the graph. */}
                <button
                  onClick={() => setShowCommunityPicker(true)}
                  className="mb-3 w-full flex items-center gap-2 px-3 py-2 border border-dashed border-primary/30 bg-primary/5 hover:bg-primary/10 rounded-lg text-left group"
                >
                  <Package className="w-4 h-4 text-primary flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-primary">
                      Community transform
                    </div>
                    <div className="text-[11px] text-gray-500">
                      Pick from 124+ community components
                    </div>
                  </div>
                  <Plus className="w-4 h-4 text-primary/60 group-hover:text-primary flex-shrink-0" />
                </button>

                <div className="space-y-2 flex-1">
                  {/* Accordion Section: Column Selection */}
                  <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
                    <button
                      onClick={() => toggleSection('columns')}
                      className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center space-x-2">
                        <Columns3 className="w-4 h-4 text-blue-600" />
                        <span className="text-sm font-semibold text-gray-900">Columns</span>
                        <span className="text-xs text-gray-500">
                          {selectedColumns.size} of {data?.columns?.length || 0}
                        </span>
                      </div>
                      {expandedSections.has('columns') ? (
                        <ChevronDown className="w-4 h-4 text-gray-500" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-gray-500" />
                      )}
                    </button>
                    {expandedSections.has('columns') && (
                      <div className="px-4 pb-3 border-t border-gray-100">
                        <div className="space-y-2 max-h-60 overflow-y-auto mt-3">
                          {data?.columns?.map((col) => (
                            <label key={col} className="flex items-center space-x-2 cursor-pointer hover:bg-gray-50 p-1.5 rounded">
                              <input
                                type="checkbox"
                                checked={selectedColumns.has(col)}
                                onChange={() => toggleColumn(col)}
                                className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                              />
                              <span className="text-sm text-gray-700 flex-1">{col}</span>
                              {data.dtypes?.[col] && (
                                <span className="text-xs text-gray-500">{data.dtypes[col]}</span>
                              )}
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Accordion Section: Filters */}
                  <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
                    <button
                      onClick={() => toggleSection('filters')}
                      className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center space-x-2">
                        <Filter className="w-4 h-4 text-blue-600" />
                        <span className="text-sm font-semibold text-gray-900">Filters</span>
                        {filters.length > 0 && (
                          <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                            {filters.length}
                          </span>
                        )}
                      </div>
                      {expandedSections.has('filters') ? (
                        <ChevronDown className="w-4 h-4 text-gray-500" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-gray-500" />
                      )}
                    </button>
                    {expandedSections.has('filters') && (
                      <div className="px-4 pb-3 border-t border-gray-100">
                        <button
                          onClick={addFilter}
                          className="w-full mt-3 mb-3 text-xs text-blue-600 hover:text-blue-700 font-medium px-3 py-2 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors"
                        >
                          + Add Filter
                        </button>
                        {hasFilterExpression && (
                          <div className="mb-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                            <div className="flex items-start space-x-2">
                              <AlertCircle className="w-4 h-4 text-yellow-600 mt-0.5 flex-shrink-0" />
                              <div className="flex-1">
                                <p className="text-xs font-semibold text-yellow-900 mb-1">
                                  Existing Filter Expression Detected
                                </p>
                                <p className="text-xs text-yellow-800 mb-2">
                                  This component has a filter expression that cannot be edited in the visual editor:
                                </p>
                                <code className="block text-xs bg-yellow-100 text-yellow-900 px-2 py-1 rounded border border-yellow-300 mb-2 font-mono">
                                  {filterExpressionValue}
                                </code>
                                <p className="text-xs text-yellow-800">
                                  To modify this filter, edit it in the component config modal. Any new filters created here will be separate.
                                </p>
                              </div>
                            </div>
                          </div>
                        )}
                        <div className="space-y-3">
                          {filters.map((filter, idx) => (
                            <div key={idx} className="border border-gray-200 rounded-lg p-3 bg-gray-50 space-y-2">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-medium text-gray-700">Filter {idx + 1}</span>
                                <button
                                  onClick={() => removeFilter(idx)}
                                  className="text-red-600 hover:text-red-700"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                              <select
                                value={filter.column}
                                onChange={(e) => updateFilter(idx, { column: e.target.value })}
                                className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 bg-white"
                              >
                                {data?.columns?.map((col) => (
                                  <option key={col} value={col}>{col}</option>
                                ))}
                              </select>
                              <select
                                value={filter.operator}
                                onChange={(e) => updateFilter(idx, { operator: e.target.value as any })}
                                className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 bg-white"
                              >
                                <option value="equals">Equals</option>
                                <option value="not_equals">Not Equals</option>
                                <option value="contains">Contains</option>
                                <option value="not_contains">Does Not Contain</option>
                                <option value="greater_than">Greater Than</option>
                                <option value="less_than">Less Than</option>
                              </select>
                              <input
                                type="text"
                                value={filter.value}
                                onChange={(e) => updateFilter(idx, { value: e.target.value })}
                                placeholder="Filter value..."
                                className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 bg-white"
                              />
                            </div>
                          ))}
                          {filters.length === 0 && (
                            <p className="text-xs text-gray-500 italic text-center py-2">No filters applied</p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Accordion Section: Row Operations */}
                  <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
                    <button
                      onClick={() => toggleSection('rows')}
                      className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center space-x-2">
                        <RotateCw className="w-4 h-4 text-blue-600" />
                        <span className="text-sm font-semibold text-gray-900">Row Operations</span>
                      </div>
                      {expandedSections.has('rows') ? (
                        <ChevronDown className="w-4 h-4 text-gray-500" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-gray-500" />
                      )}
                    </button>
                    {expandedSections.has('rows') && (
                      <div className="px-4 pb-3 border-t border-gray-100">
                        <div className="space-y-2 mt-3">
                          <label className="flex items-center space-x-2 cursor-pointer hover:bg-gray-50 p-1.5 rounded">
                            <input
                              type="checkbox"
                              checked={dropDuplicates}
                              onChange={(e) => setDropDuplicates(e.target.checked)}
                              className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                            />
                            <span className="text-sm text-gray-700">Drop Duplicates</span>
                          </label>
                          <label className="flex items-center space-x-2 cursor-pointer hover:bg-gray-50 p-1.5 rounded">
                            <input
                              type="checkbox"
                              checked={dropNA}
                              onChange={(e) => setDropNA(e.target.checked)}
                              className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                            />
                            <span className="text-sm text-gray-700">Drop Rows with NA</span>
                          </label>
                          <div className="pt-2">
                            <label className="text-xs text-gray-600 mb-1 block">Fill NA with value:</label>
                            <input
                              type="text"
                              value={fillNAValue}
                              onChange={(e) => setFillNAValue(e.target.value)}
                              placeholder="e.g., 0 or N/A"
                              className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
                            />
                          </div>
                          <div className="pt-2">
                            <label className="text-xs text-gray-600 mb-1 block">Limit rows (top N):</label>
                            <input
                              type="number"
                              min={1}
                              value={limitRows ?? ''}
                              onChange={(e) => {
                                const raw = e.target.value.trim();
                                setLimitRows(raw === '' ? null : Math.max(1, parseInt(raw, 10) || 1));
                              }}
                              placeholder="e.g., 100 (leave blank for all)"
                              className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
                            />
                            <p className="text-[11px] text-gray-500 mt-1">
                              Applies after sort/filter; SQL mode compiles to LIMIT N.
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Accordion Section: Sorting */}
                  <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
                    <button
                      onClick={() => toggleSection('sorting')}
                      className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center space-x-2">
                        <ArrowDownUp className="w-4 h-4 text-blue-600" />
                        <span className="text-sm font-semibold text-gray-900">Sorting</span>
                        {sortColumns.length > 0 && (
                          <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                            {sortColumns.length}
                          </span>
                        )}
                      </div>
                      {expandedSections.has('sorting') ? (
                        <ChevronDown className="w-4 h-4 text-gray-500" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-gray-500" />
                      )}
                    </button>
                    {expandedSections.has('sorting') && (
                      <div className="px-4 pb-3 border-t border-gray-100">
                        <div className="space-y-2 mt-3">
                          <label className="text-xs text-gray-600 mb-1 block">Sort by columns:</label>
                          <select
                            multiple
                            value={sortColumns}
                            onChange={(e) => setSortColumns(Array.from(e.target.selectedOptions, option => option.value))}
                            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 h-24"
                          >
                            {data?.columns?.map((col) => (
                              <option key={col} value={col}>{col}</option>
                            ))}
                          </select>
                          <label className="flex items-center space-x-2 cursor-pointer hover:bg-gray-50 p-1.5 rounded">
                            <input
                              type="checkbox"
                              checked={sortAscending}
                              onChange={(e) => setSortAscending(e.target.checked)}
                              className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                            />
                            <span className="text-sm text-gray-700">Ascending</span>
                          </label>
                          <p className="text-xs text-gray-500 italic">Hold Ctrl/Cmd to select multiple</p>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Accordion Section: Group & Aggregate */}
                  <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
                    <button
                      onClick={() => toggleSection('aggregate')}
                      className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center space-x-2">
                        <Sigma className="w-4 h-4 text-blue-600" />
                        <span className="text-sm font-semibold text-gray-900">Group & Aggregate</span>
                      </div>
                      {expandedSections.has('aggregate') ? (
                        <ChevronDown className="w-4 h-4 text-gray-500" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-gray-500" />
                      )}
                    </button>
                    {expandedSections.has('aggregate') && (
                      <div className="px-4 pb-3 border-t border-gray-100">
                        <div className="space-y-3 mt-3">
                          <div>
                            <label className="text-xs text-gray-600 mb-1 block">Group by columns:</label>
                            <select
                              multiple
                              value={groupByColumns}
                              onChange={(e) => setGroupByColumns(Array.from(e.target.selectedOptions, option => option.value))}
                              className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 h-20"
                            >
                              {data?.columns?.map((col) => (
                                <option key={col} value={col}>{col}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="text-xs text-gray-600 mb-1 block">Aggregations:</label>
                            <div className="space-y-2">
                              {/* Aggregation Builder */}
                              <div className="flex gap-2">
                                <select
                                  id="agg-column-select"
                                  className="flex-1 text-xs border border-gray-300 rounded px-2 py-1.5"
                                  defaultValue=""
                                >
                                  <option value="" disabled>Select column...</option>
                                  {data?.columns?.filter(col => !groupByColumns.includes(col)).map((col) => (
                                    <option key={col} value={col}>{col}</option>
                                  ))}
                                </select>
                                <select
                                  id="agg-function-select"
                                  className="w-24 text-xs border border-gray-300 rounded px-2 py-1.5"
                                  defaultValue=""
                                >
                                  <option value="" disabled>Function...</option>
                                  <option value="sum">sum</option>
                                  <option value="count">count</option>
                                  <option value="mean">mean</option>
                                  <option value="min">min</option>
                                  <option value="max">max</option>
                                  <option value="first">first</option>
                                  <option value="last">last</option>
                                </select>
                                <button
                                  onClick={() => {
                                    const colSelect = document.getElementById('agg-column-select') as HTMLSelectElement;
                                    const funcSelect = document.getElementById('agg-function-select') as HTMLSelectElement;
                                    if (colSelect.value && funcSelect.value) {
                                      setAggregations({
                                        ...aggregations,
                                        [colSelect.value]: funcSelect.value
                                      });
                                      colSelect.value = '';
                                      funcSelect.value = '';
                                    }
                                  }}
                                  className="px-2 py-1 text-xs font-medium text-white bg-blue-600 rounded hover:bg-blue-700 transition-colors"
                                >
                                  Add
                                </button>
                              </div>

                              {/* Current Aggregations */}
                              {Object.keys(aggregations).length > 0 && (
                                <div className="border border-gray-200 rounded mt-2">
                                  <table className="w-full text-xs">
                                    <thead className="bg-gray-50 border-b border-gray-200">
                                      <tr>
                                        <th className="px-2 py-1.5 text-left font-medium text-gray-700">Column</th>
                                        <th className="px-2 py-1.5 text-left font-medium text-gray-700">Function</th>
                                        <th className="px-2 py-1.5 w-8"></th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {Object.entries(aggregations).map(([col, func]) => (
                                        <tr key={col} className="border-b border-gray-100 last:border-0">
                                          <td className="px-2 py-1.5 text-gray-900">{col}</td>
                                          <td className="px-2 py-1.5">
                                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
                                              {func}
                                            </span>
                                          </td>
                                          <td className="px-2 py-1.5 text-right">
                                            <button
                                              onClick={() => {
                                                const newAggs = { ...aggregations };
                                                delete newAggs[col];
                                                setAggregations(newAggs);
                                              }}
                                              className="text-red-600 hover:text-red-800"
                                              title="Remove"
                                            >
                                              <X className="w-3 h-3" />
                                            </button>
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                              <p className="text-xs text-gray-500 mt-1">
                                Select a column and aggregation function to add
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Accordion Section: Calculated Columns */}
                  <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
                    <button
                      onClick={() => toggleSection('calculated')}
                      className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center space-x-2">
                        <Calculator className="w-4 h-4 text-blue-600" />
                        <span className="text-sm font-semibold text-gray-900">Calculated Columns</span>
                        {Object.keys(calculatedColumns).length > 0 && (
                          <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                            {Object.keys(calculatedColumns).length}
                          </span>
                        )}
                      </div>
                      {expandedSections.has('calculated') ? (
                        <ChevronDown className="w-4 h-4 text-gray-500" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-gray-500" />
                      )}
                    </button>
                    {expandedSections.has('calculated') && (
                      <div className="px-4 pb-3 border-t border-gray-100">
                        <div className="space-y-3 mt-3">
                          <div>
                            <label className="text-xs text-gray-600 mb-1 block">New Column Name:</label>
                            <input
                              type="text"
                              value={newCalcColName}
                              onChange={(e) => setNewCalcColName(e.target.value)}
                              placeholder="e.g., total_price"
                              className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
                            />
                          </div>
                          <div>
                            <label className="text-xs text-gray-600 mb-1 block">Expression (pandas eval):</label>
                            <input
                              type="text"
                              value={newCalcColExpr}
                              onChange={(e) => setNewCalcColExpr(e.target.value)}
                              placeholder="e.g., price * quantity"
                              className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 font-mono"
                            />
                            <p className="text-xs text-gray-500 mt-1">
                              Use column names and operators: +, -, *, /, **
                            </p>
                          </div>
                          <button
                            onClick={handleAddCalculatedColumn}
                            disabled={!newCalcColName.trim() || !newCalcColExpr.trim()}
                            className="w-full px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          >
                            Add Calculated Column
                          </button>
                          {Object.keys(calculatedColumns).length > 0 && (
                            <div className="border-t border-gray-200 pt-2 mt-2">
                              <p className="text-xs text-gray-600 mb-2">Current:</p>
                              <div className="space-y-1">
                                {Object.entries(calculatedColumns).map(([colName, expr]) => (
                                  <div key={colName} className="flex items-center justify-between text-xs bg-gray-50 rounded px-2 py-1.5">
                                    <div className="flex-1 min-w-0 truncate">
                                      <span className="font-medium text-gray-900">{colName}</span>
                                      <span className="text-gray-500 mx-1">=</span>
                                      <span className="text-gray-700 font-mono">{expr}</span>
                                    </div>
                                    <button
                                      onClick={() => {
                                        const newCalcs = { ...calculatedColumns };
                                        delete newCalcs[colName];
                                        setCalculatedColumns(newCalcs);
                                      }}
                                      className="ml-2 text-red-600 hover:text-red-800 flex-shrink-0"
                                      title="Remove"
                                    >
                                      <X className="w-3 h-3" />
                                    </button>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Accordion Section: Replace */}
                  <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
                    <button
                      onClick={() => toggleSection('replace')}
                      className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center space-x-2">
                        <RotateCw className="w-4 h-4 text-blue-600" />
                        <span className="text-sm font-semibold text-gray-900">Replace</span>
                        {replaceOps.length > 0 && <span className="text-xs text-gray-500">{replaceOps.length}</span>}
                      </div>
                      {expandedSections.has('replace') ? (
                        <ChevronDown className="w-4 h-4 text-gray-500" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-gray-500" />
                      )}
                    </button>
                    {expandedSections.has('replace') && (
                      <div className="px-4 pb-3 border-t border-gray-100">
                        <div className="space-y-2 mt-3">
                          {replaceOps.map((op, i) => (
                            <div key={i} className="bg-gray-50 border border-gray-200 rounded p-2 space-y-1.5">
                              <div className="flex items-center justify-between">
                                <select
                                  value={op.column}
                                  onChange={(e) => setReplaceOps(ops => ops.map((o, j) => j === i ? { ...o, column: e.target.value } : o))}
                                  className="text-xs border border-gray-300 rounded px-1.5 py-1 flex-1 mr-1"
                                >
                                  <option value="">Column…</option>
                                  {data?.columns?.map(c => <option key={c} value={c}>{c}</option>)}
                                </select>
                                <button
                                  onClick={() => setReplaceOps(ops => ops.filter((_, j) => j !== i))}
                                  className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded flex-shrink-0"
                                  title="Remove replace"
                                  aria-label="Remove replace"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                              <input
                                type="text"
                                value={op.find}
                                onChange={(e) => setReplaceOps(ops => ops.map((o, j) => j === i ? { ...o, find: e.target.value } : o))}
                                placeholder="find (literal or /regex/g)"
                                className="w-full text-xs border border-gray-300 rounded px-1.5 py-1"
                              />
                              <input
                                type="text"
                                value={op.replace}
                                onChange={(e) => setReplaceOps(ops => ops.map((o, j) => j === i ? { ...o, replace: e.target.value } : o))}
                                placeholder="replace with"
                                className="w-full text-xs border border-gray-300 rounded px-1.5 py-1"
                              />
                            </div>
                          ))}
                          <button
                            onClick={() => setReplaceOps(ops => [...ops, { column: data?.columns?.[0] || '', find: '', replace: '' }])}
                            className="text-xs text-primary hover:underline flex items-center gap-1"
                          >
                            <Plus className="w-3 h-3" /> Add replace
                          </button>
                          <p className="text-[10px] text-gray-500">
                            Literal text by default; wrap in <code className="font-mono bg-gray-100 px-1 rounded">/regex/flags</code> for regex.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Accordion Section: Split */}
                  <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
                    <button
                      onClick={() => toggleSection('split')}
                      className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center space-x-2">
                        <ArrowDownUp className="w-4 h-4 text-blue-600" />
                        <span className="text-sm font-semibold text-gray-900">Split Column</span>
                        {splitOps.length > 0 && <span className="text-xs text-gray-500">{splitOps.length}</span>}
                      </div>
                      {expandedSections.has('split') ? (
                        <ChevronDown className="w-4 h-4 text-gray-500" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-gray-500" />
                      )}
                    </button>
                    {expandedSections.has('split') && (
                      <div className="px-4 pb-3 border-t border-gray-100">
                        <div className="space-y-2 mt-3">
                          {splitOps.map((op, i) => (
                            <div key={i} className="space-y-1 bg-gray-50 border border-gray-200 rounded p-2">
                              <div className="grid grid-cols-[1fr_1fr_auto] gap-1">
                                <select
                                  value={op.column}
                                  onChange={(e) => setSplitOps(ops => ops.map((o, j) => j === i ? { ...o, column: e.target.value } : o))}
                                  className="text-xs border border-gray-300 rounded px-1.5 py-1"
                                >
                                  <option value="">Column…</option>
                                  {data?.columns?.map(c => <option key={c} value={c}>{c}</option>)}
                                </select>
                                <input
                                  type="text"
                                  value={op.delimiter}
                                  onChange={(e) => setSplitOps(ops => ops.map((o, j) => j === i ? { ...o, delimiter: e.target.value } : o))}
                                  placeholder="delimiter (e.g. , or |)"
                                  className="text-xs border border-gray-300 rounded px-1.5 py-1"
                                />
                                <button
                                  onClick={() => setSplitOps(ops => ops.filter((_, j) => j !== i))}
                                  className="text-gray-400 hover:text-red-600"
                                  title="Remove"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                              <div>
                                <label className="text-[10px] text-gray-500 block mb-1">Into columns (order matters)</label>
                                <MultiColumnSelect
                                  columns={data?.columns || []}
                                  value={op.into ? op.into.split(',').map(s => s.trim()).filter(Boolean) : []}
                                  onChange={(cols) =>
                                    setSplitOps(ops => ops.map((o, j) => j === i ? { ...o, into: cols.join(',') } : o))
                                  }
                                  placeholder="pick existing or type new names…"
                                  allowFreeText
                                />
                              </div>
                            </div>
                          ))}
                          <button
                            onClick={() => setSplitOps(ops => [...ops, { column: data?.columns?.[0] || '', delimiter: ',', into: '' }])}
                            className="text-xs text-primary hover:underline flex items-center gap-1"
                          >
                            <Plus className="w-3 h-3" /> Add split
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Accordion Section: Window / Ranking */}
                  <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
                    <button
                      onClick={() => toggleSection('window')}
                      className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center space-x-2">
                        <SortAsc className="w-4 h-4 text-blue-600" />
                        <span className="text-sm font-semibold text-gray-900">Rank & Row Number</span>
                        {windowOps.length > 0 && <span className="text-xs text-gray-500">{windowOps.length}</span>}
                      </div>
                      {expandedSections.has('window') ? (
                        <ChevronDown className="w-4 h-4 text-gray-500" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-gray-500" />
                      )}
                    </button>
                    {expandedSections.has('window') && (
                      <div className="px-4 pb-3 border-t border-gray-100">
                        <div className="space-y-2 mt-3">
                          {windowOps.map((op, i) => (
                            <div key={i} className="space-y-1 bg-gray-50 border border-gray-200 rounded p-2">
                              <div className="grid grid-cols-[1fr_1fr_auto] gap-1">
                                <select
                                  value={op.kind}
                                  onChange={(e) => setWindowOps(ops => ops.map((o, j) => j === i ? { ...o, kind: e.target.value as any } : o))}
                                  className="text-xs border border-gray-300 rounded px-1.5 py-1"
                                >
                                  <option value="rank">RANK()</option>
                                  <option value="dense_rank">DENSE_RANK()</option>
                                  <option value="row_number">ROW_NUMBER()</option>
                                </select>
                                <input
                                  type="text"
                                  value={op.into}
                                  onChange={(e) => setWindowOps(ops => ops.map((o, j) => j === i ? { ...o, into: e.target.value } : o))}
                                  placeholder="new column name"
                                  className="text-xs border border-gray-300 rounded px-1.5 py-1"
                                />
                                <button
                                  onClick={() => setWindowOps(ops => ops.filter((_, j) => j !== i))}
                                  className="text-gray-400 hover:text-red-600"
                                  title="Remove"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                              <div className="grid grid-cols-[auto_1fr_auto] gap-1 items-center">
                                <span className="text-[10px] text-gray-500">ORDER BY</span>
                                <select
                                  value={op.orderBy}
                                  onChange={(e) => setWindowOps(ops => ops.map((o, j) => j === i ? { ...o, orderBy: e.target.value } : o))}
                                  className="text-xs border border-gray-300 rounded px-1.5 py-1"
                                >
                                  <option value="">Column…</option>
                                  {data?.columns?.map(c => <option key={c} value={c}>{c}</option>)}
                                </select>
                                <button
                                  onClick={() => setWindowOps(ops => ops.map((o, j) => j === i ? { ...o, orderAsc: !o.orderAsc } : o))}
                                  className="text-[10px] px-1.5 py-1 border border-gray-300 rounded hover:bg-gray-100"
                                  title="Toggle sort direction"
                                >
                                  {op.orderAsc ? 'ASC' : 'DESC'}
                                </button>
                              </div>
                              <div className="grid grid-cols-[auto_1fr] gap-1 items-start">
                                <span className="text-[10px] text-gray-500 pt-1.5">PARTITION BY</span>
                                <MultiColumnSelect
                                  columns={data?.columns || []}
                                  value={op.partitionBy ? op.partitionBy.split(',').map(s => s.trim()).filter(Boolean) : []}
                                  onChange={(cols) =>
                                    setWindowOps(ops => ops.map((o, j) => j === i ? { ...o, partitionBy: cols.join(',') } : o))
                                  }
                                  placeholder="(optional) partition columns…"
                                />
                              </div>
                            </div>
                          ))}
                          <button
                            onClick={() => setWindowOps(ops => [...ops, {
                              kind: 'rank' as const,
                              orderBy: data?.columns?.[0] || '',
                              partitionBy: '',
                              orderAsc: true,
                              into: `rank_${ops.length + 1}`,
                            }])}
                            className="text-xs text-primary hover:underline flex items-center gap-1"
                          >
                            <Plus className="w-3 h-3" /> Add ranking
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Accordion Section: Count Matching */}
                  <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
                    <button
                      onClick={() => toggleSection('countMatch')}
                      className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center space-x-2">
                        <Sigma className="w-4 h-4 text-blue-600" />
                        <span className="text-sm font-semibold text-gray-900">Count Matching</span>
                        {countMatchOps.length > 0 && <span className="text-xs text-gray-500">{countMatchOps.length}</span>}
                      </div>
                      {expandedSections.has('countMatch') ? (
                        <ChevronDown className="w-4 h-4 text-gray-500" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-gray-500" />
                      )}
                    </button>
                    {expandedSections.has('countMatch') && (
                      <div className="px-4 pb-3 border-t border-gray-100">
                        <div className="space-y-2 mt-3">
                          {countMatchOps.map((op, i) => (
                            <div key={i} className="bg-gray-50 border border-gray-200 rounded p-2 space-y-1.5">
                              <div className="flex items-center justify-between">
                                <input
                                  type="text"
                                  value={op.into}
                                  onChange={(e) => setCountMatchOps(ops => ops.map((o, j) => j === i ? { ...o, into: e.target.value } : o))}
                                  placeholder="new column name"
                                  className="text-xs border border-gray-300 rounded px-1.5 py-1 flex-1 mr-1"
                                />
                                <button
                                  onClick={() => setCountMatchOps(ops => ops.filter((_, j) => j !== i))}
                                  className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded flex-shrink-0"
                                  title="Remove"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                              <div className="text-[10px] text-gray-500">
                                Count rows where
                              </div>
                              <div className="grid grid-cols-[1fr_auto_1fr] gap-1">
                                <select
                                  value={op.column}
                                  onChange={(e) => setCountMatchOps(ops => ops.map((o, j) => j === i ? { ...o, column: e.target.value } : o))}
                                  className="text-xs border border-gray-300 rounded px-1.5 py-1"
                                >
                                  <option value="">Column…</option>
                                  {data?.columns?.map(c => <option key={c} value={c}>{c}</option>)}
                                </select>
                                <select
                                  value={op.operator}
                                  onChange={(e) => setCountMatchOps(ops => ops.map((o, j) => j === i ? { ...o, operator: e.target.value as any } : o))}
                                  className="text-xs border border-gray-300 rounded px-1.5 py-1"
                                >
                                  <option value="equals">=</option>
                                  <option value="not_equals">≠</option>
                                  <option value="greater_than">&gt;</option>
                                  <option value="less_than">&lt;</option>
                                  <option value="contains">contains</option>
                                </select>
                                <input
                                  type="text"
                                  value={op.value}
                                  onChange={(e) => setCountMatchOps(ops => ops.map((o, j) => j === i ? { ...o, value: e.target.value } : o))}
                                  placeholder="value"
                                  className="text-xs border border-gray-300 rounded px-1.5 py-1"
                                />
                              </div>
                              <div>
                                <label className="text-[10px] text-gray-500 block mb-0.5">PARTITION BY (optional)</label>
                                <MultiColumnSelect
                                  columns={data?.columns || []}
                                  value={op.partitionBy ? op.partitionBy.split(',').map(s => s.trim()).filter(Boolean) : []}
                                  onChange={(cols) =>
                                    setCountMatchOps(ops => ops.map((o, j) => j === i ? { ...o, partitionBy: cols.join(',') } : o))
                                  }
                                  placeholder="count globally, or per group…"
                                />
                              </div>
                            </div>
                          ))}
                          <button
                            onClick={() => setCountMatchOps(ops => [...ops, {
                              column: data?.columns?.[0] || '',
                              operator: 'equals',
                              value: '',
                              into: `count_${ops.length + 1}`,
                              partitionBy: '',
                            }])}
                            className="text-xs text-primary hover:underline flex items-center gap-1"
                          >
                            <Plus className="w-3 h-3" /> Add count-matching
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Accordion Section: Case-When */}
                  <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
                    <button
                      onClick={() => toggleSection('caseWhen')}
                      className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center space-x-2">
                        <Filter className="w-4 h-4 text-blue-600" />
                        <span className="text-sm font-semibold text-gray-900">Case-When</span>
                        {caseWhenOps.length > 0 && <span className="text-xs text-gray-500">{caseWhenOps.length}</span>}
                      </div>
                      {expandedSections.has('caseWhen') ? (
                        <ChevronDown className="w-4 h-4 text-gray-500" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-gray-500" />
                      )}
                    </button>
                    {expandedSections.has('caseWhen') && (
                      <div className="px-4 pb-3 border-t border-gray-100">
                        <div className="space-y-2 mt-3">
                          {caseWhenOps.map((op, i) => (
                            <div key={i} className="bg-gray-50 border border-gray-200 rounded p-2 space-y-1.5">
                              <div className="flex items-center justify-between">
                                <input
                                  type="text"
                                  value={op.into}
                                  onChange={(e) => setCaseWhenOps(ops => ops.map((o, j) => j === i ? { ...o, into: e.target.value } : o))}
                                  placeholder="new column name"
                                  className="text-xs border border-gray-300 rounded px-1.5 py-1 flex-1 mr-1"
                                />
                                <button
                                  onClick={() => setCaseWhenOps(ops => ops.filter((_, j) => j !== i))}
                                  className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded flex-shrink-0"
                                  title="Remove"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                              {op.branches.map((b, bi) => (
                                <div key={bi} className="bg-white border border-gray-200 rounded p-1.5 space-y-1">
                                  <div className="flex items-center justify-between">
                                    <span className="text-[10px] text-gray-500">WHEN</span>
                                    <button
                                      onClick={() => setCaseWhenOps(ops => ops.map((o, j) => j === i ? { ...o, branches: o.branches.filter((_, k) => k !== bi) } : o))}
                                      className="text-gray-300 hover:text-red-600"
                                      title="Remove branch"
                                    >
                                      <X className="w-3 h-3" />
                                    </button>
                                  </div>
                                  <div className="grid grid-cols-[1fr_auto_1fr] gap-1">
                                    <select
                                      value={b.column}
                                      onChange={(e) => setCaseWhenOps(ops => ops.map((o, j) => j === i ? { ...o, branches: o.branches.map((br, k) => k === bi ? { ...br, column: e.target.value } : br) } : o))}
                                      className="text-xs border border-gray-300 rounded px-1.5 py-1"
                                    >
                                      <option value="">Column…</option>
                                      {data?.columns?.map(c => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                    <select
                                      value={b.operator}
                                      onChange={(e) => setCaseWhenOps(ops => ops.map((o, j) => j === i ? { ...o, branches: o.branches.map((br, k) => k === bi ? { ...br, operator: e.target.value } : br) } : o))}
                                      className="text-xs border border-gray-300 rounded px-1.5 py-1"
                                    >
                                      <option value="equals">=</option>
                                      <option value="not_equals">≠</option>
                                      <option value="greater_than">&gt;</option>
                                      <option value="less_than">&lt;</option>
                                      <option value="contains">contains</option>
                                    </select>
                                    <input
                                      type="text"
                                      value={b.value}
                                      onChange={(e) => setCaseWhenOps(ops => ops.map((o, j) => j === i ? { ...o, branches: o.branches.map((br, k) => k === bi ? { ...br, value: e.target.value } : br) } : o))}
                                      placeholder="value"
                                      className="text-xs border border-gray-300 rounded px-1.5 py-1"
                                    />
                                  </div>
                                  <div className="grid grid-cols-[auto_1fr] gap-1 items-center">
                                    <span className="text-[10px] text-gray-500">THEN</span>
                                    <input
                                      type="text"
                                      value={b.then}
                                      onChange={(e) => setCaseWhenOps(ops => ops.map((o, j) => j === i ? { ...o, branches: o.branches.map((br, k) => k === bi ? { ...br, then: e.target.value } : br) } : o))}
                                      placeholder="output value"
                                      className="text-xs border border-gray-300 rounded px-1.5 py-1"
                                    />
                                  </div>
                                </div>
                              ))}
                              <button
                                onClick={() => setCaseWhenOps(ops => ops.map((o, j) => j === i ? { ...o, branches: [...o.branches, { column: data?.columns?.[0] || '', operator: 'equals', value: '', then: '' }] } : o))}
                                className="text-[10px] text-primary hover:underline flex items-center gap-1"
                              >
                                <Plus className="w-2.5 h-2.5" /> Add WHEN branch
                              </button>
                              <div className="grid grid-cols-[auto_1fr] gap-1 items-center pt-1 border-t border-gray-200">
                                <span className="text-[10px] text-gray-500">ELSE</span>
                                <input
                                  type="text"
                                  value={op.else}
                                  onChange={(e) => setCaseWhenOps(ops => ops.map((o, j) => j === i ? { ...o, else: e.target.value } : o))}
                                  placeholder="default value"
                                  className="text-xs border border-gray-300 rounded px-1.5 py-1"
                                />
                              </div>
                            </div>
                          ))}
                          <button
                            onClick={() => setCaseWhenOps(ops => [...ops, {
                              branches: [{ column: data?.columns?.[0] || '', operator: 'equals', value: '', then: '' }],
                              else: '',
                              into: `case_${ops.length + 1}`,
                            }])}
                            className="text-xs text-primary hover:underline flex items-center gap-1"
                          >
                            <Plus className="w-3 h-3" /> Add case-when
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Accordion Section: Concat Columns */}
                  <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
                    <button
                      onClick={() => toggleSection('concat')}
                      className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center space-x-2">
                        <ArrowDownUp className="w-4 h-4 text-blue-600" />
                        <span className="text-sm font-semibold text-gray-900">Concat Columns</span>
                        {concatOps.length > 0 && <span className="text-xs text-gray-500">{concatOps.length}</span>}
                      </div>
                      {expandedSections.has('concat') ? (
                        <ChevronDown className="w-4 h-4 text-gray-500" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-gray-500" />
                      )}
                    </button>
                    {expandedSections.has('concat') && (
                      <div className="px-4 pb-3 border-t border-gray-100">
                        <div className="space-y-2 mt-3">
                          {concatOps.map((op, i) => (
                            <div key={i} className="bg-gray-50 border border-gray-200 rounded p-2 space-y-1.5">
                              <div className="flex items-center justify-between">
                                <input
                                  type="text"
                                  value={op.into}
                                  onChange={(e) => setConcatOps(ops => ops.map((o, j) => j === i ? { ...o, into: e.target.value } : o))}
                                  placeholder="new column name (e.g. full_name)"
                                  className="text-xs border border-gray-300 rounded px-1.5 py-1 flex-1 mr-1"
                                />
                                <button
                                  onClick={() => setConcatOps(ops => ops.filter((_, j) => j !== i))}
                                  className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded flex-shrink-0"
                                  title="Remove"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                              <MultiColumnSelect
                                columns={data?.columns || []}
                                value={op.columns ? op.columns.split(',').map(s => s.trim()).filter(Boolean) : []}
                                onChange={(cols) =>
                                  setConcatOps(ops => ops.map((o, j) => j === i ? { ...o, columns: cols.join(',') } : o))
                                }
                                placeholder="pick columns to concat (in order)…"
                              />
                              <div className="grid grid-cols-[auto_1fr] gap-1 items-center">
                                <span className="text-[10px] text-gray-500">SEPARATOR</span>
                                <input
                                  type="text"
                                  value={op.separator}
                                  onChange={(e) => setConcatOps(ops => ops.map((o, j) => j === i ? { ...o, separator: e.target.value } : o))}
                                  placeholder="e.g. space, comma, empty"
                                  className="text-xs border border-gray-300 rounded px-1.5 py-1"
                                />
                              </div>
                            </div>
                          ))}
                          <button
                            onClick={() => setConcatOps(ops => [...ops, { columns: '', separator: ' ', into: `concat_${ops.length + 1}` }])}
                            className="text-xs text-primary hover:underline flex items-center gap-1"
                          >
                            <Plus className="w-3 h-3" /> Add concat
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Accordion Section: Date Extract */}
                  <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
                    <button
                      onClick={() => toggleSection('dateExtract')}
                      className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center space-x-2">
                        <Calculator className="w-4 h-4 text-blue-600" />
                        <span className="text-sm font-semibold text-gray-900">Date Extract</span>
                        {dateExtractOps.length > 0 && <span className="text-xs text-gray-500">{dateExtractOps.length}</span>}
                      </div>
                      {expandedSections.has('dateExtract') ? (
                        <ChevronDown className="w-4 h-4 text-gray-500" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-gray-500" />
                      )}
                    </button>
                    {expandedSections.has('dateExtract') && (
                      <div className="px-4 pb-3 border-t border-gray-100">
                        <div className="space-y-2 mt-3">
                          {dateExtractOps.map((op, i) => (
                            <div key={i} className="bg-gray-50 border border-gray-200 rounded p-2 space-y-1.5">
                              <div className="flex items-center justify-between">
                                <input
                                  type="text"
                                  value={op.into}
                                  onChange={(e) => setDateExtractOps(ops => ops.map((o, j) => j === i ? { ...o, into: e.target.value } : o))}
                                  placeholder="new column name"
                                  className="text-xs border border-gray-300 rounded px-1.5 py-1 flex-1 mr-1"
                                />
                                <button
                                  onClick={() => setDateExtractOps(ops => ops.filter((_, j) => j !== i))}
                                  className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded flex-shrink-0"
                                  title="Remove"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                              <div className="grid grid-cols-[1fr_1fr] gap-1">
                                <select
                                  value={op.column}
                                  onChange={(e) => setDateExtractOps(ops => ops.map((o, j) => j === i ? { ...o, column: e.target.value } : o))}
                                  className="text-xs border border-gray-300 rounded px-1.5 py-1"
                                >
                                  <option value="">Date column…</option>
                                  {data?.columns?.map(c => <option key={c} value={c}>{c}</option>)}
                                </select>
                                <select
                                  value={op.part}
                                  onChange={(e) => setDateExtractOps(ops => ops.map((o, j) => j === i ? { ...o, part: e.target.value as any } : o))}
                                  className="text-xs border border-gray-300 rounded px-1.5 py-1"
                                >
                                  <option value="year">Year</option>
                                  <option value="month">Month</option>
                                  <option value="day">Day</option>
                                  <option value="dayofweek">Day of week</option>
                                  <option value="hour">Hour</option>
                                </select>
                              </div>
                            </div>
                          ))}
                          <button
                            onClick={() => setDateExtractOps(ops => [...ops, { column: data?.columns?.[0] || '', part: 'year', into: `date_part_${ops.length + 1}` }])}
                            className="text-xs text-primary hover:underline flex items-center gap-1"
                          >
                            <Plus className="w-3 h-3" /> Add date extract
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Accordion Section: Substring */}
                  <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
                    <button
                      onClick={() => toggleSection('substring')}
                      className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center space-x-2">
                        <Wand2 className="w-4 h-4 text-blue-600" />
                        <span className="text-sm font-semibold text-gray-900">Substring</span>
                        {substringOps.length > 0 && <span className="text-xs text-gray-500">{substringOps.length}</span>}
                      </div>
                      {expandedSections.has('substring') ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronRight className="w-4 h-4 text-gray-500" />}
                    </button>
                    {expandedSections.has('substring') && (
                      <div className="px-4 pb-3 border-t border-gray-100">
                        <div className="space-y-2 mt-3">
                          {substringOps.map((op, i) => (
                            <div key={i} className="bg-gray-50 border border-gray-200 rounded p-2 space-y-1.5">
                              <div className="flex items-center justify-between">
                                <input
                                  type="text"
                                  value={op.into}
                                  onChange={(e) => setSubstringOps(ops => ops.map((o, j) => j === i ? { ...o, into: e.target.value } : o))}
                                  placeholder="new column name"
                                  className="text-xs border border-gray-300 rounded px-1.5 py-1 flex-1 mr-1"
                                />
                                <button
                                  onClick={() => setSubstringOps(ops => ops.filter((_, j) => j !== i))}
                                  className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded flex-shrink-0"
                                  title="Remove"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                              <div className="grid grid-cols-[1fr_auto_auto] gap-1 items-center">
                                <select
                                  value={op.column}
                                  onChange={(e) => setSubstringOps(ops => ops.map((o, j) => j === i ? { ...o, column: e.target.value } : o))}
                                  className="text-xs border border-gray-300 rounded px-1.5 py-1"
                                >
                                  <option value="">Column…</option>
                                  {data?.columns?.map(c => <option key={c} value={c}>{c}</option>)}
                                </select>
                                <input
                                  type="number"
                                  min={1}
                                  value={op.start}
                                  onChange={(e) => setSubstringOps(ops => ops.map((o, j) => j === i ? { ...o, start: Math.max(1, parseInt(e.target.value, 10) || 1) } : o))}
                                  placeholder="start"
                                  className="w-16 text-xs border border-gray-300 rounded px-1.5 py-1"
                                  title="Start position (1-based)"
                                />
                                <input
                                  type="number"
                                  min={0}
                                  value={op.length ?? ''}
                                  onChange={(e) => {
                                    const raw = e.target.value.trim();
                                    setSubstringOps(ops => ops.map((o, j) => j === i ? { ...o, length: raw === '' ? null : Math.max(0, parseInt(raw, 10) || 0) } : o));
                                  }}
                                  placeholder="len"
                                  className="w-16 text-xs border border-gray-300 rounded px-1.5 py-1"
                                  title="Length (blank = to end)"
                                />
                              </div>
                            </div>
                          ))}
                          <button
                            onClick={() => setSubstringOps(ops => [...ops, { column: data?.columns?.[0] || '', start: 1, length: null, into: `substr_${ops.length + 1}` }])}
                            className="text-xs text-primary hover:underline flex items-center gap-1"
                          >
                            <Plus className="w-3 h-3" /> Add substring
                          </button>
                          <p className="text-[10px] text-gray-500">Start is 1-based. Blank length = to end of string.</p>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Accordion Section: Numeric Ops */}
                  <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
                    <button
                      onClick={() => toggleSection('numeric')}
                      className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center space-x-2">
                        <Calculator className="w-4 h-4 text-blue-600" />
                        <span className="text-sm font-semibold text-gray-900">Numeric (round / floor / ceil / abs)</span>
                        {numericOps.length > 0 && <span className="text-xs text-gray-500">{numericOps.length}</span>}
                      </div>
                      {expandedSections.has('numeric') ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronRight className="w-4 h-4 text-gray-500" />}
                    </button>
                    {expandedSections.has('numeric') && (
                      <div className="px-4 pb-3 border-t border-gray-100">
                        <div className="space-y-2 mt-3">
                          {numericOps.map((op, i) => (
                            <div key={i} className="bg-gray-50 border border-gray-200 rounded p-2 space-y-1.5">
                              <div className="flex items-center justify-between">
                                <input
                                  type="text"
                                  value={op.into}
                                  onChange={(e) => setNumericOps(ops => ops.map((o, j) => j === i ? { ...o, into: e.target.value } : o))}
                                  placeholder="new column name"
                                  className="text-xs border border-gray-300 rounded px-1.5 py-1 flex-1 mr-1"
                                />
                                <button
                                  onClick={() => setNumericOps(ops => ops.filter((_, j) => j !== i))}
                                  className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded flex-shrink-0"
                                  title="Remove"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                              <div className="grid grid-cols-[1fr_auto_auto] gap-1">
                                <select
                                  value={op.column}
                                  onChange={(e) => setNumericOps(ops => ops.map((o, j) => j === i ? { ...o, column: e.target.value } : o))}
                                  className="text-xs border border-gray-300 rounded px-1.5 py-1"
                                >
                                  <option value="">Column…</option>
                                  {data?.columns?.map(c => <option key={c} value={c}>{c}</option>)}
                                </select>
                                <select
                                  value={op.op}
                                  onChange={(e) => setNumericOps(ops => ops.map((o, j) => j === i ? { ...o, op: e.target.value as any } : o))}
                                  className="text-xs border border-gray-300 rounded px-1.5 py-1"
                                >
                                  <option value="round">Round</option>
                                  <option value="floor">Floor</option>
                                  <option value="ceil">Ceil</option>
                                  <option value="abs">Abs</option>
                                </select>
                                {op.op === 'round' && (
                                  <input
                                    type="number"
                                    min={0}
                                    value={op.digits}
                                    onChange={(e) => setNumericOps(ops => ops.map((o, j) => j === i ? { ...o, digits: Math.max(0, parseInt(e.target.value, 10) || 0) } : o))}
                                    placeholder="dp"
                                    className="w-16 text-xs border border-gray-300 rounded px-1.5 py-1"
                                    title="Decimal places"
                                  />
                                )}
                              </div>
                            </div>
                          ))}
                          <button
                            onClick={() => setNumericOps(ops => [...ops, { column: data?.columns?.[0] || '', op: 'round', digits: 2, into: `num_${ops.length + 1}` }])}
                            className="text-xs text-primary hover:underline flex items-center gap-1"
                          >
                            <Plus className="w-3 h-3" /> Add numeric op
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Accordion Section: Sample */}
                  <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
                    <button
                      onClick={() => toggleSection('sample')}
                      className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center space-x-2">
                        <Wand2 className="w-4 h-4 text-blue-600" />
                        <span className="text-sm font-semibold text-gray-900">Sample</span>
                        {sampleConfig && (sampleConfig.n || sampleConfig.fraction) && <span className="text-xs text-gray-500">1</span>}
                      </div>
                      {expandedSections.has('sample') ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronRight className="w-4 h-4 text-gray-500" />}
                    </button>
                    {expandedSections.has('sample') && (
                      <div className="px-4 pb-3 border-t border-gray-100">
                        <div className="space-y-2 mt-3">
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="text-[10px] text-gray-600 block mb-1">N rows</label>
                              <input
                                type="number"
                                min={0}
                                value={sampleConfig?.n ?? ''}
                                onChange={(e) => {
                                  const raw = e.target.value.trim();
                                  const n = raw === '' ? null : Math.max(0, parseInt(raw, 10) || 0);
                                  setSampleConfig((prev) => ({
                                    n,
                                    fraction: n ? null : prev?.fraction ?? null,
                                    random: prev?.random ?? true,
                                  }));
                                }}
                                placeholder="e.g. 1000"
                                className="w-full text-xs border border-gray-300 rounded px-1.5 py-1"
                              />
                            </div>
                            <div>
                              <label className="text-[10px] text-gray-600 block mb-1">or Fraction (0-1)</label>
                              <input
                                type="number"
                                min={0}
                                max={1}
                                step={0.05}
                                value={sampleConfig?.fraction ?? ''}
                                onChange={(e) => {
                                  const raw = e.target.value.trim();
                                  const f = raw === '' ? null : Math.max(0, Math.min(1, parseFloat(raw) || 0));
                                  setSampleConfig((prev) => ({
                                    n: f ? null : prev?.n ?? null,
                                    fraction: f,
                                    random: prev?.random ?? true,
                                  }));
                                }}
                                placeholder="0.10 = 10%"
                                className="w-full text-xs border border-gray-300 rounded px-1.5 py-1"
                              />
                            </div>
                          </div>
                          <label className="flex items-center gap-2 text-xs cursor-pointer">
                            <input
                              type="checkbox"
                              checked={sampleConfig?.random ?? true}
                              onChange={(e) => setSampleConfig((prev) => ({
                                n: prev?.n ?? null,
                                fraction: prev?.fraction ?? null,
                                random: e.target.checked,
                              }))}
                              className="w-4 h-4"
                            />
                            <span className="text-gray-700">Random sample (uncheck for top-N)</span>
                          </label>
                          {sampleConfig && (sampleConfig.n || sampleConfig.fraction) && (
                            <button
                              onClick={() => setSampleConfig(null)}
                              className="text-xs text-red-600 hover:underline"
                            >
                              Clear sample
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Accordion Section: Advanced Reshaping */}
                  <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
                    <button
                      onClick={() => toggleSection('reshape')}
                      className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center space-x-2">
                        <TableIcon className="w-4 h-4 text-blue-600" />
                        <span className="text-sm font-semibold text-gray-900">Pivot & Unpivot</span>
                      </div>
                      {expandedSections.has('reshape') ? (
                        <ChevronDown className="w-4 h-4 text-gray-500" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-gray-500" />
                      )}
                    </button>
                    {expandedSections.has('reshape') && (
                      <div className="px-4 pb-3 border-t border-gray-100">
                        <div className="space-y-4 mt-3">
                          <div>
                            <label className="text-xs font-medium text-gray-700 mb-2 block">Pivot (Long → Wide):</label>
                            <div className="space-y-2 bg-blue-50 border border-blue-200 rounded p-3">
                              <div className="grid grid-cols-2 gap-2">
                                <div>
                                  <label className="text-xs text-gray-600 mb-1 block">Index (Row labels):</label>
                                  <select
                                    value={pivotConfig?.index || ''}
                                    onChange={(e) => setPivotConfig(e.target.value ? { ...pivotConfig, index: e.target.value } : null)}
                                    className="w-full text-xs border border-gray-300 rounded px-2 py-1.5 bg-white"
                                  >
                                    <option value="">Select column...</option>
                                    {data?.columns?.map((col) => (
                                      <option key={col} value={col}>{col}</option>
                                    ))}
                                  </select>
                                </div>
                                <div>
                                  <label className="text-xs text-gray-600 mb-1 block">Columns:</label>
                                  <select
                                    value={pivotConfig?.columns || ''}
                                    onChange={(e) => setPivotConfig(e.target.value ? { ...pivotConfig, columns: e.target.value } : null)}
                                    className="w-full text-xs border border-gray-300 rounded px-2 py-1.5 bg-white"
                                  >
                                    <option value="">Select column...</option>
                                    {data?.columns?.map((col) => (
                                      <option key={col} value={col}>{col}</option>
                                    ))}
                                  </select>
                                </div>
                                <div>
                                  <label className="text-xs text-gray-600 mb-1 block">Values (Data):</label>
                                  <select
                                    value={pivotConfig?.values || ''}
                                    onChange={(e) => setPivotConfig(e.target.value ? { ...pivotConfig, values: e.target.value } : null)}
                                    className="w-full text-xs border border-gray-300 rounded px-2 py-1.5 bg-white"
                                  >
                                    <option value="">Select column...</option>
                                    {data?.columns?.map((col) => (
                                      <option key={col} value={col}>{col}</option>
                                    ))}
                                  </select>
                                </div>
                                <div>
                                  <label className="text-xs text-gray-600 mb-1 block">Aggregation:</label>
                                  <select
                                    value={pivotConfig?.aggfunc || 'sum'}
                                    onChange={(e) => setPivotConfig(pivotConfig ? { ...pivotConfig, aggfunc: e.target.value } : null)}
                                    className="w-full text-xs border border-gray-300 rounded px-2 py-1.5 bg-white"
                                  >
                                    <option value="sum">sum</option>
                                    <option value="mean">mean</option>
                                    <option value="count">count</option>
                                    <option value="min">min</option>
                                    <option value="max">max</option>
                                    <option value="first">first</option>
                                    <option value="last">last</option>
                                  </select>
                                </div>
                              </div>
                              {pivotConfig && pivotConfig.index && pivotConfig.columns && pivotConfig.values && (
                                <div className="flex items-center justify-between bg-white border border-blue-300 rounded px-2 py-1.5">
                                  <div className="text-xs text-gray-700">
                                    <span className="font-medium">Active:</span> {pivotConfig.index} × {pivotConfig.columns} → {pivotConfig.values} ({pivotConfig.aggfunc || 'sum'})
                                  </div>
                                  <button
                                    onClick={() => setPivotConfig(null)}
                                    className="text-red-600 hover:text-red-800"
                                    title="Clear pivot"
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                </div>
                              )}
                              <p className="text-xs text-gray-600">
                                Converts long-format data to wide-format (e.g., date × category → amounts)
                              </p>
                            </div>
                          </div>
                          <div>
                            <label className="text-xs font-medium text-gray-700 mb-2 block">Unpivot (Wide → Long):</label>
                            <div className="space-y-3 bg-green-50 border border-green-200 rounded p-3">
                              <div className="grid grid-cols-2 gap-3">
                                <div>
                                  <label className="text-xs text-gray-600 mb-1 block font-medium">ID Variables (Keep as-is):</label>
                                  <div className="bg-white border border-gray-300 rounded px-2 py-1.5 max-h-32 overflow-y-auto">
                                    {data?.columns?.map((col) => (
                                      <label key={col} className="flex items-center space-x-2 py-1 hover:bg-gray-50 cursor-pointer">
                                        <input
                                          type="checkbox"
                                          checked={unpivotConfig?.id_vars?.includes(col) || false}
                                          onChange={(e) => {
                                            const currentIdVars: string[] = unpivotConfig?.id_vars || [];
                                            const newIdVars = e.target.checked
                                              ? [...currentIdVars, col]
                                              : currentIdVars.filter((c: string) => c !== col);
                                            setUnpivotConfig({ ...unpivotConfig, id_vars: newIdVars });
                                          }}
                                          className="w-3 h-3 text-green-600 rounded"
                                        />
                                        <span className="text-xs text-gray-900">{col}</span>
                                      </label>
                                    ))}
                                  </div>
                                </div>
                                <div>
                                  <label className="text-xs text-gray-600 mb-1 block font-medium">Value Variables (Unpivot):</label>
                                  <div className="bg-white border border-gray-300 rounded px-2 py-1.5 max-h-32 overflow-y-auto">
                                    {data?.columns?.map((col) => (
                                      <label key={col} className="flex items-center space-x-2 py-1 hover:bg-gray-50 cursor-pointer">
                                        <input
                                          type="checkbox"
                                          checked={unpivotConfig?.value_vars?.includes(col) || false}
                                          onChange={(e) => {
                                            const currentValueVars: string[] = unpivotConfig?.value_vars || [];
                                            const newValueVars = e.target.checked
                                              ? [...currentValueVars, col]
                                              : currentValueVars.filter((c: string) => c !== col);
                                            setUnpivotConfig({ ...unpivotConfig, value_vars: newValueVars });
                                          }}
                                          className="w-3 h-3 text-green-600 rounded"
                                        />
                                        <span className="text-xs text-gray-900">{col}</span>
                                      </label>
                                    ))}
                                  </div>
                                </div>
                              </div>
                              <div className="grid grid-cols-2 gap-2">
                                <div>
                                  <label className="text-xs text-gray-600 mb-1 block">Variable Name (column name):</label>
                                  <input
                                    type="text"
                                    value={unpivotConfig?.var_name || ''}
                                    onChange={(e) => setUnpivotConfig({ ...unpivotConfig, var_name: e.target.value })}
                                    placeholder="variable"
                                    className="w-full text-xs border border-gray-300 rounded px-2 py-1.5"
                                  />
                                </div>
                                <div>
                                  <label className="text-xs text-gray-600 mb-1 block">Value Name (column name):</label>
                                  <input
                                    type="text"
                                    value={unpivotConfig?.value_name || ''}
                                    onChange={(e) => setUnpivotConfig({ ...unpivotConfig, value_name: e.target.value })}
                                    placeholder="value"
                                    className="w-full text-xs border border-gray-300 rounded px-2 py-1.5"
                                  />
                                </div>
                              </div>
                              {unpivotConfig && unpivotConfig.id_vars?.length > 0 && unpivotConfig.value_vars?.length > 0 && (
                                <div className="flex items-center justify-between bg-white border border-green-300 rounded px-2 py-1.5">
                                  <div className="text-xs text-gray-700">
                                    <span className="font-medium">Active:</span> Keep {unpivotConfig.id_vars.join(', ')} | Unpivot {unpivotConfig.value_vars.length} columns
                                  </div>
                                  <button
                                    onClick={() => setUnpivotConfig(null)}
                                    className="text-red-600 hover:text-red-800"
                                    title="Clear unpivot"
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                </div>
                              )}
                              <p className="text-xs text-gray-600">
                                Converts wide-format data to long-format (e.g., Q1, Q2, Q3 columns → quarter & value columns)
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Save as New Asset - Sticky Bottom */}
                  <div className="mt-auto pt-4 border-t-2 border-gray-300 bg-gradient-to-b from-gray-50 to-white">
                    <div className="space-y-3">
                      <h3 className="text-sm font-semibold text-gray-900 flex items-center">
                        <Save className="w-4 h-4 mr-2 text-green-600" />
                        {existingComponentId ? 'Update Transformation' : 'Save Transformation'}
                      </h3>
                      <input
                        type="text"
                        value={newAssetName}
                        onChange={(e) => setNewAssetName(e.target.value)}
                        placeholder="e.g., transformed_customers"
                        disabled={!!existingComponentId}
                        className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-green-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed"
                      />
                      <button
                        onClick={handleSaveAsNewAsset}
                        disabled={!newAssetName.trim() || saving}
                        className="w-full px-4 py-3 text-sm font-semibold text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-sm hover:shadow-md"
                      >
                        {saving ? (
                          <span className="flex items-center justify-center">
                            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                            {existingComponentId ? 'Saving...' : 'Creating...'}
                          </span>
                        ) : (
                          existingComponentId ? 'Save Changes' : 'Create New Asset'
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Data Table */}
            <div className="flex-1 overflow-auto p-6">
              {loading && (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
                    <p className="text-gray-600">Loading asset data…</p>
                    <p className="text-xs text-gray-400 mt-2">
                      dbt models query the warehouse; this can take a few seconds.
                    </p>
                  </div>
                </div>
              )}

              {error && isNotMaterializedError && (
                <div className="flex items-center justify-center h-full">
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-6 max-w-xl text-center">
                    <Play className="w-8 h-8 text-amber-600 mx-auto mb-3" />
                    <h3 className="text-base font-medium text-gray-900 mb-1">
                      No data yet for this asset
                    </h3>
                    <p className="text-sm text-gray-600 mb-4">
                      This asset needs to be materialized before you can preview
                      its output. Click below to run it (and every upstream
                      asset it depends on).
                    </p>
                    <button
                      onClick={handleRunToHere}
                      disabled={runningToHere}
                      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-60"
                    >
                      {runningToHere ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Running…
                        </>
                      ) : (
                        <>
                          <Play className="w-4 h-4 fill-current" />
                          Run to here
                        </>
                      )}
                    </button>
                    <details className="mt-4 text-left">
                      <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
                        Details
                      </summary>
                      <p className="text-xs text-gray-500 mt-2 whitespace-pre-wrap">{error}</p>
                    </details>
                  </div>
                </div>
              )}

              {error && !isNotMaterializedError && (
                <div className="flex items-center justify-center h-full">
                  <div className="bg-red-50 border border-red-200 rounded-lg p-6 max-w-2xl">
                    <div className="flex items-start space-x-3">
                      <AlertCircle className="w-5 h-5 text-red-600 mt-0.5 flex-shrink-0" />
                      <div>
                        <h3 className="text-sm font-medium text-red-900 mb-1">
                          Cannot Preview Asset
                        </h3>
                        <p className="text-sm text-red-700">{error}</p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {displayData && displayData.success && displayData.data && displayData.columns && (
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          {displayData.columns.map((col, idx) => (
                            <th
                              key={idx}
                              className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider"
                            >
                              <div className="flex items-start justify-between group">
                                <div className="flex flex-col flex-1 min-w-0">
                                  <span className="truncate">{col}</span>
                                  {displayData.dtypes && displayData.dtypes[col] && (
                                    <span className="text-[10px] text-gray-500 font-normal normal-case mt-1">
                                      {displayData.dtypes[col]}
                                    </span>
                                  )}
                                  {displayData.data && (
                                    <ColumnProfileStrip
                                      rows={displayData.data}
                                      column={col}
                                      dtype={displayData.dtypes?.[col]}
                                    />
                                  )}
                                </div>
                                {mode === 'transform' && (
                                  <DropdownMenu.Root open={openColumnMenu === col} onOpenChange={(open) => setOpenColumnMenu(open ? col : null)}>
                                    <DropdownMenu.Trigger asChild>
                                      <button className="ml-2 p-1 rounded hover:bg-gray-200 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <ChevronDown className="w-3.5 h-3.5 text-gray-600" />
                                      </button>
                                    </DropdownMenu.Trigger>
                                    <DropdownMenu.Portal>
                                      <DropdownMenu.Content
                                        className="min-w-[200px] bg-white rounded-lg shadow-lg border border-gray-200 p-1 z-[100]"
                                        sideOffset={5}
                                      >
                                        {/* Visibility */}
                                        <DropdownMenu.Item
                                          className="flex items-center px-3 py-2 text-sm text-gray-700 rounded hover:bg-gray-100 cursor-pointer outline-none"
                                          onSelect={() => selectedColumns.has(col) ? handleHideColumn(col) : handleShowColumn(col)}
                                        >
                                          {selectedColumns.has(col) ? (
                                            <><EyeOff className="w-4 h-4 mr-2" /> Hide Column</>
                                          ) : (
                                            <><Eye className="w-4 h-4 mr-2" /> Show Column</>
                                          )}
                                        </DropdownMenu.Item>

                                        <DropdownMenu.Separator className="h-px bg-gray-200 my-1" />

                                        {/* Sorting */}
                                        <DropdownMenu.Item
                                          className="flex items-center px-3 py-2 text-sm text-gray-700 rounded hover:bg-gray-100 cursor-pointer outline-none"
                                          onSelect={() => handleSortByColumn(col, true)}
                                        >
                                          <SortAsc className="w-4 h-4 mr-2" /> Sort Ascending
                                        </DropdownMenu.Item>
                                        <DropdownMenu.Item
                                          className="flex items-center px-3 py-2 text-sm text-gray-700 rounded hover:bg-gray-100 cursor-pointer outline-none"
                                          onSelect={() => handleSortByColumn(col, false)}
                                        >
                                          <SortDesc className="w-4 h-4 mr-2" /> Sort Descending
                                        </DropdownMenu.Item>

                                        <DropdownMenu.Separator className="h-px bg-gray-200 my-1" />

                                        {/* Filter */}
                                        <DropdownMenu.Item
                                          className="flex items-center px-3 py-2 text-sm text-gray-700 rounded hover:bg-gray-100 cursor-pointer outline-none"
                                          onSelect={() => handleFilterColumn(col)}
                                        >
                                          <Filter className="w-4 h-4 mr-2" /> Add Filter
                                        </DropdownMenu.Item>

                                        <DropdownMenu.Separator className="h-px bg-gray-200 my-1" />

                                        {/* Rename Column */}
                                        <DropdownMenu.Item
                                          className="flex items-center px-3 py-2 text-sm text-gray-700 rounded hover:bg-gray-100 cursor-pointer outline-none"
                                          onSelect={() => handleRenameColumn(col)}
                                        >
                                          <Columns3 className="w-4 h-4 mr-2" /> Rename Column
                                        </DropdownMenu.Item>

                                        {/* Drop Column */}
                                        <DropdownMenu.Item
                                          className="flex items-center px-3 py-2 text-sm text-red-600 rounded hover:bg-red-50 cursor-pointer outline-none"
                                          onSelect={() => columnsToDrop.has(col) ? handleUndropColumn(col) : handleDropColumn(col)}
                                        >
                                          <Trash2 className="w-4 h-4 mr-2" />
                                          {columnsToDrop.has(col) ? 'Undrop Column' : 'Drop Column'}
                                        </DropdownMenu.Item>

                                        <DropdownMenu.Separator className="h-px bg-gray-200 my-1" />

                                        {/* Column Reordering */}
                                        <DropdownMenu.Sub>
                                          <DropdownMenu.SubTrigger className="flex items-center px-3 py-2 text-sm text-gray-700 rounded hover:bg-gray-100 cursor-pointer outline-none">
                                            <ArrowDownUp className="w-4 h-4 mr-2" /> Reorder →
                                          </DropdownMenu.SubTrigger>
                                          <DropdownMenu.Portal>
                                            <DropdownMenu.SubContent
                                              className="min-w-[180px] bg-white rounded-lg shadow-lg border border-gray-200 p-1 z-[100]"
                                              sideOffset={2}
                                            >
                                              <DropdownMenu.Item
                                                className="px-3 py-2 text-sm text-gray-700 rounded hover:bg-gray-100 cursor-pointer outline-none"
                                                onSelect={() => handleMoveColumnToBeginning(col)}
                                              >
                                                Move to Beginning
                                              </DropdownMenu.Item>
                                              <DropdownMenu.Item
                                                className="px-3 py-2 text-sm text-gray-700 rounded hover:bg-gray-100 cursor-pointer outline-none"
                                                onSelect={() => handleShiftColumnLeft(col)}
                                              >
                                                Shift Left
                                              </DropdownMenu.Item>
                                              <DropdownMenu.Item
                                                className="px-3 py-2 text-sm text-gray-700 rounded hover:bg-gray-100 cursor-pointer outline-none"
                                                onSelect={() => handleShiftColumnRight(col)}
                                              >
                                                Shift Right
                                              </DropdownMenu.Item>
                                              <DropdownMenu.Item
                                                className="px-3 py-2 text-sm text-gray-700 rounded hover:bg-gray-100 cursor-pointer outline-none"
                                                onSelect={() => handleMoveColumnToEnd(col)}
                                              >
                                                Move to End
                                              </DropdownMenu.Item>
                                            </DropdownMenu.SubContent>
                                          </DropdownMenu.Portal>
                                        </DropdownMenu.Sub>

                                        <DropdownMenu.Separator className="h-px bg-gray-200 my-1" />

                                        {/* Group By */}
                                        <DropdownMenu.Item
                                          className="flex items-center px-3 py-2 text-sm text-gray-700 rounded hover:bg-gray-100 cursor-pointer outline-none"
                                          onSelect={() => handleGroupByColumn(col)}
                                        >
                                          <Group className="w-4 h-4 mr-2" /> Group By
                                        </DropdownMenu.Item>

                                        {/* Aggregations */}
                                        <DropdownMenu.Sub>
                                          <DropdownMenu.SubTrigger className="flex items-center px-3 py-2 text-sm text-gray-700 rounded hover:bg-gray-100 cursor-pointer outline-none">
                                            <Sigma className="w-4 h-4 mr-2" /> Aggregate →
                                          </DropdownMenu.SubTrigger>
                                          <DropdownMenu.Portal>
                                            <DropdownMenu.SubContent
                                              className="min-w-[150px] bg-white rounded-lg shadow-lg border border-gray-200 p-1 z-[100]"
                                              sideOffset={2}
                                            >
                                              <DropdownMenu.Item
                                                className="px-3 py-2 text-sm text-gray-700 rounded hover:bg-gray-100 cursor-pointer outline-none"
                                                onSelect={() => handleAggregateColumn(col, 'sum')}
                                              >
                                                Sum
                                              </DropdownMenu.Item>
                                              <DropdownMenu.Item
                                                className="px-3 py-2 text-sm text-gray-700 rounded hover:bg-gray-100 cursor-pointer outline-none"
                                                onSelect={() => handleAggregateColumn(col, 'count')}
                                              >
                                                Count
                                              </DropdownMenu.Item>
                                              <DropdownMenu.Item
                                                className="px-3 py-2 text-sm text-gray-700 rounded hover:bg-gray-100 cursor-pointer outline-none"
                                                onSelect={() => handleAggregateColumn(col, 'mean')}
                                              >
                                                Mean
                                              </DropdownMenu.Item>
                                              <DropdownMenu.Item
                                                className="px-3 py-2 text-sm text-gray-700 rounded hover:bg-gray-100 cursor-pointer outline-none"
                                                onSelect={() => handleAggregateColumn(col, 'min')}
                                              >
                                                Min
                                              </DropdownMenu.Item>
                                              <DropdownMenu.Item
                                                className="px-3 py-2 text-sm text-gray-700 rounded hover:bg-gray-100 cursor-pointer outline-none"
                                                onSelect={() => handleAggregateColumn(col, 'max')}
                                              >
                                                Max
                                              </DropdownMenu.Item>
                                            </DropdownMenu.SubContent>
                                          </DropdownMenu.Portal>
                                        </DropdownMenu.Sub>

                                        {/* String Operations */}
                                        <DropdownMenu.Sub>
                                          <DropdownMenu.SubTrigger className="flex items-center px-3 py-2 text-sm text-gray-700 rounded hover:bg-gray-100 cursor-pointer outline-none">
                                            <Columns3 className="w-4 h-4 mr-2" /> String Ops →
                                          </DropdownMenu.SubTrigger>
                                          <DropdownMenu.Portal>
                                            <DropdownMenu.SubContent
                                              className="min-w-[150px] bg-white rounded-lg shadow-lg border border-gray-200 p-1 z-[100]"
                                              sideOffset={2}
                                            >
                                              <DropdownMenu.Item
                                                className="px-3 py-2 text-sm text-gray-700 rounded hover:bg-gray-100 cursor-pointer outline-none"
                                                onSelect={() => handleStringOperation(col, 'upper')}
                                              >
                                                UPPERCASE
                                              </DropdownMenu.Item>
                                              <DropdownMenu.Item
                                                className="px-3 py-2 text-sm text-gray-700 rounded hover:bg-gray-100 cursor-pointer outline-none"
                                                onSelect={() => handleStringOperation(col, 'lower')}
                                              >
                                                lowercase
                                              </DropdownMenu.Item>
                                              <DropdownMenu.Item
                                                className="px-3 py-2 text-sm text-gray-700 rounded hover:bg-gray-100 cursor-pointer outline-none"
                                                onSelect={() => handleStringOperation(col, 'title')}
                                              >
                                                Title Case
                                              </DropdownMenu.Item>
                                              <DropdownMenu.Item
                                                className="px-3 py-2 text-sm text-gray-700 rounded hover:bg-gray-100 cursor-pointer outline-none"
                                                onSelect={() => handleStringOperation(col, 'trim')}
                                              >
                                                Trim Whitespace
                                              </DropdownMenu.Item>
                                            </DropdownMenu.SubContent>
                                          </DropdownMenu.Portal>
                                        </DropdownMenu.Sub>
                                      </DropdownMenu.Content>
                                    </DropdownMenu.Portal>
                                  </DropdownMenu.Root>
                                )}
                              </div>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {displayData.data.map((row, rowIdx) => (
                          <tr key={rowIdx} className="hover:bg-gray-50">
                            {displayData.columns!.map((col, colIdx) => (
                              <td
                                key={colIdx}
                                className="px-4 py-3 text-sm text-gray-900 whitespace-nowrap"
                              >
                                {row[col] === null || row[col] === undefined
                                  ? <span className="text-gray-400 italic">null</span>
                                  : String(row[col])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
            {mode === 'transform' && (
              <RecipePanel
                steps={recipeSteps}
                previewAtStep={previewAtStep}
                onSelectStep={setPreviewAtStep}
                onClearAll={() => {
                  setPreviewAtStep(null);
                  setFilters([]);
                  setCaseWhenOps([]);
                  setConcatOps([]);
                  setDateExtractOps([]);
                  setCountMatchOps([]);
                  setReplaceOps([]);
                  setSplitOps([]);
                  setWindowOps([]);
                  setDropDuplicates(false);
                  setDropNA(false);
                  setFillNAValue('');
                  setSortColumns([]);
                  setGroupByColumns([]);
                  setAggregations({});
                  setColumnRenames({});
                  setColumnsToDrop(new Set());
                  setStringOperations([]);
                  setCalculatedColumns({});
                  setPivotConfig(null);
                  setUnpivotConfig(null);
                  setLimitRows(null);
                  setSubstringOps([]);
                  setNumericOps([]);
                  setSampleConfig(null);
                }}
              />
            )}
          </div>

          {/* Footer */}
          {data && data.success && mode === 'view' && (
            <div className="px-6 py-4 border-t border-gray-200 bg-gray-50">
              <button
                onClick={loadData}
                disabled={loading}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? 'Refreshing...' : 'Refresh Data'}
              </button>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>

      {/* Community transform picker — nested modal on top of this one. */}
      <CommunityTransformPicker
        open={showCommunityPicker}
        onOpenChange={setShowCommunityPicker}
        projectId={projectId}
        upstreamAssetKey={assetKey}
        onInstalled={({ instanceName }) => {
          // Close the preview modal so the user can see the new node land
          // on the graph and configure it. onTransformerCreated triggers a
          // project reload upstream.
          if (onTransformerCreated) onTransformerCreated(null);
          onClose();
          notify.info(`Configure "${instanceName}" from the graph to fill in its attributes.`);
        }}
      />
    </Dialog.Root>
  );
}
