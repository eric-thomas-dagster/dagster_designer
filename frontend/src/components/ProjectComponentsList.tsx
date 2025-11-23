import { useProjectStore } from '@/hooks/useProject';
import { Settings, Trash2 } from 'lucide-react';
import type { ComponentInstance } from '@/types';

interface ProjectComponentsListProps {
  onEditComponent: (component: ComponentInstance) => void;
  onDeleteComponent: (component: ComponentInstance) => void;
}

export function ProjectComponentsList({ onEditComponent, onDeleteComponent }: ProjectComponentsListProps) {
  const { currentProject } = useProjectStore();

  if (!currentProject || currentProject.components.length === 0) {
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
      {currentProject.components.map((component) => (
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
    </div>
  );
}
