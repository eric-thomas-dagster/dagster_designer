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
  /** Large-project mode only: the group each end belongs to (an end whose group isn't loaded is drawn as that group). */
  source_group?: string | null;
  target_group?: string | null;
}

/** Summary of a very large project served in pieces (see backend services/graph_index.py). */
export interface LazyGraphInfo {
  total_assets: number;
  groups: Array<{ name: string; count: number; kinds: string[]; has_checks: number; code_locations: string[] }>;
  group_edges: Array<{ source: string; target: string; count: number }>;
}

export interface PipelineGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Present only for a large project: nodes/edges then hold just the groups loaded so far. */
  lazy?: LazyGraphInfo | null;
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
  asset_field_overrides?: Record<string, { description?: string | null; group_name?: string | null; owners?: string[] | null; tags?: Record<string, string> | null; kinds?: string[] | null }>;
  asset_post_processing_rules?: Array<{ target: string; group_name?: string | null; owners?: string[] | null; tags?: Record<string, string> | null }>;
  directory_name?: string;
  /** Real importable Python module (pyproject root_module). Use this -- not directory_name -- to build src/<module>/... paths. */
  root_module?: string | null;
  manual_ingestion_asset_keys?: string[];
  dagster_plus_region?: 'us' | 'eu';
  is_imported?: boolean;
  dagster_package_subdir?: string | null;
  // How community-catalog components install into this project -- a
  // project-wide choice (not per-install), since it's really about the
  // project's own character (own/review the code vs. fast setup), not
  // something that makes sense to flip component-by-component. See
  // install_component_via_cli's own docstring for what each mode does.
  component_install_mode?: 'vendored_latest' | 'vendored_pinned' | 'as_package';
}

export interface ProjectCreate {
  name: string;
  description?: string;
  git_repo?: string;
  git_branch?: string;
}
