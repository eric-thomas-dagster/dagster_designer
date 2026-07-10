import axios from 'axios';
import type {
  Project,
  ProjectCreate,
} from '@/types';

const API_BASE = '/api/v1';

const api = axios.create({
  baseURL: API_BASE,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 600000, // 10 minute timeout for long operations (asset generation for large projects with 500+ assets)
});

// Components API
export const componentsApi = {
  list: async (category?: string) => {
    const params = category ? { category } : {};
    const response = await api.get<{ components: ComponentSchema[]; total: number }>(
      '/components',
      { params }
    );
    return response.data;
  },

  get: async (componentType: string, projectId?: string) => {
    const params = projectId ? { project_id: projectId } : {};
    const response = await api.get<ComponentSchema>(`/components/${componentType}`, { params });
    return response.data;
  },
};

// Projects API
export interface MaterializeRequest {
  asset_keys?: string[];
  config?: Record<string, any>;
  tags?: Record<string, string>;
}

export interface MaterializeResponse {
  success: boolean;
  message: string;
  stdout: string;
  stderr: string;
}

export const projectsApi = {
  list: async () => {
    // Use /projects/summary for faster list loading (only loads minimal metadata)
    const response = await api.get<{ projects: Project[]; total: number }>('/projects/summary');
    return response.data;
  },

  get: async (id: string) => {
    const response = await api.get<Project>(`/projects/${id}`);
    return response.data;
  },

  create: async (data: ProjectCreate) => {
    const response = await api.post<Project>('/projects', data);
    return response.data;
  },

  import: async (path: string) => {
    const response = await api.post<Project>('/projects/import', { path });
    return response.data;
  },

  update: async (id: string, data: Partial<Project>) => {
    const response = await api.put<Project>(`/projects/${id}`, data);
    return response.data;
  },

  delete: async (id: string) => {
    await api.delete(`/projects/${id}`);
  },

  deleteComponentInstance: async (projectId: string, componentId: string) => {
    const response = await api.delete<Project>(`/projects/${projectId}/component-instances/${componentId}`);
    return response.data;
  },

  materialize: async (
    projectId: string,
    assetKeys?: string[],
    config?: Record<string, any>,
    tags?: Record<string, string>,
    partition?: string
  ) => {
    const response = await api.post<MaterializeResponse>(
      `/projects/${projectId}/materialize`,
      { asset_keys: assetKeys, config, tags, partition }
    );
    return response.data;
  },

  regenerateAssets: async (projectId: string, recalculateLayout: boolean = false) => {
    const url = `/projects/${projectId}/regenerate-assets${recalculateLayout ? '?recalculate_layout=true' : ''}`;
    const response = await api.post<Project>(url);
    return response.data;
  },

  discoverComponents: async (projectId: string) => {
    const response = await api.post<Project>(`/projects/${projectId}/discover-components`);
    return response.data;
  },

  validate: async (projectId: string) => {
    const response = await api.post<{
      valid: boolean | null;  // null indicates pending/unknown status
      pending?: boolean;  // true if dependencies are still installing
      message?: string;
      error?: string;
      details?: {
        stdout?: string;
        stderr?: string;
        validation_error?: string;
        asset_count?: number;
      } | null;
    }>(`/projects/${projectId}/validate`);
    return response.data;
  },

  updateProject: async (projectId: string, updates: Partial<Project>) => {
    const response = await api.put<Project>(`/projects/${projectId}`, updates);
    return response.data;
  },

  addCustomLineage: async (projectId: string, source: string, target: string) => {
    const response = await api.post<Project>(`/projects/${projectId}/custom-lineage`, {
      source,
      target,
    });
    return response.data;
  },

  removeCustomLineage: async (projectId: string, source: string, target: string) => {
    const response = await api.delete<Project>(`/projects/${projectId}/custom-lineage`, {
      data: { source, target },
    });
    return response.data;
  },

  // dbt authoring: discover the dbt project(s) inside this Dagster
  // project (local + git-cloned repos), scaffold new models, commit
  // changes back to the origin remote.
  listDbtProjects: async (projectId: string): Promise<{
    projects: Array<{
      name: string;
      relative_path: string;
      model_paths: string[];
      profile: string | null;
      version: string | null;
      is_git_repo: boolean;
    }>;
  }> => {
    const response = await api.get(`/projects/${projectId}/dbt-projects`);
    return response.data as any;
  },

  listDbtModels: async (
    projectId: string,
    dbtRelativePath?: string,
  ): Promise<{
    dbt_project_relative_path: string;
    project_name: string | null;
    models: Array<{
      unique_id: string;
      name: string;
      resource_type: string;
      schema: string | null;
      database: string | null;
      description: string | null;
      materialization: string | null;
      tags: string[];
      depends_on_nodes: string[];
      package_name: string | null;
      relative_sql_path: string | null;
      columns: Record<string, { description?: string | null; data_type?: string | null; tests: string[] }>;
      tests: string[];
      tests_detail: Array<{
        unique_id: string;
        name: string;
        test_kind: string;
        target_column: string | null;
        last_run_status: string | null;
        last_run_message: string | null;
        last_run_failures: number | null;
        duration_ms: number | null;
      }>;
      last_run_status: string | null;
      last_run_duration_ms: number | null;
      row_count: number | null;
      bytes_bytes: number | null;
    }>;
    stats: Record<string, number>;
  }> => {
    const response = await api.get(`/projects/${projectId}/dbt-models`, {
      params: dbtRelativePath ? { dbt_relative_path: dbtRelativePath } : {},
    });
    return response.data as any;
  },

  previewDbtModel: async (
    projectId: string,
    body: { dbt_relative_path: string; model_name: string; limit?: number; target?: string | null },
  ): Promise<{
    success: boolean;
    columns: string[];
    dtypes: Record<string, string>;
    data: Array<Record<string, any>>;
    row_count: number;
    compiled_sql: string | null;
    error: string | null;
    duration_ms: number;
  }> => {
    const response = await api.post(`/projects/${projectId}/dbt-model-preview`, body);
    return response.data as any;
  },

  getDbtCost: async (
    projectId: string,
    dbtRelativePath?: string,
  ): Promise<{
    dbt_project_relative_path: string;
    project_name: string | null;
    total_bytes: number;
    total_rows: number;
    total_usd: number;
    per_model: Array<{
      unique_id: string;
      name: string;
      duration_ms: number | null;
      bytes_processed: number | null;
      rows_processed: number | null;
      slot_ms: number | null;
      query_id: string | null;
      warehouse: string | null;
      usd_estimate: number | null;
      raw_adapter_response: Record<string, any>;
    }>;
    pricing_note: string;
  }> => {
    const response = await api.get(`/projects/${projectId}/dbt-cost`, {
      params: dbtRelativePath ? { dbt_relative_path: dbtRelativePath } : {},
    });
    return response.data as any;
  },

  getDbtModelDiff: async (
    projectId: string,
    dbtRelativePath: string,
    relativeSqlPath: string,
  ): Promise<{ current: string; committed: string; committed_sha: string | null; is_dirty: boolean }> => {
    const response = await api.get(`/projects/${projectId}/dbt-model-diff`, {
      params: { dbt_relative_path: dbtRelativePath, relative_sql_path: relativeSqlPath },
    });
    return response.data as any;
  },

  getDbtSourceFreshness: async (
    projectId: string,
    dbtRelativePath?: string,
  ): Promise<{
    dbt_project_relative_path: string;
    project_name: string | null;
    sources: Array<{
      unique_id: string;
      source_name: string;
      table_name: string;
      schema: string | null;
      loaded_at_field: string | null;
      max_loaded_at_field_pass: { count: number; period: string } | null;
      max_loaded_at_field_error: { count: number; period: string } | null;
      last_run_status: string | null;
      last_loaded_at: string | null;
      max_age_seconds: number | null;
    }>;
  }> => {
    const response = await api.get(`/projects/${projectId}/dbt-source-freshness`, {
      params: dbtRelativePath ? { dbt_relative_path: dbtRelativePath } : {},
    });
    return response.data as any;
  },

  getDbtColumnLineage: async (
    projectId: string,
    dbtRelativePath?: string,
  ): Promise<{
    dbt_project_relative_path: string;
    project_name: string | null;
    columns_by_model: Record<string, string[]>;
    edges: Array<{
      from_unique_id: string;
      from_column: string;
      to_unique_id: string;
      to_column: string;
      confidence: number;
    }>;
    warnings: string[];
  }> => {
    const response = await api.get(`/projects/${projectId}/dbt-column-lineage`, {
      params: dbtRelativePath ? { dbt_relative_path: dbtRelativePath } : {},
    });
    return response.data as any;
  },

  getDbtDocs: async (
    projectId: string,
    dbtRelativePath?: string,
  ): Promise<{
    dbt_project_relative_path: string;
    overview_markdown: string | null;
    overview_relative_path: string | null;
    blocks: Array<{ name: string; content: string; relative_path: string }>;
  }> => {
    const response = await api.get(`/projects/${projectId}/dbt-docs`, {
      params: dbtRelativePath ? { dbt_relative_path: dbtRelativePath } : {},
    });
    return response.data as any;
  },

  scaffoldDbtDocs: async (
    projectId: string,
    body: { dbt_relative_path: string; generate_blocks?: boolean },
  ): Promise<{
    success: boolean;
    overview_written: string | null;
    blocks_written: string | null;
    already_existed: boolean;
  }> => {
    const response = await api.post(`/projects/${projectId}/dbt-docs/scaffold`, body);
    return response.data as any;
  },

  generateDbtDocs: async (
    projectId: string,
    body: { dbt_relative_path: string },
  ): Promise<{ success: boolean; duration_ms: number; stdout: string; stderr: string }> => {
    const response = await api.post(`/projects/${projectId}/dbt-docs/generate`, body);
    return response.data as any;
  },

  addDbtProject: async (
    projectId: string,
    body: {
      mode: 'clone' | 'scaffold';
      name: string;
      git_url?: string;
      git_token?: string;
      git_branch?: string;
      subpath?: string;
      profile?: string;
      adapter?: string;
    },
  ): Promise<{ success: boolean; relative_path: string; message: string | null }> => {
    const response = await api.post(`/projects/${projectId}/dbt-project/add`, body);
    return response.data as any;
  },

  getDbtSelectors: async (
    projectId: string,
    dbtRelativePath?: string,
  ): Promise<{
    dbt_project_relative_path: string;
    selectors: Array<{
      name: string;
      description: string | null;
      definition: Record<string, any>;
      default: boolean;
    }>;
  }> => {
    const response = await api.get(`/projects/${projectId}/dbt-selectors`, {
      params: dbtRelativePath ? { dbt_relative_path: dbtRelativePath } : {},
    });
    return response.data as any;
  },

  addDbtSelector: async (
    projectId: string,
    body: {
      dbt_relative_path: string;
      name: string;
      description?: string | null;
      definition: Record<string, any>;
      default?: boolean;
    },
  ): Promise<{
    dbt_project_relative_path: string;
    selectors: Array<{ name: string; description: string | null; definition: Record<string, any>; default: boolean }>;
  }> => {
    const response = await api.post(`/projects/${projectId}/dbt-selectors`, body);
    return response.data as any;
  },

  addDbtExposure: async (
    projectId: string,
    body: {
      dbt_relative_path: string;
      name: string;
      type?: string;
      label?: string | null;
      description?: string | null;
      owner_name?: string | null;
      owner_email?: string | null;
      url?: string | null;
      maturity?: string | null;
      depends_on?: string[];
    },
  ): Promise<{
    dbt_project_relative_path: string;
    exposures: any[];
  }> => {
    const response = await api.post(`/projects/${projectId}/dbt-exposures`, body);
    return response.data as any;
  },

  addDbtTest: async (
    projectId: string,
    body: {
      dbt_relative_path: string;
      model_unique_id: string;
      kind: 'not_null' | 'unique' | 'accepted_values' | 'relationships' | 'dbt_utils' | 'singular';
      column?: string | null;
      values?: string[] | null;
      to_model_name?: string | null;
      to_field?: string | null;
      package_test_name?: string | null;
      package_test_config?: Record<string, any> | null;
      test_name?: string | null;
      sql?: string | null;
      description?: string | null;
    },
  ): Promise<{ success: boolean; relative_path: string; detail: string | null }> => {
    const response = await api.post(`/projects/${projectId}/dbt-test`, body);
    return response.data as any;
  },

  deleteDbtTest: async (
    projectId: string,
    body: { dbt_relative_path: string; test_unique_id: string },
  ): Promise<{ success: boolean; relative_path: string; detail: string | null }> => {
    const response = await api.post(`/projects/${projectId}/dbt-test/delete`, body);
    return response.data as any;
  },

  addDbtSource: async (
    projectId: string,
    body: {
      dbt_relative_path: string;
      source_name: string;
      schema?: string | null;
      database?: string | null;
      table_name: string;
      description?: string | null;
      loaded_at_field?: string | null;
      warn_after?: { count: number; period: 'minute' | 'hour' | 'day' } | null;
      error_after?: { count: number; period: 'minute' | 'hour' | 'day' } | null;
      columns?: Array<{ name: string; description?: string | null; tests?: string[] }>;
    },
  ): Promise<{ success: boolean; relative_path: string }> => {
    const response = await api.post(`/projects/${projectId}/dbt-sources`, body);
    return response.data as any;
  },

  getDbtExposures: async (
    projectId: string,
    dbtRelativePath?: string,
  ): Promise<{
    dbt_project_relative_path: string;
    exposures: Array<{
      unique_id: string;
      name: string;
      type: string | null;
      label: string | null;
      description: string | null;
      owner_name: string | null;
      owner_email: string | null;
      url: string | null;
      maturity: string | null;
      tags: string[];
      depends_on_nodes: string[];
    }>;
  }> => {
    const response = await api.get(`/projects/${projectId}/dbt-exposures`, {
      params: dbtRelativePath ? { dbt_relative_path: dbtRelativePath } : {},
    });
    return response.data as any;
  },

  runDbtModel: async (
    projectId: string,
    body: {
      dbt_relative_path: string;
      select: string;
      exclude?: string | null;
      defer?: boolean;
      state_dir?: string | null;
      full_refresh?: boolean;
      target?: string | null;
    },
  ): Promise<{ success: boolean; duration_ms: number; stdout: string; stderr: string }> => {
    const response = await api.post(`/projects/${projectId}/dbt/run`, body);
    return response.data as any;
  },

  addDbtModel: async (
    projectId: string,
    body: {
      dbt_project_relative_path: string;
      model_name: string;
      subfolder?: string | null;
      materialization: 'view' | 'table' | 'incremental' | 'ephemeral';
      sql: string;
      description?: string | null;
      tests?: Array<Record<string, any>> | null;
    },
  ): Promise<{ success: boolean; sql_path: string; schema_written: boolean }> => {
    const response = await api.post(`/projects/${projectId}/dbt-model`, body);
    return response.data as any;
  },

  projectGitStatus: async (
    projectId: string,
    subpath?: string,
  ): Promise<{
    is_git_repo: boolean;
    branch: string | null;
    ahead: number;
    behind: number;
    modified: string[];
    untracked: string[];
    staged: string[];
  }> => {
    const response = await api.get(`/projects/${projectId}/git/status`, {
      params: subpath ? { subpath } : {},
    });
    return response.data as any;
  },

  projectGitCommitPush: async (
    projectId: string,
    body: {
      subpath?: string | null;
      files: string[];
      message: string;
      token?: string | null;
      push?: boolean;
    },
  ): Promise<{ success: boolean; committed_sha: string | null; pushed: boolean; detail?: string | null }> => {
    const response = await api.post(`/projects/${projectId}/git/commit-push`, body);
    return response.data as any;
  },

  exportYAML: async (projectId: string) => {
    const response = await api.get<{ yaml_content: string; filename: string }>(
      `/projects/${projectId}/export-yaml`
    );
    return response.data;
  },

  importYAML: async (projectId: string, yamlContent: string) => {
    const response = await api.post<Project>(`/projects/${projectId}/import-yaml`, {
      yaml_content: yamlContent,
    });
    return response.data;
  },
};

