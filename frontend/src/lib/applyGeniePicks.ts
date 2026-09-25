import { API_BASE } from '@/services/api';
import { useProjectStore } from '@/hooks/useProject';

export interface GeniePickLike {
  component_type: string;
  asset_name: string;
  upstream_asset_names: string[];
  config: Record<string, any>;
  action?: string;
}

export interface ApplyGeniePicksResult {
  installed: number;
  failed: number;
  warnings: string[];
}

/**
 * Applies a full Genie plan's picks (add/edit/remove) to a project:
 * installs each pick via the appropriate endpoint, waits for freshly
 * installed assets to actually appear (`uvx dagster-component add`
 * sometimes returns before its downstream `uv sync` fully registers the
 * component with Dagster, so the first regenerate can miss them), and
 * updates useProjectStore with the refreshed project.
 *
 * Shared between DagsterAIBar (the general multi-pick flow) and any
 * scoped single-purpose "describe it" flow (e.g. the Agents & Pipelines
 * builder) -- both apply picks exactly the same way and both need the
 * same reliability fixes (the retry-poll, correctly writing
 * upstream_asset_keys as an array, surfacing dropped_attributes/
 * components_list_warning instead of failing silently). Extracted from
 * DagsterAIBar's original inline apply() so a future fix to any of that
 * applies everywhere at once instead of needing to be ported by hand.
 *
 * Caller is responsible for: confirming destructive "remove" picks
 * before calling this, invalidating any OTHER react-query caches it
 * cares about (installed-components/primitives/definitions/resources),
 * and showing its own success/error UI from the returned result.
 */
