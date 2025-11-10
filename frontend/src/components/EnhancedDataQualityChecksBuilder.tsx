import { useState } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight, AlertCircle } from 'lucide-react';

interface CheckConfig {
  id: string;
  checkType: string;
  config: Record<string, any>;
}

interface AssetChecks {
  assetName: string;
  checks: CheckConfig[];
}

interface Props {
  assets: string[]; // Available asset names from project
  onConfigChange: (config: Record<string, any>) => void;
}

const CHECK_TYPES = [
  { id: 'row_count_check', name: 'Row Count', description: 'Validate min/max row counts' },
  { id: 'null_check', name: 'Null Check', description: 'Check for null values in columns' },
  { id: 'data_type_check', name: 'Data Type', description: 'Validate column data types' },
  { id: 'range_check', name: 'Range Check', description: 'Validate min/max values' },
  { id: 'pattern_matching', name: 'Pattern Matching', description: 'Regex validation for text columns' },
  { id: 'value_set_validation', name: 'Value Set', description: 'Validate against allowed values' },
  { id: 'uniqueness_check', name: 'Uniqueness', description: 'Check column uniqueness' },
  { id: 'static_threshold', name: 'Static Threshold', description: 'Validate metrics against thresholds' },
  { id: 'anomaly_detection', name: 'Anomaly Detection', description: 'Detect anomalies using statistical methods' },
  { id: 'percent_delta', name: 'Percent Delta', description: 'Track percent changes from historical values' },
  { id: 'entropy_analysis', name: 'Entropy Analysis', description: 'Analyze data diversity' },
  { id: 'benford_law', name: "Benford's Law", description: 'Validate numerical distributions' },
  { id: 'correlation_check', name: 'Correlation', description: 'Analyze correlations between columns' },
  { id: 'custom_sql_check', name: 'Custom SQL', description: 'Execute custom SQL queries' },
  { id: 'custom_dataframe_check', name: 'Custom Dataframe', description: 'Execute custom Python code' },
];