// Codegen API
export const codegenApi = {
  preview: async (projectId: string) => {
    const response = await api.get<{ files: Record<string, string>; project_name: string }>(
      `/codegen/preview/${projectId}`
    );
    return response.data;
  },

  generate: async (projectId: string, includeDeployment = true) => {
    const response = await api.post(
      '/codegen/generate',
      { project_id: projectId, include_deployment: includeDeployment },
      { responseType: 'blob' }
    );
    return response.data;
  },
};

// Git API
export const gitApi = {
  clone: async (repoUrl: string, token?: string, branch = 'main') => {
    const response = await api.post<{ repo_path: string; repo_name: string }>(
      '/git/clone',
      { repo_url: repoUrl, token, branch }
    );
    return response.data;
  },

  commitPush: async (
    repoName: string,
    files: string[],
    message: string,
    token?: string
  ) => {
    const response = await api.post('/git/commit-push', {
      repo_name: repoName,
      files,
      message,
      token,
    });
    return response.data;
  },

  pull: async (repoName: string, token?: string) => {
    const response = await api.post('/git/pull', { repo_name: repoName, token });
    return response.data;
  },

  status: async (repoName: string) => {
    const response = await api.get(`/git/status/${repoName}`);
    return response.data;
  },
};

// Dagster CLI API
export interface AssetInfo {
  key: string;
  group_name?: string;
  description?: string;
  deps: string[];
  metadata: Record<string, any>;
}

