import { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { Layers, Database, Tag, Users, CheckCircle, X, Wand2, Search, Package } from 'lucide-react';

// Icon mapping for component icons
const componentIconMap: Record<string, any> = {
  'Wand2': Wand2,
  'Database': Database,
  'Search': Search,
  'Package': Package,
};

export const AssetNode = memo(({ data, selected, id }: NodeProps) => {
  // Dagster uses a purple/blue color scheme for assets
  const hasGroup = data.group_name;
  const hasOwners = data.owners && data.owners.length > 0;
  const hasDescription = data.description && data.description.length > 0;
  const hasChecks = data.checks && data.checks.length > 0;
  const isSelected = selected;

  // Check if this asset produces DataFrames (based on source component)
  const producesDataFrame = data.io_output_type === 'dataframe';

  // Truncate description to 60 characters for display
  const truncatedDescription = hasDescription
    ? data.description.length > 60
      ? data.description.substring(0, 60) + '...'
      : data.description
    : '';

  // Handle styles - make them visible and connectable always
  const handleStyle = {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    border: '1.5px solid #6366f1',
    background: '#ffffff',
    cursor: 'crosshair',
    opacity: data.onDelete ? 0 : 1, // Hidden visually in pipeline builder but still connectable
  };

  return (
    <div
      className={`relative shadow-md rounded-md bg-gradient-to-br from-purple-50 to-blue-50 min-w-[140px] max-w-[200px] ${
        isSelected
          ? 'border-2 border-green-500 ring-2 ring-green-200'
          : 'border border-purple-400'
      }`}
      title={hasDescription ? data.description : ''}
    >
      {/* Delete button */}
      {data.onDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            data.onDelete(id);
          }}
          className="absolute -top-1.5 -right-1.5 z-10 w-5 h-5 bg-red-500 hover:bg-red-600 rounded-full flex items-center justify-center shadow-md transition-colors"
          title="Remove asset from pipeline"
        >
          <X className="w-3 h-3 text-white" />
        </button>
      )}

      {/* Input handles on all four sides */}
      <Handle
        type="target"
        position={Position.Left}
        id="left"
        style={handleStyle}
      />
      <Handle
        type="target"
        position={Position.Top}
        id="top"
        style={handleStyle}
      />
      <Handle
        type="target"
        position={Position.Bottom}
        id="bottom"
        style={handleStyle}
      />
      <Handle
        type="target"
        position={Position.Right}
        id="right-target"
        style={handleStyle}
      />

      {/* Header with asset icon and key */}
      <div className="px-2 py-1.5 bg-gradient-to-r from-purple-500 to-blue-500 rounded-t-md">
        <div className="flex items-center space-x-1.5">
          <div className="flex-shrink-0">
            <Layers className="w-3.5 h-3.5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold text-white truncate">
              {data.asset_key || data.label}
            </div>
          </div>
        </div>
      </div>

      {/* Body with metadata facets */}
      <div className="px-2 py-1.5 space-y-1">
        {/* Label if different from asset key */}
        {data.label && data.label !== data.asset_key && (
          <div className="text-[10px] text-gray-700 font-medium truncate leading-tight">
            {data.label}
          </div>
        )}

        {/* Description - truncated with tooltip on hover */}
        {hasDescription && (
          <div
            className="text-[10px] text-gray-600 line-clamp-1 cursor-help leading-tight"
            title={data.description}
          >
            {truncatedDescription}
          </div>
        )}

        {/* Metadata badges (facets) */}
        <div className="flex flex-wrap gap-1 pt-0.5">
          {/* Group badge - only show if not "default" */}
          {hasGroup && data.group_name !== 'default' && (
            <div
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-100 text-blue-700 border border-blue-300"
              title={`Group: ${data.group_name}`}
            >
              <Database className="w-2.5 h-2.5" />
              <span className="truncate max-w-[80px]">{data.group_name}</span>
            </div>
          )}

          {/* Owners badge */}
          {hasOwners && (
            <div
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-700 border border-purple-300"
              title={`Owners: ${data.owners.join(', ')}`}
            >
              <Users className="w-2.5 h-2.5" />
              <span>{data.owners.length}</span>
            </div>
          )}

          {/* Source component badge with icon */}
          {data.source_component && (() => {
            const componentIconName = data.component_icon;
            const ComponentIcon = componentIconName ? componentIconMap[componentIconName] || Package : Package;
            const componentName = data.source_component.replace('community_', '').replace(/_/g, ' ');

            return (
              <div
                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-700 border border-purple-300"
                title={`Generated by: ${componentName}`}
              >
                <ComponentIcon className="w-2.5 h-2.5" />
                <span className="truncate max-w-[80px]">{componentName}</span>
              </div>
            );
          })()}

          {/* Asset checks badge */}
          {hasChecks && (
            <div
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-orange-100 text-orange-700 border border-orange-300 cursor-pointer hover:bg-orange-200"
              title={`${data.checks.length} check${data.checks.length !== 1 ? 's' : ''}`}
            >
              <CheckCircle className="w-2.5 h-2.5" />
              <span>{data.checks.length}</span>
            </div>
          )}

          {/* DataFrame badge */}
          {producesDataFrame && (
            <div
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-cyan-100 text-cyan-700 border border-cyan-300"
              title="Produces DataFrame output"
            >
              <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 20 20">
                <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h12a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6z" />
              </svg>
              <span>DataFrame</span>
            </div>
          )}
        </div>
      </div>

      {/* Output handles on all four sides */}
      <Handle
        type="source"
        position={Position.Right}
        id="right"
        style={handleStyle}
      />
      <Handle
        type="source"
        position={Position.Left}
        id="left-source"
        style={handleStyle}
      />
      <Handle
        type="source"
        position={Position.Top}
        id="top-source"
        style={handleStyle}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="bottom-source"
        style={handleStyle}
      />
    </div>
  );
});

AssetNode.displayName = 'AssetNode';
