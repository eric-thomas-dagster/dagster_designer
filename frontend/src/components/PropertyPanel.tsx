import { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useProjectStore } from '@/hooks/useProject';
import { useComponent } from '@/hooks/useComponentRegistry';
import { X, Save, Settings, Play, Trash2, Plus, Wand2, Database, Search, Package, ChevronDown, FileCode, Calendar, Table } from 'lucide-react';
import { AssetPreview } from './AssetPreview';
import { TranslationEditor } from './TranslationEditor';
import { Launchpad } from './Launchpad';
import { PartitionBackfill } from './PartitionBackfill';
import { PartitionConfig, type PartitionConfig as PartitionConfigType } from './PartitionConfig';
import { DataPreviewModal } from './DataPreviewModal';
import { projectsApi, primitivesApi, partitionsApi, templatesApi, type BackfillRequest } from '@/services/api';
import type { ComponentInstance } from '@/types';

// Icon mapping for component icons
const iconMap: Record<string, any> = {
  'Wand2': Wand2,
  'Database': Database,
  'Search': Search,
  'Package': Package,
};

// Helper to check if a component is a dbt component (including custom dbt components)
const isDbtComponentType = (componentType: string | undefined): boolean => {
  if (!componentType) return false;
  // Check for standard dbt component
  if (componentType === 'dagster_dbt.DbtProjectComponent') return true;
  // Check for custom dbt components (matches by class name, not full module path)
  if (componentType.includes('DbtProjectWithTranslatorComponent')) return true;
  if (componentType.includes('DbtProjectComponent')) return true;
  // Also check the generic component catalog type
  if (componentType === 'dagster_designer_components.DbtProjectWithTranslatorComponent') return true;
  return false;
};

interface ComponentTemplate {
  id: string;
  name: string;
  category: string;
  supports_partitions?: boolean;
  supported_partition_types?: string[];
}

interface TemplateManifest {
  components: ComponentTemplate[];
}

interface PropertyPanelProps {
  nodeId: string;
  onConfigureComponent?: (component: ComponentInstance) => void;
  onOpenFile?: (filePath: string) => void;
}

