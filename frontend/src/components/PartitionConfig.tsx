import { useState } from 'react';
import { Calendar, Plus, X, Info } from 'lucide-react';

export interface PartitionConfig {
  enabled: boolean;
  partition_type: 'daily' | 'weekly' | 'monthly' | 'hourly' | 'static' | 'dynamic';
  start_date: string | null;
  end_date: string | null;
  timezone: string;
  cron_schedule: string | null;
  fmt: string | null;
  partition_keys: string[];
  var_name: string;
  minute_offset?: number | null; // Minutes past the hour (all time-based)
  hour_offset?: number | null; // Hours past midnight (daily/weekly/monthly)
  day_offset?: number | null; // Day of week (weekly: 0-6) or day of month (monthly: 1-31)
}

interface PartitionConfigProps {
  config: PartitionConfig | null;
  onChange: (config: PartitionConfig | null) => void;
  supportedPartitionTypes?: string[]; // Optional list of supported partition types
}

const DEFAULT_CONFIG: PartitionConfig = {
  enabled: false,
  partition_type: 'daily',
  start_date: (() => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday.toISOString().split('T')[0];
  })(),
  end_date: null,
  timezone: 'UTC',
  cron_schedule: null,
  fmt: null,
  partition_keys: [],
  var_name: 'component_partitions_def',
  minute_offset: null,
  hour_offset: null,
  day_offset: null,
};

