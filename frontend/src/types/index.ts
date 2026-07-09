export interface ColumnSchema {
  name: string;
  type: 'string' | 'number' | 'datetime' | 'boolean';
  required?: boolean;
  alternatives?: string[];
  description?: string;
  optional?: boolean;
}

export interface ComponentSchema {
  name: string;
  module?: string;
  type: string;
  description?: string;
  schema?: Record<string, any>;
  attributes?: Record<string, any>;
  category: string;
  icon?: string;
  version?: string;
  outputs?: any[];
  dependencies?: any;
  tags?: string[];
  'x-dagster-io'?: Record<string, any>;
}

export interface ComponentInstance {
  id: string;
  component_type: string;
  label: string;
  description?: string;
  attributes: Record<string, any>;
  translation?: Record<string, any> | null;
  post_processing?: Record<string, any> | null;
  is_asset_factory: boolean;
  type?: string;
}

export interface GraphNodeData {
  label: string;
  component_type?: string;
  componentType?: string;
  attributes?: Record<string, any>;
  component_attributes?: Record<string, any>;
  translation?: Record<string, any>;
  post_processing?: Record<string, any>;
  asset_key?: string;
  description?: string;
  group?: string;
  group_name?: string;
  owners?: string[];
  checks?: any[];
  jobs?: string[];
  schedules?: string[];
  sensors?: string[];
  component_id?: string;
  source?: string;
  source_component?: string;
  component_icon?: string;
  compute_kind?: string;
  kinds?: string[];
  metadata?: Record<string, any>;
  node_kind?: 'asset' | 'component';
  partition_config?: Record<string, any>;
  deps?: any[];
  freshness_policy?: Record<string, any>;
  io_input_type?: string | null;
  io_output_type?: string | null;
  io_input_required?: boolean;
  io_expected_columns?: ColumnSchema[] | null;
  io_output_columns?: ColumnSchema[] | null;
  io_compatible_upstream?: string[] | null;
  onDelete?: (id: string) => void;
  onPrimitiveClick?: (category: 'job' | 'schedule' | 'sensor' | 'asset_check', name: string) => void;
}

export interface GraphNode {
  id: string;
  type: string;
  data: GraphNodeData;
  position: { x: number; y: number };
  node_kind?: 'asset' | 'component';
  source_component?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  is_custom?: boolean;
}

export interface PipelineGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  viewport?: {
    x: number;
    y: number;
    zoom: number;
  };
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  graph: PipelineGraph;
  components: ComponentInstance[];
  created_at: string;
  updated_at: string;
  git_repo?: string;
  git_branch: string;
  custom_lineage?: any;
  directory_name?: string;
}

export interface ProjectCreate {
  name: string;
  description?: string;
  git_repo?: string;
  git_branch?: string;
}
