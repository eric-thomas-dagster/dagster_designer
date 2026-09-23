import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Loader2, AlertTriangle, Sparkles, ShieldAlert, Info, ChevronDown, ChevronRight, CheckCircle2 } from 'lucide-react';
import yaml from 'js-yaml';
import {
  authoredApi,
  communityTemplatesApi,
  componentsApi,
  designerLocApi,
  SANDBOX_LOCATION_NAME,
  type AuthoredDeployment,
  type AuthoredLocation,
  type ComponentTypeInfo,
  type ComponentSchema,
  type CommunityTemplate,
  type Produces,
} from '@/services/api';

/**
 * AddComponentModal — a *picker* for the authoring flow.
 *
 * Step 1 lives here: pick a Dagster+ deployment (long-lived or
 * branch), pick a target location (customer loc or the Designer
 * sandbox), pick a component type from either Designer's catalog
 * (sandbox) or the loc's registered types (cloud). Everything after
 * "Continue" is delegated to `ComponentConfigModal` via the
 * `onConfigure` callback — so we use exactly the same form as the
 * local-project component editor.
 */
export interface ConfigureAuthoringPayload {
  componentType: string;
  displayName: string;
  /** Pass null to let ComponentConfigModal fetch the schema from
   *  Designer's local component registry (used by the graph-sidebar
   *  palette shortcut, which knows a type name but hasn't fetched
   *  the schema yet). */
  schema: ComponentSchema | null;
  initialAttributes: Record<string, any>;
  location: string;                 // customer loc name OR SANDBOX_LOCATION_NAME
  deployment: string | null;        // Dagster+ deployment name; null for sandbox
  target: 'sandbox' | 'cloud_draft';
  /** Asset keys registered in the target deployment+location — used
   *  by the asset_selection picker. Empty for sandbox. */
  availableAssets: string[];
  /** Names of jobs / schedules / sensors registered in the target —
   *  powers `job_name` / `schedule_name` / `sensor_name` pickers. */
  availableJobs: string[];
  availableSchedules: string[];
  availableSensors: string[];
}

interface AddComponentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onConfigure: (payload: ConfigureAuthoringPayload) => void;
  /** Optional pre-filter on `produces`. When set, only types whose
   *  produces list contains at least one of these values render.
   *  Populated by context-aware entry points ("Add schedule" on the
   *  Schedules tab passes ['schedule']). */
  initialProducesFilter?: Produces[];
}

interface UnifiedTypeRow {
  fullName: string;
  displayName: string;
  namespace: string | null;
  description: string | null;
  example: string | null;
  dataSchema: any | null;
  category?: string;
  isAppManaged?: boolean;
  /** For community-manifest templates: the manifest id (e.g. `airtable_ingestion`).
   *  Presence of this field means "install via CLI on Continue." */
  communityId?: string;
  /** Dagster primitives this component creates. Sourced from the
   *  manifest's `produces` field when present; otherwise inferred
   *  from the dataSchema property names. */
  produces?: Produces[];
}


/**
 * Heuristic fallback for types where the manifest hasn't published
 * a `produces` field (Dagster+ locs, Designer's built-in registry).
 * Reads schema property names and returns the primitives the component
 * probably creates. Multi-produces when several markers hit.
 */
