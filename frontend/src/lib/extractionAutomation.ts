import { API_BASE } from '@/services/api';
import { automationNames } from './extractionFreeze';

/** Install a community component's code into the project, then write its configured instance (what the builders do for any component). */
export async function installAndConfigure(projectId: string, componentId: string, config: Record<string, unknown>): Promise<void> {
  const post = async (path: string, body: unknown, what: string) => {
    const res = await fetch(`${API_BASE}/templates/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({} as any));
    if (!res.ok) throw new Error(`${what}: ${typeof out.detail === 'string' ? out.detail : out.detail?.message || `HTTP ${res.status}`}`);
  };
  await post(`install-via-cli/${componentId}`, { project_id: projectId, config: {}, template_only: true }, `Couldn't add ${componentId}`);
  await post(`configure/${componentId}`, { project_id: projectId, config }, `Couldn't configure ${componentId}`);
}

export interface WatchSettings {
  assetName: string;
  directory: string;
  /** Regex matched against file names. */
  pattern: string;
  intervalSeconds: number;
}

/** A job that materializes the extraction asset, and a sensor that runs it when new files land in the folder. The job comes first:
 * the sensor refers to it by name. Re-running with the same asset name rewrites the same two instances. */
export async function createWatchAutomation(projectId: string, w: WatchSettings): Promise<{ job: string; sensor: string }> {
  const names = automationNames(w.assetName);
  await installAndConfigure(projectId, 'asset_job', { name: names.job, job_name: names.job, asset_keys: [w.assetName] });
  await installAndConfigure(projectId, 'filesystem_monitor', {
    name: names.sensor,
    sensor_name: names.sensor,
    directory_path: w.directory,
    file_pattern: w.pattern,
    job_name: names.job,
    minimum_interval_seconds: Math.max(5, Math.round(w.intervalSeconds)),
    default_status: 'running',
  });
  return names;
}
