import { API_BASE } from '@/services/api';
import { useProjectStore } from '@/hooks/useProject';

export interface GeniePickLike {
  component_type: string;
  asset_name: string;
  upstream_asset_names: string[];
  config: Record<string, any>;
  action?: string;
}

// Mirrors _AGENTIC_PIPELINE_FAMILY in genie_service.py. These components
// name their own asset(s) via `asset_name_prefix` and their upstream
// source via a nested `source: {kind: upstream_asset, upstream_asset_key}`
// block, both already present in `pick.config` -- NOT the flat
// `asset_name`/`upstream_asset_keys` fields every other component uses.
const AGENTIC_PIPELINE_FAMILY = new Set(['agentic_pipeline', 'ml_pipeline', 'polars_pipeline', 'warehouse_pipeline']);

export interface ApplyGeniePicksResult {
  installed: number;
  failed: number;
  warnings: string[];
  /** Set when every "add" pick that appeared to install successfully was
   *  automatically deleted again because the resulting project failed to
   *  load as a whole (Dagster's definitions build is all-or-nothing -- one
   *  bad pick, e.g. a duplicate asset key or a dangling upstream
   *  reference, fails the ENTIRE project, not just that pick). When this
   *  is set, `installed` reflects the post-rollback count (0 for a plain
   *  add-only plan), not what briefly existed on disk. */
  rolledBack?: string;
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
  // Every "add" pick's instance_name that successfully installed THIS
  // call -- the exact set to roll back (delete again) if the project as
  // a whole fails to validate afterward. Not "edit"/"remove" picks: there
  // isn't a clean, safe auto-undo for those (an edit's prior attributes
  // aren't tracked anywhere to restore, and a remove already succeeded at
  // deleting something real) -- scoping rollback to adds keeps it a
  // strictly reversible action.
  const addedInstanceNames: string[] = [];

  // Each pick's own work (install/edit/remove) touches only its own
  // component's files, so picks are safe to apply concurrently instead of
  // one at a time -- EXCEPT "add" picks each also trigger install-via-
  // cli's own `uv add` for the component's dependencies, which mutates
  // the whole project's shared pyproject.toml/uv.lock. That race is now
  // closed server-side (install_component_via_cli holds a per-project
  // lock around its uv-add-triggering steps -- see templates_registry.py),
  // so firing every pick in parallel here is safe: concurrent installs
  // for the SAME project serialize on the backend instead of racing, and
  // picks for DIFFERENT projects (not a thing in practice, but if it were)
  // would run fully in parallel. This replaces what was previously a
  // strictly sequential for-loop paying N full network round-trips in a
  // row for an N-pick plan.
  const snapshotGraphNodes = useProjectStore.getState().currentProject?.graph.nodes;