export interface AssetPreviewResponse {
  success: boolean;
  assets: AssetInfo[];
  asset_count: number;
  error?: string;
}

export const dagsterApi = {
  createProject: async (projectId: string, projectName: string) => {
    const response = await api.post('/dagster/create-project', {
      project_id: projectId,
      project_name: projectName,
    });
    return response.data;
  },

  scaffoldComponent: async (
    projectId: string,
    componentType: string,
    componentName: string,
    options: Record<string, any>
  ) => {
    const response = await api.post('/dagster/scaffold-component', {
      project_id: projectId,
      component_type: componentType,
      component_name: componentName,
      options,
    });
    return response.data;
  },

  previewAssets: async (projectId: string): Promise<AssetPreviewResponse> => {
    const response = await api.get<AssetPreviewResponse>(
      `/dagster/preview-assets/${projectId}`
    );
    return response.data;
  },

  validateProject: async (projectId: string) => {
    const response = await api.get(`/dagster/validate-project/${projectId}`);
    return response.data;
  },

  listComponents: async () => {
    const response = await api.get('/dagster/list-components');
    return response.data;
  },

  getComponentOptions: async (componentType: string) => {
    const response = await api.get(`/dagster/component-options/${componentType}`);
    return response.data;
  },
};

// Files API
export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  children?: FileTreeNode[];
}

