import React, { useState, useMemo } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { X, AlertCircle, Table as TableIcon, Wand2, Save, Filter, Columns3, Trash2, Eye, EyeOff, ChevronDown, ChevronRight, SortAsc, SortDesc, Sigma, Group, Calculator, Type, ArrowDownUp, RotateCw } from 'lucide-react';
import { assetsApi, type AssetDataPreview } from '@/services/api';

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
}: DataPreviewModalProps) {
  const [data, setData] = useState<AssetDataPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'transform'>('view');
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

  // Accordion state for transform sections
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['columns', 'filters']));

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
      // For now, we'll show a message that complex filters need to be edited in the component config
      // In the future, we could parse simple expressions back into FilterCondition objects

      // Load sort_by
      if (existingComponentAttributes.sort_by) {
        const sortCols = existingComponentAttributes.sort_by.split(',').map((c: string) => c.trim());
        setSortColumns(sortCols);
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

  // Apply transformations to preview data
  const transformedData = useMemo(() => {
    if (!data || !data.data || mode !== 'transform') {
      return data;
    }

    let result = [...data.data];

    // Apply filters
    filters.forEach(filter => {
      result = result.filter(row => {
        const value = row[filter.column];
        const filterValue = filter.value;

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

    // Drop duplicates
    if (dropDuplicates) {
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

    // Drop NA
    if (dropNA) {
      result = result.filter(row => {
        return Object.values(row).every(val => val !== null && val !== undefined && val !== '');
      });
    }

    // Fill NA
    if (fillNAValue) {
      result = result.map(row => {
        const newRow: any = {};
        Object.keys(row).forEach(key => {
          const val = row[key];
          newRow[key] = (val === null || val === undefined || val === '') ? fillNAValue : val;
        });
        return newRow;
      });
    }

    // Group by and aggregate
    if (groupByColumns.length > 0 && Object.keys(aggregations).length > 0) {
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

    // Sorting
    if (sortColumns.length > 0) {
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

    // Apply column renames
    if (Object.keys(columnRenames).length > 0) {
      result = result.map(row => {
        const newRow: any = {};
        Object.keys(row).forEach(key => {
          const newKey = columnRenames[key] || key;
          newRow[newKey] = row[key];
        });
        return newRow;
      });
    }

    // Apply string operations
    if (stringOperations.length > 0) {
      result = result.map(row => {
        const newRow = { ...row };
        stringOperations.forEach(op => {
          if (newRow[op.column] !== undefined && newRow[op.column] !== null) {
            const val = String(newRow[op.column]);
            switch (op.operation) {
              case 'upper':
                newRow[op.column] = val.toUpperCase();
                break;
              case 'lower':
                newRow[op.column] = val.toLowerCase();
                break;
              case 'title':
                newRow[op.column] = val.replace(/\w\S*/g, txt =>
                  txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
                );
                break;
              case 'trim':
                newRow[op.column] = val.trim();
                break;
            }
          }
        });
        return newRow;
      });
    }

    // Apply calculated columns
    if (Object.keys(calculatedColumns).length > 0) {
      result = result.map(row => {
        const newRow = { ...row };
        Object.entries(calculatedColumns).forEach(([colName, expression]) => {
          try {
            // Simple expression evaluation - replace column names with values
            let expr = expression;
            Object.keys(row).forEach(key => {
              const value = Number(row[key]);
              if (!isNaN(value)) {
                // Replace column name with value, ensuring word boundaries
                expr = expr.replace(new RegExp(`\\b${key}\\b`, 'g'), String(value));
              }
            });
            // Evaluate the expression (basic math operations)
            newRow[colName] = eval(expr);
          } catch (e) {
            // If evaluation fails, set to null
            newRow[colName] = null;
          }
        });
        return newRow;
      });
    }

    // Drop columns
    if (columnsToDrop.size > 0) {
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

    return {
      ...data,
      data: result,
      columns: finalColumns,
      row_count: result.length,
      column_count: finalColumns.length,
    };
  }, [data, mode, filters, selectedColumns, dropDuplicates, dropNA, fillNAValue, sortColumns, sortAscending, groupByColumns, aggregations, columnRenames, columnsToDrop, stringOperations, calculatedColumns, columnOrder]);

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
      alert('Please enter a name for the new asset');
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
        pivotConfig: pivotConfig,
        unpivotConfig: unpivotConfig
      };

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

      alert(`Successfully created new asset: ${newAssetName}`);
      handleClose();
    } catch (err: any) {
      alert(`Failed to create asset: ${err.message}`);
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
                                            const currentIdVars = unpivotConfig?.id_vars || [];
                                            const newIdVars = e.target.checked
                                              ? [...currentIdVars, col]
                                              : currentIdVars.filter(c => c !== col);
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
                                            const currentValueVars = unpivotConfig?.value_vars || [];
                                            const newValueVars = e.target.checked
                                              ? [...currentValueVars, col]
                                              : currentValueVars.filter(c => c !== col);
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
                    <p className="text-gray-600">Loading asset data...</p>
                  </div>
                </div>
              )}

              {error && (
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
                              <div className="flex items-center justify-between group">
                                <div className="flex flex-col flex-1">
                                  <span>{col}</span>
                                  {displayData.dtypes && displayData.dtypes[col] && (
                                    <span className="text-[10px] text-gray-500 font-normal normal-case mt-1">
                                      {displayData.dtypes[col]}
                                    </span>
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
    </Dialog.Root>
  );
}