export function PartitionConfig({ config, onChange, supportedPartitionTypes }: PartitionConfigProps) {
  const [expanded, setExpanded] = useState(false);
  const currentConfig = config || DEFAULT_CONFIG;

  // Filter partition types based on component support (default: all types if not specified)
  const availablePartitionTypes = supportedPartitionTypes || ['daily', 'weekly', 'monthly', 'hourly', 'static'];
  const isPartitionTypeSupported = (type: string) => availablePartitionTypes.includes(type);

  const handleToggle = () => {
    if (!currentConfig.enabled) {
      // Enable partitions
      onChange({ ...DEFAULT_CONFIG, enabled: true });
      setExpanded(true);
    } else {
      // Disable partitions
      onChange(null);
      setExpanded(false);
    }
  };

  const handleFieldChange = (field: keyof PartitionConfig, value: any) => {
    onChange({ ...currentConfig, [field]: value });
  };

  return (
    <div className="border-t border-gray-200 pt-4">
      {/* Header with toggle */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-gray-500" />
          <span className="text-sm font-medium text-gray-700">Partitions</span>
        </div>
        <div className="flex items-center gap-2">
          {currentConfig.enabled && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-xs text-blue-600 hover:text-blue-700"
            >
              {expanded ? 'Hide' : 'Show'}
            </button>
          )}
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={currentConfig.enabled}
              onChange={handleToggle}
              className="sr-only peer"
            />
            <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
          </label>
        </div>
      </div>

      {currentConfig.enabled && expanded && (
        <div className="space-y-4 pl-6 border-l-2 border-gray-200">
          {/* Partition Type */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Partition Type
            </label>
            <select
              value={currentConfig.partition_type}
              onChange={(e) => handleFieldChange('partition_type', e.target.value)}
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {isPartitionTypeSupported('daily') && <option value="daily">Daily</option>}
              {isPartitionTypeSupported('weekly') && <option value="weekly">Weekly</option>}
              {isPartitionTypeSupported('monthly') && <option value="monthly">Monthly</option>}
              {isPartitionTypeSupported('hourly') && <option value="hourly">Hourly</option>}
              {isPartitionTypeSupported('static') && <option value="static">Static (Custom Keys)</option>}
            </select>
          </div>

          {/* Time-based partitions */}
          {['daily', 'weekly', 'monthly', 'hourly'].includes(currentConfig.partition_type) && (
            <>
              {/* Start Date */}
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Start Date <span className="text-red-500">*</span>
                </label>
                <input
                  type="date"
                  value={currentConfig.start_date || ''}
                  onChange={(e) => handleFieldChange('start_date', e.target.value)}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              {/* End Date (optional) */}
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  End Date <span className="text-gray-400">(optional)</span>
                </label>
                <input
                  type="date"
                  value={currentConfig.end_date || ''}
                  onChange={(e) => handleFieldChange('end_date', e.target.value || null)}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Leave empty to partition indefinitely into the future
                </p>
              </div>

              {/* Minute Offset (for hourly only) */}
              {currentConfig.partition_type === 'hourly' && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1 flex items-center gap-1">
                    Minute Offset
                    <div className="group relative">
                      <Info className="w-3 h-3 text-gray-400 cursor-help" />
                      <div className="hidden group-hover:block absolute left-0 top-5 w-64 p-2 bg-gray-900 text-white text-xs rounded shadow-lg z-10">
                        Minutes past the hour when partition starts. Example: 30 means partition starts at :30 past each hour.
                      </div>
                    </div>
                  </label>
                  <input
                    type="number"
                    value={currentConfig.minute_offset ?? ''}
                    onChange={(e) => handleFieldChange('minute_offset', e.target.value ? parseInt(e.target.value) : null)}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="0"
                    min="0"
                    max="59"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Minutes past the hour (0-59)
                  </p>
                </div>
              )}

              {/* Minute and Hour Offset (for daily) */}
              {currentConfig.partition_type === 'daily' && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1 flex items-center gap-1">
                      Minute Offset
                      <div className="group relative">
                        <Info className="w-3 h-3 text-gray-400 cursor-help" />
                        <div className="hidden group-hover:block absolute left-0 top-5 w-64 p-2 bg-gray-900 text-white text-xs rounded shadow-lg z-10">
                          Minutes past the hour when partition boundary occurs.
                        </div>
                      </div>
                    </label>
                    <input
                      type="number"
                      value={currentConfig.minute_offset ?? ''}
                      onChange={(e) => handleFieldChange('minute_offset', e.target.value ? parseInt(e.target.value) : null)}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="0"
                      min="0"
                      max="59"
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      Minutes past the hour (0-59)
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1 flex items-center gap-1">
                      Hour Offset
                      <div className="group relative">
                        <Info className="w-3 h-3 text-gray-400 cursor-help" />
                        <div className="hidden group-hover:block absolute left-0 top-5 w-64 p-2 bg-gray-900 text-white text-xs rounded shadow-lg z-10">
                          Hours past midnight when partition boundary occurs. Example: 1 means partitions start at 1:00 AM.
                        </div>
                      </div>
                    </label>
                    <input
                      type="number"
                      value={currentConfig.hour_offset ?? ''}
                      onChange={(e) => handleFieldChange('hour_offset', e.target.value ? parseInt(e.target.value) : null)}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="0"
                      min="0"
                      max="23"
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      Hours past midnight (0-23)
                    </p>
                  </div>
                </>
              )}

              {/* Minute, Hour, and Day Offset (for weekly) */}
              {currentConfig.partition_type === 'weekly' && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1 flex items-center gap-1">
                      Minute Offset
                      <div className="group relative">
                        <Info className="w-3 h-3 text-gray-400 cursor-help" />
                        <div className="hidden group-hover:block absolute left-0 top-5 w-64 p-2 bg-gray-900 text-white text-xs rounded shadow-lg z-10">
                          Minutes past the hour when partition boundary occurs.
                        </div>
                      </div>
                    </label>
                    <input
                      type="number"
                      value={currentConfig.minute_offset ?? ''}
                      onChange={(e) => handleFieldChange('minute_offset', e.target.value ? parseInt(e.target.value) : null)}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="0"
                      min="0"
                      max="59"
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      Minutes past the hour (0-59)
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1 flex items-center gap-1">
                      Hour Offset
                      <div className="group relative">
                        <Info className="w-3 h-3 text-gray-400 cursor-help" />
                        <div className="hidden group-hover:block absolute left-0 top-5 w-64 p-2 bg-gray-900 text-white text-xs rounded shadow-lg z-10">
                          Hours past midnight when partition boundary occurs.
                        </div>
                      </div>
                    </label>
                    <input
                      type="number"
                      value={currentConfig.hour_offset ?? ''}
                      onChange={(e) => handleFieldChange('hour_offset', e.target.value ? parseInt(e.target.value) : null)}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="0"
                      min="0"
                      max="23"
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      Hours past midnight (0-23)
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1 flex items-center gap-1">
                      Day Offset (Day of Week)
                      <div className="group relative">
                        <Info className="w-3 h-3 text-gray-400 cursor-help" />
                        <div className="hidden group-hover:block absolute left-0 top-5 w-64 p-2 bg-gray-900 text-white text-xs rounded shadow-lg z-10">
                          Which day of the week the partition starts. 0 = Sunday, 6 = Saturday.
                        </div>
                      </div>
                    </label>
                    <select
                      value={currentConfig.day_offset ?? ''}
                      onChange={(e) => handleFieldChange('day_offset', e.target.value ? parseInt(e.target.value) : null)}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Default (Sunday)</option>
                      <option value="0">Sunday (0)</option>
                      <option value="1">Monday (1)</option>
                      <option value="2">Tuesday (2)</option>
                      <option value="3">Wednesday (3)</option>
                      <option value="4">Thursday (4)</option>
                      <option value="5">Friday (5)</option>
                      <option value="6">Saturday (6)</option>
                    </select>
                    <p className="mt-1 text-xs text-gray-500">
                      Day of week (0=Sunday, 6=Saturday)
                    </p>
                  </div>
                </>
              )}

              {/* Minute, Hour, and Day Offset (for monthly) */}
              {currentConfig.partition_type === 'monthly' && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1 flex items-center gap-1">
                      Minute Offset
                      <div className="group relative">
                        <Info className="w-3 h-3 text-gray-400 cursor-help" />
                        <div className="hidden group-hover:block absolute left-0 top-5 w-64 p-2 bg-gray-900 text-white text-xs rounded shadow-lg z-10">
                          Minutes past the hour when partition boundary occurs.
                        </div>
                      </div>
                    </label>
                    <input
                      type="number"
                      value={currentConfig.minute_offset ?? ''}
                      onChange={(e) => handleFieldChange('minute_offset', e.target.value ? parseInt(e.target.value) : null)}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="0"
                      min="0"
                      max="59"
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      Minutes past the hour (0-59)
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1 flex items-center gap-1">
                      Hour Offset
                      <div className="group relative">
                        <Info className="w-3 h-3 text-gray-400 cursor-help" />
                        <div className="hidden group-hover:block absolute left-0 top-5 w-64 p-2 bg-gray-900 text-white text-xs rounded shadow-lg z-10">
                          Hours past midnight when partition boundary occurs.
                        </div>
                      </div>
                    </label>
                    <input
                      type="number"
                      value={currentConfig.hour_offset ?? ''}
                      onChange={(e) => handleFieldChange('hour_offset', e.target.value ? parseInt(e.target.value) : null)}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="0"
                      min="0"
                      max="23"
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      Hours past midnight (0-23)
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1 flex items-center gap-1">
                      Day Offset (Day of Month)
                      <div className="group relative">
                        <Info className="w-3 h-3 text-gray-400 cursor-help" />
                        <div className="hidden group-hover:block absolute left-0 top-5 w-64 p-2 bg-gray-900 text-white text-xs rounded shadow-lg z-10">
                          Which day of the month the partition starts (1-31).
                        </div>
                      </div>
                    </label>
                    <input
                      type="number"
                      value={currentConfig.day_offset ?? ''}
                      onChange={(e) => handleFieldChange('day_offset', e.target.value ? parseInt(e.target.value) : null)}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="1"
                      min="1"
                      max="31"
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      Day of month (1-31), default: 1
                    </p>
                  </div>
                </>
              )}

              {/* Timezone */}
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Timezone
                </label>
                <select
                  value={currentConfig.timezone}
                  onChange={(e) => handleFieldChange('timezone', e.target.value)}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="UTC">UTC</option>
                  <option value="America/New_York">America/New_York</option>
                  <option value="America/Chicago">America/Chicago</option>
                  <option value="America/Denver">America/Denver</option>
                  <option value="America/Los_Angeles">America/Los_Angeles</option>
                  <option value="Europe/London">Europe/London</option>
                  <option value="Asia/Tokyo">Asia/Tokyo</option>
                </select>
              </div>

              {/* Date Format (optional) */}
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Date Format <span className="text-gray-400">(optional)</span>
                </label>
                <input
                  type="text"
                  value={currentConfig.fmt || ''}
                  onChange={(e) => handleFieldChange('fmt', e.target.value || null)}
                  placeholder="%Y-%m-%d"
                  className="w-full px-2 py-1.5 text-sm font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Default: %Y-%m-%d (e.g., 2024-01-15)
                </p>
              </div>
            </>
          )}

          {/* Static partitions */}
          {currentConfig.partition_type === 'static' && (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Partition Keys
              </label>
              <textarea
                value={currentConfig.partition_keys.join('\n')}
                onChange={(e) => {
                  const keys = e.target.value
                    .split('\n')
                    .map(k => k.trim())
                    .filter(k => k.length > 0);
                  handleFieldChange('partition_keys', keys);
                }}
                placeholder="Enter partition keys, one per line&#10;Example:&#10;customer_1&#10;customer_2&#10;customer_3"
                className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 min-h-[120px]"
              />
              <p className="mt-1 text-xs text-gray-500">
                Enter one partition key per line (e.g., customer_1, us_region, product_a)
              </p>
            </div>
          )}

          {/* Info box */}
          <div className="flex items-start gap-2 p-2 bg-blue-50 border border-blue-200 rounded text-xs text-blue-800">
            <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <div>
              <div className="font-medium mb-1">Partitions apply to all assets</div>
              <div>
                All assets generated by this component will be partitioned using this definition.
              </div>
            </div>
          </div>
        </div>
      )}

      {!expanded && currentConfig.enabled && (
        <div className="pl-6 text-xs text-gray-600">
          {currentConfig.partition_type} partitions
          {currentConfig.start_date && ` from ${currentConfig.start_date}`}
        </div>
      )}
    </div>
  );
}