export interface FileListResponse {
  project_id: string;
  path: string;
  tree: {
    children: FileTreeNode[];
  };
}

export interface FileReadResponse {
  project_id: string;
  path: string;
  content: string | null;
  size: number;
  is_binary: boolean;
  message?: string;
}

export interface FileWriteResponse {
  project_id: string;
  path: string;
  size: number;
  message: string;
}

export interface ExecuteCommandRequest {
  command: string;
  timeout?: number;
}

export interface ExecuteCommandResponse {
  project_id: string;
  command: string;
  stdout: string;
  stderr: string;
  return_code: number;
  success: boolean;
}

export const filesApi = {
  list: async (projectId: string, path: string = ''): Promise<FileListResponse> => {
    const response = await api.get<FileListResponse>(`/files/list/${projectId}`, {
      params: { path },
    });
    return response.data;
  },

  read: async (projectId: string, filePath: string): Promise<FileReadResponse> => {
    const response = await api.get<FileReadResponse>(`/files/read/${projectId}/${filePath}`);
    return response.data;
  },

  write: async (projectId: string, filePath: string, content: string): Promise<FileWriteResponse> => {
    const response = await api.post<FileWriteResponse>(
      `/files/write/${projectId}/${filePath}`,
      { content }
    );
    return response.data;
  },

  delete: async (projectId: string, filePath: string): Promise<{ message: string }> => {
    const response = await api.delete<{ message: string }>(`/files/delete/${projectId}/${filePath}`);
    return response.data;
  },

  createDirectory: async (projectId: string, dirPath: string): Promise<{ message: string }> => {
    const response = await api.post<{ message: string }>(`/files/mkdir/${projectId}/${dirPath}`);
    return response.data;
  },

  deleteDirectory: async (projectId: string, dirPath: string): Promise<{ message: string }> => {
    const response = await api.delete<{ message: string }>(`/files/rmdir/${projectId}/${dirPath}`);
    return response.data;
  },

  rename: async (projectId: string, oldPath: string, newPath: string): Promise<{ message: string; old_path: string; new_path: string }> => {
    const response = await api.post<{ message: string; old_path: string; new_path: string }>(
      `/files/rename/${projectId}/${oldPath}`,
      { new_path: newPath }
    );
    return response.data;
  },

  execute: async (
    projectId: string,
    command: string,
    timeout: number = 30
  ): Promise<ExecuteCommandResponse> => {
    const response = await api.post<ExecuteCommandResponse>(`/files/execute/${projectId}`, {
      command,
      timeout,
    });
    return response.data;
  },
};

// Templates API
export type PrimitiveType = 'python_asset' | 'sql_asset' | 'schedule' | 'job' | 'sensor' | 'asset_check' | 'io_manager' | 'resource' | 'freshness_policy';

export interface PythonAssetParams {
  asset_name: string;
  group_name?: string;
  description?: string;
  compute_kind?: string;
  code?: string;
  deps?: string[];
  owners?: string[];
  tags?: Record<string, string>;
}

export interface SQLAssetParams {
  asset_name: string;
  query: string;
  group_name?: string;
  description?: string;
  io_manager_key?: string;
  deps?: string[];
}

export interface ScheduleParams {
  schedule_name: string;
  cron_expression: string;
  job_name?: string;
  asset_selection?: string[];
  description?: string;
  timezone?: string;
}

