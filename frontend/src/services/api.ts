import axios from 'axios';
import type {
  Project,
  ProjectCreate,
} from '@/types';

// In the browser (dev or a plain web deploy) this stays relative and rides
// Vite's dev proxy / whatever reverse proxy fronts the app. The Tauri build
// sets VITE_API_BASE to an absolute http://127.0.0.1:PORT URL because the
// packaged webview loads the UI from a tauri:// origin, not from the
// backend's origin, so a relative path would resolve nowhere.
export const API_BASE = import.meta.env.VITE_API_BASE || '/api/v1';

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

/** The org's web UI base URL (not GraphQL) -- e.g. `https://hooli.dagster.cloud`
 *  or `https://hooli.eu.dagster.cloud`. Mirrors the backend's
 *  `dagster_plus_client.org_base_url` so every "Open in Dagster+" deep
 *  link respects the project's region instead of assuming US. */
export function dagsterPlusOrgBaseUrl(project: { dagster_plus_org?: string | null; dagster_plus_region?: string | null } | null | undefined): string {
  const org = (project?.dagster_plus_org || '')
    .replace(/^https?:\/\//, '')
    .replace(/\.eu\.dagster\.cloud.*$/, '')
    .replace(/\.dagster\.(cloud|plus).*$/, '')
    .split('/')[0];
  const suffix = (project?.dagster_plus_region || 'us').toLowerCase() === 'eu' ? 'eu.dagster.cloud' : 'dagster.cloud';
  return `https://${org}.${suffix}`;
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

  /** Moves or deletes every project in the current projects folder, ahead
   * of switching to a new one. Must be called before that switch -- it
   * acts on wherever the backend is currently pointed. */
  migrateFolder: async (targetDir: string, action: 'move' | 'delete') => {
    const response = await api.post<{ moved: number; deleted: number; skipped: { id: string; name: string; reason: string }[] }>(
      '/projects/migrate-folder',
      { target_dir: targetDir, action }
    );
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
  dependencyStatus: async (
    projectId: string,
  ): Promise<{ status: 'idle' | 'installing' | 'success' | 'error'; error: string | null }> => {
    const response = await api.get(`/projects/${projectId}/dependency-status`);
    return response.data as any;
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
      is_remote_git: boolean;
      remote_git_url: string | null;
      remote_git_relative_path: string;
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

  deleteDbtSelector: async (
    projectId: string,
    body: { dbt_relative_path: string; name: string },
  ): Promise<{ dbt_project_relative_path: string; selectors: any[] }> => {
    const response = await api.post(`/projects/${projectId}/dbt-selectors/delete`, body);
    return response.data as any;
  },

  deleteDbtExposure: async (
    projectId: string,
    body: { dbt_relative_path: string; name: string },
  ): Promise<{ dbt_project_relative_path: string; exposures: any[] }> => {
    const response = await api.post(`/projects/${projectId}/dbt-exposures/delete`, body);
    return response.data as any;
  },

  deleteDbtSource: async (
    projectId: string,
    body: { dbt_relative_path: string; source_name: string; table_name: string },
  ): Promise<{ success: boolean; relative_path: string }> => {
    const response = await api.post(`/projects/${projectId}/dbt-sources/delete`, body);
    return response.data as any;
  },

  deleteMonitor: async (
    projectId: string,
    body: { kind: 'dbt_test' | 'enhanced_check' | 'asset_check'; monitor_id: string; dbt_relative_path?: string | null },
  ): Promise<{ success: boolean; detail: string | null }> => {
    const response = await api.post(`/projects/${projectId}/monitors/delete`, body);
    return response.data as any;
  },

  // Generic per-page AI Assistant endpoints. Same response shape
  // across dbt / ingestions / automation / pipelines so the shared
  // AiAssistantPanel component doesn't care which page it's on.
  // ------------ Dagster+ (cloud) integration ---------------------------
  testDagsterPlusConnection: async (
    body: { name: string; description?: string; org: string; region?: 'us' | 'eu'; deployment: string; token: string; location?: string },
  ): Promise<{
    ok: boolean;
    version: string | null;
    detail: string | null;
    deployments: Array<{ deployment_name: string; deployment_type: string | null; deployment_status: string | null }>;
    default_deployment: string | null;
  }> => {
    const response = await api.post(`/projects/dagster-plus/test`, body);
    return response.data as any;
  },

  connectDagsterPlus: async (
    body: { name: string; description?: string; org: string; region?: 'us' | 'eu'; deployment: string; token: string; location?: string },
  ): Promise<{ id: string; name: string; is_dagster_plus: boolean; dagster_plus_org: string | null; dagster_plus_region: string | null; dagster_plus_deployment: string | null }> => {
    const response = await api.post(`/projects/dagster-plus/connect`, body);
    return response.data as any;
  },

  getDagsterPlusAssets: async (
    projectId: string,
  ): Promise<{
    assets: Array<{
      id: string;
      asset_key: string;
      group_name: string | null;
      description: string | null;
      compute_kind: string | null;
      is_source: boolean;
      is_partitioned: boolean;
      partition_definition: any;
      upstream: string[];
      downstream: string[];
    }>;
    total: number;
  }> => {
    const response = await api.get(`/projects/${projectId}/dagster-plus/assets`);
    return response.data as any;
  },

  getDagsterPlusAssetChecks: async (
    projectId: string,
  ): Promise<{
    checks: Array<{
      name: string;
      description: string | null;
      asset_key: string;
      can_execute: boolean;
      last_status: string | null;
      last_run_id: string | null;
      last_timestamp: number | null;
      last_severity: string | null;
    }>;
    total: number;
  }> => {
    const response = await api.get(`/projects/${projectId}/dagster-plus/asset-checks`);
    return response.data as any;
  },

  listDagsterPlusDeployments: async (
    projectId: string,
  ): Promise<{ current: string | null; deployments: Array<{ deployment_name: string; deployment_id: string | null; deployment_type: string | null; deployment_status: string | null }> }> => {
    const response = await api.get(`/projects/${projectId}/dagster-plus/deployments`);
    return response.data as any;
  },

  switchDagsterPlusDeployment: async (
    projectId: string,
    deployment: string,
  ): Promise<any> => {
    const response = await api.post(`/projects/${projectId}/dagster-plus/switch-deployment`, { deployment });
    return response.data as any;
  },

  getDagsterPlusRuns: async (
    projectId: string,
    limit = 25,
  ): Promise<{
    runs: Array<{
      run_id: string;
      status: string;
      pipeline_name: string | null;
      start_time: number | null;
      end_time: number | null;
      steps_succeeded: number | null;
      steps_failed: number | null;
      materializations: number | null;
    }>;
    total: number;
  }> => {
    const response = await api.get(`/projects/${projectId}/dagster-plus/runs`, { params: { limit } });
    return response.data as any;
  },

  pageInsights: async (
    projectId: string,
    surface: 'dbt' | 'ingestions' | 'automation' | 'pipelines',
  ): Promise<{
    summary: string;
    insights: Array<{ kind: string; title: string; detail: string; action: string | null; refs: string[] }>;
  }> => {
    const response = await api.get(`/projects/${projectId}/${surface}/insights`);
    return response.data as any;
  },

  pageAsk: async (
    projectId: string,
    surface: 'dbt' | 'ingestions' | 'automation' | 'pipelines',
    body: { question: string; history?: Array<{ role: 'user' | 'assistant'; content: string }> },
  ): Promise<{ answer: string; tools_used?: string[] }> => {
    const response = await api.post(`/projects/${projectId}/${surface}/ask`, body);
    return response.data as any;
  },

  monitorFleetInsights: async (
    projectId: string,
  ): Promise<{
    summary: string;
    insights: Array<{
      kind: 'concern' | 'suggestion' | 'observation' | string;
      title: string;
      detail: string;
      action: string | null;
      monitor_ids: string[];
      asset_keys: string[];
    }>;
  }> => {
    const response = await api.get(`/projects/${projectId}/monitors/insights`);
    return response.data as any;
  },

  askMonitorFleet: async (
    projectId: string,
    body: { question: string; history?: Array<{ role: 'user' | 'assistant'; content: string }> },
  ): Promise<{ answer: string; used_context: Record<string, any> }> => {
    const response = await api.post(`/projects/${projectId}/monitors/ask-fleet`, body);
    return response.data as any;
  },

  askMonitor: async (
    projectId: string,
    monitorId: string,
    body: { question: string; history?: Array<{ role: 'user' | 'assistant'; content: string }> },
  ): Promise<{ answer: string; used_context: Record<string, any> }> => {
    const response = await api.post(`/projects/${projectId}/monitors/${encodeURIComponent(monitorId)}/ask`, body);
    return response.data as any;
  },

  generateMonitors: async (
    projectId: string,
    body: { asset_key: string; max_proposals?: number; focus?: string | null },
  ): Promise<{
    asset_key: string;
    proposals: Array<{
      name: string;
      check_kind: string;
      implementation: string;
      column: string | null;
      severity: string;
      description: string;
      reasoning: string;
      params: Record<string, any>;
      schedule_cron: string | null;
      run_on_materialization: boolean;
    }>;
  }> => {
    const response = await api.post(`/projects/${projectId}/monitors/generate`, body);
    return response.data as any;
  },

  // Cheap heuristic ranker (no LLM) — surfaces assets that need
  // monitors the most. Used as the pre-step to "Generate with AI" so
  // the user can pick a good candidate before spending a Claude call.
  coverageRecommendations: async (
    projectId: string,
    limit: number = 10,
  ): Promise<{
    recommendations: Array<{
      asset_key: string;
      label: string | null;
      current_monitor_count: number;
      downstream_count: number;
      upstream_count: number;
      has_freshness_check: boolean;
      has_row_count_check: boolean;
      has_null_check: boolean;
      score: number;
      reasons: string[];
    }>;
    total_assets: number;
    unmonitored_asset_count: number;
  }> => {
    const response = await api.get(`/projects/${projectId}/monitors/coverage-recommendations`, { params: { limit } });
    return response.data as any;
  },

  getMonitorImpact: async (
    projectId: string,
    monitorId: string,
  ): Promise<{
    affected_assets: string[];
    affected_exposures: Array<{ unique_id: string; name: string; type: string | null; label: string | null; url: string | null; owner: string | null }>;
    affected_monitors: string[];
    hop_counts: Record<string, number>;
  }> => {
    // The monitor id can contain slashes (test.jaffle_shop.foo/bar) so
    // encode carefully.
    const response = await api.get(`/projects/${projectId}/monitors/${encodeURIComponent(monitorId)}/impact`);
    return response.data as any;
  },

  getMonitorHistory: async (
    projectId: string,
    monitorId: string,
    limit = 200,
  ): Promise<{
    monitor_id: string;
    events: Array<{
      ts: string;
      status: string;
      duration_ms: number | null;
      failures: number | null;
      message: string | null;
      value: number | null;
      value_label: string | null;
      expected_min: number | null;
      expected_max: number | null;
      run_id: string | null;
      metadata: MetadataEntry[];
    }>;
    numeric_series: Array<{ ts: string; value: number; expected_min?: number | null; expected_max?: number | null }>;
    numeric_label: string | null;
    numeric_metrics: Array<{
      label: string;
      points: Array<{ ts: string; value: number }>;
      is_default: boolean;
    }>;
  }> => {
    const response = await api.get(`/projects/${projectId}/monitors/history`, {
      params: { monitor_id: monitorId, limit },
    });
    return response.data as any;
  },

  addMonitor: async (
    projectId: string,
    body: {
      implementation: 'dbt_test' | 'enhanced_check';
      name: string;
      target_asset_key: string;
      check_kind: string;
      description?: string | null;
      severity?: 'error' | 'warn' | 'info';
      max_age_seconds?: number | null;
      min_row_count?: number | null;
      max_row_count?: number | null;
      row_count_z_score?: number | null;
      column?: string | null;
      max_null_ratio?: number | null;
      accepted_values?: string[] | null;
      min_value?: number | null;
      max_value?: number | null;
      custom_sql?: string | null;
      custom_python?: string | null;
      schedule_cron?: string | null;
      schedule_interval_minutes?: number | null;
      run_on_materialization?: boolean;
      slack_channel?: string | null;
      email?: string | null;
      dbt_relative_path?: string | null;
      dbt_model_unique_id?: string | null;
      params_json?: Record<string, any> | null;
      check_kind_override?: string | null;
    },
  ): Promise<{ success: boolean; kind: string; relative_path: string; detail: string | null }> => {
    const response = await api.post(`/projects/${projectId}/monitors`, body);
    return response.data as any;
  },

  listMonitors: async (
    projectId: string,
  ): Promise<{
    monitors: Array<{
      id: string;
      kind: 'dbt_test' | 'asset_check' | 'enhanced_check';
      label: string;
      check_kind: string | null;
      target_asset_keys: string[];
      severity: string;
      last_status: string | null;
      last_run_at: string | null;
      last_run_message: string | null;
      last_run_failures: number | null;
      duration_ms: number | null;
      source_location: string | null;
      source_project: string | null;
      code_location: string | null;
      schedule: string | null;
      tags: string[];
      description: string | null;
      recent_statuses: string[];
    }>;
    stats: Record<string, number>;
  }> => {
    const response = await api.get(`/projects/${projectId}/monitors`);
    return response.data as any;
  },

  deleteDbtModel: async (
    projectId: string,
    body: { dbt_relative_path: string; model_unique_id: string; delete_schema_entry?: boolean },
  ): Promise<{ success: boolean; deleted_sql: string | null; schema_yml_updated: string | null; detail: string | null }> => {
    const response = await api.post(`/projects/${projectId}/dbt-model/delete`, body);
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

  getDbtSemanticModels: async (
    projectId: string,
    dbtRelativePath?: string,
  ): Promise<{
    dbt_project_relative_path: string;
    semantic_models: Array<{
      unique_id: string;
      name: string;
      description: string | null;
      model: string | null;
      primary_entity: string | null;
      entities: Array<{ name: string; type: string | null; expr: string | null; description: string | null }>;
      dimensions: Array<{ name: string; type: string | null; expr: string | null; description: string | null }>;
      measures: Array<{ name: string; agg: string | null; expr: string | null; description: string | null; agg_time_dimension: string | null }>;
      tags: string[];
      depends_on_nodes: string[];
    }>;
  }> => {
    const response = await api.get(`/projects/${projectId}/dbt-semantic-models`, {
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

  addDbtModelRemote: async (
    projectId: string,
    body: {
      git_url: string;
      repo_relative_path?: string;
      base_branch?: string;
      model_name: string;
      subfolder?: string | null;
      materialization: 'view' | 'table' | 'incremental' | 'ephemeral';
      sql: string;
    },
  ): Promise<{ success: boolean; pr_url: string; branch: string; base_branch: string; file: string }> => {
    const response = await api.post(`/projects/${projectId}/dbt-model/remote`, body);
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
      /** Branch off the current branch, push that, and open a PR against
       *  where you started — instead of pushing straight to the current
       *  branch. Requires push=true and a GitHub token. */
      open_pr?: boolean;
      pr_title?: string | null;
      branch_name?: string | null;
    },
  ): Promise<{
    success: boolean;
    committed_sha: string | null;
    pushed: boolean;
    detail?: string | null;
    branch?: string | null;
    pr_url?: string | null;
  }> => {
    const response = await api.post(`/projects/${projectId}/git/commit-push`, body);
    return response.data as any;
  },

  projectGitCreateRemote: async (
    projectId: string,
    body: {
      subpath?: string | null;
      repo_name: string;
      private?: boolean;
      token?: string | null;
    },
  ): Promise<{ success: boolean; repo_url: string; html_url: string; created: boolean; detail?: string | null }> => {
    const response = await api.post(`/projects/${projectId}/git/create-remote`, body);
    return response.data as any;
  },

  // Local-project counterpart to designerLocApi.publishServerless (which
  // only applies to Dagster+-connected projects and their sandbox). A
  // plain local project has no stored org/token/deployment, so those are
  // collected here instead of assumed.
  publishServerless: async (
    projectId: string,
    body: { organization: string; api_token: string; deployment: string; location_name?: string | null },
  ): Promise<{ location_name: string; deployment: string; log_tail: string[] }> => {
    const response = await api.post(`/projects/${projectId}/publish-serverless`, body, { timeout: 900_000 });
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

export type Produces =
  | 'asset'
  | 'multi_asset'
  | 'asset_check'
  | 'job'
  | 'schedule'
  | 'sensor'
  | 'resource'
  | 'io_manager'
  | 'partitions_def'
  | 'other';

export interface CommunityTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  path: string;
  schema_url?: string | null;
  example_url: string;
  component_url: string;
  requirements_url?: string | null;
  icon?: string | null;
  tags?: string[];
  /** Optional manifest-declared list of Dagster primitives this component
   *  creates when loaded. Landed 2026-07-15 in the eric-thomas-dagster
   *  community-templates repo. Consumers should degrade to schema-field
   *  heuristics when absent. */
  produces?: Produces[];
}

export const communityTemplatesApi = {
  manifest: async (): Promise<{ components: CommunityTemplate[] }> => {
    const r = await api.get('/templates/manifest');
    return r.data as { components: CommunityTemplate[] };
  },
};


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
      `/primitives/details/${projectId}/${category}/${encodeURIComponent(name)}`
    );
    return response.data;
  },

  delete: async (
    projectId: string,
    category: PrimitiveCategory,
    name: string
  ): Promise<{ message: string }> => {
    const response = await api.delete<{ message: string }>(
      `/primitives/delete/${projectId}/${category}/${encodeURIComponent(name)}`
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

// Mirrors Dagster+'s SecretScopesInput -- distinct from location_names,
// which further restricts to specific code locations within whichever of
// these scopes is chosen.
export interface CloudSecretScopes {
  full_deployment_scope: boolean;
  all_branch_deployments_scope: boolean;
  specific_branch_deployment_scope: string | null;
  local_deployment_scope: boolean;
}

export interface CloudEnvVariable extends EnvVariable {
  id: string;
  scopes: CloudSecretScopes;
  location_names: string[];
  can_edit: boolean;
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

  createCloudSecret: async (
    projectId: string,
    key: string,
    value: string,
    scopes: CloudSecretScopes,
    locationNames: string[],
  ): Promise<{ variables: CloudEnvVariable[] }> => {
    const response = await api.post(`/env/${projectId}/cloud-secrets`, { key, value, scopes, location_names: locationNames });
    return response.data;
  },

  updateCloudSecret: async (
    projectId: string,
    secretId: string,
    key: string,
    value: string,
    scopes: CloudSecretScopes,
    locationNames: string[],
  ): Promise<{ variables: CloudEnvVariable[] }> => {
    const response = await api.put(`/env/${projectId}/cloud-secrets/${encodeURIComponent(secretId)}`, { key, value, scopes, location_names: locationNames });
    return response.data;
  },

  deleteCloudSecret: async (projectId: string, secretId: string): Promise<{ variables: CloudEnvVariable[] }> => {
    const response = await api.delete(`/env/${projectId}/cloud-secrets/${encodeURIComponent(secretId)}`);
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
  file?: string;
  // Only present for Dagster+ (cloud) jobs -- needed to launch one (a
  // bare job name doesn't uniquely identify a job across code locations
  // the way it does locally) and to show where it lives.
  location_name?: string;
  repository_name?: string;
  schedules?: string[];
  sensors?: string[];
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

// -------- Alerts (Dagster+ alert policies, authored locally) ----------
export type AlertPolicyType = 'asset' | 'run' | 'code_location' | 'automation' | 'agent_downtime' | 'insight_metric';

export interface AlertPolicy {
  name: string;
  description?: string | null;
  enabled?: boolean;
  type: AlertPolicyType;
  asset?: {
    asset_selection?: string | string[] | null;
    asset_group?: string | null;
    events?: string[];
    tags?: Record<string, string> | null;
  } | null;
  run?: {
    events?: string[];
    tags?: Record<string, string> | null;
    time_limit_seconds?: number | null;
  } | null;
  code_location?: Record<string, never> | null;
  automation?: {
    events?: string[];
    include_schedules?: boolean;
    include_sensors?: boolean;
  } | null;
  agent_downtime?: Record<string, never> | null;
  insight_metric?: {
    metric: string;
    threshold?: number | null;
    comparison?: string | null;
  } | null;
  notification_service?: {
    email?: { email_addresses: string[] } | null;
    slack?: { slack_workspace_name?: string | null; slack_channel_name: string } | null;
    ms_teams?: { ms_teams_webhook_url: string } | null;
    pagerduty?: { integration_key: string } | null;
    webhook?: { url: string; headers?: Record<string, string> | null } | null;
  };
  extra_config?: Record<string, any> | null;
}

export interface AlertsFile {
  path: string;
  policies: AlertPolicy[];
}

// Dagster+ (cloud) alert policies, fetched + edited live -- a deliberately
// simpler shape than AlertPolicy above (see the backend's CloudAlertsFile
// docstring for why it isn't forced into that one). `document` is the raw
// per-policy config in the exact shape Dagster+'s save mutation expects
// back -- editing means handing this same object back, tweaked.
export interface CloudAlertPolicy {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  event_types: string[];
  notification_type: string | null;
  target_types: string[];
  source?: string | null;
  is_code_backed: boolean;
  muted_until: number | null;
  document: Record<string, any> | null;
}

export interface CloudAlertsFile {
  path: string;
  policies: CloudAlertPolicy[];
  is_cloud: true;
}

export const alertsApi = {
  list: async (projectId: string): Promise<AlertsFile | CloudAlertsFile> => {
    const r = await api.get(`/projects/${projectId}/alerts`);
    return r.data as AlertsFile | CloudAlertsFile;
  },
  save: async (projectId: string, policies: AlertPolicy[]): Promise<AlertsFile> => {
    const r = await api.put(`/projects/${projectId}/alerts`, { policies });
    return r.data as AlertsFile;
  },
  remove: async (projectId: string, name: string): Promise<AlertsFile> => {
    const r = await api.delete(`/projects/${projectId}/alerts/${encodeURIComponent(name)}`);
    return r.data as AlertsFile;
  },
  preview: async (projectId: string, policies: AlertPolicy[]): Promise<{ yaml: string }> => {
    const r = await api.post(`/projects/${projectId}/alerts/preview`, { policies });
    return r.data as { yaml: string };
  },
  syncToCloud: async (projectId: string, confirmed: boolean): Promise<{ success: boolean; detail: string; policies_pushed: number; stdout?: string | null; stderr?: string | null }> => {
    const r = await api.post(`/projects/${projectId}/alerts/sync-to-cloud`, { confirmed });
    return r.data as any;
  },
  syncFromCloud: async (projectId: string): Promise<AlertsFile> => {
    const r = await api.post(`/projects/${projectId}/alerts/sync-from-cloud`);
    return r.data as AlertsFile;
  },
  saveCloud: async (projectId: string, document: Record<string, any>): Promise<CloudAlertsFile> => {
    const r = await api.post(`/projects/${projectId}/alerts/cloud`, { document });
    return r.data as CloudAlertsFile;
  },
  removeCloud: async (projectId: string, name: string): Promise<CloudAlertsFile> => {
    const r = await api.delete(`/projects/${projectId}/alerts/cloud/${encodeURIComponent(name)}`);
    return r.data as CloudAlertsFile;
  },
  muteCloud: async (projectId: string, alertId: string, muteForSeconds: number | null): Promise<CloudAlertsFile> => {
    const r = await api.post(`/projects/${projectId}/alerts/cloud/${encodeURIComponent(alertId)}/mute`, { mute_for_seconds: muteForSeconds });
    return r.data as CloudAlertsFile;
  },
};

// -------- Runs (local dagster dev + Dagster+ GraphQL) -----------------
export interface Run {
  run_id: string;
  job_name: string | null;
  pipeline_name: string | null;
  status: string;
  start_time: number | null;
  end_time: number | null;
  steps_succeeded: number | null;
  steps_failed: number | null;
  materializations: number | null;
}

export interface RunsListResponse {
  runs: Run[];
  next_cursor: string | null;
  source: 'cloud' | 'local';
  error?: string | null;
}

export interface RunStep {
  step_key: string;
  status: string;
  start_time: number | null;
  end_time: number | null;
}
export interface RunMaterialization {
  asset_key: string;
  partition: string | null;
  timestamp: number | null;
  metadata: Array<{ label: string; description: string | null; type: string }>;
}
export interface StepEdge {
  from_step: string;
  to_step: string;
}
export interface RunDetail {
  run_id: string;
  job_name: string | null;
  pipeline_name: string | null;
  status: string;
  start_time: number | null;
  end_time: number | null;
  run_config_yaml: string | null;
  tags: Record<string, string>;
  steps: RunStep[];
  step_edges: StepEdge[];
  materializations: RunMaterialization[];
  steps_succeeded: number | null;
  steps_failed: number | null;
  source: 'cloud' | 'local';
  external_url: string | null;
}

// Dagster+ Custom Metrics + threshold alerts.
export const metricsApi = {
  list: async (projectId: string): Promise<{ metrics: Array<{
    id: string; metadata_key: string; display_name: string | null; description: string | null; unit_type: string | null;
  }> }> => {
    const r = await api.get(`/projects/${projectId}/custom-metrics`);
    return r.data as any;
  },
  ensure: async (projectId: string, body: {
    metadata_key: string;
    unit_type?: string;
    display_name?: string | null;
    description?: string | null;
  }): Promise<{ id: string; metadata_key: string; display_name: string | null; description: string | null; unit_type: string | null }> => {
    const r = await api.post(`/projects/${projectId}/custom-metrics/ensure`, body);
    return r.data as any;
  },
  createThresholdAlert: async (projectId: string, body: {
    name: string;
    description?: string | null;
    metadata_key: string;
    asset_key: string;
    threshold: number;
    operator?: 'GREATER_THAN' | 'LESS_THAN' | 'GREATER_THAN_OR_EQUAL' | 'LESS_THAN_OR_EQUAL';
    lookback_window_hours?: number;
    aggregation?: 'MAX' | 'MIN' | 'AVG' | 'LATEST' | 'SUM';
    notify_emails?: string[];
    notify_slack_channel?: string | null;
    notify_slack_workspace?: string | null;
    enabled?: boolean;
  }): Promise<{ id: string; name: string; enabled: boolean; event_types: string[] }> => {
    const r = await api.post(`/projects/${projectId}/alerts/metric-threshold`, body);
    return r.data as any;
  },
};

export const runsApi = {
  query: async (
    projectId: string,
    params: {
      limit?: number;
      cursor?: string | null;
      statuses?: string[] | null;
      job_name?: string | null;
      tags?: Array<{ key: string; value: string }> | null;
      code_location?: string | null;
      created_after?: number | null;
      created_before?: number | null;
      updated_after?: number | null;
    },
  ): Promise<RunsListResponse> => {
    const r = await api.post(`/projects/${projectId}/runs/query`, params);
    return r.data as RunsListResponse;
  },
  detail: async (projectId: string, runId: string): Promise<RunDetail> => {
    const r = await api.get(`/projects/${projectId}/runs/${runId}`);
    return r.data as RunDetail;
  },
  logs: async (
    projectId: string,
    runId: string,
    params: { cursor?: string | null; limit?: number } = {},
  ): Promise<{
    events: Array<{ type_name: string; message: string | null; level: string | null; timestamp: number | null; step_key: string | null }>;
    cursor: string | null;
    has_more: boolean;
    source: string;
    error?: string | null;
  }> => {
    const search = new URLSearchParams();
    if (params.cursor) search.set('cursor', params.cursor);
    if (params.limit) search.set('limit', String(params.limit));
    const qs = search.toString();
    const r = await api.get(`/projects/${projectId}/runs/${runId}/logs${qs ? '?' + qs : ''}`);
    return r.data as any;
  },
  status: async (projectId: string, runId: string): Promise<{ run_id: string; status: string; error?: string | null }> => {
    const r = await api.get(`/projects/${projectId}/runs/${runId}/status`);
    return r.data as any;
  },
  reexecute: async (
    projectId: string,
    runId: string,
    strategy: 'ALL_STEPS' | 'FROM_FAILURE',
    stepKeys?: string[],
  ): Promise<{ success: boolean; new_run_id: string | null; status: string | null; detail: string | null }> => {
    const r = await api.post(`/projects/${projectId}/runs/${runId}/reexecute`, {
      strategy,
      step_keys: stepKeys && stepKeys.length > 0 ? stepKeys : null,
    });
    return r.data as any;
  },
  terminate: async (
    projectId: string,
    runId: string,
  ): Promise<{ success: boolean; status: string | null; detail: string | null }> => {
    const r = await api.post(`/projects/${projectId}/runs/${runId}/terminate`);
    return r.data as any;
  },
  codeLocations: async (
    projectId: string,
  ): Promise<{ code_locations: string[]; source: 'local' | 'cloud' }> => {
    const r = await api.get(`/projects/${projectId}/runs/code-locations`);
    return r.data as any;
  },
  jobNames: async (
    projectId: string,
  ): Promise<{ job_names: string[]; source: 'local' | 'cloud' }> => {
    const r = await api.get(`/projects/${projectId}/runs/job-names`);
    return r.data as any;
  },
  tagKeys: async (projectId: string): Promise<{ tag_keys: string[] }> => {
    const r = await api.get(`/projects/${projectId}/runs/tag-keys`);
    return r.data as any;
  },
  tagValues: async (projectId: string, key: string): Promise<{ key: string; values: string[] }> => {
    const r = await api.get(`/projects/${projectId}/runs/tag-values`, { params: { key } });
    return r.data as any;
  },
};

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
    tags?: Record<string, string>,
    // Only meaningful for Dagster+ (cloud) jobs -- see PipelineItem's
    // location_name/repository_name, which a cloud job list result carries
    // and a local one doesn't.
    locationName?: string,
    repositoryName?: string,
  ): Promise<LaunchJobResponse> => {
    const response = await api.post<LaunchJobResponse>(
      `/pipelines/${projectId}/${jobName}/launch`,
      { config, tags, location_name: locationName, repository_name: repositoryName }
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

  /** Best-effort "does this asset need a partition to materialize" check --
   *  every single-asset quick-materialize button (Run to here, the node's
   *  own materialize action, ...) needs this same check before calling
   *  materialize() with no partition, which `dg launch` rejects outright
   *  ("Asset has partitions, but no '--partition' option was provided") for
   *  any asset that has one. A lookup failure returns false rather than
   *  throwing -- shouldn't block a plain, unpartitioned run from a flaky
   *  partition-info call. */
  isPartitioned: async (projectId: string, assetKey: string): Promise<boolean> => {
    try {
      const info = await partitionsApi.getPartitionInfo(projectId, assetKey);
      return !!info.is_partitioned;
    } catch {
      return false;
    }
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

  /** Per-partition materialization status matrix -- works for both local
   *  (queries the project's own `dagster dev`) and Dagster+ (cloud). */
  getPartitionStatus: async (projectId: string, assetKey: string): Promise<PartitionStatusResponse> => {
    const response = await api.get<PartitionStatusResponse>(
      `/projects/${projectId}/assets/${encodeURIComponent(assetKey)}/partition-status`
    );
    return response.data;
  },

  /** What happened to one specific partition last -- its most recent
   *  run and materialization timestamp. Fetched on click, not prefetched
   *  for the whole matrix (too expensive for assets with 1000s of keys). */
  getPartitionDetail: async (projectId: string, assetKey: string, partition: string): Promise<PartitionDetailResponse> => {
    const response = await api.get<PartitionDetailResponse>(
      `/projects/${projectId}/assets/${encodeURIComponent(assetKey)}/partitions/${encodeURIComponent(partition)}/detail`
    );
    return response.data;
  },

  /** Materialize one asset for one partition on Dagster+ (cloud). Local
   *  projects should use launchBackfill/materialize instead -- this
   *  fires a real launchRun mutation against the live deployment. */
  materializePartitionCloud: async (projectId: string, assetKey: string, partition: string): Promise<MaterializePartitionResponse> => {
    const response = await api.post<MaterializePartitionResponse>(
      `/projects/${projectId}/assets/${encodeURIComponent(assetKey)}/partitions/${encodeURIComponent(partition)}/materialize`
    );
    return response.data;
  },
};

export interface PartitionKeyStatus {
  key: string;
  status: 'materialized' | 'failed' | 'materializing' | 'missing';
}

export interface PartitionStatusResponse {
  asset_key: string;
  is_partitioned: boolean;
  total: number;
  materialized: number;
  failed: number;
  materializing: number;
  missing: number;
  keys: PartitionKeyStatus[];
  truncated: boolean;
  supported: boolean;
}

export interface PartitionDetailResponse {
  asset_key: string;
  partition: string;
  last_run_id: string | null;
  last_run_status: string | null;
  last_run_start_time: number | null;
  last_run_end_time: number | null;
  last_materialized_at: number | null;
  last_materialization_run_id: string | null;
}

export interface MaterializePartitionResponse {
  success: boolean;
  message: string;
  run_id: string | null;
}

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

  /** Sifflet-style Auto Coverage. Given an asset key, returns a batch
   *  of proposed monitors (freshness / row_count anomaly / uniqueness
   *  on id-shaped columns / null_ratio per column). Deterministic
   *  heuristics; frontend shows them in a preview modal and applies
   *  the selected subset via coverageApply. */
  coverageSuggest: async (
    projectId: string,
    assetKey: string,
  ): Promise<{
    asset_key: string;
    suggestions: Array<{
      name: string;
      check_kind: string;
      description: string;
      severity: string;
      target_column: string | null;
      max_age_seconds: number | null;
      min_row_count: number | null;
      max_row_count: number | null;
      row_count_z_score: number | null;
      max_null_ratio: number | null;
      rationale: string;
      confidence: string;
    }>;
  }> => {
    const response = await api.post(`/projects/${projectId}/assets/coverage-suggest`, {
      asset_key: assetKey,
    });
    return response.data as any;
  },

  coverageApply: async (
    projectId: string,
    assetKey: string,
    suggestions: any[],
  ): Promise<{ applied: number; failed: Array<{ name: string; error: string }> }> => {
    const response = await api.post(`/projects/${projectId}/assets/coverage-apply`, {
      asset_key: assetKey,
      suggestions,
    });
    return response.data as any;
  },

  coverageSuggestBulk: async (
    projectId: string,
    assetKeys: string[],
  ): Promise<{ per_asset: Array<{ asset_key: string; suggestions: any[] }> }> => {
    const response = await api.post(`/projects/${projectId}/assets/coverage-suggest-bulk`, {
      asset_keys: assetKeys,
    });
    return response.data as any;
  },

  coverageApplyBulk: async (
    projectId: string,
    perAsset: Array<{ asset_key: string; suggestions: any[] }>,
  ): Promise<{ applied: number; failed: Array<{ asset_key: string; name: string; error: string }> }> => {
    const response = await api.post(`/projects/${projectId}/assets/coverage-apply-bulk`, {
      per_asset: perAsset,
    });
    return response.data as any;
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

  /** Manually mark/unmark an asset as an ingestion source — overrides the
   *  Ingestions tab's automatic heuristic, which has no way to notice
   *  e.g. a plain Python asset that calls a REST API and writes to
   *  Snowflake. Works for local and cloud projects alike. */
  tagAsIngestion: async (projectId: string, assetKey: string): Promise<{ manual_ingestion_asset_keys: string[] }> => {
    const response = await api.post(`/assets/${projectId}/${encodeURIComponent(assetKey)}/tag-ingestion`);
    return response.data as any;
  },

  untagAsIngestion: async (projectId: string, assetKey: string): Promise<{ manual_ingestion_asset_keys: string[] }> => {
    const response = await api.delete(`/assets/${projectId}/${encodeURIComponent(assetKey)}/tag-ingestion`);
    return response.data as any;
  },

  /** Live Dagster+ Insights usage/cost/reliability metrics for one asset,
   *  fetched directly via MCP tools (no LLM involved) -- there's no
   *  GraphQL equivalent for this. Cloud projects only. */
  getInsightsMetrics: async (projectId: string, assetKey: string, days: number = 30): Promise<AssetInsightsResponse> => {
    const response = await api.get<AssetInsightsResponse>(
      `/assets/${projectId}/${encodeURIComponent(assetKey)}/insights-metrics`,
      { params: { days } },
    );
    return response.data;
  },

  /** Deploy-over-deploy diff history for one asset's definition.
   *  Dagster+ only, and plan-gated on Dagster+'s side -- `available:
   *  false` means "not offered for this org", not an error. */
  getChangeHistory: async (projectId: string, assetKey: string, limit: number = 50): Promise<AssetChangeHistoryResponse> => {
    const response = await api.get<AssetChangeHistoryResponse>(
      `/assets/${projectId}/${encodeURIComponent(assetKey)}/change-history`,
      { params: { limit } },
    );
    return response.data;
  },

  /** Deployment-wide Insights metrics -- the top-level view before
   *  drilling into a specific asset. Direct MCP call, no LLM. */
  getDeploymentInsights: async (projectId: string, days: number = 30): Promise<DeploymentInsightsResponse> => {
    const response = await api.get<DeploymentInsightsResponse>(
      `/assets/${projectId}/insights/deployment`,
      { params: { days } },
    );
    return response.data;
  },

  /** Per-asset breakdown for one metric across every asset, sorted
   *  highest first -- powers the "top assets by ..." drill-down list. */
  getInsightsBreakdown: async (projectId: string, metricName: string, days: number = 30): Promise<AssetBreakdownResponse> => {
    const response = await api.get<AssetBreakdownResponse>(
      `/assets/${projectId}/insights/breakdown`,
      { params: { metric_name: metricName, days } },
    );
    return response.data;
  },

  /** Per-job breakdown for one metric across every job in the
   *  deployment, sorted highest first -- powers the "top jobs by ..."
   *  cards. */
  getJobInsightsBreakdown: async (projectId: string, metricName: string, days: number = 30): Promise<JobBreakdownResponse> => {
    const response = await api.get<JobBreakdownResponse>(
      `/assets/${projectId}/insights/job-breakdown`,
      { params: { metric_name: metricName, days } },
    );
    return response.data;
  },

  /** Live Dagster+ Insights metrics for a single job over a trailing
   *  window -- the job-level counterpart to getInsightsMetrics. */
  getJobInsightsMetrics: async (projectId: string, jobName: string, days: number = 30): Promise<JobInsightsResponse> => {
    const response = await api.get<JobInsightsResponse>(
      `/assets/${projectId}/insights/job-metrics`,
      { params: { job_name: jobName, days } },
    );
    return response.data;
  },
  // Materialization / observation events. Powers the Activity tab.
  // Backend dispatches to Dagster+ or local `dg dev` GraphQL based on
  // project kind. Same event shape either way.
  getAssetEvents: async (
    projectId: string,
    assetKey: string,
    limit: number = 200,
  ): Promise<{ events: Array<{ ts: string; kind: string; message?: string | null; run_id?: string | null; partition?: string | null }> }> => {
    const r = await api.get(`/assets/${projectId}/${encodeURIComponent(assetKey)}/events`, { params: { limit } });
    return r.data as any;
  },

  // Partition list + per-key status. Powers the Partitions tab.
  getAssetPartitions: async (
    projectId: string,
    assetKey: string,
    limit: number = 500,
  ): Promise<{
    partitions: Array<{
      key: string;
      status?: string | null;
      last_materialization_ts?: string | null;
      run_id?: string | null;
      step_key?: string | null;
      label?: string | null;
      description?: string | null;
      metadata?: Array<{ label: string; type: string; value: any; description?: string | null }>;
    }>;
    total_count: number;
    materialized_count: number;
    missing_count: number;
    failed_count: number;
  }> => {
    const r = await api.get(`/assets/${projectId}/${encodeURIComponent(assetKey)}/partitions`, { params: { limit } });
    return r.data as any;
  },
};

export interface JobInsightsResponse {
  job_name: string;
  window_days: number;
  metrics: AssetInsightMetric[];
}

export interface AssetInsightMetric {
  metric_name: string;
  label: string;
  unit: 'count' | 'credits' | 'ms' | 'percent' | string;
  aggregate_value: number | null;
  previous_aggregate_value: number | null;
  timestamps: number[];
  values: number[];
  // Daily values for the prior period, aligned by day-offset (not
  // calendar date) so it overlays cleanly against `values` on one chart.
  previous_values: number[];
}

export interface AssetInsightsResponse {
  asset_key: string;
  window_days: number;
  metrics: AssetInsightMetric[];
}

export interface AssetChangeEntry {
  timestamp: number;
  code_location: string;
  git_commit_hash: string | null;
  change_types: string[];
  code_version_old: string | null;
  code_version_new: string | null;
  partitions_definition_old: string | null;
  partitions_definition_new: string | null;
  dependencies_added: string[];
  dependencies_changed: string[];
  dependencies_removed: string[];
  tags_added: string[];
  tags_changed: string[];
  tags_removed: string[];
  metadata_added: string[];
  metadata_changed: string[];
  metadata_removed: string[];
}

export interface AssetChangeHistoryResponse {
  asset_key: string;
  available: boolean;
  entries: AssetChangeEntry[];
}

export interface DeploymentInsightsResponse {
  window_days: number;
  metrics: AssetInsightMetric[];
}

export interface AssetBreakdownRow {
  asset_key: string;
  value: number;
}

export interface AssetBreakdownResponse {
  metric_name: string;
  label: string;
  unit: string;
  window_days: number;
  rows: AssetBreakdownRow[];
}

/** Same curated metric catalog as the backend's _ASSET_INSIGHT_METRICS --
 *  kept in sync by hand since it's small and stable; powers the
 *  "top assets by ..." cards on the deployment-level Insights page. */
export const INSIGHTS_BREAKDOWN_METRICS: Array<{ name: string; label: string }> = [
  { name: '__dagster_dagster_credits', label: 'Dagster Credits' },
  { name: '__dagster_materializations', label: 'Materializations' },
  { name: '__dagster_execution_time_ms', label: 'Execution Time' },
  { name: '__dagster_asset_success_rate', label: 'Success Rate' },
  { name: '__dagster_run_failures', label: 'Run Failures' },
  { name: '__dagster_observations', label: 'Observations' },
  { name: '__dagster_failed_to_materialize', label: 'Failed to Materialize' },
  { name: '__dagster_step_retries', label: 'Step Retries' },
  { name: '__dagster_asset_check_errors', label: 'Check Errors' },
  { name: 'row_count', label: 'Row Count' },
  { name: '__dagster_asset_check_success_rate', label: 'Check Success Rate' },
  { name: '__dagster_freshness_pass_rate', label: 'Freshness Pass Rate' },
];

export interface JobBreakdownRow {
  job_name: string;
  code_location: string | null;
  value: number;
}

export interface JobBreakdownResponse {
  metric_name: string;
  label: string;
  unit: string;
  window_days: number;
  rows: JobBreakdownRow[];
}

/** Same catalog as the backend's _JOB_BREAKDOWN_METRICS -- job-flavored
 *  (run health/cost), reusing deployment-level metric labels since
 *  asset-only concepts (freshness, observations) don't apply to a job. */
export const INSIGHTS_JOB_BREAKDOWN_METRICS: Array<{ name: string; label: string }> = [
  { name: '__dagster_dagster_credits', label: 'Dagster Credits' },
  { name: '__dagster_materializations', label: 'Materializations' },
  { name: '__dagster_run_successes', label: 'Run Successes' },
  { name: '__dagster_run_failures', label: 'Run Failures' },
  { name: '__dagster_run_duration_ms', label: 'Run Duration' },
  { name: '__dagster_step_failures', label: 'Step Failures' },
  { name: '__dagster_failed_to_materialize', label: 'Failed to Materialize' },
  { name: '__dagster_run_queue_time_ms', label: 'Run Queue Time' },
  { name: '__dagster_observations', label: 'Observations' },
  { name: 'row_count', label: 'Row Count' },
];

export interface MetadataEntry {
  label: string;
  description: string | null;
  type: 'float' | 'int' | 'text' | 'markdown' | 'url' | 'path' | 'json' | 'bool' | 'timestamp' | 'other';
  value: string | number | boolean | null;
}

export interface IngestionEvent {
  ts: string;                          // ISO-8601 UTC
  type: 'materialize' | 'preview';
  asset_key: string;
  component?: string;
  rows?: number;
  bytes?: number;
  duration_ms?: number;
  status: 'success' | 'failure' | 'running';
  /** The Dagster run that produced this event -- only populated for
   *  Dagster+ (cloud) materializations; local materializes aren't
   *  always wrapped in a full run. */
  run_id?: string;
  /** Typed metadata Dagster attached to the materialization (row
   *  counts, a markdown summary, a dashboard link, etc.) -- cloud only. */
  metadata?: MetadataEntry[];
}

export interface AiProvidersStatus {
  openai_available: boolean;
  anthropic_available: boolean;
  any_available: boolean;
}

export const aiApi = {
  providers: async (): Promise<AiProvidersStatus> => {
    const response = await api.get<AiProvidersStatus>('/ai/providers');
    return response.data;
  },
  // Pass a key to set it, or '' to clear it. Omit a field to leave that
  // provider's key untouched. Applied to the running backend immediately --
  // no restart needed.
  setKeys: async (keys: { openai_api_key?: string; anthropic_api_key?: string }): Promise<AiProvidersStatus> => {
    const response = await api.post<AiProvidersStatus>('/ai/keys', keys);
    return response.data;
  },
};

// Designer-managed code location — laptop-hosted Dagster subprocess that
// runs alongside a Dagster+ project as a *peer* data source. See
// backend/app/services/designer_loc_service.py.
export interface DesignerLocStatus {
  status: 'missing' | 'scaffolding' | 'installing' | 'starting' | 'ready' | 'error';
  pid: number | null;
  port: number | null;
  error: string | null;
  graphql_url: string | null;
  scaffolded: boolean;
  installed: boolean;
  log_tail: string[];
}

// Drafts — AppManagedComponent-shaped records authored against a target
// code location (customer cloud loc OR the sandbox), pending promotion
// via PR. Storage is server-side per project.
export interface Draft {
  id: string;
  project_id: string;
  location_name: string;
  deployment_name: string | null;
  component_type: string;
  component_id: string;
  attributes: string;               // YAML string
  status: 'draft' | 'promoted';
  promoted_pr_url: string | null;
  created_at: number;
  updated_at: number;
}

export const draftsApi = {
  list: async (projectId: string): Promise<{ drafts: Draft[] }> => {
    const r = await api.get(`/projects/${projectId}/drafts`);
    return r.data as { drafts: Draft[] };
  },
  create: async (
    projectId: string,
    body: {
      location_name: string;
      deployment_name?: string | null;
      component_type: string;
      attributes: string;
      component_id?: string | null;
    },
  ): Promise<Draft> => {
    const r = await api.post(`/projects/${projectId}/drafts`, body);
    return r.data as Draft;
  },
  update: async (projectId: string, draftId: string, attributes: string): Promise<Draft> => {
    const r = await api.patch(`/projects/${projectId}/drafts/${draftId}`, { attributes });
    return r.data as Draft;
  },
  remove: async (projectId: string, draftId: string): Promise<void> => {
    await api.delete(`/projects/${projectId}/drafts/${draftId}`);
  },
  promoteInfo: async (projectId: string, draftId: string): Promise<{
    available: boolean;
    mapping: { owner_repo: string; default_branch: string; defs_subdir: string; has_token: boolean } | null;
    status: 'draft' | 'promoted';
    promoted_pr_url: string | null;
  }> => {
    const r = await api.get(`/projects/${projectId}/drafts/${draftId}/promote-info`);
    return r.data as any;
  },
  promote: async (projectId: string, draftId: string): Promise<{
    pr_url: string;
    branch: string;
    files_written: string[];
    owner_repo: string;
    base_branch: string;
    /** Predicted BD name Dagster+ CI will create off the PR branch —
     *  matches `branch` under the default 1:1 branch→BD convention. */
    expected_bd_name?: string;
    /** Result of the post-promote `deleteAppManagedComponent` call.
     *  `{cleared: true, deployment}` on success, `{cleared: false, reason, deployment}`
     *  on failure, `null` if the draft had no active preview state. */
    cleared_state?: {
      cleared: boolean;
      deployment?: string;
      reason?: string;
    } | null;
    /** When Designer had to rewrite the state-registry component type
     *  string to a real Python import path for defs.yaml, this records
     *  the mapping (else null). */
    rewrote_type?: { from: string; to: string } | null;
    /** Pre-promote environment check (design doc §7). Null when the
     *  promoted component declared no `consumes` in the manifest OR the
     *  introspection call failed. Otherwise contains match/miss detail. */
    resource_check?: {
      checked: boolean;
      reason?: string;
      resources_available?: string[];
      matches?: Array<{ service: string; matched_by: string }>;
      missing?: Array<{ service: string; reason: string }>;
    } | null;
    /** Repo-relative paths for files the community_component_installer
     *  bootstrap added or updated on this PR. Empty when the promoted
     *  component wasn't recognized as a community-catalog entry (nothing
     *  to bootstrap). */
    installer_files?: string[];
  }> => {
    const r = await api.post(`/projects/${projectId}/drafts/${draftId}/promote`, null, {
      timeout: 120_000,   // clone + push can take a bit on cold cache
    });
    return r.data as any;
  },
};


// Authored — unified locations + component-types query, routes to
// Dagster+ for cloud locs and to the sandbox subprocess for the
// sandbox sentinel `__sandbox__`.
export const SANDBOX_LOCATION_NAME = '__sandbox__';

export interface AuthoredLocation {
  name: string;
  source: 'dagster_plus' | 'sandbox';
  deployment?: string | null;      // which Dagster+ deployment (long-lived or branch); null for sandbox
  authoring_supported?: boolean;   // false for cloud locs with no isAppManaged types
  error?: string;
}

export interface AuthoredDeployment {
  name: string;
  id: number;
  type: 'PRODUCTION' | 'BRANCH' | string;
  status: string;
  display_name: string;            // human-friendly (branch name / PR # for branch deployments)
  branch_name: string | null;
  pull_request_url: string | null;
}

export interface ComponentTypeInfo {
  name: string;
  namespace: string | null;
  schema: any;                     // JSON Schema
  formSchema: { dataSchema: any; uiSchema: any } | null;
  isAppManaged: boolean;
  example: string | null;          // example YAML
  description: string | null;
  owners: string[] | null;
  tags: string[] | null;
}

// Promotion configuration — user-editable via the UI so no env vars
// are needed for the demo. Storage: `~/.dagster-designer/config/promotion.json`.
export interface RepoMapping {
  org: string;
  location: string;
  owner_repo: string;
  default_branch: string;
  defs_subdir: string;
  // Env vars injected into the preview `dagster dev` subprocess.
  // Non-prod values (dev warehouse, staging DB, sandbox S3, …).
  preview_env?: Record<string, string>;
}

export interface PromotionConfig {
  github_token_preview: string;
  github_token_present: boolean;
  mappings: RepoMapping[];
  defaults: RepoMapping[];
}

export const promotionApi = {
  getConfig: async (): Promise<PromotionConfig> => {
    const r = await api.get('/promotion/config');
    return r.data as PromotionConfig;
  },
  // Pass `github_token: ""` to preserve the existing token, or
  // `"__CLEAR__"` to wipe it. Any other string replaces it.
  saveConfig: async (body: { github_token: string; mappings: RepoMapping[] }): Promise<PromotionConfig> => {
    const r = await api.put('/promotion/config', body);
    return r.data as PromotionConfig;
  },
  // Validate a PAT without saving. If `github_token` is empty, the
  // saved token is tested. Pass mapping repos so fine-grained PATs
  // (which have empty scopes on `/user`) can be verified per-repo.
  testToken: async (body: { github_token: string; owner_repos: string[] }): Promise<{
    valid: boolean;
    login?: string;
    name?: string;
    scopes?: string[];
    has_repo_scope?: boolean;
    repos?: Array<{ owner_repo: string; ok: boolean; can_push?: boolean; reason?: string | null }>;
    ok_for_promote?: boolean;
    message: string;
  }> => {
    const r = await api.post('/promotion/test-token', body);
    return r.data as any;
  },
  // Scan the target repo and suggest `defs_subdir` candidates. Reads
  // `dagster_cloud.yaml` when present for an authoritative pick; falls
  // back to `**/defs/` tree scoring otherwise.
  resolveDefsSubdir: async (body: {
    owner_repo: string;
    ref: string;
    location_name: string;
  }): Promise<{
    candidates: Array<{ path: string; score: number; reason: string }>;
    total_scanned: number;
    truncated: boolean;
    authoritative_build_dir?: string | null;
    message: string;
  }> => {
    const r = await api.post('/promotion/resolve-defs-subdir', body);
    return r.data as any;
  },
  // Confirm `defs_subdir` exists as a real directory on the target branch.
  // `exists: null` = check couldn't run (no token, missing input).
  validateDefsSubdir: async (body: {
    owner_repo: string;
    ref: string;
    defs_subdir: string;
  }): Promise<{
    exists: boolean | null;
    is_dir?: boolean;
    message: string;
  }> => {
    const r = await api.post('/promotion/validate-defs-subdir', body);
    return r.data as any;
  },
  // Refresh live GitHub state for every promoted draft in the project.
  // Returns `{draft_id → {state, merged, message, ...}}` — state is
  // one of 'open' | 'closed' | 'merged' | 'deleted' | 'unknown'.
  // Enables the Drafts panel to swap "Open PR" for "Re-promote" once
  // a PR is closed without merging.
  prStatus: async (projectId: string): Promise<{
    statuses: Record<string, {
      state: 'open' | 'closed' | 'merged' | 'deleted' | 'unknown';
      merged?: boolean;
      merged_at?: string | null;
      closed_at?: string | null;
      head_sha?: string;
      base_ref?: string;
      message: string;
    }>;
    message?: string;
  }> => {
    const r = await api.post('/promotion/pr-status', { project_id: projectId });
    return r.data as any;
  },
};


// Preview runtime — git-cloned per-deployment `dagster dev` on the
// laptop. Bit-for-bit safer than "run against prod credentials" because
// env vars come from the (org, location) mapping's `preview_env`.
export type PreviewStatus =
  | 'idle'
  | 'preparing'
  | 'installing'
  | 'starting'
  | 'ready'
  | 'error';

export interface PreviewState {
  project_id: string;
  deployment_name: string;
  location_name: string;
  status: PreviewStatus;
  pid: number | null;
  port: number | null;
  worktree_path: string | null;
  error: string | null;
  graphql_url: string | null;
  webserver_url: string | null;
  files_written: string[];
  env_var_count: number;
  log_tail: string[];
}

export interface RemotePreviewState {
  kind: 'remote';
  bd_name: string;
  bd_id: number | null;
  /** True when Designer created a fresh isolated BD (slow-path).
   *  False when we attached to a pre-existing branch deployment
   *  (fast-path via `setAppManagedComponent`). Governs whether Stop
   *  deletes the BD or just detaches. */
  fresh_bd_created: boolean;
  base_deployment: string;
  location_name: string;
  webserver_url: string;
  graphql_url: string;
  drafts_applied: Array<{ draft_id: string; component_id: string }>;
  draft_count: number;
  /** Installer-driven install actions taken during this sync. Empty
   *  when no drafts required a source install (the class was already
   *  loaded on the target). When an entry has `action==='added'`, the
   *  user just gained access to a new community component on the BD
   *  without a PR. */
  installer_actions?: Array<{
    draft_id: string;
    catalog_id: string;
    action: 'added' | 'already-present' | 'no-installer' | 'error';
    message: string;
    components?: string[];
  }>;
}

export const previewApi = {
  // Idempotent: clone + worktree + apply drafts + uv sync + boot dagster dev.
  boot: async (projectId: string, deploymentName: string, locationName: string): Promise<PreviewState> => {
    const r = await api.post(`/projects/${projectId}/preview/boot`, {
      deployment_name: deploymentName,
      location_name: locationName,
    }, { timeout: 600_000 });
    return r.data as PreviewState;
  },
  // Spin up a Dagster+ Branch Deployment as the preview — no laptop
  // `dagster dev`, no docker. Reuses the base deployment's image +
  // applies drafts via `setAppManagedComponent`. Returns the BD's
  // Dagster+ webserver URL to open.
  // Fire-and-forget: kick off BD creation for a long-lived-deployment
  // target so the eventual Cloud click completes in ~1s. No-op for
  // branch targets (fast path handles those). Returns immediately;
  // actual work runs server-side in the background.
  prewarmRemote: async (projectId: string, baseDeployment: string, locationName: string): Promise<{ status: string }> => {
    const r = await api.post(`/projects/${projectId}/preview/prewarm-remote`, {
      base_deployment: baseDeployment,
      location_name: locationName,
    }, { timeout: 15_000 });
    return r.data as { status: string };
  },
  bootRemote: async (projectId: string, baseDeployment: string, locationName: string): Promise<RemotePreviewState> => {
    // Real BD creation + location update + agent image pull can take
    // 30-90s in practice; occasionally longer if the agent's warm. Give
    // the backend its full 5-minute window plus a bit of buffer.
    const r = await api.post(`/projects/${projectId}/preview/boot-remote`, {
      base_deployment: baseDeployment,
      location_name: locationName,
    }, { timeout: 480_000 });
    return r.data as RemotePreviewState;
  },
  remoteStatus: async (projectId: string): Promise<{ remote_previews: RemotePreviewState[] }> => {
    const r = await api.get(`/projects/${projectId}/preview/remote-status`);
    return r.data as { remote_previews: RemotePreviewState[] };
  },
  teardownRemote: async (projectId: string, baseDeployment: string, locationName: string): Promise<void> => {
    await api.delete(`/projects/${projectId}/preview/remote-session`, {
      params: { base_deployment: baseDeployment, location: locationName },
    });
  },
  // Explicit "Sync" — reapply the current set of drafts to an already-
  // running preview. Same as `bootRemote` semantically but the UI treats
  // it as a distinct user action so it's obvious when changes land.
  syncRemote: async (projectId: string, baseDeployment: string, locationName: string): Promise<RemotePreviewState> => {
    const r = await api.post(`/projects/${projectId}/preview/boot-remote`, {
      base_deployment: baseDeployment,
      location_name: locationName,
    }, { timeout: 120_000 });
    return r.data as RemotePreviewState;
  },
  stop: async (projectId: string, deploymentName: string, locationName: string): Promise<void> => {
    await api.post(`/projects/${projectId}/preview/stop`, {
      deployment_name: deploymentName,
      location_name: locationName,
    });
  },
  status: async (projectId: string): Promise<{ previews: PreviewState[] }> => {
    const r = await api.get(`/projects/${projectId}/preview/status`);
    return r.data as { previews: PreviewState[] };
  },
  teardown: async (projectId: string, deploymentName: string, locationName: string): Promise<void> => {
    await api.delete(`/projects/${projectId}/preview/session/${encodeURIComponent(deploymentName)}`, {
      params: { location: locationName },
    });
  },
  graphql: async (projectId: string, deploymentName: string, query: string, variables?: Record<string, any>): Promise<any> => {
    const r = await api.post(`/projects/${projectId}/preview/graphql`, {
      deployment_name: deploymentName,
      query,
      variables: variables || null,
    });
    return r.data;
  },
};


export const authoredApi = {
  deployments: async (projectId: string): Promise<{ deployments: AuthoredDeployment[] }> => {
    const r = await api.get(`/projects/${projectId}/authored/deployments`);
    return r.data as { deployments: AuthoredDeployment[] };
  },
  // Probe every deployment for authoring support (any loc with isAppManaged=true).
  // Slow first call (fans out 100+ GraphQL requests, concurrency-limited server-side),
  // subsequent calls hit the 60s cache. Returns { deploymentName -> bool }.
  deploymentSupport: async (projectId: string): Promise<{ support: Record<string, boolean> }> => {
    const r = await api.get(`/projects/${projectId}/authored/deployment-support`, {
      timeout: 60_000,
    });
    return r.data as { support: Record<string, boolean> };
  },
  locations: async (projectId: string, deployment?: string): Promise<{ locations: AuthoredLocation[] }> => {
    const params = deployment ? { deployment } : {};
    const r = await api.get(`/projects/${projectId}/authored/locations`, { params });
    return r.data as { locations: AuthoredLocation[] };
  },
  componentTypes: async (
    projectId: string,
    location: string,
    deployment?: string,
  ): Promise<{ types: ComponentTypeInfo[]; error?: string }> => {
    const params: Record<string, string> = { location };
    if (deployment) params.deployment = deployment;
    const r = await api.get(`/projects/${projectId}/authored/component-types`, { params });
    return r.data as { types: ComponentTypeInfo[]; error?: string };
  },
  // Community-catalog IDs already installed on the target location via
  // `community_component_installer`. Powers the picker's "already
  // installed ✓" indicator. Returns { checked: false } on sandbox or
  // when introspection fails (picker degrades to no annotation).
  installedCommunityComponents: async (
    projectId: string,
    location: string,
    deployment?: string,
  ): Promise<{
    checked: boolean;
    installed?: string[];
    installer_present?: boolean;
    reason?: string;
  }> => {
    const params: Record<string, string> = { location };
    if (deployment) params.deployment = deployment;
    const r = await api.get(`/projects/${projectId}/authored/installed-community-components`, { params });
    return r.data as any;
  },
  // Asset keys for the deployment+location the user is authoring
  // against. Populates the asset_selection picker with the RIGHT
  // asset set — not whatever the project's hydrated graph holds.
  assets: async (
    projectId: string,
    deployment?: string,
    location?: string,
  ): Promise<{ asset_keys: string[] }> => {
    const params: Record<string, string> = {};
    if (deployment) params.deployment = deployment;
    if (location) params.location = location;
    const r = await api.get(`/projects/${projectId}/authored/assets`, { params });
    return r.data as { asset_keys: string[] };
  },
  // Job / schedule / sensor names for the deployment+location. Powers
  // `job_name` / `schedule_name` / `sensor_name` pickers.
  primitives: async (
    projectId: string,
    deployment?: string,
    location?: string,
  ): Promise<{ jobs: string[]; schedules: string[]; sensors: string[] }> => {
    const params: Record<string, string> = {};
    if (deployment) params.deployment = deployment;
    if (location) params.location = location;
    const r = await api.get(`/projects/${projectId}/authored/primitives`, { params });
    return r.data as { jobs: string[]; schedules: string[]; sensors: string[] };
  },
};


export const designerLocApi = {
  status: async (projectId: string): Promise<DesignerLocStatus> => {
    const r = await api.get(`/projects/${projectId}/designer-loc/status`);
    return r.data as DesignerLocStatus;
  },
  ensure: async (projectId: string): Promise<DesignerLocStatus> => {
    // Slow the first time (scaffold + uv sync + dg dev boot).
    const r = await api.post(`/projects/${projectId}/designer-loc/ensure`, null, { timeout: 600_000 });
    return r.data as DesignerLocStatus;
  },
  stop: async (projectId: string): Promise<void> => {
    await api.post(`/projects/${projectId}/designer-loc/stop`);
  },
  // Proxy a GraphQL request to the subprocess (browser can't hit the
  // subprocess directly — no CORS).
  graphql: async (projectId: string, query: string, variables?: Record<string, any>): Promise<any> => {
    const r = await api.post(`/projects/${projectId}/designer-loc/graphql`, {
      query,
      variables: variables || null,
    });
    return r.data;
  },
  // Install a community-templates component into the sandbox via the
  // official `dagster-component` CLI (fetches template from GitHub,
  // adds Python deps). Restarts the sandbox so the new type registers.
  installCommunityComponent: async (
    projectId: string,
    componentId: string,
  ): Promise<{ component_id: string; component_type: string | null; install_stdout_tail: string[] }> => {
    const r = await api.post(`/projects/${projectId}/designer-loc/install-community/${componentId}`, null, {
      timeout: 600_000,   // CLI install can pull heavy deps
    });
    return r.data as any;
  },
  // Author a real component in the sandbox: install the package (if
  // needed) + write `defs.yaml` + hot-reload. Not a draft — direct file.
  scaffoldComponent: async (
    projectId: string,
    body: { component_type: string; attributes_yaml: string; component_id?: string | null },
  ): Promise<{ component_id: string; path: string; restarted: boolean; package: string | null }> => {
    const r = await api.post(`/projects/${projectId}/designer-loc/scaffold-component`, body, {
      timeout: 600_000,   // uv add can pull a big dep
    });
    return r.data as any;
  },
  // Every authored component instance currently in the sandbox — reads
  // straight off each defs.yaml. Powers "Promote to PR": the sandbox
  // has no target repo of its own, so promoting means creating a Draft
  // against a REAL (deployment, location) using one of these.
  listComponents: async (
    projectId: string,
  ): Promise<{ components: { component_id: string; component_type: string; attributes_yaml: string }[] }> => {
    const r = await api.get(`/projects/${projectId}/designer-loc/components`);
    return r.data as any;
  },
  // Skips git entirely — pushes the sandbox's current code straight to
  // a Dagster+ Serverless deployment. Explicitly the discouraged fast
  // path (no review, no history); use Promote to PR for anything that
  // should last.
  publishServerless: async (
    projectId: string,
    locationName?: string,
  ): Promise<{ location_name: string; deployment: string; log_tail: string[] }> => {
    const r = await api.post(`/projects/${projectId}/designer-loc/publish-serverless`, {
      location_name: locationName || null,
    }, { timeout: 900_000 });
    return r.data as any;
  },
};

export default api;