export function PropertyPanel({ nodeId, onConfigureComponent, onOpenFile }: PropertyPanelProps) {
  const { currentProject, updateGraph, loadProject } = useProjectStore();
  const node = currentProject?.graph.nodes.find((n) => n.id === nodeId);

  // Fetch component templates manifest to check partition support
  // IMPORTANT: All hooks must be called before any conditional returns
  const { data: manifest } = useQuery({
    queryKey: ['community-templates-manifest'],
    queryFn: async () => {
      const response = await fetch('/api/v1/templates/manifest');
      if (!response.ok) {
        throw new Error('Failed to fetch manifest');
      }
      return response.json() as Promise<TemplateManifest>;
    },
    staleTime: Infinity, // Never refetch automatically
    gcTime: Infinity, // Keep in cache forever (formerly cacheTime)
  });

  // Fetch installed templates for this project
  const { data: installedTemplates } = useQuery({
    queryKey: ['installed-templates', currentProject?.id],
    queryFn: async () => {
      if (!currentProject?.id) return { components: [] };
      return templatesApi.getInstalled(currentProject.id);
    },
    enabled: !!currentProject?.id,
    staleTime: 30000, // Refetch after 30 seconds
  });

  // Return early if node is not found (AFTER all hooks have been called)
  if (!node) {
    return (
      <aside className="property-panel">
        <div className="p-4 text-sm text-gray-500">
          Node not found
        </div>
      </aside>
    );
  }

  // Handle both backend structure (node_kind at top level) and React Flow structure (node_kind in data)
  const nodeKind = (node as any)?.node_kind || node?.data?.node_kind;
  const sourceComponentId = (node as any)?.source_component || node?.data?.source_component;
  const isAssetNode = nodeKind === 'asset';

  // Check if current component supports partitions (memoized for performance)
  const componentType = node?.data.component_type;
  const componentSupportsPartitions = useMemo(() => {
    if (!componentType || !manifest) return false;

    // Extract component ID from component_type
    // Format: "project_name.components.component_id.ComponentClass"
    // We want the second-to-last part (component_id)
    const parts = componentType.split('.');
    const componentId = parts.length > 1 ? parts[parts.length - 2] : null;

    if (!componentId) return false;

    // Find component in manifest
    const template = manifest.components.find(c => c.id === componentId);
    return template?.supports_partitions === true;
  }, [componentType, manifest]);

  // Get supported partition types for the component
  const supportedPartitionTypes = useMemo(() => {
    if (!componentType || !manifest?.components) return undefined;

    // Extract component ID from component_type
    const parts = componentType.split('.');
    const componentId = parts.length > 1 ? parts[parts.length - 2] : null;

    if (!componentId) return undefined;

    // Find component in manifest and return supported_partition_types
    const template = manifest.components.find(c => c.id === componentId);
    return template?.supported_partition_types;
  }, [componentType, manifest]);

  // Handle both regular components and community components
  const [sourceComponent, setSourceComponent] = useState<ComponentInstance | null>(null);
  const [loadingCommunityComponent, setLoadingCommunityComponent] = useState(false);

  // Load source component (regular or community)
  useEffect(() => {
    if (!isAssetNode || !sourceComponentId) {
      setSourceComponent(null);
      return;
    }

    // First try to find component in project.components (works for both regular and community)
    // Community components have the 'community_' prefix stripped from their ID in the components list
    const componentId = sourceComponentId.startsWith('community_')
      ? sourceComponentId.replace('community_', '')
      : sourceComponentId;

    const comp = currentProject?.components.find((c) => c.id === componentId);

    if (comp) {
      // Found in components list - use it directly (has correct label)
      setSourceComponent(comp);
      setLoadingCommunityComponent(false);
    } else if (sourceComponentId.includes('.components.')) {
      // Handle case where source_component is a full component type
      // e.g., "project_name.components.dataframe_transformer.DataFrameTransformerComponent"
      // Extract component name from type and use asset's component data
      const parts = sourceComponentId.split('.');
      const componentIdx = parts.indexOf('components');
      const componentName = componentIdx >= 0 && componentIdx + 1 < parts.length
        ? parts[componentIdx + 1]
        : parts[parts.length - 1] || 'Component';
      const displayName = componentName.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

      // Create a component instance from the asset's component data
      const assetComponentId = (node as any)?.data?.component_id || node?.id;
      setSourceComponent({
        id: assetComponentId,
        component_type: sourceComponentId,
        label: displayName,
        attributes: (node as any)?.data?.component_attributes || {},
        is_asset_factory: false,
      });
      setLoadingCommunityComponent(false);
    } else if (sourceComponentId.startsWith('community_')) {
      // Community component not in list - load from backend as fallback
      const componentName = sourceComponentId.replace('community_', '');
      setLoadingCommunityComponent(true);

      fetch(`/api/v1/projects/${currentProject?.id}/community-component/${componentName}`)
        .then(res => res.json())
        .then(data => {
          setSourceComponent({
            id: sourceComponentId,
            component_type: data.component_type,
            label: data.display_name || componentName.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
            attributes: data.attributes || {},
          });
        })
        .catch(err => {
          console.error(`[PropertyPanel] Failed to load community component ${componentName}:`, err);
          setSourceComponent(null);
        })
        .finally(() => {
          setLoadingCommunityComponent(false);
        });
    } else {
      setSourceComponent(null);
      setLoadingCommunityComponent(false);
    }
  }, [isAssetNode, sourceComponentId, currentProject?.id, currentProject?.components, nodeId]);

  const { data: componentSchema } = useComponent(node?.data.component_type || '');

  const [formData, setFormData] = useState<Record<string, any>>({});
  const [label, setLabel] = useState('');
  const [translation, setTranslation] = useState<Record<string, any>>({});
  const [gitRepo, setGitRepo] = useState('');
  const [gitBranch, setGitBranch] = useState('main');
  const [isCloning, setIsCloning] = useState(false);
  const [isMaterializing, setIsMaterializing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [materializeResult, setMaterializeResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saveResult, setSaveResult] = useState<{ success: boolean; message: string } | null>(null);
  const [showMaterializeMenu, setShowMaterializeMenu] = useState(false);
  const [showLaunchpad, setShowLaunchpad] = useState(false);
  const [showBackfillModal, setShowBackfillModal] = useState(false);
  const [showDataPreview, setShowDataPreview] = useState(false);
  const [isPartitioned, setIsPartitioned] = useState(false);

  // Compute asset key for API calls
  const assetKey = node?.data?.asset_key || node?.id || '';
  const [checkingPartitions, setCheckingPartitions] = useState(false);
  const [assetConfigSchema, setAssetConfigSchema] = useState<any>(null);
  const [assetDefaultConfig, setAssetDefaultConfig] = useState<any>(null);
  const [editableMetadata, setEditableMetadata] = useState({
    description: '',
    group_name: '',
    owners: [] as string[],
  });
  const [hasEdited, setHasEdited] = useState(false);

  useEffect(() => {
    // Only reset form when switching to a different node (nodeId changes)
    // Don't reset while user is editing or saving
    if (node && !hasEdited && !isSaving) {
      setFormData(node.data.attributes || {});
      setLabel(node.data.label || '');
      setTranslation(node.data.translation || {});

      // Initialize editable metadata for assets
      if (isAssetNode) {
        setEditableMetadata({
          description: node.data.description || '',
          group_name: node.data.group_name || '',
          owners: node.data.owners || [],
        });
      }
    }
  }, [nodeId, node, isAssetNode, hasEdited, isSaving]);

  // Check if asset is partitioned
  useEffect(() => {
    if (isAssetNode && currentProject && node) {
      const assetKey = node.data.asset_key || node.id;
      setCheckingPartitions(true);
      setIsPartitioned(false);

      partitionsApi
        .getPartitionInfo(currentProject.id, assetKey)
        .then((response) => {
          setIsPartitioned(response.is_partitioned);
        })
        .catch((err) => {
          console.error('[PropertyPanel] Failed to check partitions:', err);
          setIsPartitioned(false);
        })
        .finally(() => {
          setCheckingPartitions(false);
        });
    } else {
      setIsPartitioned(false);
    }
  }, [isAssetNode, currentProject?.id, nodeId, node]);

  if (!node) {
    return null;
  }

  // Handle asset nodes differently
  if (isAssetNode) {
    const handleSaveMetadata = async () => {
      if (!currentProject) return;

      setIsSaving(true);
      setSaveResult(null);

      try {
        // Check if this asset is from a dbt component and has customizations
        const isDbtAsset = isDbtComponentType(sourceComponent?.component_type);
        const assetKey = node.data.asset_key || node.id;

        // Check if metadata has changed from original
        const hasCustomizations =
          editableMetadata.description !== (node.data.description || '') ||
          editableMetadata.group_name !== (node.data.group_name || '') ||
          JSON.stringify(editableMetadata.owners || []) !== JSON.stringify(node.data.owners || []);

        console.log('[PropertyPanel] Save debug:', {
          sourceComponent: sourceComponent?.component_type,
          isDbtAsset,
          assetKey,
          hasSourceComponent: !!sourceComponent,
          hasCustomizations,
          editableMetadata,
          nodeData: {
            description: node.data.description,
            group_name: node.data.group_name,
            owners: node.data.owners,
          },
        });

        if (isDbtAsset && hasCustomizations && sourceComponent) {
          // For dbt assets with customizations, we need to:
          // 1. Create a new dbt component for this specific asset with translation
          // 2. Exclude this asset from the original dbt component
          // 3. Regenerate assets to apply changes

          // Find the dbt model name from the asset key (last part)
          const dbtModelName = assetKey.split('/').pop() || assetKey;

          // Check if there's already a customization component for this asset
          const existingCustomComponent = currentProject.components.find(
            (c) =>
              c.component_type === 'dagster_dbt.DbtProjectComponent' &&
              c.attributes?.select === dbtModelName
          );

          // Build translation object from customizations
          const translation: Record<string, any> = {};
          if (editableMetadata.group_name) {
            translation.group_name = editableMetadata.group_name;
          }
          if (editableMetadata.description) {
            translation.description = editableMetadata.description;
          }
          if (editableMetadata.owners && editableMetadata.owners.length > 0) {
            translation.owners = editableMetadata.owners;
          }

          let updatedComponents: ComponentInstance[];

          if (existingCustomComponent) {
            // Update existing customization component
            updatedComponents = currentProject.components.map((c) =>
              c.id === existingCustomComponent.id
                ? {
                    ...c,
                    translation,
                  }
                : c
            );
          } else {
            // Create new customization component
            const customComponent: ComponentInstance = {
              id: `dbt-custom-${Date.now()}`,
              component_type: 'dagster_dbt.DbtProjectComponent',
              label: `dbt: ${dbtModelName} (customized)`,
              attributes: {
                // Support both project_path (created by tool) and project (imported)
                project_path: sourceComponent.attributes.project_path || sourceComponent.attributes.project,
                select: dbtModelName,
              },
              translation,
              is_asset_factory: true,
            };

            // Update the original component to exclude this asset
            const originalExclude = sourceComponent.attributes.exclude || '';
            const excludeList = originalExclude ? originalExclude.split(',').map(s => s.trim()) : [];

            if (!excludeList.includes(dbtModelName)) {
              excludeList.push(dbtModelName);
            }

            updatedComponents = currentProject.components.map((c) =>
              c.id === sourceComponent.id
                ? {
                    ...c,
                    attributes: {
                      ...c.attributes,
                      exclude: excludeList.join(', '),
                    },
                  }
                : c
            );

            // Add the new customization component
            updatedComponents.push(customComponent);
          }

          // Update the project with new components list
          await projectsApi.updateProject(currentProject.id, {
            components: updatedComponents,
          });

          // Regenerate assets to apply the changes
          console.log('Regenerating assets after dbt customization...');
          await projectsApi.regenerateAssets(currentProject.id);

          // Refresh the project state to show updated assets
          await loadProject(currentProject.id);

          setSaveResult({
            success: true,
            message: `Customization applied to "${dbtModelName}". The asset has been moved to the "${editableMetadata.group_name}" group.`,
          });
        } else {
          // For non-dbt assets or assets without source component, just update the node
          const updatedNodes = currentProject.graph.nodes.map((n) =>
            n.id === nodeId
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    description: editableMetadata.description,
                    group_name: editableMetadata.group_name,
                    owners: editableMetadata.owners,
                  },
                }
              : n
          );

          updateGraph(updatedNodes, currentProject.graph.edges);

          setSaveResult({
            success: true,
            message: 'Asset metadata updated successfully.',
          });
        }

        // Always save the graph to persist any partition config changes
        await projectsApi.update(currentProject.id, {
          graph: currentProject.graph,
        });

      } catch (error) {
        console.error('Failed to save metadata:', error);
        setSaveResult({
          success: false,
          message: 'Failed to save metadata. Check console for details.',
        });
      } finally {
        setIsSaving(false);
        setHasEdited(false);
      }
    };

    const handleAddOwner = () => {
      const owner = prompt('Enter owner email or team name:');
      if (owner && owner.trim()) {
        setEditableMetadata({
          ...editableMetadata,
          owners: [...editableMetadata.owners, owner.trim()],
        });
        setHasEdited(true);
      }
    };

    const handleRemoveOwner = (index: number) => {
      setEditableMetadata({
        ...editableMetadata,
        owners: editableMetadata.owners.filter((_, i) => i !== index),
      });
      setHasEdited(true);
    };

    const handleMaterialize = async () => {
      if (!currentProject) return;

      setIsMaterializing(true);
      setMaterializeResult(null);

      try {
        const assetKey = node.data.asset_key || node.id;
        const result = await projectsApi.materialize(currentProject.id, [assetKey]);

        setMaterializeResult({
          success: result.success,
          message: result.message,
        });

        if (result.success) {
          console.log('Materialization output:', result.stdout);
        } else {
          console.error('Materialization failed:', result.stderr);
        }
      } catch (error) {
        console.error('Materialize failed:', error);
        setMaterializeResult({
          success: false,
          message: 'Failed to materialize asset. Check console for details.',
        });
      } finally {
        setIsMaterializing(false);
      }
    };

    const handleOpenLaunchpad = async () => {
      setShowMaterializeMenu(false);

      // Fetch config schema before opening
      if (currentProject && node) {
        const assetKey = node.data.asset_key || node.id;
        try {
          const configInfo = await partitionsApi.getConfigSchema(currentProject.id, assetKey);
          if (configInfo.has_config) {
            setAssetConfigSchema(configInfo.config_schema);
            setAssetDefaultConfig(configInfo.default_config);
          } else {
            setAssetConfigSchema(null);
            setAssetDefaultConfig(null);
          }
        } catch (err) {
          console.error('[PropertyPanel] Failed to fetch config schema:', err);
          setAssetConfigSchema(null);
          setAssetDefaultConfig(null);
        }
      }

      setShowLaunchpad(true);
    };

    const handleLaunchpadSubmit = async (config?: Record<string, any>, tags?: Record<string, string>) => {
      if (!currentProject) return;

      setIsMaterializing(true);
      setMaterializeResult(null);

      try {
        const assetKey = node.data.asset_key || node.id;
        const result = await projectsApi.materialize(currentProject.id, [assetKey], config, tags);

        setMaterializeResult({
          success: result.success,
          message: result.message,
        });

        if (result.success) {
          console.log('Materialization output:', result.stdout);
        } else {
          console.error('Materialization failed:', result.stderr);
        }
      } catch (error) {
        console.error('Materialize failed:', error);
        setMaterializeResult({
          success: false,
          message: 'Failed to materialize asset. Check console for details.',
        });
        throw error;
      } finally {
        setIsMaterializing(false);
      }
    };

    const handleOpenBackfill = () => {
      setShowMaterializeMenu(false);
      setShowBackfillModal(true);
    };

    const handleBackfillSubmit = async (request: BackfillRequest) => {
      if (!currentProject) return;

      setIsMaterializing(true);
      setMaterializeResult(null);

      try {
        const result = await partitionsApi.launchBackfill(currentProject.id, request);

        setMaterializeResult({
          success: result.success,
          message: result.message,
        });

        if (result.success) {
          console.log('Backfill output:', result.stdout);
        } else {
          console.error('Backfill failed:', result.stderr);
        }
      } catch (error) {
        console.error('Backfill failed:', error);
        setMaterializeResult({
          success: false,
          message: 'Failed to launch backfill. Check console for details.',
        });
        throw error;
      } finally {
        setIsMaterializing(false);
      }
    };

    // Get component icon from node data
    const componentIconName = node.data.component_icon;
    const ComponentIcon = componentIconName ? iconMap[componentIconName] || Package : Package;

    return (
      <div className="h-full flex flex-col">
        <div className="p-4 border-b border-gray-200">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center space-x-2">
              {componentIconName && <ComponentIcon className="w-5 h-5 text-purple-600" />}
              <h2 className="text-lg font-semibold text-gray-900">
                {sourceComponent ? `${sourceComponent.label} Asset` : 'Asset Details'}
              </h2>
            </div>
            <div className="flex items-center space-x-2">
              <div className="relative">
                <button
                  onClick={() => setShowMaterializeMenu(!showMaterializeMenu)}
                  disabled={isMaterializing}
                  className="flex items-center space-x-1 px-3 py-1.5 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                >
                  <Play className="w-4 h-4" />
                  <span>{isMaterializing ? 'Materializing...' : 'Materialize'}</span>
                  <ChevronDown className="w-3 h-3" />
                </button>
                {showMaterializeMenu && (
                  <>
                    <div
                      className="fixed inset-0 z-10"
                      onClick={() => setShowMaterializeMenu(false)}
                    />
                    <div className="absolute right-0 mt-1 w-48 bg-white border border-gray-200 rounded-md shadow-lg z-20">
                      {!isPartitioned && (
                        <button
                          onClick={() => {
                            handleMaterialize();
                            setShowMaterializeMenu(false);
                          }}
                          className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 text-left"
                        >
                          <Play className="w-4 h-4" />
                          Materialize
                        </button>
                      )}
                      <button
                        onClick={handleOpenLaunchpad}
                        className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 text-left"
                      >
                        <FileCode className="w-4 h-4" />
                        Open Launchpad
                      </button>
                      {isPartitioned && (
                        <button
                          onClick={handleOpenBackfill}
                          className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 text-left"
                        >
                          <Calendar className="w-4 h-4" />
                          Launch Backfill
                        </button>
                      )}
                      <button
                        onClick={() => {
                          setShowDataPreview(true);
                          setShowMaterializeMenu(false);
                        }}
                        className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 text-left"
                      >
                        <Table className="w-4 h-4" />
                        View Data
                      </button>
                    </div>
                  </>
                )}
              </div>
              <button
                onClick={handleSaveMetadata}
                disabled={isSaving}
                className="flex items-center space-x-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
              >
                <Save className="w-4 h-4" />
                <span>{isSaving ? 'Saving...' : 'Save'}</span>
              </button>
            </div>
          </div>
          {materializeResult && (
            <div className={`text-xs px-3 py-2 rounded-md ${materializeResult.success ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>
              {materializeResult.message}
            </div>
          )}
          {saveResult && (
            <div className={`text-xs px-3 py-2 rounded-md ${saveResult.success ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>
              {saveResult.message}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* dbt Asset Notice */}
          {isDbtComponentType(sourceComponent?.component_type) && (
            <div className="text-xs bg-blue-50 border border-blue-200 rounded-md p-3">
              <div className="flex items-start space-x-2">
                <div className="flex-shrink-0 mt-0.5">
                  <svg className="w-4 h-4 text-blue-600" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                  </svg>
                </div>
                <div>
                  <strong className="text-blue-900">dbt Asset Customization</strong>
                  <p className="mt-1 text-blue-800">
                    Customizing this dbt asset will create a new dbt component with <code className="bg-blue-100 px-1 rounded">select</code> for this model and exclude it from the original component.
                    Changes will be applied via <code className="bg-blue-100 px-1 rounded">translation</code>.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Asset Key (Read-only) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Asset Key
            </label>
            <div className="px-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-md text-gray-900 font-mono">
              {node.data.asset_key || node.id}
            </div>
          </div>

          {/* dbt Model Source - Link to SQL file */}
          {node.data.source && node.data.kinds?.includes('dbt') && isDbtComponentType(sourceComponent?.component_type) && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                dbt Model
              </label>
              <button
                onClick={() => {
                  if (!onOpenFile) return;
                  // The source for dbt models is like "dbt_project/models/marts/customer_metrics.sql"
                  // The project_path is like "/path/to/project/dbt_project"
                  // We need to go up one level and append the source
                  const dbtProjectPath = sourceComponent.attributes.project_path || sourceComponent.attributes.project;
                  const modelPath = node.data.source;

                  // Get the parent directory of dbt_project
                  const pathParts = dbtProjectPath.split('/');
                  pathParts.pop(); // Remove "dbt_project"
                  const projectRoot = pathParts.join('/');

                  // Construct full path: project_root + / + model_path
                  const fullPath = `${projectRoot}/${modelPath}`;
                  onOpenFile(fullPath);
                }}
                className="w-full px-3 py-2 text-sm bg-orange-50 border border-orange-200 rounded-md text-orange-700 font-mono hover:bg-orange-100 transition-colors text-left flex items-center justify-between group"
              >
                <span className="truncate">{node.data.source}</span>
                <svg className="w-4 h-4 flex-shrink-0 ml-2 opacity-50 group-hover:opacity-100" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </button>
              <p className="text-xs text-gray-500 mt-1">
                Click to open dbt model in code editor
              </p>
            </div>
          )}

          {/* Source Code (Read-only with link) - Only for Python assets, not dbt */}
          {node.data.source && !node.data.kinds?.includes('dbt') && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Source Code
              </label>
              <button
                onClick={() => {
                  if (!onOpenFile) return;
                  // Navigate to code editor and open the file
                  const sourceFile = node.data.source;
                  onOpenFile(sourceFile);
                }}
                className="w-full px-3 py-2 text-sm bg-blue-50 border border-blue-200 rounded-md text-blue-700 font-mono hover:bg-blue-100 transition-colors text-left flex items-center justify-between group"
              >
                <span className="truncate">{node.data.source}</span>
                <svg className="w-4 h-4 flex-shrink-0 ml-2 opacity-50 group-hover:opacity-100" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </button>
              <p className="text-xs text-gray-500 mt-1">
                Click to open in code editor
              </p>
            </div>
          )}

          {/* Label (Read-only) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Label
            </label>
            <div className="px-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-md text-gray-900">
              {node.data.label}
            </div>
          </div>

          {/* Description (Editable) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Description
            </label>
            <textarea
              value={editableMetadata.description}
              onChange={(e) => {
                setEditableMetadata({ ...editableMetadata, description: e.target.value });
                setHasEdited(true);
              }}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Add a description for this asset..."
              rows={4}
            />
          </div>

          {/* Group Name (Editable) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Group Name
            </label>
            <input
              type="text"
              value={editableMetadata.group_name}
              onChange={(e) => {
                setEditableMetadata({ ...editableMetadata, group_name: e.target.value });
                setHasEdited(true);
              }}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g., analytics, raw_data, staging"
            />
            <p className="text-xs text-gray-500 mt-1">
              Assets with the same group will be visually grouped together
            </p>
          </div>

          {/* Owners (Editable) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Owners
            </label>
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                {editableMetadata.owners.map((owner: string, idx: number) => (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-purple-50 border border-purple-200 rounded text-purple-700"
                  >
                    {owner}
                    <button
                      onClick={() => handleRemoveOwner(idx)}
                      className="hover:text-purple-900"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
              <button
                onClick={handleAddOwner}
                className="text-xs text-blue-600 hover:text-blue-700 font-medium"
              >
                + Add Owner
              </button>
            </div>
          </div>

          {/* Additional Metadata */}
          {node.data.metadata && Object.keys(node.data.metadata).length > 0 && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Additional Metadata
              </label>
              <div className="px-3 py-2 text-xs bg-gray-50 border border-gray-200 rounded-md text-gray-700 font-mono">
                <pre>{JSON.stringify(node.data.metadata, null, 2)}</pre>
              </div>
            </div>
          )}

          {/* Configure Component Node */}
          {node?.type === 'component' && onConfigureComponent && (
            <div className="border-t border-gray-200 pt-4 mt-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Component Configuration
              </label>
              <button
                onClick={() => {
                  // Find the component in the project or create one from node data
                  const existingComponent = currentProject?.components.find((c) => c.id === node.id);
                  const componentToEdit = existingComponent ? {
                    ...existingComponent,
                    // Merge in the latest data from the node (e.g., updated deps from edges)
                    attributes: {
                      ...existingComponent.attributes,
                      ...node.data,
                      deps: node.data.deps || existingComponent.attributes.deps || [],
                    },
                  } : {
                    // Create a new component from node data
                    id: node.id,
                    component_type: node.data.componentType || node.data.component_type || 'dagster.PythonScriptComponent',
                    type: node.data.componentType || node.data.component_type || 'dagster.PythonScriptComponent',
                    label: node.data.label || 'New Component',
                    attributes: {
                      deps: node.data.deps || [],
                      ...node.data.attributes,
                    },
                    is_asset_factory: false,
                  };
                  onConfigureComponent(componentToEdit);
                }}
                className="w-full flex items-center justify-between p-3 bg-green-50 border border-green-200 rounded-lg hover:bg-green-100 transition-colors group"
              >
                <div className="flex items-center space-x-2">
                  <Settings className="w-4 h-4 text-green-600" />
                  <div className="text-left">
                    <div className="text-sm font-medium text-green-900">
                      {node.data.label || 'Component'}
                    </div>
                    <div className="text-xs text-green-600">
                      {node.data.componentType || node.data.component_type || 'Component'}
                    </div>
                  </div>
                </div>
                <span className="text-xs text-green-600 group-hover:text-green-700">
                  Configure →
                </span>
              </button>
              <p className="text-xs text-gray-500 mt-2">
                Click to configure this component's properties and dependencies
              </p>

              {/* Partition Configuration for Components */}
              {componentSupportsPartitions && (
                <PartitionConfig
                  config={node.data.partition_config || null}
                  onChange={(partitionConfig) => {
                    if (!currentProject) return;

                    // Update the node with partition config
                    const updatedNodes = currentProject.graph.nodes.map((n) =>
                      n.id === nodeId
                        ? {
                            ...n,
                            data: {
                              ...n.data,
                              partition_config: partitionConfig,
                            },
                          }
                        : n
                    );

                    // Save to backend
                    updateGraph(updatedNodes, currentProject.graph.edges);
                  }}
                  supportedPartitionTypes={supportedPartitionTypes}
                />
              )}
            </div>
          )}

          {/* Source Component */}
          {sourceComponent && onConfigureComponent && (
            <div className="border-t border-gray-200 pt-4 mt-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Generated By Component
              </label>
              <button
                onClick={() => onConfigureComponent(sourceComponent)}
                className="w-full flex items-center justify-between p-3 bg-purple-50 border border-purple-200 rounded-lg hover:bg-purple-100 transition-colors group"
              >
                <div className="flex items-center space-x-2">
                  <Settings className="w-4 h-4 text-purple-600" />
                  <div className="text-left">
                    <div className="text-sm font-medium text-purple-900">
                      {sourceComponent.label}
                    </div>
                    <div className="text-xs text-purple-600">
                      {sourceComponent.component_type.split('.').pop()}
                    </div>
                  </div>
                </div>
                <span className="text-xs text-purple-600 group-hover:text-purple-700">
                  Configure →
                </span>
              </button>
              <p className="text-xs text-gray-500 mt-2">
                Click to modify the source component configuration. Changes to the component may regenerate this asset.
              </p>

              {/* Partition Configuration for Component-Generated Assets */}
              {componentSupportsPartitions && (
                <PartitionConfig
                  config={node.data.partition_config || null}
                  onChange={(partitionConfig) => {
                    if (!currentProject) return;

                    // Update the node with partition config
                    const updatedNodes = currentProject.graph.nodes.map((n) =>
                      n.id === nodeId
                        ? {
                            ...n,
                            data: {
                              ...n.data,
                              partition_config: partitionConfig,
                            },
                          }
                        : n
                    );

                    updateGraph(updatedNodes, currentProject.graph.edges);
                  }}
                  supportedPartitionTypes={supportedPartitionTypes}
                />
              )}

              {/* Freshness Policy Configuration */}
              <div className="border-t border-gray-200 pt-4 mt-4">
                <label className="block text-sm font-medium text-gray-700 mb-3">
                  Freshness Policy
                </label>

                {/* Mode Selection - Three Radio Buttons */}
                <div className="space-y-3">
                  {/* Mode: None */}
                  <div className="flex items-start space-x-2">
                    <input
                      type="radio"
                      id={`${nodeId}-freshness-none`}
                      name={`${nodeId}-freshness-mode`}
                      checked={node.data.freshness_policy?.mode === 'none' || !node.data.freshness_policy?.mode && !node.data.freshness_policy?.enabled}
                      onChange={() => {
                        if (!currentProject) return;

                        const updatedNodes = currentProject.graph.nodes.map((n) =>
                          n.id === nodeId
                            ? {
                                ...n,
                                data: {
                                  ...n.data,
                                  freshness_policy: {
                                    mode: 'none',
                                    enabled: false,
                                  },
                                },
                              }
                            : n
                        );

                        updateGraph(updatedNodes, currentProject.graph.edges);
                      }}
                      className="w-4 h-4 text-blue-600 mt-0.5"
                    />
                    <label htmlFor={`${nodeId}-freshness-none`} className="text-sm text-gray-700 cursor-pointer">
                      None
                    </label>
                  </div>

                  {/* Mode: Template */}
                  <div className="space-y-2">
                    <div className="flex items-start space-x-2">
                      <input
                        type="radio"
                        id={`${nodeId}-freshness-template`}
                        name={`${nodeId}-freshness-mode`}
                        checked={node.data.freshness_policy?.mode === 'template'}
                        onChange={() => {
                          if (!currentProject) return;

                          const updatedNodes = currentProject.graph.nodes.map((n) =>
                            n.id === nodeId
                              ? {
                                  ...n,
                                  data: {
                                    ...n.data,
                                    freshness_policy: {
                                      mode: 'template',
                                      template_name: n.data.freshness_policy?.template_name || '',
                                      enabled: true,
                                    },
                                  },
                                }
                              : n
                          );

                          updateGraph(updatedNodes, currentProject.graph.edges);
                        }}
                        className="w-4 h-4 text-blue-600 mt-0.5"
                      />
                      <div className="flex-1">
                        <label htmlFor={`${nodeId}-freshness-template`} className="text-sm text-gray-700 cursor-pointer">
                          Use Template
                        </label>
                        {node.data.freshness_policy?.mode === 'template' && (
                          <input
                            type="text"
                            value={node.data.freshness_policy?.template_name || ''}
                            onChange={(e) => {
                              if (!currentProject) return;

                              const updatedNodes = currentProject.graph.nodes.map((n) =>
                                n.id === nodeId
                                  ? {
                                      ...n,
                                      data: {
                                        ...n.data,
                                        freshness_policy: {
                                          ...n.data.freshness_policy,
                                          template_name: e.target.value,
                                        },
                                      },
                                    }
                                  : n
                              );

                              updateGraph(updatedNodes, currentProject.graph.edges);
                            }}
                            className="w-full mt-1 px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            placeholder="Select or enter template name..."
                          />
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Mode: Inline */}
                  <div className="space-y-2">
                    <div className="flex items-start space-x-2">
                      <input
                        type="radio"
                        id={`${nodeId}-freshness-inline`}
                        name={`${nodeId}-freshness-mode`}
                        checked={node.data.freshness_policy?.mode === 'inline' || !node.data.freshness_policy?.mode && node.data.freshness_policy?.enabled}
                        onChange={() => {
                          if (!currentProject) return;

                          const updatedNodes = currentProject.graph.nodes.map((n) =>
                            n.id === nodeId
                              ? {
                                  ...n,
                                  data: {
                                    ...n.data,
                                    freshness_policy: {
                                      mode: 'inline',
                                      enabled: true,
                                      maximum_lag_minutes: n.data.freshness_policy?.maximum_lag_minutes || 60,
                                      maximum_lag_env_var: n.data.freshness_policy?.maximum_lag_env_var || null,
                                      cron_schedule: n.data.freshness_policy?.cron_schedule || '',
                                      cron_env_var: n.data.freshness_policy?.cron_env_var || null,
                                    },
                                  },
                                }
                              : n
                          );

                          updateGraph(updatedNodes, currentProject.graph.edges);
                        }}
                        className="w-4 h-4 text-blue-600 mt-0.5"
                      />
                      <label htmlFor={`${nodeId}-freshness-inline`} className="text-sm text-gray-700 cursor-pointer">
                        Define Inline
                      </label>
                    </div>

                    {/* Inline Configuration - Only show when mode is 'inline' or backwards compatibility */}
                    {(node.data.freshness_policy?.mode === 'inline' || (!node.data.freshness_policy?.mode && node.data.freshness_policy?.enabled)) && (
                      <div className="ml-6 space-y-4 mt-3 pl-4 border-l-2 border-gray-200">
                        {/* Maximum Data Age Section */}
                        <div className="space-y-2">
                          <label className="block text-sm font-medium text-gray-700">
                            Maximum Data Age
                          </label>

                          {/* Radio: Static Value */}
                          <div className="flex items-start space-x-2">
                            <input
                              type="radio"
                              id={`${nodeId}-lag-static`}
                              name={`${nodeId}-lag-mode`}
                              checked={node.data.freshness_policy?.maximum_lag_env_var === null}
                              onChange={() => {
                                if (!currentProject) return;

                                const updatedNodes = currentProject.graph.nodes.map((n) =>
                                  n.id === nodeId
                                    ? {
                                        ...n,
                                        data: {
                                          ...n.data,
                                          freshness_policy: {
                                            ...n.data.freshness_policy,
                                            maximum_lag_env_var: null,
                                          },
                                        },
                                      }
                                    : n
                                );

                                updateGraph(updatedNodes, currentProject.graph.edges);
                              }}
                              className="w-4 h-4 text-blue-600 mt-0.5"
                            />
                            <div className="flex-1">
                              <label htmlFor={`${nodeId}-lag-static`} className="text-sm text-gray-700 cursor-pointer">
                                Static value (minutes)
                              </label>
                              <input
                                type="number"
                                min="1"
                                value={node.data.freshness_policy?.maximum_lag_minutes || 60}
                                disabled={node.data.freshness_policy?.maximum_lag_env_var !== null}
                                onChange={(e) => {
                                  if (!currentProject) return;

                                  const updatedNodes = currentProject.graph.nodes.map((n) =>
                                    n.id === nodeId
                                      ? {
                                          ...n,
                                          data: {
                                            ...n.data,
                                            freshness_policy: {
                                              ...n.data.freshness_policy,
                                              maximum_lag_minutes: parseInt(e.target.value) || 60,
                                            },
                                          },
                                        }
                                      : n
                                  );

                                  updateGraph(updatedNodes, currentProject.graph.edges);
                                }}
                                className="w-full mt-1 px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-500 disabled:cursor-not-allowed"
                              />
                            </div>
                          </div>

                          {/* Radio: Environment Variable */}
                          <div className="flex items-start space-x-2">
                            <input
                              type="radio"
                              id={`${nodeId}-lag-env`}
                              name={`${nodeId}-lag-mode`}
                              checked={node.data.freshness_policy?.maximum_lag_env_var !== null}
                              onChange={() => {
                                if (!currentProject) return;

                                const updatedNodes = currentProject.graph.nodes.map((n) =>
                                  n.id === nodeId
                                    ? {
                                        ...n,
                                        data: {
                                          ...n.data,
                                          freshness_policy: {
                                            ...n.data.freshness_policy,
                                            maximum_lag_env_var: n.data.freshness_policy?.maximum_lag_env_var || 'FRESHNESS_LAG_MINUTES',
                                          },
                                        },
                                      }
                                    : n
                                );

                                updateGraph(updatedNodes, currentProject.graph.edges);
                              }}
                              className="w-4 h-4 text-blue-600 mt-0.5"
                            />
                            <div className="flex-1">
                              <label htmlFor={`${nodeId}-lag-env`} className="text-sm text-gray-700 cursor-pointer">
                                Environment variable
                              </label>
                              <input
                                type="text"
                                value={node.data.freshness_policy?.maximum_lag_env_var || ''}
                                disabled={node.data.freshness_policy?.maximum_lag_env_var === null}
                                onChange={(e) => {
                                  if (!currentProject) return;

                                  const updatedNodes = currentProject.graph.nodes.map((n) =>
                                    n.id === nodeId
                                      ? {
                                          ...n,
                                          data: {
                                            ...n.data,
                                            freshness_policy: {
                                              ...n.data.freshness_policy,
                                              maximum_lag_env_var: e.target.value,
                                            },
                                          },
                                        }
                                      : n
                                  );

                                  updateGraph(updatedNodes, currentProject.graph.edges);
                                }}
                                className="w-full mt-1 px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-500 disabled:cursor-not-allowed"
                                placeholder="FRESHNESS_LAG_MINUTES"
                              />
                            </div>
                          </div>
                        </div>

                        {/* Expected Update Schedule Section */}
                        <div className="space-y-2">
                          <label className="block text-sm font-medium text-gray-700">
                            Expected Update Schedule
                          </label>

                          {/* Radio: Static Value (cron) */}
                          <div className="flex items-start space-x-2">
                            <input
                              type="radio"
                              id={`${nodeId}-cron-static`}
                              name={`${nodeId}-cron-mode`}
                              checked={node.data.freshness_policy?.cron_env_var === null}
                              onChange={() => {
                                if (!currentProject) return;

                                const updatedNodes = currentProject.graph.nodes.map((n) =>
                                  n.id === nodeId
                                    ? {
                                        ...n,
                                        data: {
                                          ...n.data,
                                          freshness_policy: {
                                            ...n.data.freshness_policy,
                                            cron_env_var: null,
                                          },
                                        },
                                      }
                                    : n
                                );

                                updateGraph(updatedNodes, currentProject.graph.edges);
                              }}
                              className="w-4 h-4 text-blue-600 mt-0.5"
                            />
                            <div className="flex-1">
                              <label htmlFor={`${nodeId}-cron-static`} className="text-sm text-gray-700 cursor-pointer">
                                Static value (cron)
                              </label>
                              <input
                                type="text"
                                value={node.data.freshness_policy?.cron_schedule || ''}
                                disabled={node.data.freshness_policy?.cron_env_var !== null}
                                onChange={(e) => {
                                  if (!currentProject) return;

                                  const updatedNodes = currentProject.graph.nodes.map((n) =>
                                    n.id === nodeId
                                      ? {
                                          ...n,
                                          data: {
                                            ...n.data,
                                            freshness_policy: {
                                              ...n.data.freshness_policy,
                                              cron_schedule: e.target.value,
                                            },
                                          },
                                        }
                                      : n
                                  );

                                  updateGraph(updatedNodes, currentProject.graph.edges);
                                }}
                                className="w-full mt-1 px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-500 disabled:cursor-not-allowed"
                                placeholder="0 */6 * * *"
                              />
                            </div>
                          </div>

                          {/* Radio: Environment Variable */}
                          <div className="flex items-start space-x-2">
                            <input
                              type="radio"
                              id={`${nodeId}-cron-env`}
                              name={`${nodeId}-cron-mode`}
                              checked={node.data.freshness_policy?.cron_env_var !== null}
                              onChange={() => {
                                if (!currentProject) return;

                                const updatedNodes = currentProject.graph.nodes.map((n) =>
                                  n.id === nodeId
                                    ? {
                                        ...n,
                                        data: {
                                          ...n.data,
                                          freshness_policy: {
                                            ...n.data.freshness_policy,
                                            cron_env_var: n.data.freshness_policy?.cron_env_var || 'FRESHNESS_CRON_SCHEDULE',
                                          },
                                        },
                                      }
                                    : n
                                );

                                updateGraph(updatedNodes, currentProject.graph.edges);
                              }}
                              className="w-4 h-4 text-blue-600 mt-0.5"
                            />
                            <div className="flex-1">
                              <label htmlFor={`${nodeId}-cron-env`} className="text-sm text-gray-700 cursor-pointer">
                                Environment variable
                              </label>
                              <input
                                type="text"
                                value={node.data.freshness_policy?.cron_env_var || ''}
                                disabled={node.data.freshness_policy?.cron_env_var === null}
                                onChange={(e) => {
                                  if (!currentProject) return;

                                  const updatedNodes = currentProject.graph.nodes.map((n) =>
                                    n.id === nodeId
                                      ? {
                                          ...n,
                                          data: {
                                            ...n.data,
                                            freshness_policy: {
                                              ...n.data.freshness_policy,
                                              cron_env_var: e.target.value,
                                            },
                                          },
                                        }
                                      : n
                                  );

                                  updateGraph(updatedNodes, currentProject.graph.edges);
                                }}
                                className="w-full mt-1 px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-500 disabled:cursor-not-allowed"
                                placeholder="FRESHNESS_CRON_SCHEDULE"
                              />
                            </div>
                          </div>
                        </div>

                        {/* Help Text */}
                        <div className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-md p-2">
                          Freshness policies define SLAs for data freshness. Dagster will alert if data becomes stale.
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Delete Component Instance Button - only for non-factory components */}
              {!sourceComponent.is_asset_factory && (
                <div className="border-t border-red-200 pt-4 mt-4">
                  <button
                    onClick={async () => {
                      if (!currentProject) return;

                      // Use the component_id from node.data, which contains the actual folder name
                      const componentId = node.data.component_id;
                      const confirmed = window.confirm(
                        `Are you sure you want to delete "${node.data.asset_key || node.data.label}"?\n\nThis will permanently remove the component instance and all its configuration.`
                      );

                      if (!confirmed) return;

                      try {
                        // Optimistic update: immediately remove the node from the UI
                        const updatedNodes = currentProject.graph.nodes.filter(n => n.id !== nodeId);
                        const updatedEdges = currentProject.graph.edges.filter(
                          e => e.source !== nodeId && e.target !== nodeId
                        );
                        await updateGraph(updatedNodes, updatedEdges);

                        // Call the API to delete the component instance in the background
                        // The backend will regenerate assets and return the updated project
                        projectsApi.deleteComponentInstance(
                          currentProject.id,
                          componentId
                        ).then(async (updatedProject) => {
                          // Reload the project to get the final state from the backend
                          await loadProject(currentProject.id);
                        }).catch((error) => {
                          console.error('Failed to delete component instance:', error);
                          // Reload to restore the correct state
                          loadProject(currentProject.id);
                          alert('Failed to delete component instance. The view has been restored.');
                        });
                      } catch (error) {
                        console.error('Failed to update UI:', error);
                        alert('Failed to update UI. Please try again.');
                      }
                    }}
                    className="w-full p-3 bg-red-50 border-2 border-red-300 hover:border-red-500 hover:bg-red-100 rounded-lg transition-all group"
                  >
                    <div className="flex items-center justify-center space-x-2">
                      <Trash2 className="w-5 h-5 text-red-600 group-hover:text-red-700" />
                      <div className="text-sm font-semibold text-red-900 group-hover:text-red-950">
                        Delete Component Instance
                      </div>
                    </div>
                  </button>
                  <p className="text-xs text-gray-600 mt-2 text-center">
                    Remove this asset and its configuration permanently
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Asset Checks Section */}
          <div className="border-t border-gray-200 pt-4 mt-4">
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-gray-700">
                Asset Checks {node.data.checks?.length > 0 && <span className="text-orange-600">({node.data.checks.length})</span>}
              </label>
              <button
                onClick={() => {
                  // Navigate to template builder with asset pre-selected
                  const assetKey = node.data.asset_key || node.id;
                  window.location.hash = `#/templates?type=asset_check&asset=${encodeURIComponent(assetKey)}`;
                }}
                className="flex items-center space-x-1 px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700"
              >
                <Plus className="w-3 h-3" />
                <span>Add Check</span>
              </button>
            </div>

            {node.data.checks && node.data.checks.length > 0 ? (
              <div className="space-y-2">
                {node.data.checks.map((check: any, idx: number) => {
                  const isDbtTest = check.key && (
                    check.key.includes('dbt_utils') ||
                    check.key.includes('not_null') ||
                    check.key.includes('unique') ||
                    check.key.includes('relationships') ||
                    check.key.includes('accepted_values')
                  );

                  return (
                    <div
                      key={idx}
                      className="bg-orange-50 border border-orange-200 rounded-md p-3 text-xs"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-orange-900 mb-1 break-words">
                            {check.name}
                          </div>
                          {check.description && (
                            <div className="text-orange-700 mb-2 break-words">
                              {check.description}
                            </div>
                          )}
                          {isDbtTest && (
                            <div className="inline-flex items-center gap-1 px-2 py-0.5 bg-orange-100 text-orange-800 rounded text-xs font-medium">
                              <span>dbt test</span>
                            </div>
                          )}
                        </div>
                        {check.source && (
                          <button
                            onClick={async () => {
                              if (!onOpenFile || !currentProject) return;

                              // For dbt tests and other primitives, use the search API to find the actual definition
                              if (isDbtTest) {
                                try {
                                  const searchResult = await primitivesApi.searchPrimitiveDefinition(
                                    currentProject.id,
                                    'asset_check',
                                    check.name
                                  );

                                  if (searchResult.found) {
                                    // Open the file at the specific line number
                                    const filePath = searchResult.file_path;
                                    const lineNumber = searchResult.line_number;
                                    onOpenFile(`${filePath}:${lineNumber}`);
                                    return;
                                  }
                                } catch (error) {
                                  console.error('Failed to search for primitive definition:', error);
                                  // Fall through to fallback
                                }
                              }

                              // Fallback: open the component YAML
                              const sourcePath = check.source.split(':')[0]; // Remove line number
                              onOpenFile(sourcePath);
                            }}
                            className="flex-shrink-0 p-1.5 text-orange-600 hover:bg-orange-100 rounded transition-colors"
                            title={isDbtTest ? "Open dbt test definition" : "Open source file"}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                            </svg>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-md p-3">
                <p>
                  No checks configured. Add data quality checks to validate this asset. Checks run after the asset materializes.
                </p>
              </div>
            )}
          </div>

          {/* Asset Info - only show for dbt assets */}
          {sourceComponent?.component_type === 'dagster_dbt.DbtProjectComponent' && (
            <div className="text-xs text-gray-500 bg-blue-50 border border-blue-200 rounded-md p-3">
              <strong>About dbt assets:</strong> This asset is generated from a dbt model.
              Most metadata comes from your dbt project. You can add custom descriptions,
              groups, and owners here.
            </div>
          )}
        </div>

        {/* Launchpad for asset materialization */}
        {currentProject && (
          <Launchpad
            open={showLaunchpad}
            onOpenChange={setShowLaunchpad}
            projectId={currentProject.id}
            mode="materialize"
            assetKeys={[node.data.asset_key || node.id]}
            onLaunch={handleLaunchpadSubmit}
            defaultConfig={assetDefaultConfig || {}}
            configSchema={assetConfigSchema || {}}
          />
        )}

        {/* Partition Backfill modal */}
        {currentProject && isPartitioned && (
          <PartitionBackfill
            open={showBackfillModal}
            onOpenChange={setShowBackfillModal}
            projectId={currentProject.id}
            assetKey={node.data.asset_key || node.id}
            onLaunch={handleBackfillSubmit}
          />
        )}

        {/* Data Preview Modal */}
        {showDataPreview && currentProject && (
          <DataPreviewModal
            isOpen={showDataPreview}
            onClose={() => setShowDataPreview(false)}
            projectId={currentProject.id}
            assetKey={assetKey}
            assetName={node.data.label || node.id}
            hasTransformerComponent={installedTemplates?.components?.some(c =>
              c.id === 'dataframe_transformer' ||
              c.component_type?.includes('dataframe_transformer') ||
              c.component_type?.includes('DataFrameTransformerComponent')
            ) || false}
            onTransformerCreated={(updatedProject) => {
              // Update the graph with the new project data
              if (updatedProject?.graph) {
                updateGraph(updatedProject.graph);
              }
              // Also refresh the entire project to ensure everything is in sync
              loadProject(currentProject.id);
            }}
          />
        )}
      </div>
    );
  }

  // For component nodes, show a simplified view with a prominent button to open the full config modal
  if (node?.type === 'component' && onConfigureComponent) {
    const componentType = node.data.componentType || node.data.component_type || '';
    const componentName = componentType.split('.').pop() || 'Component';

    const handleDeleteNode = () => {
      if (!currentProject) return;

      const confirmed = window.confirm(`Are you sure you want to delete "${node.data.label}"?`);
      if (!confirmed) return;

      // Remove the node from the graph
      const updatedNodes = currentProject.graph.nodes.filter((n) => n.id !== nodeId);
      // Remove all edges connected to this node
      const updatedEdges = currentProject.graph.edges.filter(
        (edge) => edge.source !== nodeId && edge.target !== nodeId
      );

      updateGraph(updatedNodes, updatedEdges);

      // Also remove from components list if it exists
      const updatedComponents = currentProject.components.filter((c) => c.id !== nodeId);
      if (updatedComponents.length !== currentProject.components.length) {
        // Component was in the list, update it
        projectsApi.updateProject(currentProject.id, {
          components: updatedComponents,
        });
      }
    };

    return (
      <div className="h-full flex flex-col">
        <div className="p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Component Node</h2>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Component Info */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Label
            </label>
            <div className="px-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-md text-gray-900">
              {node.data.label}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Component Type
            </label>
            <div className="px-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-md text-gray-900 font-mono">
              {componentType}
            </div>
          </div>

          {/* Dependencies */}
          {node.data.deps && node.data.deps.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Dependencies
              </label>
              <div className="space-y-1">
                {node.data.deps.map((dep: string, idx: number) => (
                  <div
                    key={idx}
                    className="px-2 py-1 text-xs bg-blue-50 border border-blue-200 rounded text-blue-700 font-mono"
                  >
                    {dep}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Prominent Configure Button */}
          <div className="border-t border-gray-200 pt-4 mt-6">
            <button
              onClick={() => {
                // Find the component in the project or create one from node data
                const existingComponent = currentProject?.components.find((c) => c.id === node.id);
                const componentToEdit = existingComponent ? {
                  ...existingComponent,
                  // Merge in the latest data from the node (e.g., updated deps from edges)
                  attributes: {
                    ...existingComponent.attributes,
                    ...node.data,
                    deps: node.data.deps || existingComponent.attributes.deps || [],
                  },
                } : {
                  // Create a new component from node data
                  id: node.id,
                  component_type: node.data.componentType || node.data.component_type || 'dagster.PythonScriptComponent',
                  type: node.data.componentType || node.data.component_type || 'dagster.PythonScriptComponent',
                  label: node.data.label || 'New Component',
                  attributes: {
                    deps: node.data.deps || [],
                    ...node.data.attributes,
                  },
                  is_asset_factory: false,
                };
                onConfigureComponent(componentToEdit);
              }}
              className="w-full p-4 bg-gradient-to-br from-blue-50 to-purple-50 border-2 border-blue-300 hover:border-blue-500 rounded-lg transition-all group"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="p-2 bg-blue-500 rounded-lg group-hover:bg-blue-600 transition-colors">
                    <Settings className="w-5 h-5 text-white" />
                  </div>
                  <div className="text-left">
                    <div className="text-base font-semibold text-blue-900">
                      Configure Component
                    </div>
                    <div className="text-xs text-blue-600 mt-0.5">
                      Set properties, dependencies, and advanced options
                    </div>
                  </div>
                </div>
                <div className="text-blue-600 group-hover:text-blue-700">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </div>
            </button>
            <p className="text-xs text-gray-600 mt-3 text-center">
              The configuration modal provides access to all component settings including nested object fields and advanced options
            </p>
          </div>

          {/* Info about the component */}
          {componentSchema && componentSchema.description && (
            <div className="text-sm text-gray-600 bg-blue-50 border border-blue-200 rounded-md p-3 mt-4">
              <strong className="text-blue-900">About {componentName}:</strong>
              <p className="mt-1">{componentSchema.description}</p>
            </div>
          )}

          {/* Delete Button */}
          <div className="border-t border-red-200 pt-4 mt-6">
            <button
              onClick={handleDeleteNode}
              className="w-full p-3 bg-red-50 border-2 border-red-300 hover:border-red-500 hover:bg-red-100 rounded-lg transition-all group"
            >
              <div className="flex items-center justify-center space-x-2">
                <Trash2 className="w-5 h-5 text-red-600 group-hover:text-red-700" />
                <div className="text-sm font-semibold text-red-900 group-hover:text-red-950">
                  Delete Component
                </div>
              </div>
            </button>
            <p className="text-xs text-gray-600 mt-2 text-center">
              Remove from canvas and delete all connections (or press Delete/Backspace key)
            </p>
          </div>
        </div>
      </div>
    );
  }

  // If not a component node or no configure callback, show nothing
  return null;
}