export interface JobParams {
  job_name: string;
  asset_selection: string[];
  description?: string;
  tags?: Record<string, string>;
  project_id?: string;  // For partition validation
}

export interface SensorParams {
  sensor_name: string;
  sensor_type: 'file' | 'run_status' | 'asset' | 'custom' | 's3' | 'email' | 'filesystem' | 'database' | 'webhook';
  job_name: string;
  description?: string;
  file_path?: string;
  asset_key?: string;
  monitored_job_name?: string;
  run_status?: 'SUCCESS' | 'FAILURE' | 'CANCELED';
  minimum_interval_seconds?: number;
  // S3 sensor params
  bucket_name?: string;
  prefix?: string;
  pattern?: string;
  aws_region?: string;
  since_key?: string;
  // Email sensor params
  imap_host?: string;
  imap_port?: number;
  email_user?: string;
  email_password?: string;
  mailbox?: string;
  subject_pattern?: string;
  from_pattern?: string;
  mark_as_read?: boolean;
  // Filesystem sensor params
  directory_path?: string;
  file_pattern?: string;
  recursive?: boolean;
  move_after_processing?: boolean;
  archive_directory?: string;
  // Database sensor params
  connection_string?: string;
  table_name?: string;
  timestamp_column?: string;
  query_condition?: string;
  batch_size?: number;
  // Webhook sensor params
  webhook_path?: string;
  auth_token?: string;
  validate_signature?: boolean;
  signature_header?: string;
  secret_key?: string;
  // Community sensor params (allows passthrough of community component fields)
  component_type?: string;
  [key: string]: any;
}

export interface AssetCheckParams {
  check_name: string;
  asset_name: string;
  check_type: 'row_count' | 'freshness' | 'schema' | 'custom';
  description?: string;
  threshold?: number;
  max_age_hours?: number;
}

export interface FreshnessPolicyParams {
  policy_name: string;
  description?: string;
  maximum_lag_minutes?: number;
  maximum_lag_env_var?: string;
  cron_schedule?: string;
  cron_env_var?: string;
}

export interface IOManagerParams {
  io_manager_name: string;
  io_manager_type: 'filesystem' | 'duckdb' | 'duckdb_pandas' | 'duckdb_polars' | 'duckdb_pyspark' |
    'snowflake' | 'snowflake_pandas' | 'snowflake_polars' | 'snowflake_pyspark' |
    'polars' | 'deltalake' | 'deltalake_pandas' | 'deltalake_polars' |
    'iceberg' | 'custom';
  description?: string;
  base_path?: string;
  database_path?: string;
  account?: string;
  user?: string;
  password?: string;
  database?: string;
  schema?: string;
  warehouse?: string;
  table_path?: string;
  config_params?: Record<string, string>;
}

export interface ResourceParams {
  resource_name: string;
  resource_type: 'database' | 'api_client' |
    'airbyte' | 'fivetran' | 'census' | 'hightouch' |
    'databricks' | 'snowflake_resource' |
    'aws_s3' | 'aws_athena' | 'gcp_bigquery' | 'gcp_gcs' | 'azure_blob' |
    'dbt' | 'sling' |
    'custom';
  description?: string;
  connection_string?: string;
  api_key?: string;
  api_url?: string;
  account_id?: string;
  region?: string;
  project_id?: string;
  workspace_id?: string;
  host?: string;
  token?: string;
  config_params?: Record<string, string>;
}

export interface TemplateResponse {
  code: string;
}

export interface SaveTemplateRequest {
  project_id: string;
  primitive_type: PrimitiveType;
  name: string;
  code: string;
}

export const templatesApi = {
  preview: async (primitiveType: PrimitiveType, params: any): Promise<TemplateResponse> => {
    const response = await api.post<TemplateResponse>('/templates/preview', {
      primitive_type: primitiveType,
      params,
    });
    return response.data;
  },

  generatePythonAsset: async (params: PythonAssetParams): Promise<TemplateResponse> => {
    const response = await api.post<TemplateResponse>('/templates/python-asset', params);
    return response.data;
  },

  generateSQLAsset: async (params: SQLAssetParams): Promise<TemplateResponse> => {
    const response = await api.post<TemplateResponse>('/templates/sql-asset', params);
    return response.data;
  },

  generateSchedule: async (params: ScheduleParams): Promise<TemplateResponse> => {
    const response = await api.post<TemplateResponse>('/templates/schedule', params);
    return response.data;
  },

  generateJob: async (params: JobParams): Promise<TemplateResponse> => {
    const response = await api.post<TemplateResponse>('/templates/job', params);
    return response.data;
  },

  generateSensor: async (params: SensorParams): Promise<TemplateResponse> => {
    const response = await api.post<TemplateResponse>('/templates/sensor', params);
    return response.data;
  },

  generateAssetCheck: async (params: AssetCheckParams): Promise<TemplateResponse> => {
    const response = await api.post<TemplateResponse>('/templates/asset-check', params);
    return response.data;
  },

  generateFreshnessPolicy: async (params: FreshnessPolicyParams): Promise<TemplateResponse> => {
    const response = await api.post<TemplateResponse>('/templates/freshness-policy', params);
    return response.data;
  },

  generateIOManager: async (params: IOManagerParams): Promise<TemplateResponse> => {
    const response = await api.post<TemplateResponse>('/templates/io-manager', params);
    return response.data;
  },

  generateResource: async (params: ResourceParams): Promise<TemplateResponse> => {
    const response = await api.post<TemplateResponse>('/templates/resource', params);
    return response.data;
  },

  createPythonAsset: async (params: {
    project_id: string;
    asset_name: string;
    group_name?: string;
    description?: string;
    deps?: string[];
  }): Promise<{ message: string; file_path: string; asset_name: string }> => {
    const response = await api.post<{ message: string; file_path: string; asset_name: string }>(
      '/templates/create-python-asset',
      params
    );
    return response.data;
  },

  save: async (request: SaveTemplateRequest): Promise<{ message: string; file_path: string }> => {
    const response = await api.post<{ message: string; file_path: string }>(
      '/templates/save',
      request
    );
    return response.data;
  },

  getExamples: async (primitiveType: PrimitiveType): Promise<{ examples: any[] }> => {
    const response = await api.get<{ examples: any[] }>(
      `/templates/examples/${primitiveType}`
    );
    return response.data;
  },

  // Get installed community components
  getInstalled: async (projectId: string): Promise<{ components: InstalledComponent[] }> => {
    const response = await api.get<{ components: InstalledComponent[] }>(
      `/templates/installed/${projectId}`
    );
    return response.data;
  },

  // Get schema for an installed community component
  getInstalledComponentSchema: async (projectId: string, componentId: string): Promise<ComponentSchema> => {
    const response = await api.get<ComponentSchema>(
      `/templates/installed/${projectId}/${componentId}/schema`
    );
    return response.data;
  },
};