function inferProduces(dataSchema: any): Produces[] {
  const props = dataSchema?.properties ?? {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(props, k);
  const out: Produces[] = [];
  const hasCron = has('cron_schedule') || has('schedule') || has('crontab');
  const hasJobName = has('job_name');
  const hasAssetSel = has('asset_selection') || has('selection');
  const hasAssetName = has('asset_name') || has('asset_key');
  const hasCheckKind = has('check_kind') || has('check_name') || has('checks');
  if (hasCron) out.push('schedule');
  if (hasJobName || (hasCron && hasAssetSel)) out.push('job');
  if (hasAssetName) out.push('asset');
  if (hasAssetSel && !hasAssetName) {
    // asset_selection alone typically means "operates over assets"
    // rather than creating one — treat as a job-shaped input signal
    // only if we didn't already tag as schedule/job.
  }
  if (hasCheckKind) out.push('asset_check');
  return out;
}

export function AddComponentModal({
  open,
  onOpenChange,
  projectId,
  onConfigure,
  initialProducesFilter,
}: AddComponentModalProps) {
  const [deployments, setDeployments] = useState<AuthoredDeployment[]>([]);
  const [loadingDeployments, setLoadingDeployments] = useState(false);
  const [deployment, setDeployment] = useState<string>('');
  const [supportMap, setSupportMap] = useState<Record<string, boolean | undefined>>({});
  const [probingSupport, setProbingSupport] = useState(false);

  const [locations, setLocations] = useState<AuthoredLocation[]>([]);
  const [loadingLocations, setLoadingLocations] = useState(false);
  const [locationsError, setLocationsError] = useState<string | null>(null);
  const [location, setLocation] = useState<string>('');

  // Orientation banner — collapsed state persists across opens so a
  // user who's read it once doesn't get re-explained every time.
  const [bannerOpen, setBannerOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('addComponentBanner.collapsed') !== '1'; }
    catch { return true; }
  });
  const toggleBanner = () => {
    setBannerOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem('addComponentBanner.collapsed', next ? '0' : '1'); } catch {}
      return next;
    });
  };

  const [types, setTypes] = useState<UnifiedTypeRow[]>([]);
  const [loadingTypes, setLoadingTypes] = useState(false);
  const [typesError, setTypesError] = useState<string | null>(null);
  const [componentType, setComponentType] = useState<string>('');
  const [typeSearch, setTypeSearch] = useState('');
  const [producesFilter, setProducesFilter] = useState<Set<Produces>>(new Set());

  // Community-catalog IDs already installed on the current target location
  // (via community_component_installer). Powers the "already installed ✓"
  // marker in the type list. Empty when the target isn't a Dagster+ loc
  // OR when the installer isn't set up there yet.
  const [installedCatalogIds, setInstalledCatalogIds] = useState<Set<string>>(new Set());

  // Reset produces filter when the modal opens with a new preset.
  useEffect(() => {
    if (open) setProducesFilter(new Set(initialProducesFilter ?? []));
  }, [open, initialProducesFilter]);

  const isSandbox = location === SANDBOX_LOCATION_NAME;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoadingDeployments(true);
    authoredApi.deployments(projectId)
      .then((r) => {
        if (!alive) return;
        setDeployments(r.deployments);
        const first = r.deployments.find((d) => d.type === 'PRODUCTION') ?? r.deployments[0];
        if (first) setDeployment(first.name);
        setProbingSupport(true);
        authoredApi.deploymentSupport(projectId)
          .then((s) => { if (alive) setSupportMap(s.support); })
          .catch(() => { /* leave map empty */ })
          .finally(() => { if (alive) setProbingSupport(false); });
      })
      .catch(() => { /* sandbox-only path still fine */ })
      .finally(() => { if (alive) setLoadingDeployments(false); });
    return () => { alive = false; };
  }, [open, projectId]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoadingLocations(true);
    setLocationsError(null);
    authoredApi.locations(projectId, deployment || undefined)
      .then((r) => {
        if (!alive) return;
        setLocations(r.locations);
        const preferred =
          r.locations.find((l) => l.source === 'dagster_plus' && l.authoring_supported) ??
          r.locations.find((l) => l.source === 'sandbox') ??
          r.locations[0];
        if (preferred) setLocation(preferred.name);
      })
      .catch((e) => { if (alive) setLocationsError(e?.message || String(e)); })
      .finally(() => { if (alive) setLoadingLocations(false); });
    return () => { alive = false; };
  }, [open, projectId, deployment]);

  // Fetch already-installed community components from the target
  // whenever the (deployment, location) pair changes. Best-effort — a
  // failure leaves the set empty and the picker just doesn't mark
  // anything as installed. Sandbox location skips entirely.
  useEffect(() => {
    if (!open || !location || location === SANDBOX_LOCATION_NAME || !deployment) {
      setInstalledCatalogIds(new Set());
      return;
    }
    let alive = true;
    authoredApi.installedCommunityComponents(projectId, location, deployment)
      .then((r) => {
        if (!alive) return;
        setInstalledCatalogIds(new Set(r.checked ? (r.installed ?? []) : []));
      })
      .catch(() => { if (alive) setInstalledCatalogIds(new Set()); });
    return () => { alive = false; };
  }, [open, projectId, location, deployment]);

  useEffect(() => {
    if (!open || !location) { setTypes([]); return; }
    let alive = true;
    setLoadingTypes(true);
    setTypesError(null);
    setComponentType('');

    const load = async () => {
      try {
        if (location === SANDBOX_LOCATION_NAME) {
          // Sandbox catalog = Designer's local registry (~16 built-ins)
          // + the full community manifest (~900 templates). The user
          // sees one unified list; on Continue we route to the right
          // installer.
          const [localRes, manifestRes] = await Promise.all([
            componentsApi.list(),
            communityTemplatesApi.manifest().catch(() => ({ components: [] as CommunityTemplate[] })),
          ]);
          if (!alive) return;
          const local: UnifiedTypeRow[] = localRes.components.map((c: ComponentSchema) => ({
            fullName: c.type,
            displayName: c.name,
            namespace: c.module ?? null,
            description: c.description || null,
            example: null,
            dataSchema: c.schema || null,
            category: c.category,
            produces: inferProduces(c.schema),
          }));
          const community: UnifiedTypeRow[] = (manifestRes.components || []).map((t: CommunityTemplate) => ({
            fullName: t.id,
            displayName: t.name,
            namespace: 'community',
            description: t.description || null,
            example: null,
            dataSchema: null,
            category: t.category,
            communityId: t.id,
            // Manifest-declared produces is authoritative; nothing to infer
            // yet since the schema is fetched post-install.
            produces: t.produces,
          }));
          setTypes([...local, ...community]);
        } else {
          const r = await authoredApi.componentTypes(projectId, location, deployment || undefined);
          if (!alive) return;
          if (r.error) setTypesError(r.error);
          // Filter to `isAppManaged: true` — the other types Dagster+
          // returns are stateless built-ins (dagster.DefsFolderComponent,
          // dagster.DefinitionsComponent, etc.) that aren't backed by
          // per-instance state, so authoring them via this flow has no
          // meaning. This matches Dagster+'s own component picker.
          //
          // Dedupe by class name too — Dagster+ registers each type
          // under both the canonical namespace and a doubled variant
          // (e.g. `hooli_data_eng.components.X` AND
          // `hooli_data_eng.hooli_data_eng.components.X`). We keep the
          // shortest full-name, which is always the canonical form.
          const rows = (r.types || [])
            .filter((t: ComponentTypeInfo) => t.isAppManaged)
            .map((t: ComponentTypeInfo): UnifiedTypeRow => {
              const dataSchema = t.formSchema?.dataSchema ?? t.schema ?? null;
              return {
                fullName: t.namespace ? `${t.namespace}.${t.name}` : t.name,
                displayName: t.name,
                namespace: t.namespace,
                description: t.description,
                example: t.example,
                dataSchema,
                isAppManaged: t.isAppManaged,
                produces: inferProduces(dataSchema),
              };
            });
          const byName = new Map<string, UnifiedTypeRow>();
          for (const row of rows) {
            const existing = byName.get(row.displayName);
            if (!existing || row.fullName.length < existing.fullName.length) {
              byName.set(row.displayName, row);
            }
          }
          setTypes(Array.from(byName.values()));
        }
      } catch (e: any) {
        if (alive) setTypesError(e?.response?.data?.detail || e?.message || String(e));
      } finally {
        if (alive) setLoadingTypes(false);
      }
    };
    load();
    return () => { alive = false; };
  }, [open, projectId, location, deployment]);

  const selectedType = useMemo(() => types.find((t) => t.fullName === componentType), [types, componentType]);

  const filteredTypes = useMemo(() => {
    let out = types;
    if (producesFilter.size > 0) {
      out = out.filter((t) => (t.produces ?? []).some((p) => producesFilter.has(p)));
    }
    if (typeSearch.trim()) {
      const q = typeSearch.trim().toLowerCase();
      out = out.filter((t) =>
        t.fullName.toLowerCase().includes(q)
        || t.displayName.toLowerCase().includes(q)
        || (t.description ?? '').toLowerCase().includes(q)
        || (t.category ?? '').toLowerCase().includes(q));
    }
    return out;
  }, [types, typeSearch, producesFilter]);

  // Counts per primitive so filter chips can show "Schedules (40)" etc.
  const producesCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of types) {
      for (const p of t.produces ?? []) c[p] = (c[p] ?? 0) + 1;
    }
    return c;
  }, [types]);

  const canContinue = !!location && !!componentType;

  const [continuing, setContinuing] = useState(false);
  const [continuingMessage, setContinuingMessage] = useState<string | null>(null);
  const handleContinue = async () => {
    if (!canContinue || !selectedType) return;

    let effectiveType = selectedType;

    // Community template? Install first — the CLI drops files into the
    // sandbox and adds Python deps. After install we ask the SANDBOX
    // (not Designer's own registry) for the newly-registered type's
    // schema. The sandbox's Python env is separate from Designer's;
    // Designer's `componentsApi.list()` only sees types installed in
    // Designer's own venv, so post-install we have to query
    // `componentTypesForLocationOrError` on the sandbox subprocess.
    if (isSandbox && selectedType.communityId) {
      setContinuing(true);
      setContinuingMessage(`Installing ${selectedType.displayName} into sandbox (fetches from GitHub, ~30s)…`);
      try {
        const r = await designerLocApi.installCommunityComponent(projectId, selectedType.communityId);
        const canonicalType = r.component_type;
        if (canonicalType) {
          // Ask the sandbox subprocess for its updated type list.
          const sandboxTypes = await authoredApi.componentTypes(projectId, SANDBOX_LOCATION_NAME);
          const match = sandboxTypes.types.find(
            (t) => (t.namespace ? `${t.namespace}.${t.name}` : t.name) === canonicalType
          );
          if (match) {
            effectiveType = {
              ...selectedType,
              fullName: canonicalType,
              displayName: match.name,
              namespace: match.namespace ?? null,
              description: match.description ?? selectedType.description,
              example: match.example,
              dataSchema: match.formSchema?.dataSchema ?? match.schema ?? null,
            };
          } else {
            // Sandbox knows the type by a different canonical name —
            // proceed with what we have; ConfigModal falls back to YAML.
            effectiveType = { ...selectedType, fullName: canonicalType };
          }
        }
      } catch (e: any) {
        setContinuing(false);
        setContinuingMessage(null);
        alert(`Install failed: ${e?.response?.data?.detail || e?.message || String(e)}`);
        return;
      }
      setContinuing(false);
      setContinuingMessage(null);
    }

    let initialAttributes: Record<string, any> = {};
    if (effectiveType.example) {
      try {
        const doc = yaml.load(effectiveType.example) as any;
        if (doc?.attributes && typeof doc.attributes === 'object') {
          initialAttributes = doc.attributes;
        }
      } catch { /* fall through */ }
    }

    const schema: ComponentSchema = {
      type: effectiveType.fullName,
      name: effectiveType.displayName,
      module: effectiveType.namespace ?? '',
      description: effectiveType.description ?? '',
      category: effectiveType.category ?? 'custom',
      attributes: {},
      schema: effectiveType.dataSchema ?? {},
    };

    let availableAssets: string[] = [];
    let availableJobs: string[] = [];
    let availableSchedules: string[] = [];
    let availableSensors: string[] = [];
    if (!isSandbox) {
      setContinuing(true);
      try {
        const [a, p] = await Promise.all([
          authoredApi.assets(projectId, deployment || undefined, location),
          authoredApi.primitives(projectId, deployment || undefined, location),
        ]);
        availableAssets = a.asset_keys;
        availableJobs = p.jobs;
        availableSchedules = p.schedules;
        availableSensors = p.sensors;
      } catch { /* leave empty on error */ }
      setContinuing(false);
    }

    onConfigure({
      componentType: effectiveType.fullName,
      displayName: effectiveType.displayName,
      schema,
      initialAttributes,
      location,
      deployment: isSandbox ? null : (deployment || null),
      target: isSandbox ? 'sandbox' : 'cloud_draft',
      availableAssets,
      availableJobs,
      availableSchedules,
      availableSensors,
    });
    onOpenChange(false);
    setComponentType('');
    setTypeSearch('');
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-[6vh] z-50 w-[860px] max-w-[95vw] -translate-x-1/2 rounded-lg bg-white shadow-2xl border border-gray-200 flex flex-col h-[88vh]">
          <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3 flex-shrink-0">
            <Dialog.Title className="text-base font-semibold text-gray-900">Add component</Dialog.Title>
            <Dialog.Close className="rounded p-1 text-gray-500 hover:bg-gray-100">
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>
          <div className="px-5 py-4 space-y-4 overflow-auto">
            <Dialog.Description className="text-xs text-gray-500">
              Pick where to author and which component type. The next step opens the same
              configuration form the local project editor uses.
            </Dialog.Description>

            {/* Orientation banner. Collapsible so a returning user gets it
                out of the way, and stays collapsed across opens via
                localStorage. Keeps the flow legible for first-time users
                and demos even when the deployment has no supported
                components. */}
            <div className="rounded-md border border-sky-200 bg-sky-50 text-sky-900">
              <button
                type="button"
                onClick={toggleBanner}
                className="w-full flex items-center gap-2 px-3 py-2 text-[11.5px] font-medium text-left hover:bg-sky-100/50 rounded-md"
                aria-expanded={bannerOpen}
              >
                {bannerOpen ? <ChevronDown className="w-3.5 h-3.5 text-sky-600" /> : <ChevronRight className="w-3.5 h-3.5 text-sky-600" />}
                <Info className="w-3.5 h-3.5 text-sky-600" />
                <span className="flex-1">How authoring routes — {bannerOpen ? 'click to hide' : 'click to show details'}</span>
              </button>
              {bannerOpen && (
                <div className="px-3 pb-2.5 pl-9 text-[11.5px] leading-snug space-y-1">
                  <p><strong>Nothing you author here runs against prod.</strong> Designer routes every edit into a safe environment based on the target you pick:</p>
                  <ul className="space-y-0.5 pl-3.5 list-disc marker:text-sky-400">
                    <li><strong>Long-lived deployment</strong> with supported components → Designer forks a fresh <em>branch deployment</em> from it and applies your draft there. Never mutates the source deployment. First boot ~30–90s (image pull), then ~1s per apply.</li>
                    <li><strong>Branch deployment</strong> with supported components → applies directly to that BD (~1s). Any user of the BD sees your in-flight state.</li>
                    <li><strong>Designer sandbox</strong> → laptop-local <code className="text-[10px]">dg dev</code> with Designer's full catalog (~944 community components + built-ins). Writes real files you can commit. Always available regardless of what any deployment exposes.</li>
                  </ul>
                  <p className="text-sky-700/80">"Supported" = a code location that registers app-managed component types (<code className="text-[10px]">isAppManaged: true</code>) via <code className="text-[10px]">get_form_config()</code>. Nothing? Author in the sandbox and promote via PR.</p>
                  <div className="mt-1.5 pt-1.5 border-t border-sky-200/70 text-sky-800">
                    <p><strong>Durable landing is git-only — for any deployment.</strong> The state-apply above is a preview; the source of truth is your repo. When a draft is ready, promote it via the Drafts panel → Designer opens a PR against the git branch you pick (your team's branch for a BD, <code className="text-[10px]">main</code> for prod) → your normal review + CI + deploy pipeline is what actually lands the change. UI writes can never bypass this.</p>
                  </div>
                </div>
              )}
            </div>


            {deployments.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1 flex items-center gap-1.5">
                  Dagster+ deployment
                  {probingSupport && (
                    <span className="text-[10px] text-gray-500 font-normal inline-flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" /> probing capability…
                    </span>
                  )}
                </label>
                <select
                  value={deployment}
                  onChange={(e) => setDeployment(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={loadingDeployments}
                >
                  <optgroup label="Long-lived">
                    {deployments.filter((d) => d.type === 'PRODUCTION').map((d) => (
                      <DeploymentOption key={d.id} d={d} support={supportMap[d.name]} probing={probingSupport} />
                    ))}
                  </optgroup>
                  {deployments.some((d) => d.type === 'BRANCH') && (
                    <optgroup label="Branch deployments">
                      {deployments.filter((d) => d.type === 'BRANCH').map((d) => (
                        <DeploymentOption key={d.id} d={d} support={supportMap[d.name]} probing={probingSupport} />
                      ))}
                    </optgroup>
                  )}
                </select>
                <p className="mt-1 text-[11px] text-gray-500">
                  Authoring always runs in a sandbox — never against the deployment directly, and
                  never with prod credentials. Deployments marked <em>sandbox only</em> just don't
                  expose customer types you can extend; you can still install from the community
                  catalog into your sandbox.
                </p>
              </div>
            )}

            <div className="min-h-[80px]">
              <label className="block text-xs font-medium text-gray-700 mb-1">Target location</label>
              {loadingLocations ? (
                <div className="flex items-center gap-2 text-xs text-gray-500 h-[38px]"><Loader2 className="w-3 h-3 animate-spin" /> Loading locations…</div>
              ) : locationsError ? (
                <div className="flex items-center gap-2 text-xs text-red-700 h-[38px]"><AlertTriangle className="w-3 h-3" /> {locationsError}</div>
              ) : locations.length === 0 ? (
                <div className="text-xs text-gray-500 h-[38px] flex items-center">No locations available.</div>
              ) : (
                <>
                  <select
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {locations.map((l) => (
                      <option key={l.name} value={l.name}>
                        {l.name === SANDBOX_LOCATION_NAME ? 'Designer sandbox (laptop)' : l.name}
                        {l.source === 'dagster_plus' ? ' · Dagster+' : ''}
                      </option>
                    ))}
                  </select>
                  {locations.filter((l) => l.source === 'dagster_plus').length === 0 && (
                    <p className="mt-1 text-[11px] text-gray-500">
                      No customer code locations in this deployment expose <code>isAppManaged</code> types.
                      Only branch deployments (or locs configured with the Community Component Installer) support authoring today.
                    </p>
                  )}
                </>
              )}
              {isSandbox ? (
                <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded">
                  <Sparkles className="w-3 h-3" /> Full catalog available · installs on demand · saves as real files
                </div>
              ) : location && (() => {
                const dep = deployments.find((d) => d.name === deployment);
                const isBranch = dep?.type === 'BRANCH';
                return (
                  <div className="mt-1 space-y-1">
                    <div className="inline-flex items-center gap-1 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">
                      <ShieldAlert className="w-3 h-3" /> Limited to types registered in this location · saves as a draft (promote via PR)
                    </div>
                    <p className="text-[11px] text-gray-600 leading-snug">
                      {isBranch ? (
                        <>
                          <strong>Preview applies to <code className="text-[10px]">{deployment}</code> directly.</strong>{' '}
                          It's already a branch deployment, so Designer skips the fork step (~1s per apply).
                          Any user with access to this BD sees your in-flight state.
                        </>
                      ) : (
                        <>
                          <strong>Preview will fork a fresh branch deployment</strong> off <code className="text-[10px]">{deployment}</code>{' '}
                          (state can't be mutated on a long-lived deployment). First boot ~30–90s while Dagster+ pulls the image;
                          subsequent applies to the same fork ~1s. Designer names the fork <code className="text-[10px]">designer/…-{location}</code>.
                        </>
                      )}
                    </p>
                  </div>
                );
              })()}
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Component type {types.length > 0 && <span className="text-gray-400">({types.length})</span>}
              </label>
              <input
                value={typeSearch}
                onChange={(e) => setTypeSearch(e.target.value)}
                placeholder="Search by name, module, category…"
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 mb-1"
              />
              {/* Filter chips — click to toggle. Counts drive from the
                  unfiltered `types` so users see how much each primitive
                  narrows the list before they commit. */}
              {Object.keys(producesCounts).length > 0 && (
                <div className="flex flex-wrap items-center gap-1 mb-1">
                  {(['schedule', 'job', 'asset', 'multi_asset', 'sensor', 'asset_check', 'resource', 'io_manager', 'partitions_def', 'other'] as Produces[])
                    .filter((p) => (producesCounts[p] ?? 0) > 0)
                    .map((p) => {
                      const active = producesFilter.has(p);
                      return (
                        <button
                          key={p}
                          type="button"
                          onClick={() => {
                            const next = new Set(producesFilter);
                            active ? next.delete(p) : next.add(p);
                            setProducesFilter(next);
                          }}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] border ${
                            active
                              ? `${producesToneActive(p)}`
                              : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                          }`}
                        >
                          {producesLabel(p)} <span className="text-[10px] opacity-70">{producesCounts[p]}</span>
                        </button>
                      );
                    })}
                  {producesFilter.size > 0 && (
                    <button
                      type="button"
                      onClick={() => setProducesFilter(new Set())}
                      className="text-[10px] text-gray-500 hover:text-gray-800 ml-1 underline"
                    >
                      clear
                    </button>
                  )}
                </div>
              )}
              {/* Fixed-height container: keeps the modal from resizing as
                  types load / error / populate. Inner state slots in with
                  overflow-auto so the outer layout is stable. */}
              <div className="h-72 overflow-auto border border-gray-200 rounded divide-y divide-gray-100">
              {loadingTypes ? (
                <div className="flex items-center gap-2 text-xs text-gray-500 p-3"><Loader2 className="w-3 h-3 animate-spin" /> Loading types…</div>
              ) : typesError ? (
                <div className="flex items-center gap-2 text-xs text-red-700 p-3"><AlertTriangle className="w-3 h-3" /> {typesError}</div>
              ) : types.length === 0 ? (
                <div className="text-xs text-gray-500 p-3">
                  {isSandbox
                    ? 'Catalog is empty — check that Designer\'s component registry is populated.'
                    : 'No component types registered in this location.'}
                </div>
              ) : (
                <div>
                  {filteredTypes.map((t) => {
                    const isSelected = componentType === t.fullName;
                    return (
                      <button
                        key={t.fullName}
                        type="button"
                        onClick={() => setComponentType(t.fullName)}
                        onDoubleClick={handleContinue}
                        className={`w-full text-left px-3 py-2 text-xs hover:bg-gray-50 ${isSelected ? 'bg-indigo-50' : ''}`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-medium text-gray-900">{t.displayName}</span>
                          <span className="flex items-center gap-1 flex-shrink-0 flex-wrap justify-end">
                            {(t.produces ?? []).map((p) => (
                              <span key={p} className={`text-[10px] px-1.5 py-0.5 rounded border ${producesTone(p)}`}>
                                {producesLabel(p)}
                              </span>
                            ))}
                            {t.communityId && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200">
                                community
                              </span>
                            )}
                            {/* Green ✓ badge when this community component
                                is already installed on the target
                                location via community_component_installer.
                                Signals "no source-copy needed at promote;
                                just add a new instance." */}
                            {t.communityId && installedCatalogIds.has(t.communityId) && (
                              <span
                                className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 inline-flex items-center gap-0.5"
                                title="Already installed on this target — new instances will just add to the existing installer's list."
                              >
                                <CheckCircle2 className="w-3 h-3" /> installed
                              </span>
                            )}
                            {t.category && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 border border-gray-200">
                                {t.category}
                              </span>
                            )}
                          </span>
                        </div>
                        <div className="text-[10px] text-gray-500 mt-0.5 truncate">{t.fullName}</div>
                        {t.description && (
                          <div className="text-[11px] text-gray-600 mt-1 line-clamp-2">{truncateDescription(t.description)}</div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
              </div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-5 py-3 flex-shrink-0">
            <button
              onClick={() => onOpenChange(false)}
              className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded"
            >
              Cancel
            </button>
            <button
              disabled={!canContinue || continuing}
              onClick={handleContinue}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
              title={continuingMessage ?? undefined}
            >
              {continuing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {continuingMessage ? 'Installing…' : 'Continue →'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}


interface DeploymentOptionProps {
  d: AuthoredDeployment;
  support: boolean | undefined;
  probing: boolean;
}

// Some component descriptions (esp. Dagster+ built-ins like
// DefsFolderComponent) are full multi-paragraph docstrings dumped
// as-is by introspection -- thousands of characters vs. the usual
// couple hundred. `line-clamp-2` alone doesn't reliably cap the row's
// rendered height for those outliers in every WebKit version, leaving
// a patch of blank space below a handful of rows where the browser
// reserves room for content it isn't actually painting. Hard-capping
// the character count before it ever reaches the DOM sidesteps that
// instead of depending on CSS clamping to behave the same everywhere.
function truncateDescription(text: string, max = 180): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max).trimEnd() + '…';
}

function producesLabel(p: Produces): string {
  const map: Record<Produces, string> = {
    asset: 'asset',
    multi_asset: 'multi-asset',
    asset_check: 'check',
    job: 'job',
    schedule: 'schedule',
    sensor: 'sensor',
    resource: 'resource',
    io_manager: 'io manager',
    partitions_def: 'partitions',
    other: 'other',
  };
  return map[p];
}

// Muted per-row chip (visible without being loud).
function producesTone(p: Produces): string {
  switch (p) {
    case 'schedule': return 'bg-indigo-50 text-indigo-700 border-indigo-200';
    case 'job':      return 'bg-sky-50 text-sky-700 border-sky-200';
    case 'asset':
    case 'multi_asset': return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'asset_check': return 'bg-rose-50 text-rose-700 border-rose-200';
    case 'sensor':   return 'bg-amber-50 text-amber-700 border-amber-200';
    case 'resource':
    case 'io_manager': return 'bg-purple-50 text-purple-700 border-purple-200';
    default: return 'bg-gray-100 text-gray-600 border-gray-200';
  }
}

// Slightly stronger tone for the filter chips when active.
function producesToneActive(p: Produces): string {
  switch (p) {
    case 'schedule': return 'bg-indigo-600 text-white border-indigo-700';
    case 'job':      return 'bg-sky-600 text-white border-sky-700';
    case 'asset':
    case 'multi_asset': return 'bg-emerald-600 text-white border-emerald-700';
    case 'asset_check': return 'bg-rose-600 text-white border-rose-700';
    case 'sensor':   return 'bg-amber-600 text-white border-amber-700';
    case 'resource':
    case 'io_manager': return 'bg-purple-600 text-white border-purple-700';
    default: return 'bg-gray-700 text-white border-gray-800';
  }
}


function DeploymentOption({ d, support, probing }: DeploymentOptionProps) {
  // Every deployment is selectable — authoring never touches the
  // running deployment directly, so "does this deployment have
  // app-managed types?" isn't a shipping gate, it's just a hint
  // about which type list we can populate. Deployments without
  // customer-declared app-managed types get the sandbox catalog only.
  const unsupported = support === false;
  const label = d.display_name + (unsupported ? ' · sandbox only' : '');
  const style: React.CSSProperties = unsupported
    ? { color: '#6b7280' }
    : support === undefined && probing
      ? { fontStyle: 'italic' }
      : {};
  return (
    <option value={d.name} style={style}>{label}</option>
  );
}
