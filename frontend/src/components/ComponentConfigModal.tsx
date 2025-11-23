import { useState, useEffect } from 'react';
import { X, Save, Download, CheckCircle, XCircle, Loader } from 'lucide-react';
import { useComponent } from '@/hooks/useComponentRegistry';
import { TranslationEditor } from './TranslationEditor';
import { EnhancedDataQualityChecksBuilder } from './EnhancedDataQualityChecksBuilder';
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
    componentAttributes: component?.attributes,
    currentProjectId: currentProject?.id,
  });

  const [formData, setFormData] = useState<Record<string, any>>(component?.attributes || {});
  const [label, setLabel] = useState(component?.label || '');
  const [description, setDescription] = useState(component?.description || '');
  const [translation, setTranslation] = useState<Record<string, any>>(component?.translation || {});
  const [sqlMode, setSqlMode] = useState<'inline' | 'file'>('inline');
  const [instanceNameError, setInstanceNameError] = useState<string | null>(null);

  // DBT adapter state
  const [adapterInfo, setAdapterInfo] = useState<AdapterInfo[]>([]);
  const [loadingAdapterStatus, setLoadingAdapterStatus] = useState(false);
  const [installingAdapter, setInstallingAdapter] = useState<string | null>(null);
  // Check if this is a DBT component (not DuckDB or other components containing "db")
  // Match patterns like "dbt_project", "DbtProject", "dagster_dbt.X", but not "duckdb_table_writer"
  const isDbtComponent = /\bdbt[_\.]|^dbt/i.test(type);

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

  // Check if this is a single-asset component (has asset_name field)
  // Must calculate before using in hooks
  const hasSingleAssetField = componentSchema?.schema?.properties?.asset_name !== undefined;
  const isCommunityComponent = type.includes('.components.');

  // Auto-sync label with asset_name for single-asset community components
  useEffect(() => {
    if (!componentSchema) return;
    if (isCommunityComponent && hasSingleAssetField && formData.asset_name) {
      // Only auto-set if label is empty or matches the old asset_name
      if (!label || label === component?.attributes?.asset_name) {
        setLabel(formData.asset_name);
      }
    }
  }, [componentSchema, formData.asset_name, hasSingleAssetField, isCommunityComponent, label, component]);

  // Auto-suggest instance name for new multi-check components
  useEffect(() => {
    if (!componentSchema) return;
    console.log('[ComponentConfigModal] Instance name auto-generation check:', {
      isNew,
      isCommunityComponent,
      hasSingleAssetField,
      hasLabel: !!label,
      hasSchema: !!componentSchema,
      type
    });

    if (isNew && isCommunityComponent && !hasSingleAssetField && !label && componentSchema) {
      // Extract component_id from type for default name suggestion
      const parts = type.split('.');
      const componentsIndex = parts.indexOf('components');
      console.log('[ComponentConfigModal] Extracting component_id:', { parts, componentsIndex });

      if (componentsIndex !== -1 && componentsIndex + 1 < parts.length) {
        const componentId = parts[componentsIndex + 1];
        // Suggest name with timestamp for uniqueness
        const timestamp = new Date().getTime().toString().slice(-6);
        const suggestedName = `${componentId}_${timestamp}`;
        console.log('[ComponentConfigModal] Setting auto-generated instance name:', suggestedName);
        setLabel(suggestedName);
      }
    }
  }, [isNew, isCommunityComponent, hasSingleAssetField, componentSchema, type, label]);

  // Early return after all hooks have been called
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

    // For community components, instance name (label) is required UNLESS it's a single-asset component
    // (single-asset components auto-generate the instance name from asset_name)
    if (isCommunityComponent && !hasSingleAssetField && (!label || label.trim() === '')) {
      missing.push('Instance Name');
    }

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

    // Special validation for assets field (enhanced data quality checks)
    // Check that all check configurations have a 'name' field
    if (formData.assets && typeof formData.assets === 'object') {
      for (const [assetKey, assetConfig] of Object.entries(formData.assets)) {
        if (typeof assetConfig === 'object' && assetConfig !== null) {
          // Check each check type (row_count_check, null_check, etc.)
          for (const [checkType, checks] of Object.entries(assetConfig)) {
            if (Array.isArray(checks)) {
              for (let i = 0; i < checks.length; i++) {
                const check = checks[i];
                if (typeof check === 'object' && (!check.name || check.name.trim() === '')) {
                  missing.push(`"${checkType}" check #${i + 1} for asset "${assetKey}" is missing a name`);
                }
              }
            }
          }
        }
      }
    }

    return { valid: missing.length === 0, missing };
  };

  // Validate instance name doesn't conflict with existing instances
  const validateInstanceName = async (instanceName: string): Promise<boolean> => {
    if (!currentProject || !instanceName) {
      return true; // Skip validation if no project or empty name
    }

    try {
      const parts = type.split('.');
      const componentsIndex = parts.indexOf('components');
      if (componentsIndex === -1 || componentsIndex + 1 >= parts.length) {
        return true; // Can't extract component_id, skip check
      }
      const componentId = parts[componentsIndex + 1];

      // Check if a folder with this instance name already exists
      const response = await fetch(
        `/api/v1/templates/check-instance/${currentProject.id}/${componentId}/${instanceName}`
      );

      if (response.ok) {
        const data = await response.json();
        if (data.exists && data.instance_name !== component?.label) {
          // Folder exists and it's not the current component being edited
          setInstanceNameError(`Instance "${instanceName}" already exists. Please choose a unique name.`);
          return false;
        }
      }

      setInstanceNameError(null);
      return true;
    } catch (error) {
      console.error('Failed to validate instance name:', error);
      // Don't block saving if validation fails
      setInstanceNameError(null);
      return true;
    }
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
      // Validate instance name doesn't conflict with existing instances
      if (isNew && !hasSingleAssetField) {
        const isValidName = await validateInstanceName(label);
        if (!isValidName) {
          return; // Validation failed, error message is already shown
        }
      }
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

        // For single-asset components, always use asset_name as the instance name
        const instanceName = (isCommunityComponent && hasSingleAssetField && formData.asset_name)
          ? formData.asset_name
          : (label || componentId);

        const response = await fetch(`/api/v1/templates/configure/${componentId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: currentProject.id,
            config: {
              name: instanceName,
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

    // Special handling for upstream_asset_keys - show multi-select dropdown filtered by output type
    if (fieldName === 'upstream_asset_keys') {
      // Parse current value (comma-separated string to array)
      const selectedValues = value ? value.split(',').map((s: string) => s.trim()).filter(Boolean) : [];

      // Check if component only accepts DataFrame inputs
      const acceptsDataFrames = componentSchema?.['x-dagster-io']?.inputs?.type === 'dataframe' ||
                                 componentSchema?.['x-dagster-io']?.inputs?.accepts?.includes('dataframe');

      // Filter available assets based on what the component accepts
      let filteredAssets = availableAssets;
      if (acceptsDataFrames) {
        // For now, use heuristics to identify DataFrame-producing assets
        // TODO: Could be enhanced by checking each asset's component schema
        filteredAssets = availableAssets.filter((assetKey: string) => {
          const assetNode = currentProject?.graph.nodes.find(
            (n: any) => (n.data.asset_key === assetKey || n.data.label === assetKey || n.id === assetKey)
          );
          if (!assetNode) return false;

          // Check if it's a known DataFrame-producing component type
          const componentType = assetNode.data.component_type || '';
          const isDataFrameProducer =
            componentType.includes('synthetic_data_generator') ||
            componentType.includes('dataframe_transformer') ||
            componentType.includes('csv_file') ||
            componentType.includes('database_query') ||
            componentType.includes('rest_api') ||
            componentType.includes('duckdb_query') ||
            componentType.includes('time_series');

          return isDataFrameProducer;
        });
      }

      return (
        <div className="space-y-2">
          <select
            multiple
            value={selectedValues}
            onChange={(e) => {
              const selected = Array.from(e.target.selectedOptions, (option) => option.value);
              // Convert array back to comma-separated string
              handleFieldChange(fieldName, selected.join(', '));
            }}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            size={Math.min(6, Math.max(3, filteredAssets.length))}
          >
            {filteredAssets.length === 0 ? (
              <option disabled>
                {acceptsDataFrames
                  ? 'No DataFrame-producing assets available. Add a data source component first.'
                  : 'No assets available'}
              </option>
            ) : (
              filteredAssets.map((assetKey: string) => (
                <option key={assetKey} value={assetKey}>
                  {assetKey}
                </option>
              ))
            )}
          </select>
          <p className="text-xs text-gray-500">
            {acceptsDataFrames
              ? 'Hold Cmd/Ctrl to select multiple DataFrame assets. Only showing assets that output DataFrames.'
              : 'Hold Cmd/Ctrl to select multiple assets'}
          </p>
          {selectedValues.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {selectedValues.map((assetKey: string) => (
                <span
                  key={assetKey}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-blue-50 border border-blue-200 rounded text-blue-700"
                >
                  {assetKey}
                  <button
                    onClick={() => {
                      const newSelected = selectedValues.filter((k: string) => k !== assetKey);
                      handleFieldChange(fieldName, newSelected.join(', '));
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
      // Special handling for assets field to provide better placeholder
      const isAssetsField = fieldName === 'assets';
      const assetsPlaceholder = `{
  "asset_key_1": {
    "row_count_check": [
      {
        "name": "check_row_count",
        "min_rows": 1
      }
    ]
  }
}`;

      return (
        <div className="space-y-2">
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
            placeholder={isAssetsField ? assetsPlaceholder : "{}"}
            rows={isAssetsField ? 12 : 6}
          />
          {isAssetsField && (
            <p className="text-xs text-orange-600 bg-orange-50 border border-orange-200 rounded px-2 py-1">
              <strong>Important:</strong> Each check MUST have a unique "name" field. Empty names will cause issues.
            </p>
          )}
        </div>
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
          {/* Component Label / Instance Name - only show for non-community or multi-asset components */}
          {(!isCommunityComponent || !hasSingleAssetField) && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {isCommunityComponent ? 'Instance Name' : 'Label'}
                {isCommunityComponent && !hasSingleAssetField && <span className="text-red-500 ml-1">*</span>}
              </label>
              <input
                type="text"
                value={label}
                onChange={(e) => {
                  setLabel(e.target.value);
                  // Clear error when user types
                  if (instanceNameError) {
                    setInstanceNameError(null);
                  }
                }}
                onBlur={(e) => {
                  // Validate on blur for multi-check components
                  if (isNew && isCommunityComponent && !hasSingleAssetField && e.target.value) {
                    validateInstanceName(e.target.value);
                  }
                }}
                className={`w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 ${
                  instanceNameError
                    ? 'border-red-500 focus:ring-red-500'
                    : 'border-gray-300 focus:ring-blue-500'
                }`}
                placeholder={isCommunityComponent ?
                  `Enter unique name (e.g., ${componentSchema.name.toLowerCase().replace(/\s+/g, '_')}_1)` :
                  `${componentSchema.name} Component`}
                required={isCommunityComponent && !hasSingleAssetField}
              />
              {instanceNameError && (
                <p className="text-xs text-red-600 mt-1 flex items-center">
                  <span className="font-semibold mr-1">⚠</span> {instanceNameError}
                </p>
              )}
              {!instanceNameError && isCommunityComponent && !hasSingleAssetField && (
                <p className="text-xs text-gray-500 mt-1">
                  Each instance needs a unique name to avoid overwriting previous configurations
                </p>
              )}
            </div>
          )}

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

          {/* Visual Editor Notice for DataFrameTransformerComponent */}
          {type.includes('DataFrameTransformerComponent') && (
            <div className="bg-gradient-to-r from-purple-50 to-blue-50 border-2 border-purple-300 rounded-lg p-4">
              <div className="flex items-start space-x-3">
                <div className="flex-shrink-0">
                  <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
                <div className="flex-1">
                  <h4 className="text-sm font-semibold text-purple-900 mb-1">
                    Visual Editor Available
                  </h4>
                  <p className="text-sm text-purple-800 mb-3">
                    This transformer has a powerful visual editor with drag-and-drop configuration for all transformations including pivot/unpivot, aggregations, and more.
                  </p>
                  <div className="text-xs text-purple-700 bg-purple-100 border border-purple-200 rounded px-3 py-2">
                    <strong>To access:</strong> Click on the asset in the graph → Click the "View Data" button in the dropdown menu → Configure transformations visually
                  </div>
                </div>
              </div>
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

            {/* Special handling for Enhanced Data Quality Checks */}
            {type.includes('EnhancedDataQualityChecks') ? (
              <div className="pt-2 border-t border-gray-200">
                <EnhancedDataQualityChecksBuilder
                  assets={currentProject?.graph.nodes
                    .filter((node: any) => node.node_kind === 'asset' || node.type === 'asset')
                    .map((node: any) => node.data.asset_key || node.id) || []}
                  onConfigChange={(config) => setFormData({ ...formData, ...config })}
                />
              </div>
            ) : (
              <>
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
              </>
            )}
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