// Installed Community Component types
export interface InstalledComponent {
  id: string;
  name: string;
  description: string;
  component_type: string;
  category: string;
  version: string;
}

export interface ComponentSchema {
  type: string;
  name: string;
  category: string;
  description: string;
  version?: string;
  attributes: Record<string, ComponentAttribute>;
  outputs?: any[];
  dependencies?: any;
  tags?: string[];
  schema?: Record<string, any>;
  icon?: string;
  module?: string;
  'x-dagster-io'?: Record<string, any>;
}

export interface ComponentAttribute {
  type: 'string' | 'number' | 'boolean' | 'select';
  required: boolean;
  label: string;
  description: string;
  default?: any;
  placeholder?: string;
  sensitive?: boolean;
  enum?: string[];
  min?: number;
  max?: number;
}

// Primitives API
export type PrimitiveCategory = 'schedule' | 'job' | 'sensor' | 'asset_check' | 'freshness_policy';

export interface PrimitiveItem {
  name: string;
  file: string;
  description: string;
  [key: string]: any; // Additional fields based on type
}

export interface PrimitivesListResponse {
  project_id: string;
  category: PrimitiveCategory;
  primitives: PrimitiveItem[];
  total: number;
}

export interface AllPrimitivesResponse {
  project_id: string;
  primitives: {
    schedules: PrimitiveItem[];
    jobs: PrimitiveItem[];
    sensors: PrimitiveItem[];
    asset_checks: PrimitiveItem[];
    freshness_policies?: PrimitiveItem[];
  };
}

export interface PrimitiveDetailsResponse {
  project_id: string;
  category: PrimitiveCategory;
  primitive: PrimitiveItem & { code: string };
}

export interface StatisticsResponse {
  project_id: string;
  statistics: {
    schedules: number;
    jobs: number;
    sensors: number;
    asset_checks: number;
    total: number;
  };
}

// Dagster UI API
export interface DagsterUIStatus {
  running: boolean;
  url: string;
  port: number;
  pid?: number;
}

export const dagsterUIApi = {
  getStatus: async (projectId: string): Promise<DagsterUIStatus> => {
    const response = await api.get<DagsterUIStatus>(`/dagster-ui/status/${projectId}`);
    return response.data;
  },

  start: async (projectId: string): Promise<{ message: string; url: string; port: number; pid: number }> => {
    const response = await api.post<{ message: string; url: string; port: number; pid: number }>(
      `/dagster-ui/start/${projectId}`
    );
    return response.data;
  },

  stop: async (projectId: string): Promise<{ message: string; pid: number }> => {
    const response = await api.post<{ message: string; pid: number }>(
      `/dagster-ui/stop/${projectId}`
    );
    return response.data;
  },
};

// DBT Adapters API
export interface AdapterInfo {
  adapter_type: string;
  required: boolean;
  installed: boolean;
  package_name: string;
  version?: string | null;
}

export interface AdapterStatusResponse {
  project_id: string;
  adapters: AdapterInfo[];
  dbt_project_path?: string | null;
}

export interface InstallAdapterResponse {
  success: boolean;
  message: string;
  stdout: string;
  stderr: string;
}

export const dbtAdaptersApi = {
  getStatus: async (projectId: string): Promise<AdapterStatusResponse> => {
    const response = await api.get<AdapterStatusResponse>(`/dbt-adapters/${projectId}/status`);
    return response.data;
  },

  install: async (projectId: string, adapterType: string): Promise<InstallAdapterResponse> => {
    const response = await api.post<InstallAdapterResponse>(
      `/dbt-adapters/${projectId}/install`,
      { adapter_type: adapterType }
    );
    return response.data;
  },
};

export interface IntegrationStatusResponse {
  package: string;
  installed: boolean;
  version?: string | null;
}

export interface InstallIntegrationResponse {
  success: boolean;
  message: string;
  stdout: string;
  stderr: string;
}

export const integrationsApi = {
  getStatus: async (projectId: string, packageName: string): Promise<IntegrationStatusResponse> => {
    const response = await api.get<IntegrationStatusResponse>(`/integrations/${projectId}/status/${packageName}`);
    return response.data;
  },

  install: async (projectId: string, packageName: string): Promise<InstallIntegrationResponse> => {
    const response = await api.post<InstallIntegrationResponse>(
      `/integrations/${projectId}/install`,
      { package: packageName }
    );
    return response.data;
  },
};

