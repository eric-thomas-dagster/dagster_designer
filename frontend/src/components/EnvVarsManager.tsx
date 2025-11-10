import { useState, useEffect } from 'react';
import { Plus, Trash2, Eye, EyeOff, Save, RefreshCw } from 'lucide-react';
import { envVarsApi, type EnvVariable } from '@/services/api';

interface EnvVarsManagerProps {
  projectId: string;
}

export function EnvVarsManager({ projectId }: EnvVarsManagerProps) {
  const [variables, setVariables] = useState<EnvVariable[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [maskedValues, setMaskedValues] = useState<Set<string>>(new Set());
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    loadVariables();
  }, [projectId]);

  const loadVariables = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await envVarsApi.get(projectId);
      setVariables(response.variables);

      // Mask all sensitive variables by default
      const sensitiveMask = new Set(
        response.variables
          .filter(v => v.is_sensitive)
          .map(v => v.key)
      );
      setMaskedValues(sensitiveMask);
      setHasChanges(false);
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to load environment variables');
      console.error('Failed to load env vars:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleAddVariable = () => {
    setVariables([
      ...variables,
      { key: '', value: '', is_sensitive: false }
    ]);
    setHasChanges(true);
  };

  const handleRemoveVariable = (index: number) => {
    const newVariables = variables.filter((_, i) => i !== index);
    setVariables(newVariables);
    setHasChanges(true);
  };

  const handleUpdateVariable = (index: number, field: keyof EnvVariable, value: string | boolean) => {
    const newVariables = [...variables];
    newVariables[index] = { ...newVariables[index], [field]: value };
    setVariables(newVariables);
    setHasChanges(true);
  };

  const toggleMask = (key: string) => {
    const newMasked = new Set(maskedValues);
    if (newMasked.has(key)) {
      newMasked.delete(key);
    } else {
      newMasked.add(key);
    }
    setMaskedValues(newMasked);
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);

      // Validate variables
      for (const variable of variables) {
        if (!variable.key.trim()) {
          setError('All variables must have a key');
          return;
        }
      }

      await envVarsApi.update(projectId, variables);
      setHasChanges(false);

      // Show success message briefly
      const successMessage = 'Environment variables saved successfully';
      setError(null);
      alert(successMessage);
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to save environment variables');
      console.error('Failed to save env vars:', err);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-8 h-8 text-blue-600 animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Action Bar */}
      <div className="bg-white border-b border-gray-200 px-6 py-3">
        <div className="flex items-center justify-end space-x-3">
          <button
            onClick={loadVariables}
            disabled={loading}
            className="flex items-center space-x-2 px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            <span>Reload</span>
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !hasChanges}
            className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Save className="w-4 h-4" />
            <span>{saving ? 'Saving...' : 'Save Changes'}</span>
          </button>
        </div>
      </div>

      {/* Error message */}
      {error && (
        <div className="mx-6 mt-4 p-4 bg-red-50 border border-red-200 rounded-md">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {/* Variables List */}
      <div className="flex-1 overflow-y-auto p-6 pb-8">
        <div className="bg-white rounded-lg border border-gray-200">
          {/* Header */}
          <div className="grid grid-cols-12 gap-4 px-4 py-3 bg-gray-50 border-b border-gray-200 font-medium text-xs text-gray-700 uppercase tracking-wider">
            <div className="col-span-4">Variable Name</div>
            <div className="col-span-6">Value</div>
            <div className="col-span-2 text-right">Actions</div>
          </div>

          {/* Variables */}
          {variables.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              <p>No environment variables defined.</p>
              <p className="text-sm mt-2">Click "Add Variable" to create one.</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-200">
              {variables.map((variable, index) => (
                <div key={index} className="grid grid-cols-12 gap-4 px-4 py-3 items-center">
                  {/* Key */}
                  <div className="col-span-4">
                    <input
                      type="text"
                      value={variable.key}
                      onChange={(e) => handleUpdateVariable(index, 'key', e.target.value)}
                      placeholder="VARIABLE_NAME"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                    />
                  </div>

                  {/* Value */}
                  <div className="col-span-6">
                    <div className="relative">
                      <input
                        type={maskedValues.has(variable.key) && variable.is_sensitive ? 'password' : 'text'}
                        value={variable.value}
                        onChange={(e) => handleUpdateVariable(index, 'value', e.target.value)}
                        placeholder="value"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm pr-10"
                      />
                      {variable.is_sensitive && (
                        <button
                          onClick={() => toggleMask(variable.key)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                          title={maskedValues.has(variable.key) ? 'Show value' : 'Hide value'}
                        >
                          {maskedValues.has(variable.key) ? (
                            <Eye className="w-4 h-4" />
                          ) : (
                            <EyeOff className="w-4 h-4" />
                          )}
                        </button>
                      )}
                    </div>
                    {variable.is_sensitive && (
                      <p className="text-xs text-yellow-600 mt-1 flex items-center">
                        <span className="mr-1">⚠️</span>
                        Sensitive value - handle with care
                      </p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="col-span-2 flex items-center justify-end space-x-2">
                    <button
                      onClick={() => handleRemoveVariable(index)}
                      className="p-2 text-red-600 hover:bg-red-50 rounded-md transition-colors"
                      title="Remove variable"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Add Variable Button */}
          <div className="px-4 py-3 bg-gray-50 border-t border-gray-200">
            <button
              onClick={handleAddVariable}
              className="flex items-center space-x-2 px-4 py-2 text-blue-600 hover:bg-blue-50 rounded-md transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>Add Variable</span>
            </button>
          </div>
        </div>

        {/* Info Box */}
        <div className="mt-6 mb-4 p-4 bg-blue-50 border border-blue-200 rounded-md">
          <h3 className="text-sm font-medium text-blue-900 mb-2">About Environment Variables</h3>
          <ul className="text-sm text-blue-800 space-y-1">
            <li>• Environment variables are stored in the .env file at the project root</li>
            <li>• Variables are automatically loaded when running dagster dev or dg dev</li>
            <li>• Sensitive variables (containing "password", "secret", "key", "token", etc.) are automatically detected</li>
            <li>• Use UPPERCASE_WITH_UNDERSCORES for variable names by convention</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