export async function applyGeniePicks(
  projectId: string,
  picks: GeniePickLike[],
  resolveComponentId: (assetName: string) => string | null,
): Promise<ApplyGeniePicksResult> {
  let installed = 0;
  let failed = 0;
  const warnings: string[] = [];

  for (const pick of picks) {
    const action = pick.action || 'add';

    if (action === 'remove') {
      const componentId = resolveComponentId(pick.asset_name);
      if (!componentId) {
        failed++;
        console.warn(`[applyGeniePicks] Could not resolve existing asset '${pick.asset_name}' to remove`);
        continue;
      }
      try {
        const { projectsApi } = await import('@/services/api');
        await projectsApi.deleteComponentInstance(projectId, componentId);
        installed++;
      } catch (e) {
        failed++;
        console.warn(`[applyGeniePicks] Failed to remove ${pick.asset_name}:`, e);
      }
      continue;
    }

    if (action === 'edit') {
      const componentId = resolveComponentId(pick.asset_name);
      if (!componentId) {
        failed++;
        console.warn(`[applyGeniePicks] Could not resolve existing asset '${pick.asset_name}' to edit`);
        continue;
      }
      try {
        const res = await fetch(`${API_BASE}/templates/component-instance/${componentId}/attributes`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: projectId, attributes: pick.config }),
        });
        const body = await res.json().catch(() => ({} as any));
        if (!res.ok) {
          throw new Error(body.detail || `HTTP ${res.status}`);
        }
        if (body.dropped_attributes?.length) {
          warnings.push(`${pick.asset_name}: dropped unrecognized field(s) ${body.dropped_attributes.join(', ')}`);
        }
        if (body.components_list_warning) {
          warnings.push(`${pick.asset_name}: ${body.components_list_warning}`);
        }
        installed++;
      } catch (e) {
        failed++;
        console.warn(`[applyGeniePicks] Failed to edit ${pick.asset_name}:`, e);
      }
      continue;
    }

    // add. pick.component_type is actually the manifest component_id
    // (e.g. "agentic_pipeline"). Pass the AI's proposed attrs as
    // `attributes` so the CLI-based endpoint merges them into the stub
    // defs.yaml -- otherwise the LLM's carefully-planned config gets
    // discarded and the user has to re-enter it by hand.
    const attributes: Record<string, any> = {
      ...pick.config,
      asset_name: pick.config.asset_name || pick.asset_name,
    };
    if (pick.upstream_asset_names?.length > 0) {
      // upstream_asset_keys is schema'd as an array on every component
      // we've seen -- must be written as one, never joined into a string.
      attributes.upstream_asset_keys = pick.upstream_asset_names;
    }
    try {
      const res = await fetch(`${API_BASE}/templates/install-via-cli/${pick.component_type}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          config: {},
          attributes,
          instance_name: pick.asset_name,
        }),
      });
      const body = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        throw new Error(body.detail || `HTTP ${res.status}`);
      }
      if (body.dropped_attributes?.length) {
        warnings.push(`${pick.asset_name}: dropped unrecognized field(s) ${body.dropped_attributes.join(', ')}`);
      }
      if (body.components_list_warning) {
        warnings.push(`${pick.asset_name}: ${body.components_list_warning}`);
      }
      installed++;
    } catch (e) {
      failed++;
      console.warn(`[applyGeniePicks] Failed to install ${pick.component_type}:`, e);
    }
  }

  // install-via-cli only writes defs.yaml files -- it doesn't update the
  // project's graph JSON with the new asset nodes. Trigger asset
  // introspection (preserving existing positions) so the response
  // includes the freshly discovered assets, then swap the project in.
  //
  // Retry loop: see this function's docstring. "remove" picks should NOT
  // be waited on -- the asset is meant to disappear, not (re)appear, so
  // including it here would just waste retries waiting for something
  // that's never coming back.
  const expectedNames = new Set(
    picks
      .filter((p) => (p.action || 'add') !== 'remove')
      .map((p) => (p.config?.asset_name as string) || p.asset_name)
      .filter(Boolean),
  );
  const { projectsApi } = await import('@/services/api');
  let updatedProject: any = null;
  const MAX_RETRIES = 4;
  const RETRY_DELAY_MS = 1500;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      updatedProject = await projectsApi.regenerateAssets(projectId, false);
    } catch (e) {
      console.warn(`[applyGeniePicks] regenerate attempt ${attempt + 1} failed:`, e);
      break;
    }
    const foundNames = new Set(
      (updatedProject?.graph?.nodes ?? [])
        .filter((n: any) => n.node_kind === 'asset')
        .map((n: any) => n.id),
    );
    const missing = [...expectedNames].filter((n) => !foundNames.has(n));
    if (missing.length === 0) {
      if (attempt > 0) console.log(`[applyGeniePicks] All picks visible after ${attempt} retry(ies).`);
      break;
    }
    if (attempt === MAX_RETRIES) {
      console.warn(`[applyGeniePicks] Gave up after ${MAX_RETRIES + 1} tries; still missing:`, missing);
      break;
    }
    console.log(
      `[applyGeniePicks] Retry ${attempt + 1}/${MAX_RETRIES}: still missing`,
      missing,
      `— waiting ${RETRY_DELAY_MS}ms`,
    );
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }

  if (updatedProject) {
    useProjectStore.getState().setCurrentProject(updatedProject);
  } else {
    console.warn('[applyGeniePicks] regenerate failed entirely, falling back to loadProject');
    await useProjectStore.getState().loadProject(projectId);
  }

  return { installed, failed, warnings };
}

/** Resolves a Genie pick's asset_name back to a real component instance
 * id (the plan only carries names, what the model reasons about) --
 * needed for "edit"/"remove" actions. Reads from the CURRENT project in
 * useProjectStore rather than taking it as a param, since callers already
 * have it and re-deriving here keeps the call site a one-liner. */
export function resolveComponentIdFromCurrentProject(assetName: string): string | null {
  const currentProject = useProjectStore.getState().currentProject;
  const node = currentProject?.graph.nodes.find(
    (n: any) => (n.data?.asset_key || n.data?.label || n.id) === assetName,
  );
  return node ? ((node.data as any)?.component_id || node.id) : null;
}