export interface DefinitionJob {
  name: string;
  description: string;
  source: string | null;
}

export interface DefinitionSchedule {
  name: string;
  cron_schedule: string;
  source: string | null;
}

export interface DefinitionSensor {
  name: string;
  source: string | null;
}

export interface DefinitionAssetCheck {
  key: string;
  asset_key: string;
  name: string;
  additional_deps: string[];
  description: string | null;
  source: string | null;
}

export interface AllDefinitionsResponse {
  project_id: string;
  jobs: DefinitionJob[];
  schedules: DefinitionSchedule[];
  sensors: DefinitionSensor[];
  asset_checks: DefinitionAssetCheck[];
  freshness_policies?: any[];
  using_fallback?: boolean;
  validation_error?: string;
}

export interface PrimitiveSearchResult {
  found: boolean;
  file_path?: string;
  line_number?: number;
  primitive_type: string;
  name: string;
}

export const primitivesApi = {
  list: async (
    projectId: string,
    category: PrimitiveCategory
  ): Promise<PrimitivesListResponse> => {
    const response = await api.get<PrimitivesListResponse>(
      `/primitives/list/${projectId}/${category}`
    );
    return response.data;
  },

  listAll: async (projectId: string): Promise<AllPrimitivesResponse> => {
    const response = await api.get<AllPrimitivesResponse>(`/primitives/list/${projectId}`);
    return response.data;
  },

  getDetails: async (
    projectId: string,
    category: PrimitiveCategory,
    name: string
  ): Promise<PrimitiveDetailsResponse> => {
    const response = await api.get<PrimitiveDetailsResponse>(
      `/primitives/details/${projectId}/${category}/${name}`
    );
    return response.data;
  },

  delete: async (
    projectId: string,
    category: PrimitiveCategory,
    name: string
  ): Promise<{ message: string }> => {
    const response = await api.delete<{ message: string }>(
      `/primitives/delete/${projectId}/${category}/${name}`
    );
    return response.data;
  },

  getStatistics: async (projectId: string): Promise<StatisticsResponse> => {
    const response = await api.get<StatisticsResponse>(`/primitives/statistics/${projectId}`);
    return response.data;
  },

  getAllDefinitions: async (projectId: string): Promise<AllDefinitionsResponse> => {
    const response = await api.get<AllDefinitionsResponse>(`/primitives/definitions/${projectId}`);
    return response.data;
  },

  searchPrimitiveDefinition: async (
    projectId: string,
    primitiveType: string,
    name: string
  ): Promise<PrimitiveSearchResult> => {
    const response = await api.get<PrimitiveSearchResult>(
      `/primitives/definitions/${projectId}/search/${primitiveType}/${name}`
    );
    return response.data;
  },
};

// Environment Variables API
export interface EnvVariable {
  key: string;
  value: string;
  is_sensitive: boolean;
}

export interface EnvVarsResponse {
  variables: EnvVariable[];
}

export const envVarsApi = {
  get: async (projectId: string): Promise<EnvVarsResponse> => {
    const response = await api.get<EnvVarsResponse>(`/env/${projectId}`);
    return response.data;
  },

  update: async (projectId: string, variables: EnvVariable[]): Promise<{ message: string }> => {
    const response = await api.put<{ message: string }>(
      `/env/${projectId}`,
      { variables }
    );
    return response.data;
  },
};

// Pipelines API
export interface PipelineCreateRequest {
  name: string;
  description: string;
  asset_selection: string[];
  trigger_type: 'manual' | 'schedule' | 'sensor';
  cron_schedule?: string;
  sensor_config?: any;
}

export interface PipelineResponse {
  id: string;
  name: string;
  description: string;
  asset_selection: string[];
  trigger_type: string;
  cron_schedule?: string;
  files_created: string[];
}

export interface PipelineListItem {
  id: string;
  name: string;
  description: string;
  file: string;
}

export interface PipelinesListResponse {
  project_id: string;
  pipelines: PipelineListItem[];
  total: number;
}

export interface LaunchJobRequest {
  config?: Record<string, any>;
  tags?: Record<string, string>;
}

export interface LaunchJobResponse {
  success: boolean;
  message: string;
  stdout: string;
  stderr: string;
}

export const pipelinesApi = {
  create: async (projectId: string, pipeline: PipelineCreateRequest): Promise<PipelineResponse> => {
    const response = await api.post<PipelineResponse>(
      `/pipelines/create/${projectId}`,
      pipeline
    );
    return response.data;
  },

  list: async (projectId: string): Promise<PipelinesListResponse> => {
    const response = await api.get<PipelinesListResponse>(`/pipelines/list/${projectId}`);
    return response.data;
  },

  getDetails: async (projectId: string, pipelineName: string): Promise<any> => {
    const response = await api.get(`/pipelines/details/${projectId}/${pipelineName}`);
    return response.data;
  },

  getSensorTypes: async (projectId: string): Promise<any> => {
    const response = await api.get(`/pipelines/sensor-types/${projectId}`);
    return response.data;
  },

  launch: async (
    projectId: string,
    jobName: string,
    config?: Record<string, any>,
    tags?: Record<string, string>
  ): Promise<LaunchJobResponse> => {
    const response = await api.post<LaunchJobResponse>(
      `/pipelines/${projectId}/${jobName}/launch`,
      { config, tags }
    );
    return response.data;
  },
};

// ============================================================================
// Partition & Backfill Types and API
// ============================================================================

export interface PartitionDef {
  type: string;
  partition_keys?: string[];
  partition_count?: number;
  start_date?: string;
  end_date?: string;
  cron_schedule?: string;
  date_format?: string;
  timezone?: string;
  sample_note?: string;
}

