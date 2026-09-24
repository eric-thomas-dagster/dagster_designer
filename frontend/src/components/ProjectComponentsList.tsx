import { useMemo } from 'react';
import { useProjectStore } from '@/hooks/useProject';
import { Settings, Trash2, FileCode } from 'lucide-react';
import type { ComponentInstance } from '@/types';

interface ProjectComponentsListProps {
  onEditComponent: (component: ComponentInstance) => void;
  onDeleteComponent: (component: ComponentInstance) => void;
  /** Opens a file (optionally "path:line") in Designer's in-app code
   *  editor. Used for component instances discovered from the graph
   *  rather than Designer's own bookkeeping -- see DerivedInstance below. */
  onOpenFile: (filePath: string) => void;
}

// Components users shouldn't manage from this sidebar.
//
//  * DependencyGraphComponent is auto-created when the user draws manual edges;
//    they should edit those edges on the graph canvas, not through this list.
//  * Schedule / Sensor / AssetCheck are primitives with their own Automation
//    tab. Showing them here just gives users a gear icon that opens the
//    generic component-config modal for a primitive it doesn't know how
//    to render, which is worse than not showing them at all.
const HIDDEN_COMPONENT_TYPES =
  /(?:DependencyGraph|Schedule|Sensor|AssetCheck)Component$|(?:dependency_graph|schedule|sensor|asset_check)$/i;

interface DerivedInstance {
  id: string;
  component_type: string;
  label: string;
  attributes: Record<string, any>;
  is_asset_factory: boolean;
  /** "path/to/defs.yaml:line" for the asset that carried this component's
   *  data -- opens directly to the right file via onOpenFile. */
  sourcePath: string | undefined;
}

export function ProjectComponentsList({ onEditComponent, onDeleteComponent, onOpenFile }: ProjectComponentsListProps) {
  const { currentProject } = useProjectStore();

  const bookkeptComponents = currentProject
    ? currentProject.components.filter((c) => !HIDDEN_COMPONENT_TYPES.test(c.component_type || ''))
    : [];

  // Designer's own `project.components` bookkeeping is populated when IT
  // generates a component (scaffolding, a community install) -- never for
  // an imported project's own hand-written components, even though those
  // real instances exist right there in the project's own defs.yaml files.
  // Every asset a component produced already carries component_id /
  // component_type / component_attributes directly on its graph node (from
  // live `dg list defs` introspection, always fresh) -- grouping by
  // component_id recovers the instances bookkeeping alone misses, with no
  // need for project.components to know about them at all. Confirmed live:
  // a real imported project (project.components === []) has this data on
  // every one of the assets its one hand-written component produced.
  const bookkeptIds = useMemo(() => new Set(bookkeptComponents.map((c) => c.id)), [bookkeptComponents]);
  const derivedInstances = useMemo<DerivedInstance[]>(() => {
    if (!currentProject) return [];
    const byId = new Map<string, DerivedInstance>();
    for (const node of currentProject.graph.nodes) {
      const componentId = node.data?.component_id;
      const componentType = node.data?.component_type;
      if (!componentId || !componentType || bookkeptIds.has(componentId)) continue;
      if (HIDDEN_COMPONENT_TYPES.test(componentType)) continue;
      if (!byId.has(componentId)) {
        byId.set(componentId, {
          id: componentId,
          component_type: componentType,
          label: componentId,
          attributes: node.data?.component_attributes || {},
          is_asset_factory: true,
          sourcePath: node.data?.source,
        });
      }
    }
    return Array.from(byId.values());
  }, [currentProject, bookkeptIds]);

  if (!currentProject || (bookkeptComponents.length === 0 && derivedInstances.length === 0)) {
    return (
      <div className="p-4 text-center text-sm text-gray-500">
        No components added yet
      </div>
    );
  }

  const getIconForComponentType = (type: string): string => {
    // Check for dbt components (not duckdb - use word boundary)
    if (/\bdbt[_\.]|^dbt/i.test(type)) return '🗄️';
    if (type.includes('fivetran')) return '🔄';
    if (type.includes('sling')) return '➡️';
    if (type.includes('dlt')) return '⬇️';
    return '📦';
  };

  return (
    <div className="space-y-2">
      {bookkeptComponents.map((component) => (
        <div
          key={component.id}
          className="group relative p-3 bg-white border border-gray-200 rounded-lg hover:border-blue-300 hover:shadow-sm transition-all"
        >
          <div className="flex items-start justify-between">
            <div className="flex-1 min-w-0">
              <div className="flex items-center space-x-2">
                <span className="text-lg">{getIconForComponentType(component.component_type)}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {component.label}
                  </p>
                  <p className="text-xs text-gray-500 truncate">
                    {component.component_type.split('.').pop()}
                  </p>
                </div>
              </div>

              {component.is_asset_factory && (
                <div className="mt-2 text-xs text-purple-600 bg-purple-50 px-2 py-1 rounded inline-block">
                  Asset Factory
                </div>
              )}
            </div>

            <div className="flex items-center space-x-1 ml-2">
              <button
                onClick={() => onEditComponent(component)}
                className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                title="Configure"
              >
                <Settings className="w-4 h-4" />
              </button>
              <button
                onClick={() => onDeleteComponent(component)}
                className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                title="Delete"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      ))}

      {derivedInstances.map((component) => (
        <div
          key={component.id}
          className="group relative p-3 bg-white border border-gray-200 rounded-lg hover:border-blue-300 hover:shadow-sm transition-all"
        >
          <div className="flex items-start justify-between">
            <div className="flex-1 min-w-0">
              <div className="flex items-center space-x-2">
                <span className="text-lg">{getIconForComponentType(component.component_type)}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {component.label}
                  </p>
                  <p className="text-xs text-gray-500 truncate">
                    {component.component_type.split('.').pop()}
                  </p>
                </div>
              </div>

              {/* Discovered from this project's own defs.yaml (not something
                  Designer generated) -- editing goes to the YAML directly,
                  see the FileCode button below, rather than a form whose
                  Save wouldn't actually persist for an imported project. */}
              <div className="mt-2 text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded inline-block">
                From defs.yaml
              </div>
            </div>

            <div className="flex items-center space-x-1 ml-2">
              <button
                onClick={() => component.sourcePath && onOpenFile(component.sourcePath)}
                disabled={!component.sourcePath}
                className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                title={component.sourcePath ? 'Open in code editor' : 'Source file unknown'}
              >
                <FileCode className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
