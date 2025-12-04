import React, { useState, useMemo, useEffect } from 'react';

interface PipelineParam {
  type: string;
  description?: string;
  default?: any;
  required?: boolean;
  enum?: string[];
  sensitive?: boolean;
  environment_specific?: boolean;
  show_if?: Record<string, string | string[]>;
  placeholder?: string;
  items?: { enum?: string[] };
}

interface PipelineConfigFormProps {
  params: Record<string, PipelineParam>;
  onConfigChange: (config: Record<string, any>) => void;
  initialConfig?: Record<string, any>;
}

type Environment = 'local' | 'branch' | 'production';

export const PipelineConfigForm: React.FC<PipelineConfigFormProps> = ({
  params,
  onConfigChange,
  initialConfig = {}
}) => {
  // Initialize config with defaults from params
  const initialSharedConfig = useMemo(() => {
    const config: Record<string, any> = { ...initialConfig.shared };

    // Add default values for shared params that aren't in initialConfig
    Object.entries(params).forEach(([key, param]) => {
      if (!param.environment_specific && config[key] === undefined && param.default !== undefined) {
        config[key] = param.default;
      }
    });

    return config;
  }, [params, initialConfig.shared]);

  const initialEnvConfigs = useMemo(() => {
    const configs: Record<Environment, Record<string, any>> = {
      local: { ...initialConfig.environments?.local },
      branch: { ...initialConfig.environments?.branch },
      production: { ...initialConfig.environments?.production }
    };

    // Add default values for environment-specific params that aren't in initialConfig
    (['local', 'branch', 'production'] as Environment[]).forEach(env => {
      Object.entries(params).forEach(([key, param]) => {
        if (param.environment_specific && configs[env][key] === undefined && param.default !== undefined) {
          configs[env][key] = param.default;
        }
      });
    });

    return configs;
  }, [params, initialConfig.environments]);

  // State for multi-environment configuration
  const [activeEnv, setActiveEnv] = useState<Environment>('local');
  const [sharedConfig, setSharedConfig] = useState<Record<string, any>>(initialSharedConfig);
  const [envConfigs, setEnvConfigs] = useState<Record<Environment, Record<string, any>>>(initialEnvConfigs);

  // Separate params into shared and environment-specific
  const { sharedParams, envSpecificParams } = useMemo(() => {
    const shared: Record<string, PipelineParam> = {};
    const envSpecific: Record<string, PipelineParam> = {};

    Object.entries(params).forEach(([key, param]) => {
      if (param.environment_specific) {
        envSpecific[key] = param;
      } else {
        shared[key] = param;
      }
    });

    return { sharedParams: shared, envSpecificParams: envSpecific };
  }, [params]);

  // Notify parent with initialized config (including defaults) on mount
  useEffect(() => {
    onConfigChange({
      shared: sharedConfig,
      environments: envConfigs
    });
    // Only run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Helper to check if a field should be shown based on show_if condition
  const shouldShowField = (param: PipelineParam, currentConfig: Record<string, any>): boolean => {
    if (!param.show_if) return true;

    return Object.entries(param.show_if).every(([condKey, condValue]) => {
      // Check both current config and shared config (condition keys might be in either)
      const actualValue = currentConfig[condKey] ?? sharedConfig[condKey];
      if (Array.isArray(condValue)) {
        return condValue.includes(actualValue);
      }
      return actualValue === condValue;
    });
  };

  // Update configuration and notify parent
  const updateConfig = (env: Environment | 'shared', key: string, value: any) => {
    if (env === 'shared') {
      const newShared = { ...sharedConfig, [key]: value };
      setSharedConfig(newShared);
    } else {
      const newEnvConfig = { ...envConfigs[env], [key]: value };
      setEnvConfigs({ ...envConfigs, [env]: newEnvConfig });
    }

    // Notify parent with complete config structure
    onConfigChange({
      shared: env === 'shared' ? { ...sharedConfig, [key]: value } : sharedConfig,
      environments: env === 'shared' ? envConfigs : {
        ...envConfigs,
        [env]: { ...envConfigs[env], [key]: value }
      }
    });
  };

  // Render a single form field
  const renderField = (key: string, param: PipelineParam, env: Environment | 'shared') => {
    const currentConfig = env === 'shared' ? sharedConfig : envConfigs[env];

    // Check conditional visibility
    if (!shouldShowField(param, currentConfig)) {
      return null;
    }

    const value = currentConfig[key] ?? param.default ?? '';
    const label = key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    // Handle enum fields as dropdowns
    if (param.enum && param.type === 'string') {
      return (
        <div key={key} className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {label}
            {param.required && <span className="text-red-500 ml-1">*</span>}
          </label>
          <select
            value={value}
            onChange={(e) => updateConfig(env, key, e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Select...</option>
            {param.enum.map(option => (
              <option key={option} value={option}>
                {option.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
              </option>
            ))}
          </select>
          {param.description && (
            <p className="text-xs text-gray-500 mt-1">{param.description}</p>
          )}
        </div>
      );
    }

    // Handle array with enum as multi-select checkboxes
    if (param.type === 'array' && param.items?.enum) {
      const currentValue = (value || []) as string[];
      return (
        <div key={key} className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {label}
            {param.required && <span className="text-red-500 ml-1">*</span>}
          </label>
          <div className="space-y-2 border border-gray-300 rounded-md p-3">
            {param.items.enum.map(option => {
              const isChecked = currentValue.includes(option);
              return (
                <label key={option} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={(e) => {
                      const newValue = e.target.checked
                        ? [...currentValue, option]
                        : currentValue.filter(v => v !== option);
                      updateConfig(env, key, newValue);
                    }}
                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
                  />
                  <span className="text-sm capitalize">{option.replace(/_/g, ' ')}</span>
                </label>
              );
            })}
          </div>
          {param.description && (
            <p className="text-xs text-gray-500 mt-1">{param.description}</p>
          )}
        </div>
      );
    }

    // Handle string fields (with sensitive flag for passwords)
    if (param.type === 'string') {
      return (
        <div key={key} className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {label}
            {param.required && <span className="text-red-500 ml-1">*</span>}
            {param.sensitive && <span className="text-xs text-gray-500 ml-2">(Sensitive)</span>}
          </label>
          <input
            type={param.sensitive ? 'password' : 'text'}
            value={value}
            onChange={(e) => updateConfig(env, key, e.target.value)}
            placeholder={param.placeholder || param.description}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
          />
          {param.description && (
            <p className="text-xs text-gray-500 mt-1">{param.description}</p>
          )}
        </div>
      );
    }

    // Handle number fields
    if (param.type === 'integer' || param.type === 'number') {
      return (
        <div key={key} className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {label}
            {param.required && <span className="text-red-500 ml-1">*</span>}
          </label>
          <input
            type="number"
            step={param.type === 'number' ? '0.01' : '1'}
            value={value}
            onChange={(e) => {
              const numValue = param.type === 'integer'
                ? parseInt(e.target.value)
                : parseFloat(e.target.value);
              updateConfig(env, key, numValue);
            }}
            placeholder={param.description}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {param.description && (
            <p className="text-xs text-gray-500 mt-1">{param.description}</p>
          )}
        </div>
      );
    }

    // Handle boolean fields
    if (param.type === 'boolean') {
      return (
        <div key={key} className="mb-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={value === true}
              onChange={(e) => updateConfig(env, key, e.target.checked)}
              className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-2 focus:ring-blue-500"
            />
            <span className="text-sm font-medium text-gray-700">
              {label}
              {param.required && <span className="text-red-500 ml-1">*</span>}
            </span>
          </label>
          {param.description && (
            <p className="text-xs text-gray-500 mt-1 ml-6">{param.description}</p>
          )}
        </div>
      );
    }

    return null;
  };

  const hasEnvSpecificParams = Object.keys(envSpecificParams).length > 0;

  return (
    <div className="space-y-6">
      {/* Shared Parameters Section */}
      {Object.keys(sharedParams).length > 0 && (
        <div>
          <h3 className="text-md font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <span className="bg-purple-100 text-purple-800 px-2 py-0.5 rounded text-xs">Shared</span>
            Pipeline Settings
          </h3>
          <div className="bg-gray-50 rounded-lg p-4">
            <p className="text-xs text-gray-600 mb-4">These settings apply to all environments</p>
            {Object.entries(sharedParams).map(([key, param]) => renderField(key, param, 'shared'))}
          </div>
        </div>
      )}

      {/* Environment-Specific Parameters */}
      {hasEnvSpecificParams && (
        <div>
          <h3 className="text-md font-semibold text-gray-900 mb-3">Environment Configuration</h3>
          <p className="text-xs text-gray-600 mb-4">
            Configure credentials and destinations for each environment. The pipeline will automatically use the correct settings based on where it runs.
          </p>

          {/* Environment Tabs */}
          <div className="border-b border-gray-200 mb-4">
            <nav className="-mb-px flex space-x-4">
              {(['local', 'branch', 'production'] as Environment[]).map(env => (
                <button
                  key={env}
                  onClick={() => setActiveEnv(env)}
                  className={`
                    py-2 px-4 text-sm font-medium border-b-2 transition-colors
                    ${activeEnv === env
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    }
                  `}
                >
                  {env === 'local' && '🏠 '}
                  {env === 'branch' && '🌿 '}
                  {env === 'production' && '🚀 '}
                  {env.charAt(0).toUpperCase() + env.slice(1)}
                </button>
              ))}
            </nav>
          </div>

          {/* Active Environment Form */}
          <div className="bg-gray-50 rounded-lg p-4" key={`env-form-${activeEnv}-${JSON.stringify(sharedConfig)}`}>
            {activeEnv === 'local' && (
              <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-md text-xs text-blue-800">
                <strong>Local Development:</strong> Use DuckDB and test credentials for safe local testing
              </div>
            )}
            {activeEnv === 'branch' && (
              <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-md text-xs text-green-800">
                <strong>Branch/Staging:</strong> Use staging database and credentials for testing before production
              </div>
            )}
            {activeEnv === 'production' && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-800">
                <strong>Production:</strong> Use production database and credentials - handle with care!
              </div>
            )}

            {Object.entries(envSpecificParams).map(([key, param]) => renderField(key, param, activeEnv))}
          </div>
        </div>
      )}
    </div>
  );
};