export interface PartitionInfoResponse {
  asset_key: string;
  is_partitioned: boolean;
  partitions_def?: PartitionDef | null;
}

export interface ConfigField {
  is_required: boolean;
  description?: string;
  config_type?: any;
  default_value?: any;
}

export interface ConfigSchema {
  kind?: string;
  description?: string;
  fields?: Record<string, ConfigField>;
  inner_type?: any;
}

export interface ConfigSchemaResponse {
  asset_key: string;
  has_config: boolean;
  config_schema?: ConfigSchema | null;
  default_config?: Record<string, any> | null;
}

export interface BackfillRequest {
  asset_keys: string[];
  partition_selection?: string[] | null;
  partition_range?: {
    start: string;
    end: string;
  } | null;
  config?: Record<string, any> | null;
  tags?: Record<string, string> | null;
}

export interface BackfillResponse {
  success: boolean;
  message: string;
  stdout: string;
  stderr: string;
}

export const partitionsApi = {
  getPartitionInfo: async (projectId: string, assetKey: string): Promise<PartitionInfoResponse> => {
    const response = await api.get<PartitionInfoResponse>(
      `/projects/${projectId}/assets/${encodeURIComponent(assetKey)}/partitions`
    );
    return response.data;
  },

  getConfigSchema: async (projectId: string, assetKey: string): Promise<ConfigSchemaResponse> => {
    const response = await api.get<ConfigSchemaResponse>(
      `/projects/${projectId}/assets/${encodeURIComponent(assetKey)}/config-schema`
    );
    return response.data;
  },

  launchBackfill: async (projectId: string, request: BackfillRequest): Promise<BackfillResponse> => {
    const response = await api.post<BackfillResponse>(
      `/projects/${projectId}/backfill`,
      request
    );
    return response.data;
  },
};

// Assets API
export interface AssetDataPreview {
  success: boolean;
  data: Record<string, any>[] | null;
  columns: string[] | null;
  dtypes: Record<string, string> | null;
  shape: [number, number] | null;
  row_count: number | null;
  column_count: number | null;
  error: string | null;
  sample_limit: number | null;
}

export interface CreateTransformerRequest {
  sourceAssetKey: string;
  newAssetName: string;
  transformConfig: {
    columnsToKeep: string[] | null;
    filters: {
      column: string;
      operator: string;
      value: string;
    }[];
  };
}

export const assetsApi = {
  previewData: async (
    projectId: string,
    assetKey: string,
    opts?: { sampleLimit?: number; noCache?: boolean },
  ): Promise<AssetDataPreview> => {
    const params: Record<string, string> = {};
    if (opts?.sampleLimit) params.sample_limit = String(opts.sampleLimit);
    if (opts?.noCache) params.no_cache = 'true';
    const response = await api.get<AssetDataPreview>(
      `/assets/${projectId}/${encodeURIComponent(assetKey)}/preview`,
      { params },
    );
    return response.data;
  },

  createTransformerAsset: async (projectId: string, request: CreateTransformerRequest): Promise<Project> => {
    const response = await api.post<Project>(
      `/assets/${projectId}/create-transformer`,
      request
    );
    return response.data;
  },

  /** Fetch the schema cache — `{asset_key: {columns: [...], dtypes: {...}}}`
   *  for every asset that's been previewed at least once. Powers the
   *  column-picker dropdowns in ComponentConfigModal so `*_column` fields
   *  don't force users to type column names blindly. */
  knownSchemas: async (
    projectId: string,
  ): Promise<Record<string, { columns: string[]; dtypes: Record<string, string> }>> => {
    const response = await api.get<Record<string, { columns: string[]; dtypes: Record<string, string> }>>(
      `/assets/${projectId}/known-schemas`,
    );
    return response.data;
  },

  /** Heuristic column-level lineage for one asset, generated from the
   *  preview cache (name-match passthrough + derived/dropped tagging).
   *  Universal across every component in the catalog — no
   *  per-component instrumentation needed to light this up. */
  columnLineage: async (
    projectId: string,
    assetKey: string,
  ): Promise<{
    asset_key: string;
    upstream: Array<{ asset_key: string; columns: string[] }>;
    downstream: Array<{ asset_key: string; columns: string[] }>;
    columns: string[];
    dtypes: Record<string, string>;
    upstream_edges: Array<{ from_asset: string; from_column: string; to_asset: string; to_column: string; confidence: number }>;
    downstream_edges: Array<{ from_asset: string; from_column: string; to_asset: string; to_column: string; confidence: number }>;
    derived_columns: string[];
    dropped_from_upstream: string[];
  }> => {
    const response = await api.get(`/assets/${projectId}/column-lineage`, {
      params: { asset_key: assetKey },
    });
    return response.data as any;
  },

  /** Read the ingestion event log — every materialize and every successful
   *  preview appends a record. The Ingestions tab computes its KPIs and
   *  the trend chart client-side from this list. */
  ingestionHistory: async (
    projectId: string,
    limit: number = 1000,
  ): Promise<{ events: IngestionEvent[] }> => {
    const response = await api.get<{ events: IngestionEvent[] }>(
      `/assets/${projectId}/ingestion-history`,
      { params: { limit } },
    );
    return response.data;
  },
};

export interface IngestionEvent {
  ts: string;                          // ISO-8601 UTC
  type: 'materialize' | 'preview';
  asset_key: string;
  component?: string;
  rows?: number;
  bytes?: number;
  duration_ms?: number;
  status: 'success' | 'failure' | 'running';
}

export default api;