  async function processPick(pick: GeniePickLike): Promise<{ ok: boolean; warning?: string; addedName?: string }> {
    const action = pick.action || 'add';

    if (action === 'remove') {
      const componentId = resolveComponentId(pick.asset_name);
      if (!componentId) {
        console.warn(`[applyGeniePicks] Could not resolve existing asset '${pick.asset_name}' to remove`);
        return { ok: false };
      }
      try {
        const { projectsApi } = await import('@/services/api');
        await projectsApi.deleteComponentInstance(projectId, componentId);
        return { ok: true };
      } catch (e) {
        console.warn(`[applyGeniePicks] Failed to remove ${pick.asset_name}:`, e);
        return { ok: false };
      }
    }

    if (action === 'edit') {
      const componentId = resolveComponentId(pick.asset_name);
      if (!componentId) {
        console.warn(`[applyGeniePicks] Could not resolve existing asset '${pick.asset_name}' to edit`);
        return { ok: false };
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
        let warning: string | undefined;
        if (body.dropped_attributes?.length) {
          warning = `${pick.asset_name}: dropped unrecognized field(s) ${body.dropped_attributes.join(', ')}`;
        }
        if (body.components_list_warning) {
          warning = `${pick.asset_name}: ${body.components_list_warning}`;
        }
        return { ok: true, warning };
      } catch (e) {
        console.warn(`[applyGeniePicks] Failed to edit ${pick.asset_name}:`, e);
        return { ok: false };
      }
    }

    // add. pick.component_type is actually the manifest component_id
    // (e.g. "agentic_pipeline"). Pass the AI's proposed attrs as
    // `attributes` so the CLI-based endpoint merges them into the stub
    // defs.yaml -- otherwise the LLM's carefully-planned config gets
    // discarded and the user has to re-enter it by hand.
    //
    // Guard against re-adding something already there: confirmed live as
    // the exact root cause of a real duplicate-asset-key breakage -- a
    // plan got applied once (partially, since one pick failed at the
    // time), the user reopened the app and hit "Add to graph" again on
    // the SAME still-open conversation, and install-via-cli's own
    // dedup-by-suffix behavior (naming the new instance
    // "incoming_support_tickets_2") created a SECOND component whose
    // `asset_name` attribute was still the original, unsuffixed name --
    // two components, same asset key, whole project fails to load.
    // install-via-cli has no way to know "this exact asset already
    // exists, don't make a sibling" -- checking the current graph here,
    // before ever calling it, does. Checked against a snapshot taken
    // before any pick started (nothing in this loop mutates the stored
    // graph until the final regenerateAssets below), so this stays
    // correct run concurrently.
    if (snapshotGraphNodes?.some((n: any) => (n.data?.asset_key || n.id) === pick.asset_name)) {
      return { ok: true, warning: `${pick.asset_name}: already exists in the project -- skipped re-adding it.` };
    }
    try {
      // Building `attributes` used to sit OUTSIDE this try block --
      // confirmed live as a real bug: a malformed pick (e.g. `config`
      // coming back null/undefined from a planner edge case) threw here,
      // UNCAUGHT, which aborted the whole `for` loop -- not just this one
      // pick -- with nothing surfaced to the user at all (apply()'s own
      // try/finally in AgentPipelineBuilder.tsx has no catch around this
      // call). Every pick after the one that crashed silently never got
      // installed. Moving the construction inside the try turns that into
      // an ordinary per-pick failure.
      const attributes: Record<string, any> = { ...pick.config };
      // Confirmed live: for an agentic_pipeline-family pick, `pick.config`
      // ALREADY has the right fields (asset_name_prefix, source) filled
      // in correctly -- unconditionally adding asset_name/
      // upstream_asset_keys on top just produced two sets of fields, the
      // real ones AND a redundant, schema-invalid pair the backend
      // silently dropped. Harmless when the real fields win, but it
      // generated a confusing "dropped unrecognized field(s)" warning on
      // every single one of these picks, which also kept the dialog open
      // (a warning means apply() doesn't auto-close) even on a fully
      // successful install.
      if (!AGENTIC_PIPELINE_FAMILY.has(pick.component_type)) {
        attributes.asset_name = pick.config?.asset_name || pick.asset_name;
        if (pick.upstream_asset_names?.length > 0) {
          // upstream_asset_keys is schema'd as an array on every component
          // we've seen -- must be written as one, never joined into a string.
          attributes.upstream_asset_keys = pick.upstream_asset_names;
        }
      }
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
      let warning: string | undefined;
      if (body.dropped_attributes?.length) {
        warning = `${pick.asset_name}: dropped unrecognized field(s) ${body.dropped_attributes.join(', ')}`;
      }
      if (body.components_list_warning) {
        warning = `${pick.asset_name}: ${body.components_list_warning}`;
      }
      return { ok: true, warning, addedName: pick.asset_name };
    } catch (e) {
      console.warn(`[applyGeniePicks] Failed to install ${pick.component_type}:`, e);
      return { ok: false };
    }
  }

  const results = await Promise.allSettled(picks.map(processPick));
  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { ok, warning, addedName } = result.value;
      if (ok) installed++; else failed++;
      if (warning) warnings.push(warning);
      if (addedName) addedInstanceNames.push(addedName);
    } else {
      failed++;
      console.warn('[applyGeniePicks] Pick processing rejected unexpectedly:', result.reason);
    }
  }

  // Dagster's definitions build is all-or-nothing: ONE bad pick (a
  // duplicate asset key from double-applying a plan, a dangling
  // upstream_asset_key no asset actually provides, ...) fails the ENTIRE
  // project, not just that pick -- every tab (Runs, Assets, Ingestions,
  // everything) goes down until someone notices and manually deletes the
  // right component. Confirmed live, repeatedly, in this exact session.
  // Validating the whole project right here, before anything else
  // touches the store, and auto-reverting the adds that just happened if
  // it fails, turns "silently broken until you reopen the project" into
  // "this specific change didn't stick, here's why, nothing else changed."
  const { projectsApi } = await import('@/services/api');
  if (addedInstanceNames.length > 0) {
    const { validateProjectOrRollback } = await import('./validateProjectOrRollback');
    const result = await validateProjectOrRollback(projectId, async () => {
      for (const name of addedInstanceNames) {
        try {
          await projectsApi.deleteComponentInstance(projectId, name);
        } catch (e) {
          console.error(`[applyGeniePicks] Rollback failed to delete ${name} -- project may still be broken:`, e);
        }
      }
    });
    if (!result.ok) {
      return { installed: 0, failed: picks.length, warnings, rolledBack: result.error };
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
