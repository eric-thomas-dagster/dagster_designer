import axios from 'axios';
import type {
  ComponentSchema,
  Project,
  ProjectCreate,
} from '@/types';

const API_BASE = '/api/v1';

const api = axios.create({
  baseURL: API_BASE,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 20000, // 20 second timeout to prevent requests from hanging forever
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
}

export interface MaterializeResponse {
  success: boolean;
  message: string;
  stdout: string;
  stderr: string;
}

export const projectsApi = {
  list: async () => {
    const response = await api.get<{ projects: Project[]; total: number }>('/projects');
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

  materialize: async (projectId: string, assetKeys?: string[]) => {
    const response = await api.post<MaterializeResponse>(
      `/projects/${projectId}/materialize`,
      { asset_keys: assetKeys }
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
      valid: boolean;
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
export type PrimitiveType = 'python_asset' | 'sql_asset' | 'schedule' | 'job' | 'sensor' | 'asset_check' | 'io_manager' | 'resource';

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
}

export interface AssetCheckParams {
  check_name: string;
  asset_name: string;
  check_type: 'row_count' | 'freshness' | 'schema' | 'custom';
  description?: string;
  threshold?: number;
  max_age_hours?: number;
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
export type PrimitiveCategory = 'schedule' | 'job' | 'sensor' | 'asset_check';

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
};

export default api;