export function EnhancedDataQualityChecksBuilder({ assets, onConfigChange }: Props) {
  const [assetChecks, setAssetChecks] = useState<AssetChecks[]>([]);
  const [expandedAssets, setExpandedAssets] = useState<Set<string>>(new Set());
  const [expandedChecks, setExpandedChecks] = useState<Set<string>>(new Set());

  const addAsset = () => {
    const availableAssets = assets.filter(
      (a) => !assetChecks.some((ac) => ac.assetName === a)
    );
    if (availableAssets.length === 0) {
      alert('All assets have checks configured');
      return;
    }

    const newAsset: AssetChecks = {
      assetName: availableAssets[0],
      checks: [],
    };
    const updated = [...assetChecks, newAsset];
    setAssetChecks(updated);
    setExpandedAssets(new Set([...expandedAssets, newAsset.assetName]));
    updateConfig(updated);
  };

  const removeAsset = (assetName: string) => {
    const updated = assetChecks.filter((ac) => ac.assetName !== assetName);
    setAssetChecks(updated);
    updateConfig(updated);
  };

  const updateAssetName = (oldName: string, newName: string) => {
    const updated = assetChecks.map((ac) =>
      ac.assetName === oldName ? { ...ac, assetName: newName } : ac
    );
    setAssetChecks(updated);

    // Update expanded state
    const newExpanded = new Set(expandedAssets);
    newExpanded.delete(oldName);
    newExpanded.add(newName);
    setExpandedAssets(newExpanded);

    updateConfig(updated);
  };

  const addCheck = (assetName: string) => {
    const checkId = `${assetName}_${Date.now()}`;
    const updated = assetChecks.map((ac) =>
      ac.assetName === assetName
        ? {
            ...ac,
            checks: [
              ...ac.checks,
              {
                id: checkId,
                checkType: 'row_count_check',
                config: { name: '', min_rows: 1, blocking: false },
              },
            ],
          }
        : ac
    );
    setAssetChecks(updated);
    setExpandedChecks(new Set([...expandedChecks, checkId]));
    updateConfig(updated);
  };

  const removeCheck = (assetName: string, checkId: string) => {
    const updated = assetChecks.map((ac) =>
      ac.assetName === assetName
        ? { ...ac, checks: ac.checks.filter((c) => c.id !== checkId) }
        : ac
    );
    setAssetChecks(updated);
    updateConfig(updated);
  };

  const updateCheck = (assetName: string, checkId: string, updates: Partial<CheckConfig>) => {
    const updated = assetChecks.map((ac) =>
      ac.assetName === assetName
        ? {
            ...ac,
            checks: ac.checks.map((c) => (c.id === checkId ? { ...c, ...updates } : c)),
          }
        : ac
    );
    setAssetChecks(updated);
    updateConfig(updated);
  };

  const updateConfig = (checks: AssetChecks[]) => {
    // Convert to the expected YAML structure
    const assetsConfig: Record<string, any> = {};

    checks.forEach((assetCheck) => {
      const assetConfig: Record<string, any[]> = {};

      // Group checks by type
      assetCheck.checks.forEach((check) => {
        if (!assetConfig[check.checkType]) {
          assetConfig[check.checkType] = [];
        }
        assetConfig[check.checkType].push(check.config);
      });

      assetsConfig[assetCheck.assetName] = assetConfig;
    });

    onConfigChange({ assets: assetsConfig });
  };

  const toggleAssetExpanded = (assetName: string) => {
    const newExpanded = new Set(expandedAssets);
    if (newExpanded.has(assetName)) {
      newExpanded.delete(assetName);
    } else {
      newExpanded.add(assetName);
    }
    setExpandedAssets(newExpanded);
  };

  const toggleCheckExpanded = (checkId: string) => {
    const newExpanded = new Set(expandedChecks);
    if (newExpanded.has(checkId)) {
      newExpanded.delete(checkId);
    } else {
      newExpanded.add(checkId);
    }
    setExpandedChecks(newExpanded);
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-blue-50 border border-blue-200 rounded-md p-4">
        <div className="flex items-start gap-2">
          <AlertCircle className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
          <div>
            <h3 className="font-semibold text-blue-900 mb-1">
              Enhanced Data Quality Checks
            </h3>
            <p className="text-sm text-blue-800">
              Configure comprehensive data quality checks for your assets. Add multiple check types
              per asset to validate row counts, null values, data types, ranges, and more.
            </p>
          </div>
        </div>
      </div>

      {/* Assets List */}
      <div className="space-y-3">
        {assetChecks.map((assetCheck) => (
          <div key={assetCheck.assetName} className="border border-gray-200 rounded-md">
            {/* Asset Header */}
            <div className="bg-gray-50 p-3 flex items-center justify-between">
              <div className="flex items-center gap-2 flex-1">
                <button
                  onClick={() => toggleAssetExpanded(assetCheck.assetName)}
                  className="text-gray-600 hover:text-gray-900"
                >
                  {expandedAssets.has(assetCheck.assetName) ? (
                    <ChevronDown className="w-4 h-4" />
                  ) : (
                    <ChevronRight className="w-4 h-4" />
                  )}
                </button>
                <select
                  value={assetCheck.assetName}
                  onChange={(e) => updateAssetName(assetCheck.assetName, e.target.value)}
                  className="flex-1 px-2 py-1 border border-gray-300 rounded-md text-sm"
                >
                  {assets
                    .filter(
                      (a) =>
                        a === assetCheck.assetName ||
                        !assetChecks.some((ac) => ac.assetName === a)
                    )
                    .map((asset) => (
                      <option key={asset} value={asset}>
                        {asset}
                      </option>
                    ))}
                </select>
                <span className="text-xs text-gray-500">
                  {assetCheck.checks.length} check{assetCheck.checks.length !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => addCheck(assetCheck.assetName)}
                  className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 text-white rounded-md hover:bg-blue-700"
                >
                  <Plus className="w-3 h-3" />
                  Add Check
                </button>
                <button
                  onClick={() => removeAsset(assetCheck.assetName)}
                  className="text-red-600 hover:text-red-700"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Asset Checks */}
            {expandedAssets.has(assetCheck.assetName) && (
              <div className="p-3 space-y-2">
                {assetCheck.checks.length === 0 ? (
                  <div className="text-center py-4 text-gray-500 text-sm">
                    No checks configured. Click "Add Check" to get started.
                  </div>
                ) : (
                  assetCheck.checks.map((check) => (
                    <div key={check.id} className="border border-gray-200 rounded-md">
                      {/* Check Header */}
                      <div className="bg-white p-2 flex items-center justify-between">
                        <div className="flex items-center gap-2 flex-1">
                          <button
                            onClick={() => toggleCheckExpanded(check.id)}
                            className="text-gray-600 hover:text-gray-900"
                          >
                            {expandedChecks.has(check.id) ? (
                              <ChevronDown className="w-3 h-3" />
                            ) : (
                              <ChevronRight className="w-3 h-3" />
                            )}
                          </button>
                          <select
                            value={check.checkType}
                            onChange={(e) =>
                              updateCheck(assetCheck.assetName, check.id, {
                                checkType: e.target.value,
                                config: getDefaultConfig(e.target.value),
                              })
                            }
                            className="flex-1 px-2 py-1 border border-gray-300 rounded-md text-sm"
                          >
                            {CHECK_TYPES.map((type) => (
                              <option key={type.id} value={type.id}>
                                {type.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <button
                          onClick={() => removeCheck(assetCheck.assetName, check.id)}
                          className="text-red-600 hover:text-red-700 ml-2"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>

                      {/* Check Configuration */}
                      {expandedChecks.has(check.id) && (
                        <div className="p-3 bg-gray-50 space-y-2">
                          {renderCheckForm(
                            check.checkType,
                            check.config,
                            (updates) =>
                              updateCheck(assetCheck.assetName, check.id, {
                                config: { ...check.config, ...updates },
                              })
                          )}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Add Asset Button */}
      {assets.length > assetChecks.length && (
        <button
          onClick={addAsset}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 border-2 border-dashed border-gray-300 rounded-md text-gray-600 hover:border-blue-500 hover:text-blue-600 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add Asset
        </button>
      )}

      {assetChecks.length === 0 && (
        <div className="text-center py-8 text-gray-500">
          <p className="mb-2">No assets configured yet</p>
          <p className="text-sm">Click "Add Asset" to start configuring quality checks</p>
        </div>
      )}
    </div>
  );
}

function getDefaultConfig(checkType: string): Record<string, any> {
  switch (checkType) {
    case 'row_count_check':
      return { name: '', min_rows: 1, blocking: false };
    case 'null_check':
      return { name: '', columns: [], blocking: false };
    case 'data_type_check':
      return { name: '', columns: [], blocking: false };
    case 'range_check':
      return { name: '', columns: [], blocking: false };
    case 'pattern_matching':
      return { name: '', column: '', regex_pattern: '', match_percentage: 95.0, blocking: false };
    case 'value_set_validation':
      return { name: '', column: '', allowed_values: [], min_pct: 95.0, blocking: false };
    case 'uniqueness_check':
      return { name: '', columns: [], blocking: false };
    case 'static_threshold':
      return { name: '', metric: 'num_rows', blocking: false };
    case 'anomaly_detection':
      return { name: '', metric: 'num_rows', method: 'z_score', threshold: 2.0, history: 10, blocking: false };
    case 'percent_delta':
      return { name: '', metric: 'num_rows', max_delta: 50.0, history: 10, blocking: false };
    case 'entropy_analysis':
      return { name: '', column: '', blocking: false };
    case 'benford_law':
      return { name: '', column: '', threshold: 0.05, digit_position: 1, min_samples: 100, blocking: false };
    case 'correlation_check':
      return { name: '', column_x: '', column_y: '', method: 'pearson', blocking: false };
    case 'custom_sql_check':
      return { name: '', sql_query: '', expected_result: 0, comparison: 'equals', blocking: false };
    case 'custom_dataframe_check':
      return { name: '', python_code: '', expected_result: true, comparison: 'equals', blocking: false };
    default:
      return { name: '', blocking: false };
  }
}

function renderCheckForm(
  checkType: string,
  config: Record<string, any>,
  onChange: (updates: Record<string, any>) => void
) {
  const commonFields = (
    <>
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">
          Check Name <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          value={config.name || ''}
          onChange={(e) => onChange({ name: e.target.value })}
          className={`w-full px-2 py-1 text-sm border rounded-md ${
            !config.name ? 'border-red-300 bg-red-50' : 'border-gray-300'
          }`}
          placeholder="my_check (required)"
        />
      </div>
    </>
  );

  switch (checkType) {
    case 'row_count_check':
      return (
        <>
          {commonFields}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Min Rows</label>
              <input
                type="number"
                value={config.min_rows || 1}
                onChange={(e) => onChange({ min_rows: parseInt(e.target.value) })}
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Max Rows</label>
              <input
                type="number"
                value={config.max_rows || ''}
                onChange={(e) => onChange({ max_rows: e.target.value ? parseInt(e.target.value) : undefined })}
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
                placeholder="Optional"
              />
            </div>
          </div>
          <div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={config.blocking || false}
                onChange={(e) => onChange({ blocking: e.target.checked })}
                className="rounded"
              />
              <span>Blocking (fails pipeline)</span>
            </label>
          </div>
        </>
      );

    case 'null_check':
      return (
        <>
          {commonFields}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Columns (comma-separated) <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={Array.isArray(config.columns) ? config.columns.join(', ') : ''}
              onChange={(e) =>
                onChange({ columns: e.target.value.split(',').map((c) => c.trim()).filter(Boolean) })
              }
              className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
              placeholder="user_id, email, created_at"
            />
          </div>
          <div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={config.blocking || false}
                onChange={(e) => onChange({ blocking: e.target.checked })}
                className="rounded"
              />
              <span>Blocking (fails pipeline)</span>
            </label>
          </div>
        </>
      );

    case 'range_check':
      return (
        <>
          {commonFields}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Column Configuration (JSON format)
            </label>
            <textarea
              value={JSON.stringify(config.columns || [], null, 2)}
              onChange={(e) => {
                try {
                  onChange({ columns: JSON.parse(e.target.value) });
                } catch {
                  // Invalid JSON, ignore
                }
              }}
              className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md font-mono"
              rows={4}
              placeholder='[{"column": "price", "min_value": 0, "max_value": 1000}]'
            />
            <p className="text-xs text-gray-500 mt-1">
              Example: {`[{"column": "price", "min_value": 0, "max_value": 1000}]`}
            </p>
          </div>
          <div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={config.blocking || false}
                onChange={(e) => onChange({ blocking: e.target.checked })}
                className="rounded"
              />
              <span>Blocking (fails pipeline)</span>
            </label>
          </div>
        </>
      );

    case 'custom_sql_check':
      return (
        <>
          {commonFields}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              SQL Query <span className="text-red-500">*</span>
            </label>
            <textarea
              value={config.sql_query || ''}
              onChange={(e) => onChange({ sql_query: e.target.value })}
              className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md font-mono"
              rows={3}
              placeholder="SELECT COUNT(*) FROM table WHERE condition"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Expected Result</label>
              <input
                type="text"
                value={config.expected_result ?? ''}
                onChange={(e) => onChange({ expected_result: e.target.value })}
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Comparison</label>
              <select
                value={config.comparison || 'equals'}
                onChange={(e) => onChange({ comparison: e.target.value })}
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
              >
                <option value="equals">Equals</option>
                <option value="not_equals">Not Equals</option>
                <option value="greater_than">Greater Than</option>
                <option value="less_than">Less Than</option>
              </select>
            </div>
          </div>
          <div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={config.blocking || false}
                onChange={(e) => onChange({ blocking: e.target.checked })}
                className="rounded"
              />
              <span>Blocking (fails pipeline)</span>
            </label>
          </div>
        </>
      );

    case 'anomaly_detection':
      return (
        <>
          {commonFields}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Metric</label>
            <input
              type="text"
              value={config.metric || 'num_rows'}
              onChange={(e) => onChange({ metric: e.target.value })}
              className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
              placeholder="num_rows, mean:column_name"
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Method</label>
              <select
                value={config.method || 'z_score'}
                onChange={(e) => onChange({ method: e.target.value })}
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
              >
                <option value="z_score">Z-Score</option>
                <option value="iqr">IQR</option>
                <option value="isolation_forest">Isolation Forest</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Threshold</label>
              <input
                type="number"
                step="0.1"
                value={config.threshold || 2.0}
                onChange={(e) => onChange({ threshold: parseFloat(e.target.value) })}
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">History</label>
              <input
                type="number"
                value={config.history || 10}
                onChange={(e) => onChange({ history: parseInt(e.target.value) })}
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
              />
            </div>
          </div>
          <div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={config.blocking || false}
                onChange={(e) => onChange({ blocking: e.target.checked })}
                className="rounded"
              />
              <span>Blocking (fails pipeline)</span>
            </label>
          </div>
        </>
      );

    case 'data_type_check':
      return (
        <>
          {commonFields}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Column Configuration (JSON format) <span className="text-red-500">*</span>
            </label>
            <textarea
              value={JSON.stringify(config.columns || [], null, 2)}
              onChange={(e) => {
                try {
                  onChange({ columns: JSON.parse(e.target.value) });
                } catch {
                  // Invalid JSON, ignore
                }
              }}
              className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md font-mono"
              rows={4}
              placeholder='[{"column": "user_id", "expected_type": "int"}]'
            />
            <p className="text-xs text-gray-500 mt-1">
              Example: {`[{"column": "user_id", "expected_type": "int"}, {"column": "email", "expected_type": "object"}]`}
            </p>
          </div>
          <div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={config.blocking || false}
                onChange={(e) => onChange({ blocking: e.target.checked })}
                className="rounded"
              />
              <span>Blocking (fails pipeline)</span>
            </label>
          </div>
        </>
      );

    case 'pattern_matching':
      return (
        <>
          {commonFields}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Column <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={config.column || ''}
              onChange={(e) => onChange({ column: e.target.value })}
              className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
              placeholder="email"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Regex Pattern <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={config.regex_pattern || ''}
              onChange={(e) => onChange({ regex_pattern: e.target.value })}
              className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md font-mono"
              placeholder="^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Match Percentage</label>
            <input
              type="number"
              step="0.1"
              value={config.match_percentage || 95.0}
              onChange={(e) => onChange({ match_percentage: parseFloat(e.target.value) })}
              className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
              placeholder="95.0"
            />
          </div>
          <div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={config.blocking || false}
                onChange={(e) => onChange({ blocking: e.target.checked })}
                className="rounded"
              />
              <span>Blocking (fails pipeline)</span>
            </label>
          </div>
        </>
      );

    case 'value_set_validation':
      return (
        <>
          {commonFields}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Column <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={config.column || ''}
              onChange={(e) => onChange({ column: e.target.value })}
              className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
              placeholder="status"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Allowed Values (comma-separated) <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={Array.isArray(config.allowed_values) ? config.allowed_values.join(', ') : ''}
              onChange={(e) =>
                onChange({ allowed_values: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })
              }
              className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
              placeholder="active, inactive, pending"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Min Percentage</label>
            <input
              type="number"
              step="0.1"
              value={config.min_pct || 95.0}
              onChange={(e) => onChange({ min_pct: parseFloat(e.target.value) })}
              className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
              placeholder="95.0"
            />
          </div>
          <div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={config.blocking || false}
                onChange={(e) => onChange({ blocking: e.target.checked })}
                className="rounded"
              />
              <span>Blocking (fails pipeline)</span>
            </label>
          </div>
        </>
      );

    case 'uniqueness_check':
      return (
        <>
          {commonFields}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Column Configuration (JSON format) <span className="text-red-500">*</span>
            </label>
            <textarea
              value={JSON.stringify(config.columns || [], null, 2)}
              onChange={(e) => {
                try {
                  onChange({ columns: JSON.parse(e.target.value) });
                } catch {
                  // Invalid JSON, ignore
                }
              }}
              className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md font-mono"
              rows={3}
              placeholder='[{"columns": ["user_id"]}]'
            />
            <p className="text-xs text-gray-500 mt-1">
              Example: {`[{"columns": ["user_id"]}, {"columns": ["email", "date"]}]`}
            </p>
          </div>
          <div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={config.blocking || false}
                onChange={(e) => onChange({ blocking: e.target.checked })}
                className="rounded"
              />
              <span>Blocking (fails pipeline)</span>
            </label>
          </div>
        </>
      );

    case 'static_threshold':
      return (
        <>
          {commonFields}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Metric</label>
            <input
              type="text"
              value={config.metric || 'num_rows'}
              onChange={(e) => onChange({ metric: e.target.value })}
              className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
              placeholder="num_rows, mean:column_name, sum:column_name"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Min Value</label>
              <input
                type="number"
                step="0.1"
                value={config.min_value ?? ''}
                onChange={(e) => onChange({ min_value: e.target.value ? parseFloat(e.target.value) : undefined })}
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
                placeholder="Optional"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Max Value</label>
              <input
                type="number"
                step="0.1"
                value={config.max_value ?? ''}
                onChange={(e) => onChange({ max_value: e.target.value ? parseFloat(e.target.value) : undefined })}
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
                placeholder="Optional"
              />
            </div>
          </div>
          <div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={config.blocking || false}
                onChange={(e) => onChange({ blocking: e.target.checked })}
                className="rounded"
              />
              <span>Blocking (fails pipeline)</span>
            </label>
          </div>
        </>
      );

    case 'percent_delta':
      return (
        <>
          {commonFields}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Metric <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={config.metric || 'num_rows'}
              onChange={(e) => onChange({ metric: e.target.value })}
              className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
              placeholder="num_rows, mean:column_name"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Max Delta (%) <span className="text-red-500">*</span>
              </label>
              <input
                type="number"
                step="0.1"
                value={config.max_delta || 50.0}
                onChange={(e) => onChange({ max_delta: parseFloat(e.target.value) })}
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
                placeholder="50.0"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">History</label>
              <input
                type="number"
                value={config.history || 10}
                onChange={(e) => onChange({ history: parseInt(e.target.value) })}
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
                placeholder="10"
              />
            </div>
          </div>
          <div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={config.blocking || false}
                onChange={(e) => onChange({ blocking: e.target.checked })}
                className="rounded"
              />
              <span>Blocking (fails pipeline)</span>
            </label>
          </div>
        </>
      );

    case 'entropy_analysis':
      return (
        <>
          {commonFields}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Column <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={config.column || ''}
              onChange={(e) => onChange({ column: e.target.value })}
              className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
              placeholder="category"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Min Entropy</label>
              <input
                type="number"
                step="0.1"
                value={config.min_entropy ?? ''}
                onChange={(e) => onChange({ min_entropy: e.target.value ? parseFloat(e.target.value) : undefined })}
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
                placeholder="Optional"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Max Entropy</label>
              <input
                type="number"
                step="0.1"
                value={config.max_entropy ?? ''}
                onChange={(e) => onChange({ max_entropy: e.target.value ? parseFloat(e.target.value) : undefined })}
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
                placeholder="Optional"
              />
            </div>
          </div>
          <div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={config.blocking || false}
                onChange={(e) => onChange({ blocking: e.target.checked })}
                className="rounded"
              />
              <span>Blocking (fails pipeline)</span>
            </label>
          </div>
        </>
      );

    case 'benford_law':
      return (
        <>
          {commonFields}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Column <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={config.column || ''}
              onChange={(e) => onChange({ column: e.target.value })}
              className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
              placeholder="transaction_amount"
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Threshold</label>
              <input
                type="number"
                step="0.01"
                value={config.threshold || 0.05}
                onChange={(e) => onChange({ threshold: parseFloat(e.target.value) })}
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
                placeholder="0.05"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Digit Position</label>
              <select
                value={config.digit_position || 1}
                onChange={(e) => onChange({ digit_position: parseInt(e.target.value) })}
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
              >
                <option value="1">1st Digit</option>
                <option value="2">2nd Digit</option>
                <option value="12">First Two</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Min Samples</label>
              <input
                type="number"
                value={config.min_samples || 100}
                onChange={(e) => onChange({ min_samples: parseInt(e.target.value) })}
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
                placeholder="100"
              />
            </div>
          </div>
          <div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={config.blocking || false}
                onChange={(e) => onChange({ blocking: e.target.checked })}
                className="rounded"
              />
              <span>Blocking (fails pipeline)</span>
            </label>
          </div>
        </>
      );

    case 'correlation_check':
      return (
        <>
          {commonFields}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Column X <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={config.column_x || ''}
                onChange={(e) => onChange({ column_x: e.target.value })}
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
                placeholder="price"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Column Y <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={config.column_y || ''}
                onChange={(e) => onChange({ column_y: e.target.value })}
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
                placeholder="quantity"
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Method</label>
              <select
                value={config.method || 'pearson'}
                onChange={(e) => onChange({ method: e.target.value })}
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
              >
                <option value="pearson">Pearson</option>
                <option value="spearman">Spearman</option>
                <option value="kendall">Kendall</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Min Correlation</label>
              <input
                type="number"
                step="0.1"
                value={config.min_correlation ?? ''}
                onChange={(e) => onChange({ min_correlation: e.target.value ? parseFloat(e.target.value) : undefined })}
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
                placeholder="Optional"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Max Correlation</label>
              <input
                type="number"
                step="0.1"
                value={config.max_correlation ?? ''}
                onChange={(e) => onChange({ max_correlation: e.target.value ? parseFloat(e.target.value) : undefined })}
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
                placeholder="Optional"
              />
            </div>
          </div>
          <div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={config.blocking || false}
                onChange={(e) => onChange({ blocking: e.target.checked })}
                className="rounded"
              />
              <span>Blocking (fails pipeline)</span>
            </label>
          </div>
        </>
      );

    case 'custom_dataframe_check':
      return (
        <>
          {commonFields}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Python Code <span className="text-red-500">*</span>
            </label>
            <textarea
              value={config.python_code || ''}
              onChange={(e) => onChange({ python_code: e.target.value })}
              className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md font-mono"
              rows={3}
              placeholder="len(df) > 0"
            />
            <p className="text-xs text-gray-500 mt-1">Use 'df' to access the dataframe</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Expected Result</label>
              <input
                type="text"
                value={config.expected_result ?? ''}
                onChange={(e) => onChange({ expected_result: e.target.value })}
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
                placeholder="True"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Comparison</label>
              <select
                value={config.comparison || 'equals'}
                onChange={(e) => onChange({ comparison: e.target.value })}
                className="w-full px-2 py-1 text-sm border border-gray-300 rounded-md"
              >
                <option value="equals">Equals</option>
                <option value="not_equals">Not Equals</option>
                <option value="greater_than">Greater Than</option>
                <option value="less_than">Less Than</option>
              </select>
            </div>
          </div>
          <div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={config.blocking || false}
                onChange={(e) => onChange({ blocking: e.target.checked })}
                className="rounded"
              />
              <span>Blocking (fails pipeline)</span>
            </label>
          </div>
        </>
      );

    default:
      return (
        <>
          {commonFields}
          <div className="bg-yellow-50 border border-yellow-200 rounded p-2">
            <p className="text-xs text-yellow-800">
              Advanced configuration for this check type. Edit the generated YAML directly.
            </p>
          </div>
          <div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={config.blocking || false}
                onChange={(e) => onChange({ blocking: e.target.checked })}
                className="rounded"
              />
              <span>Blocking (fails pipeline)</span>
            </label>
          </div>
        </>
      );
  }
}
