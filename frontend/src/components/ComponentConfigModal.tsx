import { useState, useEffect } from 'react';
import { X, Save, Download, CheckCircle, XCircle, Loader } from 'lucide-react';
import { useComponent } from '@/hooks/useComponentRegistry';
import { TranslationEditor } from './TranslationEditor';
import { useProjectStore } from '@/hooks/useProject';
import { dbtAdaptersApi, type AdapterInfo } from '@/services/api';
import type { ComponentInstance, ComponentSchema } from '@/types';

interface ComponentConfigModalProps {
  component: ComponentInstance | null;
  componentType?: string; // For new components
  onSave: (component: ComponentInstance) => void;
  onClose: () => void;
}

export function ComponentConfigModal({
  component,
  componentType,
  onSave,
  onClose,
}: ComponentConfigModalProps) {
  const isNew = !component;
  const type = component?.component_type || componentType || '';
  const { currentProject, loadProject } = useProjectStore();
  const { data: componentSchema } = useComponent(type, currentProject?.id);

  console.log('[ComponentConfigModal] Opened with:', {
    isNew,
    type,
    hasComponent: !!component,
    hasComponentType: !!componentType,
    hasSchema: !!componentSchema,
    componentAttributes: component?.attributes
  });

  const [formData, setFormData] = useState<Record<string, any>>(component?.attributes || {});
  const [label, setLabel] = useState(component?.label || '');
  const [description, setDescription] = useState(component?.description || '');
  const [translation, setTranslation] = useState<Record<string, any>>(component?.translation || {});
  const [sqlMode, setSqlMode] = useState<'inline' | 'file'>('inline');

  // DBT adapter state
  const [adapterInfo, setAdapterInfo] = useState<AdapterInfo[]>([]);
  const [loadingAdapterStatus, setLoadingAdapterStatus] = useState(false);
  const [installingAdapter, setInstallingAdapter] = useState<string | null>(null);
  const isDbtComponent = type.toLowerCase().includes('dbt');

  // Get list of available assets for dependencies dropdown
  const availableAssets = currentProject?.graph.nodes
    .filter((node: any) => node.node_kind === 'asset' || node.type === 'component')
    .map((node: any) => node.data.asset_key || node.data.label || node.id) || [];

  useEffect(() => {
    if (component) {
      setFormData(component.attributes || {});
      setLabel(component.label || '');
      setDescription(component.description || '');
      setTranslation(component.translation || {});

      // Initialize SQL mode based on existing value
      const sqlTemplate = component.attributes?.sql_template;
      if (typeof sqlTemplate === 'string' && !sqlTemplate.includes('\n') && sqlTemplate.endsWith('.sql')) {
        setSqlMode('file');
      } else {
        setSqlMode('inline');
      }
    }
  }, [component]);

  // Fetch adapter status for dbt components
  useEffect(() => {
    const fetchAdapterStatus = async () => {
      if (!isDbtComponent || !currentProject) return;

      setLoadingAdapterStatus(true);
      try {
        const status = await dbtAdaptersApi.getStatus(currentProject.id);
        setAdapterInfo(status.adapters);
      } catch (error) {
        console.error('Failed to fetch adapter status:', error);
      } finally {
        setLoadingAdapterStatus(false);
      }
    };

    fetchAdapterStatus();
  }, [isDbtComponent, currentProject]);

  if (!componentSchema) {
    return null;
  }

  const handleInstallAdapter = async (adapterType: string) => {
    if (!currentProject) return;

    setInstallingAdapter(adapterType);
    try {
      const result = await dbtAdaptersApi.install(currentProject.id, adapterType);

      if (result.success) {
        alert(`Successfully installed dbt-${adapterType}!`);
        // Refresh adapter status
        const status = await dbtAdaptersApi.getStatus(currentProject.id);
        setAdapterInfo(status.adapters);
      } else {
        alert(`Failed to install dbt-${adapterType}:\n${result.message}\n\nCheck console for details.`);
        console.error('Installation failed:', result.stderr);
      }
    } catch (error) {
      console.error('Failed to install adapter:', error);
      alert('Failed to install adapter. Check console for details.');
    } finally {
      setInstallingAdapter(null);
    }
  };

  const validateRequiredFields = (): { valid: boolean; missing: string[] } => {
    const missing: string[] = [];
    const required = componentSchema.schema.required || [];

    for (const fieldName of required) {
      const fieldValue = formData[fieldName];

      // Check if the field is missing or empty
      if (fieldValue === undefined || fieldValue === null || fieldValue === '') {
        missing.push(fieldName);
      } else if (typeof fieldValue === 'object' && !Array.isArray(fieldValue)) {
        // For nested objects, check if they have any values
        if (Object.keys(fieldValue).length === 0) {
          missing.push(fieldName);
        }
      }
    }

    return { valid: missing.length === 0, missing };
  };

  const handleSave = async () => {
    // Validate required fields
    const validation = validateRequiredFields();

    if (!validation.valid) {
      alert(
        `Please fill in all required fields before saving:\n\n` +
        validation.missing.map(f => `• ${f}`).join('\n')
      );
      return;
    }

    // Check if this is a community component (installed from templates)
    // Community components have ".components." in their type path
    const isCommunityComponent = type.includes('.components.');

    if (isCommunityComponent && currentProject) {
      // For community components, update the YAML file via API
      try {
        // Extract component_id from type
        // e.g., "dagster_snowflake_dbt_demo.components.rest_api_fetcher.RestApiFetcherComponent" -> "rest_api_fetcher"
        const parts = type.split('.');
        const componentsIndex = parts.indexOf('components');
        if (componentsIndex === -1 || componentsIndex + 1 >= parts.length) {
          throw new Error('Invalid community component type');
        }
        const componentId = parts[componentsIndex + 1];

        const response = await fetch(`/api/v1/templates/configure/${componentId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: currentProject.id,
            config: {
              name: label || componentId,
              ...formData
            }
          })
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ detail: 'Unknown error' }));
          throw new Error(errorData.detail || 'Failed to configure component');
        }

        const result = await response.json();

        // Reload the project and regenerate lineage to pick up the new asset
        console.log('[ComponentConfigModal] Reloading project and regenerating lineage after configuring community component');
        await loadProject(currentProject.id);

        // Automatically regenerate lineage so the new asset appears immediately
        try {
          const { projectsApi } = await import('@/services/api');
          await projectsApi.regenerateAssets(currentProject.id, true);
          console.log('[ComponentConfigModal] Lineage regenerated successfully');
        } catch (error) {
          console.error('[ComponentConfigModal] Failed to regenerate lineage:', error);
          // Don't fail the whole operation if regeneration fails
        }

        alert(`Component configured successfully!\n\nYAML file: ${result.yaml_file}\n\nThe asset has been added to your project.`);
        onClose();
      } catch (error: any) {
        console.error('Error configuring community component:', error);
        alert(`Failed to configure component:\n\n${error.message}`);
      }
    } else {
      // For built-in components, use the standard save flow
      const newComponent: ComponentInstance = {
        id: component?.id || `comp-${Date.now()}`,
        component_type: type,
        type: type, // Add type field for App.tsx to check
        label: label || componentSchema.name,
        description: description || undefined,
        attributes: formData,
        translation: Object.keys(translation).length > 0 ? translation : undefined,
        is_asset_factory: ['dbt', 'fivetran', 'sling', 'dlt', 'airbyte'].some(
          (lib) => type.toLowerCase().includes(lib)
        ),
      };
      onSave(newComponent);
    }
  };

  const handleFieldChange = (field: string, value: any) => {
    setFormData((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const handleNestedFieldChange = (parentField: string, subField: string, value: any) => {
    setFormData((prev) => ({
      ...prev,
      [parentField]: {
        ...(prev[parentField] || {}),
        [subField]: value,
      },
    }));
  };

  const renderNestedField = (parentField: string, subField: string, fieldSchema: any, value: any) => {
    const fieldType = fieldSchema.type;

    if (fieldType === 'string') {
      if (fieldSchema.multiline) {
        return (
          <textarea
            value={value || ''}
            onChange={(e) => handleNestedFieldChange(parentField, subField, e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
            placeholder={fieldSchema.description || subField}
            rows={6}
          />
        );
      }

      return (
        <input
          type="text"
          value={value || ''}
          onChange={(e) => handleNestedFieldChange(parentField, subField, e.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder={fieldSchema.description || subField}
        />
      );
    }

    if (fieldType === 'array') {
      return (
        <textarea
          value={Array.isArray(value) ? value.join('\n') : ''}
          onChange={(e) =>
            handleNestedFieldChange(parentField, subField, e.target.value.split('\n').filter(Boolean))
          }
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
          placeholder="One item per line"
          rows={3}
        />
      );
    }

    if (fieldType === 'object') {
      return (
        <textarea
          value={typeof value === 'object' ? JSON.stringify(value, null, 2) : ''}
          onChange={(e) => {
            try {
              handleNestedFieldChange(parentField, subField, JSON.parse(e.target.value));
            } catch {
              // Invalid JSON, ignore
            }
          }}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
          placeholder="{}"
          rows={4}
        />
      );
    }

    return (
      <input
        type="text"
        value={value || ''}
        onChange={(e) => handleNestedFieldChange(parentField, subField, e.target.value)}
        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    );
  };

  const renderField = (fieldName: string, fieldSchema: any) => {
    // Check if there's a display version of this field (e.g., project_path_display)
    const displayFieldName = `${fieldName}_display`;
    const hasDisplayVersion = displayFieldName in formData;
    const value = formData[fieldName] || '';
    const displayValue = hasDisplayVersion ? formData[displayFieldName] : value;
    const fieldType = fieldSchema.type;

    console.log('[ComponentConfigModal] Rendering field:', fieldName, 'type:', fieldType, 'has properties:', !!fieldSchema.properties, 'hasDisplayVersion:', hasDisplayVersion);

    // Special handling for sql_template field - allow choosing between inline SQL or file path
    if (fieldName === 'sql_template') {
      return (
        <div className="space-y-2">
          <div className="flex items-center space-x-4 mb-2">
            <label className="flex items-center space-x-2 cursor-pointer">
              <input
                type="radio"
                checked={sqlMode === 'inline'}
                onChange={() => {
                  setSqlMode('inline');
                  if (typeof value === 'string' && value.endsWith('.sql')) {
                    handleFieldChange(fieldName, '');
                  }
                }}
                className="w-4 h-4 text-blue-600"
              />
              <span className="text-sm text-gray-700">Inline SQL</span>
            </label>
            <label className="flex items-center space-x-2 cursor-pointer">
              <input
                type="radio"
                checked={sqlMode === 'file'}
                onChange={() => {
                  setSqlMode('file');
                  handleFieldChange(fieldName, '');
                }}
                className="w-4 h-4 text-blue-600"
              />
              <span className="text-sm text-gray-700">SQL File Path</span>
            </label>
          </div>

          {sqlMode === 'inline' ? (
            <textarea
              value={typeof value === 'string' ? value : ''}
              onChange={(e) => handleFieldChange(fieldName, e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              placeholder="SELECT * FROM my_table WHERE ..."
              rows={10}
            />
          ) : (
            <input
              type="text"
              value={typeof value === 'string' ? value : ''}
              onChange={(e) => handleFieldChange(fieldName, e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="queries/my_query.sql"
            />
          )}
          <p className="text-xs text-gray-500">
            {sqlMode === 'inline'
              ? 'Write your SQL query directly (supports Jinja2 templating)'
              : 'Path to SQL file relative to project root'}
          </p>
        </div>
      );
    }

    // Check if field has enum values - render as dropdown
    if (fieldSchema.enum && Array.isArray(fieldSchema.enum) && fieldSchema.enum.length > 0) {
      return (
        <select
          value={value || ''}
          onChange={(e) => handleFieldChange(fieldName, e.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
        >
          <option value="">Select {fieldName}...</option>
          {fieldSchema.enum.map((option: string) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    }

    if (fieldType === 'string') {
      // Check if this is a multiline field (like code)
      if (fieldSchema.multiline) {
        return (
          <textarea
            value={displayValue}
            onChange={(e) => handleFieldChange(fieldName, e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
            placeholder={fieldSchema.description || fieldName}
            rows={10}
          />
        );
      }

      return (
        <input
          type="text"
          value={displayValue}
          onChange={(e) => handleFieldChange(fieldName, e.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder={fieldSchema.description || fieldName}
          readOnly={hasDisplayVersion}
          title={hasDisplayVersion ? `Actual path: ${value}` : undefined}
        />
      );
    }

    if (fieldType === 'number' || fieldType === 'integer') {
      return (
        <input
          type="number"
          value={value}
          onChange={(e) => handleFieldChange(fieldName, parseFloat(e.target.value))}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder={fieldSchema.description || fieldName}
        />
      );
    }

    if (fieldType === 'boolean') {
      return (
        <label className="flex items-center space-x-2 cursor-pointer">
          <input
            type="checkbox"
            checked={value || false}
            onChange={(e) => handleFieldChange(fieldName, e.target.checked)}
            className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
          />
          <span className="text-sm text-gray-700">
            {fieldSchema.description || 'Enable'}
          </span>
        </label>
      );
    }

    if (fieldType === 'array') {
      // Special handling for deps and asset_selection fields - show multi-select dropdown
      if (fieldName === 'deps' || fieldName === 'asset_selection') {
        const selectedValues = Array.isArray(value) ? value : [];

        return (
          <div className="space-y-2">
            <select
              multiple
              value={selectedValues}
              onChange={(e) => {
                const selected = Array.from(e.target.selectedOptions, (option) => option.value);
                handleFieldChange(fieldName, selected);
              }}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              size={Math.min(6, Math.max(3, availableAssets.length))}
            >
              {availableAssets.map((assetKey: string) => (
                <option key={assetKey} value={assetKey}>
                  {assetKey}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500">
              Hold Cmd/Ctrl to select multiple assets
            </p>
            {selectedValues.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {selectedValues.map((dep: string) => (
                  <span
                    key={dep}
                    className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-blue-50 border border-blue-200 rounded text-blue-700"
                  >
                    {dep}
                    <button
                      onClick={() => {
                        handleFieldChange(
                          fieldName,
                          selectedValues.filter((d: string) => d !== dep)
                        );
                      }}
                      className="hover:text-blue-900"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      }

      // Default array rendering for other fields
      return (
        <textarea
          value={Array.isArray(value) ? value.join('\n') : ''}
          onChange={(e) =>
            handleFieldChange(fieldName, e.target.value.split('\n').filter(Boolean))
          }
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
          placeholder="One item per line"
          rows={4}
        />
      );
    }

    if (fieldType === 'object') {
      // Check if this object has nested properties defined in the schema
      if (fieldSchema.properties && typeof fieldSchema.properties === 'object') {
        const objValue = value || {};
        console.log('[ComponentConfigModal] Rendering nested object fields for:', fieldName, Object.keys(fieldSchema.properties));

        return (
          <div className="space-y-3 pl-4 border-l-2 border-blue-200 bg-blue-50 p-3 rounded">
            <div className="text-xs text-blue-600 font-medium mb-2">
              ↳ Nested fields ({Object.keys(fieldSchema.properties).length})
            </div>
            {Object.entries(fieldSchema.properties).map(([subFieldName, subFieldSchema]: [string, any]) => (
              <div key={subFieldName}>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  {subFieldName}
                  {subFieldSchema.description && (
                    <span className="font-normal text-gray-500 ml-1 text-xs">
                      - {subFieldSchema.description}
                    </span>
                  )}
                </label>
                {renderNestedField(fieldName, subFieldName, subFieldSchema, objValue[subFieldName])}
              </div>
            ))}
          </div>
        );
      }

      // Fallback to JSON textarea for objects without defined properties
      return (
        <textarea
          value={typeof value === 'object' ? JSON.stringify(value, null, 2) : ''}
          onChange={(e) => {
            try {
              handleFieldChange(fieldName, JSON.parse(e.target.value));
            } catch {
              // Invalid JSON, ignore
            }
          }}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
          placeholder="{}"
          rows={6}
        />
      );
    }

    return (
      <input
        type="text"
        value={value}
        onChange={(e) => handleFieldChange(fieldName, e.target.value)}
        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    );
  };

  const properties = componentSchema.schema.properties || {};

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">
            {isNew ? 'Add' : 'Edit'} Component: {componentSchema.name}
          </h2>
          <button onClick={onClose}>
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Component Label */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Label
            </label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder={`${componentSchema.name} Component`}
            />
          </div>

          {/* Component Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Describe what this component does..."
              rows={2}
            />
            <p className="text-xs text-gray-500 mt-1">
              This description will be shown on the component node in the lineage graph
            </p>
          </div>

          {/* Component schema description */}
          {componentSchema.description && (
            <div className="text-sm text-gray-600 bg-blue-50 border border-blue-200 rounded-md p-3">
              {componentSchema.description}
            </div>
          )}

          {/* DBT Adapter Status */}
          {isDbtComponent && currentProject && (
            <div className="border border-gray-200 rounded-md p-4 space-y-3">
              <h3 className="text-sm font-semibold text-gray-900 flex items-center">
                <span>DBT Adapter Status</span>
                {loadingAdapterStatus && (
                  <Loader className="w-4 h-4 ml-2 animate-spin text-gray-500" />
                )}
              </h3>

              {!loadingAdapterStatus && adapterInfo.length === 0 && (
                <p className="text-sm text-gray-500">
                  No DBT project detected or adapter information not available.
                </p>
              )}

              {!loadingAdapterStatus && adapterInfo.map((adapter) => (
                <div
                  key={adapter.adapter_type}
                  className={`p-3 rounded-md border ${
                    adapter.installed
                      ? 'bg-green-50 border-green-200'
                      : 'bg-yellow-50 border-yellow-200'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      {adapter.installed ? (
                        <CheckCircle className="w-5 h-5 text-green-600" />
                      ) : (
                        <XCircle className="w-5 h-5 text-yellow-600" />
                      )}
                      <div>
                        <p className="text-sm font-medium text-gray-900">
                          {adapter.package_name}
                          {adapter.version && (
                            <span className="ml-2 text-xs text-gray-500">
                              v{adapter.version}
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-gray-600">
                          {adapter.installed
                            ? 'Adapter is installed and ready to use'
                            : 'Required adapter is not installed'}
                        </p>
                      </div>
                    </div>

                    {!adapter.installed && (
                      <button
                        onClick={() => handleInstallAdapter(adapter.adapter_type)}
                        disabled={installingAdapter === adapter.adapter_type}
                        className="flex items-center space-x-1 px-3 py-1.5 text-xs bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {installingAdapter === adapter.adapter_type ? (
                          <>
                            <Loader className="w-3 h-3 animate-spin" />
                            <span>Installing...</span>
                          </>
                        ) : (
                          <>
                            <Download className="w-3 h-3" />
                            <span>Install</span>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              ))}

              {!loadingAdapterStatus && adapterInfo.length > 0 && (
                <p className="text-xs text-gray-500">
                  DBT adapters are detected from your profiles.yml file and are required to run your DBT models.
                </p>
              )}
            </div>
          )}

          {/* Dynamic fields from schema */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-gray-900">Configuration</h3>

            {Object.keys(properties).length === 0 && (
              <p className="text-sm text-gray-500">No configuration fields available</p>
            )}

            {Object.entries(properties).map(([fieldName, fieldSchema]: [string, any]) => (
              <div key={fieldName}>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {fieldName}
                  {componentSchema.schema.required?.includes(fieldName) && (
                    <span className="text-red-500 ml-1">*</span>
                  )}
                </label>
                {fieldSchema.description && (
                  <p className="text-xs text-gray-500 mb-1">{fieldSchema.description}</p>
                )}
                {renderField(fieldName, fieldSchema)}
              </div>
            ))}
          </div>

          {/* Translation Section */}
          <div className="border-t border-gray-200 pt-4 mt-4">
            <TranslationEditor value={translation} onChange={setTranslation} />
          </div>

          {/* Template variables hint */}
          <div className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-md p-3">
            <strong>Tip:</strong> Use template variables like{' '}
            <code className="bg-gray-200 px-1 rounded">{'{{ env.VAR_NAME }}'}</code> for
            environment variables, or{' '}
            <code className="bg-gray-200 px-1 rounded">{'{{ project_root }}/repo-name'}</code> to
            reference cloned git repositories
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 flex justify-end space-x-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex items-center space-x-1 px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700"
          >
            <Save className="w-4 h-4" />
            <span>Save Component</span>
          </button>
        </div>
      </div>
    </div>
  );
}
