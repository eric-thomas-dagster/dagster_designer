import { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { Database, ArrowRight, Download, RefreshCw, Box, Code, Tag, FileText, Play, Clock, Radar, CheckCircle } from 'lucide-react';

const iconMap: Record<string, React.ComponentType<any>> = {
  database: Database,
  'arrow-right': ArrowRight,
  download: Download,
  sync: RefreshCw,
  cube: Box,
  code: Code,
  'file-text': FileText,
  play: Play,
  clock: Clock,
  radar: Radar,
  'check-circle': CheckCircle,
};

export const ComponentNode = memo(({ data, selected }: NodeProps) => {
  const Icon = iconMap[data.icon] || Box;
  const isSelected = selected;

  // Get component type
  const componentType = data.componentType || data.component_type || '';
  const category = data.category?.toLowerCase() || '';

  // Get description from various possible locations
  const description = data.description || data.attributes?.description || '';
  const hasDescription = description && description.length > 0;

  // Truncate description to 60 characters for display
  const truncatedDescription = hasDescription
    ? description.length > 60
      ? description.substring(0, 60) + '...'
      : description
    : '';

  // Determine component kind badges
  const getKindBadges = () => {
    const badges: string[] = [];

    if (componentType === 'dagster.PythonScriptComponent') {
      badges.push('python');
    } else if (componentType === 'dagster.TemplatedSqlComponent') {
      badges.push('sql');
    } else if (category.includes('dbt')) {
      badges.push('dbt', 'duckdb');
    } else if (category.includes('fivetran')) {
      badges.push('fivetran', 'sync');
    } else if (category.includes('sling')) {
      badges.push('sling', 'replication');
    } else if (category.includes('dlt')) {
      badges.push('dlt', 'pipeline');
    } else if (category.includes('airbyte')) {
      badges.push('airbyte', 'etl');
    } else if (category) {
      badges.push(category);
    }

    return badges;
  };

  // Get header gradient based on category/type
  const getHeaderGradient = () => {
    if (componentType === 'dagster.PythonScriptComponent') return 'from-teal-500 to-green-500';
    if (componentType === 'dagster.TemplatedSqlComponent') return 'from-indigo-500 to-blue-500';
    if (category.includes('dbt')) return 'from-orange-500 to-red-500';
    if (category.includes('fivetran')) return 'from-cyan-500 to-blue-500';
    if (category.includes('sling')) return 'from-emerald-500 to-green-500';
    if (category.includes('dlt')) return 'from-amber-500 to-yellow-500';
    if (category.includes('airbyte')) return 'from-blue-500 to-indigo-500';
    return 'from-gray-500 to-slate-500';
  };

  // Get background gradient
  const getBackgroundGradient = () => {
    if (componentType === 'dagster.PythonScriptComponent') return 'from-teal-50 to-green-50';
    if (componentType === 'dagster.TemplatedSqlComponent') return 'from-indigo-50 to-blue-50';
    if (category.includes('dbt')) return 'from-orange-50 to-red-50';
    if (category.includes('fivetran')) return 'from-cyan-50 to-blue-50';
    if (category.includes('sling')) return 'from-emerald-50 to-green-50';
    if (category.includes('dlt')) return 'from-amber-50 to-yellow-50';
    if (category.includes('airbyte')) return 'from-blue-50 to-indigo-50';
    return 'from-gray-50 to-slate-50';
  };

  // Get border color
  const getBorderColor = () => {
    if (componentType === 'dagster.PythonScriptComponent') return 'border-teal-400';
    if (componentType === 'dagster.TemplatedSqlComponent') return 'border-indigo-400';
    if (category.includes('dbt')) return 'border-orange-400';
    if (category.includes('fivetran')) return 'border-cyan-400';
    if (category.includes('sling')) return 'border-emerald-400';
    if (category.includes('dlt')) return 'border-amber-400';
    if (category.includes('airbyte')) return 'border-blue-400';
    return 'border-gray-400';
  };

  // Get handle color
  const getHandleColor = () => {
    if (componentType === 'dagster.PythonScriptComponent') return 'bg-teal-500 border-2 border-teal-600';
    if (componentType === 'dagster.TemplatedSqlComponent') return 'bg-indigo-500 border-2 border-indigo-600';
    if (category.includes('dbt')) return 'bg-orange-500 border-2 border-orange-600';
    if (category.includes('fivetran')) return 'bg-cyan-500 border-2 border-cyan-600';
    if (category.includes('sling')) return 'bg-emerald-500 border-2 border-emerald-600';
    if (category.includes('dlt')) return 'bg-amber-500 border-2 border-amber-600';
    if (category.includes('airbyte')) return 'bg-blue-500 border-2 border-blue-600';
    return 'bg-gray-500 border-2 border-gray-600';
  };

  const kindBadges = getKindBadges();

  return (
    <div
      className={`shadow-lg rounded-lg bg-gradient-to-br ${getBackgroundGradient()} min-w-[200px] max-w-[280px] ${
        isSelected
          ? 'border-4 border-green-500 ring-4 ring-green-200'
          : `border-2 ${getBorderColor()}`
      }`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className={`w-3 h-3 ${getHandleColor()}`}
      />

      {/* Header with icon and label */}
      <div className={`px-3 py-2 bg-gradient-to-r ${getHeaderGradient()} rounded-t-md`}>
        <div className="flex items-center space-x-2">
          <div className="flex-shrink-0">
            <Icon className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-white truncate">
              {data.label}
            </div>
          </div>
        </div>
      </div>

      {/* Body with description and kind badges */}
      <div className="px-3 py-2 space-y-2">
        {/* Description - truncated with tooltip on hover */}
        {hasDescription && (
          <div
            className="text-xs text-gray-600 line-clamp-2 cursor-help"
            title={description}
          >
            {truncatedDescription}
          </div>
        )}

        {/* Kind badges */}
        <div className="flex flex-wrap gap-1.5">
          {kindBadges.map((kind, index) => (
            <div
              key={index}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 border border-gray-300"
            >
              <Tag className="w-3 h-3" />
              <span className="truncate">{kind}</span>
            </div>
          ))}
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className={`w-3 h-3 ${getHandleColor()}`}
      />
    </div>
  );
});

ComponentNode.displayName = 'ComponentNode';
