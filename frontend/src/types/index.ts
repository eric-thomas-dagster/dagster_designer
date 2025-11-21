export interface ComponentSchema {
  name: string;
  module: string;
  type: string;
  description?: string;
  schema: Record<string, any>;
  category: string;
  icon?: string;
}

export interface ComponentInstance {
  id: string;
  component_type: string;
  label: string;
  description?: string;
  attributes: Record<string, any>;
  translation?: Record<string, any>;
  post_processing?: Record<string, any>;
  is_asset_factory: boolean;
}

export interface GraphNode {
  id: string;
  type: string;
  data: {
    label: string;
    component_type?: string;
    attributes?: Record<string, any>;
    translation?: Record<string, any>;
    post_processing?: Record<string, any>;
    asset_key?: string;
    description?: string;
    group_name?: string;
    owners?: string[];
    checks?: any[];
    component_id?: string;
    source_component?: string;
    component_icon?: string;
    io_input_type?: string | null;
    io_output_type?: string | null;
    io_input_required?: boolean;
    onDelete?: (id: string) => void;
  };
  position: { x: number; y: number };
  node_kind?: 'asset' | 'component';
  source_component?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
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
}

export interface ProjectCreate {
  name: string;
  description?: string;
  git_repo?: string;
  git_branch?: string;
}
