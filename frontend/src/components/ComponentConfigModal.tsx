import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Save, Download, CheckCircle, XCircle, Loader, Plus, Sparkles, Image as ImageIcon } from 'lucide-react';
import { useComponent } from '@/hooks/useComponentRegistry';
import { TranslationEditor } from './TranslationEditor';
import { EnhancedDataQualityChecksBuilder } from './EnhancedDataQualityChecksBuilder';
import { useProjectStore } from '@/hooks/useProject';
import { dbtAdaptersApi, projectsApi, communityTemplatesApi, templatesApi, type AdapterInfo , API_BASE } from '@/services/api';
import { notify } from './Notifications';
import type { ComponentInstance } from '@/types';
import type { ComponentSchema } from '@/services/api';
import { parseUpstreamAssetKeys } from '@/lib/upstreamAssetKeys';
import { AGENTIC_PIPELINE_FAMILY } from '@/lib/agenticPipelineFamily';
import { DOCUMENT_EXTRACTOR_FAMILY } from '@/lib/documentExtractorFamily';
import { extractComponentId } from '@/lib/componentId';

// `x-dagster-io` type fields (inputs.type, outputs.type, accepts[]) are
// freeform strings community component authors write by hand, not a
// strict enum -- e.g. dataframe_to_braze declares its input type as
// "DataFrame | source" (mutually exclusive with a separate `source:`
// config) rather than the plain "dataframe" every other component uses.
// An exact-match check against "dataframe" silently fails on phrasing
// like that and disables filtering entirely rather than erroring, so
// swallowing that variety with a lenient substring match is safer than
// chasing every real-world phrasing as a special case.
function isDataFrameType(t: unknown): boolean {
  return typeof t === 'string' && t.toLowerCase().includes('dataframe');
}

// A component's single-asset identifier can be a plain string
// (asset_name convention, the common case) OR a list of path segments
// (some components -- confirmed live with a real SFTP-ingestion
// component -- declare `asset_key: ["raw", "player_tracking"]`, a
// multi-part Dagster AssetKey). Dagster's own string form for a
// multi-part key joins segments with "/", so that's what this returns --
// matching what project.graph.nodes' real introspected asset_key values
// look like, which is what custom-lineage/field-override targets must
// match exactly to resolve as a real asset instead of a dangling one.
function toAssetKeyString(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value;
  if (Array.isArray(value) && value.every((v) => typeof v === 'string') && value.length > 0) {
    return value.join('/');
  }
  return undefined;
}

interface ComponentConfigModalProps {
  component: ComponentInstance | null;
  componentType?: string; // For new components
  onSave: (component: ComponentInstance) => void;
  onClose: () => void;
  onOpenVisualEditor?: (upstreamAssetKey: string) => void;
  /* --- Draft-authoring extensions ---
     When Designer authors a component against a sandbox or customer
     Dagster+ location, the schema comes from that source (not from
     Designer's local registry) and the save path routes into our
     drafts/sandbox APIs instead of the local project mutation. */
  schemaOverride?: ComponentSchema | null;                  // skips the useComponent fetch
  initialAttributes?: Record<string, any>;                  // seeds formData for new authors
  mode?: 'local' | 'draft';                                 // gates local-project-only UI (translation, deps)
  /** For cloud drafts: assets registered in the target deployment+
   *  location. Overrides the default (which is scraped from the
   *  currently-hydrated project graph — wrong deployment). */
  availableAssetsOverride?: string[];
  /** Names of primitives registered in the target deployment+location.
   *  Powers `job_name` / `schedule_name` / `sensor_name` pickers. */
  availableJobs?: string[];
  availableSchedules?: string[];
  availableSensors?: string[];
  onSaveDraft?: (attributes: Record<string, any>) => Promise<void> | void;
  /** Offers an "Edit with Genie" escape hatch instead of the raw form,
   *  for the whole-pipeline family (agentic_pipeline & co.) whose config
   *  is deeply nested (steps/specialists/proposers) -- see
   *  AGENTIC_PIPELINE_FAMILY. Only rendered when this AND `component`
   *  (an existing instance, not a new one) are present; local mode only,
   *  same reasoning as onSaveDraft's absence gating draft-only UI. */
  onEditWithGenie?: (component: ComponentInstance) => void;
  /** Offers a "Review extractions" button for the document/image/audio
   *  extractor family (DOCUMENT_EXTRACTOR_FAMILY) -- opens
   *  DocumentExtractionReview showing this instance's own output asset
   *  (source file next to what got extracted from it). Same
   *  existing-instance-only gating as onEditWithGenie. */
  onReviewExtractions?: (component: ComponentInstance) => void;
  /** Fires right after a community component instance is successfully
   *  created/saved (configure POST + regenerate both succeeded), BEFORE
   *  onClose() -- lets a caller that nested this modal (e.g. a "+ Create
   *  new resource" flow inside another ComponentConfigModal) read back
   *  the new instance's attributes without waiting on a project reload.
   *  Community-component saves never call `onSave` (that's the built-in-
   *  component branch only), so this is the only hook available for that
   *  path. */
  onInstanceCreated?: (instance: { component_type: string; attributes: Record<string, any> }) => void;
}

export function ComponentConfigModal({
  component,
  componentType,
  onSave,
  onClose,
  onOpenVisualEditor,
  schemaOverride,
  initialAttributes,
  mode = 'local',
  availableAssetsOverride,
  availableJobs = [],
  availableSchedules = [],
  availableSensors = [],
  onSaveDraft,
  onEditWithGenie,
  onReviewExtractions,
  onInstanceCreated,
}: ComponentConfigModalProps) {
  const isNew = !component;
  const type = component?.component_type || componentType || '';
  const { currentProject, loadProject } = useProjectStore();
  const { data: fetchedSchema } = useComponent(type, currentProject?.id);
  // An override with no actual field definitions (e.g. AddComponentModal
  // couldn't resolve a live schema right after installing a community
  // component) shouldn't win over a real one this hook fetches — that's
  // the difference between "no configuration fields available" and a
  // working form. Only prefer the override when it actually has properties.
  const overrideHasFields = !!schemaOverride?.schema
    && Object.keys(schemaOverride.schema.properties ?? schemaOverride.schema).length > 0;
  const componentSchema = overrideHasFields ? schemaOverride : (fetchedSchema ?? schemaOverride);
  const isDraftMode = mode === 'draft';

  // A brand-new instance starts with formData = {} (or initialAttributes),
  // never the schema's own declared defaults -- so a field the user never
  // touches is simply absent from what gets saved, relying on the
  // component's Python-side default applying at runtime instead of being
  // explicit in the yaml. That's invisible for most fields, but breaks a
  // caller that reads the saved attributes back immediately (e.g. "+
  // Create new resource" below, which reads the new resource's
  // `resource_key` straight out of the save response to wire it into the
  // field that triggered the creation) -- seed documented defaults once
  // the schema loads, without clobbering anything the user already typed.
  useEffect(() => {
    if (!isNew || !componentSchema?.schema?.properties) return;
    const defaults: Record<string, any> = {};
    for (const [fieldName, fieldSchema] of Object.entries(componentSchema.schema.properties as Record<string, any>)) {
      if (fieldSchema && 'default' in fieldSchema && fieldSchema.default !== null && fieldSchema.default !== undefined) {
        defaults[fieldName] = fieldSchema.default;
      }
    }
    if (Object.keys(defaults).length === 0) return;
    setFormData((prev) => ({ ...defaults, ...prev }));
  }, [isNew, componentSchema]);

  console.log('[ComponentConfigModal] Opened with:', {
    isNew,
    type,
    hasComponent: !!component,
    hasComponentType: !!componentType,
    hasSchema: !!componentSchema,
    componentAttributes: component?.attributes,
    currentProjectId: currentProject?.id,
  });

  const [formData, setFormData] = useState<Record<string, any>>(
    component?.attributes || initialAttributes || {},
  );
  const [label, setLabel] = useState(component?.label || '');
  const [description, setDescription] = useState(component?.description || '');
  const [translation, setTranslation] = useState<Record<string, any>>(component?.translation || {});
  // Custom-lineage-backed "Dependencies" field -- the asset keys this
  // component's own asset currently depends on via project.custom_lineage
  // (not the component's own native upstream_asset_keys/left_asset_key/etc,
  // which only some component types even have). initialLineageDeps is the
  // baseline to diff against on save, so only the actual add/remove delta
  // hits the API instead of re-adding every existing edge every time.
  const [lineageDeps, setLineageDeps] = useState<string[]>([]);
  const [initialLineageDeps, setInitialLineageDeps] = useState<string[]>([]);
  // Universal "Common fields" (group_name/owners/tags), backed by the same
  // post_processing mechanism via asset_field_overrides -- see
  // AssetFieldOverridesRequest. Unlike Dependencies this is a single "set"
  // call (not an edge-by-edge add/remove diff), so only the current values
  // + whether they changed at all need tracking.
  const [commonGroupName, setCommonGroupName] = useState('');
  const [commonOwners, setCommonOwners] = useState('');
  const [commonTags, setCommonTags] = useState('');
  const [initialCommonFields, setInitialCommonFields] = useState({ groupName: '', owners: '', tags: '' });
  const [sqlMode, setSqlMode] = useState<'inline' | 'file'>('inline');
  const [instanceNameError, setInstanceNameError] = useState<string | null>(null);
  // Cache of {asset_key: {columns, dtypes}} for upstreams — powers the
  // column-picker dropdowns on `*_column` / `*_columns` fields so users
  // aren't guessing column names into a blank text box.
  const [knownSchemas, setKnownSchemas] = useState<Record<string, { columns: string[]; dtypes: Record<string, string> }>>({});
  // Per-destination structured credential sub-field values, for fields whose
  // schema declares `x-dagster-destination-fields` (e.g. a dlt ingestion's
  // `destination_credentials_url`). Keyed by the current `destination` value
  // so switching between e.g. snowflake/postgres and back doesn't lose what
  // was typed. These are assembled into the real target field's connection
  // string on every change -- see renderDestinationCredentialsField.
  const [destCredFieldValues, setDestCredFieldValues] = useState<Record<string, Record<string, string>>>({});
  // Whether a destination-credentials field (see renderDestinationCredentialsField)
  // is showing its structured sub-fields or a single "env var name" input.
  // Keyed by fieldName since there could in principle be more than one such
  // field. Undefined means "not yet toggled by the user" -- the initial mode
  // is then inferred from whichever of the two underlying fields already has
  // a value (so editing an existing env-var-based config doesn't silently
  // switch it to structured mode and blank the env var out from under it).
  const [credentialInputMode, setCredentialInputMode] = useState<Record<string, 'structured' | 'env_var'>>({});

  useEffect(() => {
    if (!currentProject) return;
    let cancelled = false;
    import('@/services/api').then((m) => {
      m.assetsApi.knownSchemas(currentProject.id).then((s) => {
        if (!cancelled) setKnownSchemas(s || {});
      }).catch(() => { /* cache empty is fine */ });
    });
    return () => { cancelled = true; };
  }, [currentProject?.id]);

  // DBT adapter state
  const [adapterInfo, setAdapterInfo] = useState<AdapterInfo[]>([]);
  const [loadingAdapterStatus, setLoadingAdapterStatus] = useState(false);
  const [installingAdapter, setInstallingAdapter] = useState<string | null>(null);

  // "+ Create new resource" from a `resource_key`-style field (see
  // renderField's top-level resource_key branch AND the `source` SQL
  // mode's nested "Warehouse resource" field below -- both use this same
  // flow). A callback (not a field name) so either site can wire the
  // result back wherever its value actually lives: handleFieldChange for
  // the top-level field, updateSource for the one nested inside `source`.
  // Once the user's picked a type from the catalog, creatingResourceType
  // holds the resolved component_type to point a nested
  // ComponentConfigModal at.
  const [creatingResourceCallback, setCreatingResourceCallback] = useState<((key: string) => void) | null>(null);
  const [creatingResourceType, setCreatingResourceType] = useState<string | null>(null);
  const [pickedResourceTemplateId, setPickedResourceTemplateId] = useState('');
  const [resolvingResourceType, setResolvingResourceType] = useState(false);
  // Community catalog's resource-category components (BrazeResourceComponent,
  // KlaviyoResourceComponent, ...) -- NOT the built-in registry, which has
  // no idea these exist. Powers the type picker shown after "+ Create new
  // resource".
  const { data: communityManifest } = useQuery({
    queryKey: ['community-templates-manifest'],
    queryFn: () => communityTemplatesApi.manifest(),
    staleTime: 5 * 60 * 1000,
  });
  const resourceTemplates = (communityManifest?.components || []).filter(
    (c) => c.category === 'resource'
  );

  // Resolves a catalog template id (e.g. "braze_resource") to the real,
  // dg-registered component_type string a ComponentConfigModal needs.
  // Reuses an already-installed instance's type if this project has one
  // (avoids a redundant CLI reinstall); otherwise installs the template
  // (attributes-free -- same "template only" install the Library palette
  // and Add Data dialog use) and reads the type back from the response.
  const resolveResourceComponentType = async (templateId: string) => {
    if (!currentProject) return;
    setResolvingResourceType(true);
    try {
      const installed = await templatesApi.getInstalled(currentProject.id);
      const existing = installed.components.find((c) => c.id === templateId);
      if (existing) {
        setCreatingResourceType(existing.component_type);
        return;
      }
      const response = await fetch(`${API_BASE}/templates/install-via-cli/${templateId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: currentProject.id, config: {}, template_only: true }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ detail: 'Unknown error' }));
        throw new Error(errorData.detail || 'Failed to install resource component');
      }
      const result = await response.json();
      setCreatingResourceType(result.component_type);
    } catch (e: any) {
      notify.error(`Failed to prepare resource type: ${e?.message || String(e)}`);
    } finally {
      setResolvingResourceType(false);
    }
  };

  // Check if this is a DBT component (not DuckDB or other components containing "db")
  // Match patterns like "dbt_project", "DbtProject", "dagster_dbt.X", but not "duckdb_table_writer"
  const isDbtComponent = /\bdbt[_\.]|^dbt/i.test(type);

  // A resource component's OWN `resource_key` field (e.g.
  // BrazeResourceComponent's) is a DECLARATION -- "what name do I
  // register myself under" (defaults like "braze", editable but usually
  // left alone) -- the opposite of a CONSUMER component's `resource_key`
  // (e.g. braze_sink's), which is a REFERENCE to an already-registered
  // resource elsewhere. Confirmed confusing live: creating a new
  // BrazeResourceComponent showed its own resource_key as a "pick an
  // existing resource / create new resource" picker, which is nonsense
  // while you're already inside that exact creation flow. Matches on the
  // class name (last dotted segment) since that's the one place "this is
  // a resource type" is reliably spelled out across both the live
  // dg-sourced schema (whose `category` field is hardcoded to "custom",
  // not the real one) and the community catalog's naming convention.
  const isResourceComponentType = /resource/i.test(type.split('.').pop() || '');

  // Assets for dependency + selection dropdowns. When authoring for a
  // Dagster+ deployment that isn't the project's hydrated one (e.g.
  // a branch deployment picked in AddComponentModal), the caller
  // supplies the deployment-scoped list via `availableAssetsOverride`.
  const availableAssets = availableAssetsOverride ?? (
    currentProject?.graph.nodes
      .filter((node: any) => node.node_kind === 'asset' || node.type === 'component')
      .map((node: any) => node.data.asset_key || node.data.label || node.id) || []
  );

  // This component instance's own asset key, for the custom-lineage
  // "Dependencies" field below -- only set when we can be CONFIDENT it
  // names exactly one real asset:
  //  - not new (a brand-new, unsaved component has no real asset key yet
  //    for other assets to depend ON, and custom lineage targeting a
  //    not-yet-existing asset would be a dangling edge -- confirmed
  //    directly to crash loading of the entire project)
  //  - not an asset-factory component (is_asset_factory: dbt/fivetran/
  //    sling/dlt/airbyte-style instances produce MANY assets from ONE
  //    component instance -- post_processing's `target:` resolves by
  //    individual asset key, not by component identity, confirmed
  //    directly with a multi_asset component, so there is no single
  //    "this component's asset key" for these; falling back to the
  //    component's instance id here would silently target a key that
  //    doesn't correspond to any real asset)
  //  - attributes.asset_name (or, for components using that convention
  //    instead, attributes.asset_key -- possibly multi-part, see
  //    toAssetKeyString) is actually present (the real conventions
  //    single-asset components in this codebase use) -- NOT a fallback to
  //    component.id, which is an instance id, not an asset key
  const assetName: string | undefined = (!isNew && !component?.is_asset_factory)
    ? toAssetKeyString(component?.attributes?.asset_name) ?? toAssetKeyString(component?.attributes?.asset_key)
    : undefined;

  // Field names the universal "Common fields" section owns when it's
  // shown -- suppresses the component's own schema-declared field of the
  // same name so there's only ever one input for group_name/owners/tags,
  // not two. Empty (so nothing is hidden) when Common fields itself isn't
  // shown -- e.g. a brand-new component still needs its own native field,
  // since there's nowhere else to set it yet.
  const commonFieldNames: Set<string> = (!isNew && mode === 'local' && assetName)
    ? new Set(['group_name', 'owners', 'tags'])
    : new Set();

  // Resource keys already configured in this project (from any component
  // whose own attributes declare one, e.g. duckdb_resource/snowflake_resource
  // instances) -- offered as autocomplete suggestions for a sink's
  // resource_key, since that's a plain string with no structural link back
  // to the resource component that registers it.
  const availableResourceKeys = Array.from(
    new Set(
      (currentProject?.components || [])
        .map((c: any) => c.attributes?.resource_key)
        .filter((k: any): k is string => typeof k === 'string' && k.length > 0)
    )
  );

  useEffect(() => {
    if (component) {
      const updatedFormData = { ...component.attributes };

      // Populate upstream_asset_keys from graph edges if not already set
      if (currentProject) {
        const componentNode = currentProject.graph.nodes.find(
          (n: any) => n.id === component.id || n.data.label === component.label
        );

        if (componentNode) {
          // Find all edges that target this component
          const incomingEdges = currentProject.graph.edges.filter(
            (edge: any) => edge.target === componentNode.id
          );

          // Extract source asset keys from incoming edges
          const upstreamKeys = incomingEdges.map((edge: any) => {
            const sourceNode = currentProject.graph.nodes.find((n: any) => n.id === edge.source);
            return sourceNode?.data?.asset_key || sourceNode?.data?.label || edge.source;
          }).filter(Boolean);

          // Only set upstream_asset_keys if there are upstream dependencies.
          // Kept as a real array (the schema type every component we've
          // seen declares it as) -- a `.join(', ')` here used to silently
          // turn a correctly-typed array from component.attributes into a
          // string, which (a) round-tripped back out as a string on Save,
          // undoing any earlier fix that made it a real array, and (b)
          // crashed the multi-select renderer below outright on the very
          // first render for any component whose upstream_asset_keys was
          // ALREADY a correct array (arrays have no .split()) -- confirmed
          // live as the cause of a blank/gray screen on opening this modal.
          if (upstreamKeys.length > 0) {
            updatedFormData.upstream_asset_keys = upstreamKeys;
            console.log('[ComponentConfigModal] Populated upstream_asset_keys from graph edges:', upstreamKeys);
          }
        }
      }

      setFormData(updatedFormData);
      setLabel(component.label || '');
      setDescription(component.description || '');
      setTranslation(component.translation || {});

      // Seed "Dependencies" from whatever custom lineage edges already
      // target this asset -- same is_asset_factory / real-asset_name-only
      // gating as `assetName` below, so this never seeds against a
      // component instance id that isn't actually a resolvable asset key.
      const existingAssetName = !component.is_asset_factory
        ? (toAssetKeyString(component.attributes?.asset_name) ?? toAssetKeyString(component.attributes?.asset_key))
        : undefined;
      const existingDeps = existingAssetName
        ? (currentProject?.custom_lineage || [])
            .filter((e: any) => e.target === existingAssetName)
            .map((e: any) => e.source)
        : [];
      setLineageDeps(existingDeps);
      setInitialLineageDeps(existingDeps);

      // Seed "Common fields" the same way -- group_name/owners/tags
      // overrides keyed by this same real asset key.
      const existingOverrides = existingAssetName
        ? (currentProject?.asset_field_overrides || {})[existingAssetName]
        : undefined;
      const seededGroupName = existingOverrides?.group_name || '';
      const seededOwners = (existingOverrides?.owners || []).join(', ');
      const seededTags = Object.entries(existingOverrides?.tags || {})
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      setCommonGroupName(seededGroupName);
      setCommonOwners(seededOwners);
      setCommonTags(seededTags);
      setInitialCommonFields({ groupName: seededGroupName, owners: seededOwners, tags: seededTags });

      // Initialize SQL mode based on existing value
      const sqlTemplate = component.attributes?.sql_template;
      if (typeof sqlTemplate === 'string' && !sqlTemplate.includes('\n') && sqlTemplate.endsWith('.sql')) {
        setSqlMode('file');
      } else {
        setSqlMode('inline');
      }
    }
  }, [component, currentProject]);

  // Fetch adapter status for dbt components
  useEffect(() => {
    const fetchAdapterStatus = async () => {
      if (!isDbtComponent || !currentProject) return;

      setLoadingAdapterStatus(true);
      try {
        const status = await dbtAdaptersApi.getStatus(currentProject.id);
        setAdapterInfo(status.adapters);
      } catch (error) {
        console.error('Failed to fetch adapter status:', error);
      } finally {
        setLoadingAdapterStatus(false);
      }
    };

    fetchAdapterStatus();
  }, [isDbtComponent, currentProject]);

  // Check if this is a single-asset component (has asset_name field)
  // Must calculate before using in hooks
  const hasSingleAssetField = componentSchema?.schema?.properties?.asset_name !== undefined;
  const isCommunityComponent = type.includes('.components.');

  // Auto-sync label with asset_name for single-asset community components
  useEffect(() => {
    if (!componentSchema) return;
    if (isCommunityComponent && hasSingleAssetField && formData.asset_name) {
      // Only auto-set if label is empty or matches the old asset_name
      if (!label || label === component?.attributes?.asset_name) {
        setLabel(formData.asset_name);
      }
    }
  }, [componentSchema, formData.asset_name, hasSingleAssetField, isCommunityComponent, label, component]);

  // Auto-suggest instance name for new multi-check components
  useEffect(() => {
    if (!componentSchema) return;
    console.log('[ComponentConfigModal] Instance name auto-generation check:', {
      isNew,
      isCommunityComponent,
      hasSingleAssetField,
      hasLabel: !!label,
      hasSchema: !!componentSchema,
      type
    });

    if (isNew && isCommunityComponent && !hasSingleAssetField && !label && componentSchema) {
      // Extract component_id from type for default name suggestion
      const parts = type.split('.');
      const componentsIndex = parts.indexOf('components');
      console.log('[ComponentConfigModal] Extracting component_id:', { parts, componentsIndex });

      if (componentsIndex !== -1 && componentsIndex + 1 < parts.length) {
        const componentId = parts[componentsIndex + 1];
        // Suggest name with timestamp for uniqueness
        const timestamp = new Date().getTime().toString().slice(-6);
        const suggestedName = `${componentId}_${timestamp}`;
        console.log('[ComponentConfigModal] Setting auto-generated instance name:', suggestedName);
        setLabel(suggestedName);
      }
    }
  }, [isNew, isCommunityComponent, hasSingleAssetField, componentSchema, type, label]);

  // Early return after all hooks have been called
  if (!componentSchema) {
    return null;
  }

  const handleInstallAdapter = async (adapterType: string) => {
    if (!currentProject) return;

    setInstallingAdapter(adapterType);
    try {
      const result = await dbtAdaptersApi.install(currentProject.id, adapterType);

      if (result.success) {
        notify.success(`Successfully installed dbt-${adapterType}!`);
        // Refresh adapter status
        const status = await dbtAdaptersApi.getStatus(currentProject.id);
        setAdapterInfo(status.adapters);
      } else {
        notify.error(`Failed to install dbt-${adapterType}:\n${result.message}\n\nCheck console for details.`);
        console.error('Installation failed:', result.stderr);
      }
    } catch (error) {
      console.error('Failed to install adapter:', error);
      notify.error('Failed to install adapter. Check console for details.');
    } finally {
      setInstallingAdapter(null);
    }
  };

  const validateRequiredFields = (): { valid: boolean; missing: string[] } => {
    const missing: string[] = [];
    const required = componentSchema.schema?.required || [];

    // For community components, instance name (label) is required UNLESS it's a single-asset component
    // (single-asset components auto-generate the instance name from asset_name)
    if (isCommunityComponent && !hasSingleAssetField && (!label || label.trim() === '')) {
      missing.push('Instance Name');
    }

    for (const fieldName of required) {
      const fieldValue = formData[fieldName];

      // Check if the field is missing or empty
      if (fieldValue === undefined || fieldValue === null || fieldValue === '') {
        missing.push(fieldName);
      } else if (typeof fieldValue === 'object' && !Array.isArray(fieldValue)) {
        // For nested objects, check if they have any values
        if (Object.keys(fieldValue).length === 0) {
          missing.push(fieldName);
        }
      }
    }

    // Special validation for assets field (enhanced data quality checks)
    // Check that all check configurations have a 'name' field
    if (formData.assets && typeof formData.assets === 'object') {
      for (const [assetKey, assetConfig] of Object.entries(formData.assets)) {
        if (typeof assetConfig === 'object' && assetConfig !== null) {
          // Check each check type (row_count_check, null_check, etc.)
          for (const [checkType, checks] of Object.entries(assetConfig)) {
            if (Array.isArray(checks)) {
              for (let i = 0; i < checks.length; i++) {
                const check = checks[i];
                if (typeof check === 'object' && (!check.name || check.name.trim() === '')) {
                  missing.push(`"${checkType}" check #${i + 1} for asset "${assetKey}" is missing a name`);
                }
              }
            }
          }
        }
      }
    }

    return { valid: missing.length === 0, missing };
  };

  // Validate instance name doesn't conflict with existing instances
  const validateInstanceName = async (instanceName: string): Promise<boolean> => {
    if (!currentProject || !instanceName) {
      return true; // Skip validation if no project or empty name
    }

    try {
      const parts = type.split('.');
      const componentsIndex = parts.indexOf('components');
      if (componentsIndex === -1 || componentsIndex + 1 >= parts.length) {
        return true; // Can't extract component_id, skip check
      }
      const componentId = parts[componentsIndex + 1];

      // Check if a folder with this instance name already exists
      const response = await fetch(
        `/api/v1/templates/check-instance/${currentProject.id}/${componentId}/${instanceName}`
      );

      if (response.ok) {
        const data = await response.json();
        if (data.exists && data.instance_name !== component?.label) {
          // Folder exists and it's not the current component being edited
          setInstanceNameError(`Instance "${instanceName}" already exists. Please choose a unique name.`);
          return false;
        }
      }

      setInstanceNameError(null);
      return true;
    } catch (error) {
      console.error('Failed to validate instance name:', error);
      // Don't block saving if validation fails
      setInstanceNameError(null);
      return true;
    }
  };

  // Applies the add/remove delta between initialLineageDeps and the
  // current lineageDeps selection via the custom-lineage endpoints, rather
  // than re-adding every existing edge on every save. Non-fatal: these are
  // a separate concern from the component's own attributes, so a failure
  // here surfaces a warning instead of blocking the rest of the save.
  const applyLineageDepsChanges = async () => {
    if (isNew || mode !== 'local' || !assetName || !currentProject) return;

    const added = lineageDeps.filter((d) => !initialLineageDeps.includes(d));
    const removed = initialLineageDeps.filter((d) => !lineageDeps.includes(d));
    if (added.length === 0 && removed.length === 0) return;

    try {
      for (const source of added) {
        await projectsApi.addCustomLineage(currentProject.id, source, assetName);
      }
      for (const source of removed) {
        await projectsApi.removeCustomLineage(currentProject.id, source, assetName);
      }
      await loadProject(currentProject.id);
    } catch (error: any) {
      notify.error(
        `Dependencies: ${error?.response?.data?.detail ?? error?.message ?? error}`
      );
    }
  };

  // Parses "key=value, key2=value2" into a tags dict. Blank/malformed
  // entries (no "=") are skipped rather than erroring -- this is a plain
  // text field, not a validated form.
  const parseTagsInput = (s: string): Record<string, string> => {
    const tags: Record<string, string> = {};
    for (const part of s.split(',')) {
      const trimmed = part.trim();
      if (!trimmed || !trimmed.includes('=')) continue;
      const [k, ...rest] = trimmed.split('=');
      const key = k.trim();
      if (key) tags[key] = rest.join('=').trim();
    }
    return tags;
  };

  const applyCommonFieldsChanges = async () => {
    if (isNew || mode !== 'local' || !assetName || !currentProject) return;
    const unchanged =
      commonGroupName === initialCommonFields.groupName &&
      commonOwners === initialCommonFields.owners &&
      commonTags === initialCommonFields.tags;
    if (unchanged) return;

    try {
      await projectsApi.setAssetFieldOverrides(currentProject.id, assetName, {
        group_name: commonGroupName.trim() || null,
        owners: commonOwners.trim() ? commonOwners.split(',').map((o) => o.trim()).filter(Boolean) : null,
        tags: commonTags.trim() ? parseTagsInput(commonTags) : null,
      });
      await loadProject(currentProject.id);
    } catch (error: any) {
      notify.error(
        `Common fields: ${error?.response?.data?.detail ?? error?.message ?? error}`
      );
    }
  };

  const handleSave = async () => {
    // Validate required fields
    const validation = validateRequiredFields();

    if (!validation.valid) {
      notify.error(
        `Please fill in all required fields before saving:\n\n` +
        validation.missing.map(f => `• ${f}`).join('\n')
      );
      return;
    }

    // Independent of the component's own attributes -- apply regardless
    // of which save path below runs.
    await applyLineageDepsChanges();
    await applyCommonFieldsChanges();

    // Draft-authoring short-circuit: bypass all local-project paths.
    // The caller (AddComponentModal via App.tsx) decides whether to
    // land the change in the drafts store or the sandbox filesystem.
    if (isDraftMode && onSaveDraft) {
      try {
        await onSaveDraft(formData);
        onClose();
      } catch (error: any) {
        notify.error(`Failed to save: ${error?.message || String(error)}`);
      }
      return;
    }

    // Check if this is a community component (installed from templates)
    // Community components have ".components." in their type path
    const isCommunityComponent = type.includes('.components.');

    if (isCommunityComponent && currentProject) {
      // Validate instance name doesn't conflict with existing instances
      if (isNew && !hasSingleAssetField) {
        const isValidName = await validateInstanceName(label);
        if (!isValidName) {
          return; // Validation failed, error message is already shown
        }
      }
      // For community components, update the YAML file via API
      try {
        // Extract component_id from type
        // e.g., "dagster_snowflake_dbt_demo.components.rest_api_fetcher.RestApiFetcherComponent" -> "rest_api_fetcher"
        const parts = type.split('.');
        const componentsIndex = parts.indexOf('components');
        if (componentsIndex === -1 || componentsIndex + 1 >= parts.length) {
          throw new Error('Invalid community component type');
        }
        const componentId = parts[componentsIndex + 1];

        // For single-asset components, always use asset_name as the instance name
        const instanceName = (isCommunityComponent && hasSingleAssetField && formData.asset_name)
          ? formData.asset_name
          : (label || componentId);

        const response = await fetch(`${API_BASE}/templates/configure/${componentId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: currentProject.id,
            config: {
              name: instanceName,
              ...formData
            }
          })
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ detail: 'Unknown error' }));
          throw new Error(errorData.detail || 'Failed to configure component');
        }

        const result = await response.json();

        // Reload the project and regenerate lineage to pick up the new asset
        console.log('[ComponentConfigModal] Reloading project and regenerating lineage after configuring community component');
        await loadProject(currentProject.id);

        // Automatically regenerate lineage so the new asset appears immediately
        try {
          const { projectsApi } = await import('@/services/api');
          await projectsApi.regenerateAssets(currentProject.id, true);
          console.log('[ComponentConfigModal] Lineage regenerated successfully');
        } catch (error) {
          console.error('[ComponentConfigModal] Failed to regenerate lineage:', error);
          // Don't fail the whole operation if regeneration fails
        }

        if (result.components_list_warning) {
          notify.warning(result.components_list_warning);
        }
        if (result.assets_regenerated) {
          notify.success(`Component configured successfully!\n\nYAML file: ${result.yaml_file}\n\nThe asset has been added to your project.`);
          onInstanceCreated?.({ component_type: type, attributes: formData });
          onClose();
        } else {
          // Dagster's real component loading (stricter than this form's
          // own validation) rejected it -- the backend already rolled
          // the defs.yaml write back rather than leave the whole project
          // unable to load. Leave the modal open so the user can fix the
          // config and save again.
          notify.error(
            `Not saved -- this would have broken the project's definitions (reverted automatically):\n\n${result.regenerate_error || 'Unknown error'}\n\nFix the fields above and save again.`
          );
        }
      } catch (error: any) {
        console.error('Error configuring community component:', error);
        notify.error(`Failed to configure component:\n\n${error.message}`);
      }
    } else {
      // For built-in components, use the standard save flow
      const newComponent: ComponentInstance = {
        id: component?.id || `comp-${Date.now()}`,
        component_type: type,
        type: type, // Add type field for App.tsx to check
        label: label || componentSchema.name,
        description: description || undefined,
        attributes: formData,
        translation: Object.keys(translation).length > 0 ? translation : undefined,
        is_asset_factory: ['dbt', 'fivetran', 'sling', 'dlt', 'airbyte'].some(
          (lib) => type.toLowerCase().includes(lib)
        ),
      };
      onSave(newComponent);
    }
  };

  const handleFieldChange = (field: string, value: any) => {
    setFormData((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const handleNestedFieldChange = (parentField: string, subField: string, value: any) => {
    setFormData((prev) => ({
      ...prev,
      [parentField]: {
        ...(prev[parentField] || {}),
        [subField]: value,
      },
    }));
  };

  const renderNestedField = (parentField: string, subField: string, fieldSchema: any, value: any) => {
    const fieldType = fieldSchema.type;

    if (fieldType === 'string') {
      if (fieldSchema.multiline) {
        return (
          <textarea
            value={value || ''}
            onChange={(e) => handleNestedFieldChange(parentField, subField, e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
            placeholder={fieldSchema.description || subField}
            rows={6}
          />
        );
      }

      return (
        <input
          type="text"
          value={value || ''}
          onChange={(e) => handleNestedFieldChange(parentField, subField, e.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder={fieldSchema.description || subField}
        />
      );
    }

    if (fieldType === 'array') {
      // Arrays of scalars → one item per line; arrays of objects → pretty
      // JSON so nested step configs (agentic_pipeline.steps, debate
      // proposers, etc.) render as editable YAML-ish text instead of
      // `[object Object]` — that's what value.join('\n') produces when
      // items are dicts.
      const hasObjects = Array.isArray(value) && value.some((v) => v !== null && typeof v === 'object');
      if (hasObjects) {
        return (
          <textarea
            value={Array.isArray(value) ? JSON.stringify(value, null, 2) : ''}
            onChange={(e) => {
              try {
                const parsed = JSON.parse(e.target.value);
                if (Array.isArray(parsed)) {
                  handleNestedFieldChange(parentField, subField, parsed);
                }
              } catch {
                // Invalid JSON, ignore — user is mid-edit
              }
            }}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
            placeholder="[]"
            rows={Math.min(20, Math.max(6, JSON.stringify(value ?? [], null, 2).split('\n').length))}
          />
        );
      }
      return (
        <textarea
          value={Array.isArray(value) ? value.join('\n') : ''}
          onChange={(e) =>
            handleNestedFieldChange(parentField, subField, e.target.value.split('\n').filter(Boolean))
          }
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
          placeholder="One item per line"
          rows={3}
        />
      );
    }

    if (fieldType === 'object') {
      return (
        <textarea
          value={typeof value === 'object' ? JSON.stringify(value, null, 2) : ''}
          onChange={(e) => {
            try {
              handleNestedFieldChange(parentField, subField, JSON.parse(e.target.value));
            } catch {
              // Invalid JSON, ignore
            }
          }}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
          placeholder="{}"
          rows={4}
        />
      );
    }

    return (
      <input
        type="text"
        value={value || ''}
        onChange={(e) => handleNestedFieldChange(parentField, subField, e.target.value)}
        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    );
  };

  // Enum inference — some community templates put the choice list only
  // in the description text ("fail, replace, or append") without
  // declaring enum. Match a comma-list-terminated-by-"or" pattern and
  // treat it as a dropdown fallback.
  const inferEnumFromDescription = (desc: string | undefined): string[] | null => {
    if (!desc) return null;
    const m = desc.match(/([\w-]+(?:\s*,\s*[\w-]+)+(?:\s*,?\s*or\s+[\w-]+))/i);
    if (!m) return null;
    const parts = m[1].split(/\s*,\s*|\s+or\s+/i).map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2 || parts.length > 12) return null;
    if (parts.some((p) => /\s/.test(p) || p.length > 24)) return null;
    return parts;
  };

  // Resolve which widget to render for a given field. Explicit
  // `x-dagster-widget` schema hint wins; otherwise fall back to a
  // name-based heuristic so common patterns (partition_date_column,
  // partition_start, sort_by, group_by) get sensible pickers even for
  // community templates that don't set the hint.
  const pickWidget = (fieldName: string, fieldSchema: any): 'column' | 'columns' | 'date' | 'cron' | 'asset-selection' | 'job' | 'schedule' | 'sensor' | 'default' => {
    const hint = (fieldSchema?.['x-dagster-widget'] || '').toString().toLowerCase();
    if (hint === 'column' || hint === 'column-single') return 'column';
    if (hint === 'columns' || hint === 'column-multi' || hint === 'column-list') return 'columns';
    if (hint === 'date' || hint === 'datetime') return 'date';
    if (hint === 'cron' || hint === 'crontab') return 'cron';
    if (hint === 'asset-selection' || hint === 'assetselection') return 'asset-selection';
    if (hint === 'job' || hint === 'job-name') return 'job';
    if (hint === 'schedule' || hint === 'schedule-name') return 'schedule';
    if (hint === 'sensor' || hint === 'sensor-name') return 'sensor';
    // NOTE: we deliberately do NOT auto-detect `job_name` / `schedule_name`
    // / `sensor_name` by field name. Those fields are ambiguous — they
    // might mean "existing primitive to target" (picker useful) or "new
    // primitive to create" (picker misleading — hides that the user's
    // job doesn't exist yet). Without a declared widget hint we can't
    // tell, so default to free text and let component authors opt in
    // via `x-dagster-widget: job` when the picker semantics are right.
    // Cron by name — freshness_cron / cron_schedule / any *_cron field.
    if (/cron|schedule/i.test(fieldName) && !/kind|type|display|_name$/i.test(fieldName)) return 'cron';
    // Asset selection — Dagster selection syntax field. Recognised on
    // both `asset_selection` and `selection` field names (community
    // components use both). Only kicks in when the schema type is a
    // string (array-shaped `deps`/`asset_selection` already renders
    // as a multi-select via the array branch below).
    if ((fieldName === 'asset_selection' || fieldName === 'selection') && fieldSchema?.type === 'string') {
      return 'asset-selection';
    }

    const lower = fieldName.toLowerCase();
    // Multi-column fields — plural, or names that clearly imply a list
    // (group_by, sort_by, columns_to_keep, partition_by, etc.).
    if (
      lower === 'columns' ||
      lower.endsWith('_columns') ||
      lower === 'group_by' ||
      lower === 'sort_by' ||
      lower === 'partition_by' ||
      lower === 'order_by' ||
      lower.endsWith('_columns_to_keep') ||
      lower.endsWith('_columns_to_drop')
    ) return 'columns';
    // Single-column fields.
    if (
      lower.endsWith('_column') ||
      lower.endsWith('_col') ||
      lower === 'column' ||
      lower === 'col'
    ) return 'column';
    // Date-ish fields.
    if (
      lower === 'partition_start' ||
      lower === 'partition_end' ||
      lower.endsWith('_date') ||
      lower.endsWith('_datetime') ||
      lower.endsWith('_timestamp') ||
      lower === 'start_date' ||
      lower === 'end_date'
    ) return 'date';
    return 'default';
  };

  // Return the union of columns available from every upstream asset the
  // form currently references. Read via `formData.upstream_asset_key(s)`
  // — supports both singular and plural, comma-separated. Falls back to
  // empty when nothing's connected yet.
  const upstreamColumnsForField = (): string[] => {
    const raw =
      formData['upstream_asset_keys'] ??
      formData['upstream_asset_key'] ??
      '';
    const keys = String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (keys.length === 0) return [];
    const cols = new Set<string>();
    for (const k of keys) {
      const schema = knownSchemas[k];
      if (schema?.columns) schema.columns.forEach((c) => cols.add(c));
    }
    return Array.from(cols);
  };

  // Assembles a destination's connection-string template (see
  // `x-dagster-destination-fields` in schema.json) from the structured
  // sub-field values the user typed. Falls back to a field's own `default`
  // when it's left blank (e.g. postgres' port), and only appends optional
  // query params that actually have a value so an empty `role`/`warehouse`
  // doesn't leave a dangling `&role=` in the URL.
  const assembleDestinationUrl = (option: any, values: Record<string, string>): string => {
    const getVal = (name: string) => {
      const v = values[name];
      if (v) return v;
      const f = (option.fields || []).find((x: any) => x.name === name);
      return f?.default || '';
    };
    let url = String(option.template?.base || '').replace(/\{(\w+)\}/g, (_: string, key: string) =>
      encodeURIComponent(getVal(key))
    );
    const queryParams = option.template?.query_params || {};
    const parts = Object.entries(queryParams)
      .map(([qkey, fieldName]) => [qkey, getVal(fieldName as string)] as [string, string])
      .filter(([, v]) => v)
      .map(([qkey, v]) => `${qkey}=${encodeURIComponent(v)}`);
    if (parts.length) url += (url.includes('?') ? '&' : '?') + parts.join('&');
    return url;
  };

  // Renders structured, destination-specific credential fields (Account/
  // Username/Password/... for Snowflake, Host/Port/... for Postgres, etc.)
  // instead of one opaque "paste a connection string" text box, for fields
  // whose schema declares `x-dagster-destination-fields`. Assembles them
  // into the real target field (e.g. destination_credentials_url) on every
  // keystroke, so the saved config is still just the one connection-string
  // field the component actually reads -- no component.py changes needed.
  // Destinations without a structured definition fall back to the plain
  // field exactly as before.
  const renderDestinationCredentialsField = (fieldName: string, fieldSchema: any, destFields: any) => {
    const destination = formData[destFields.trigger_field];
    const option = destination ? destFields.options?.[destination] : null;

    if (!option) {
      return (
        <>
          <label className="block text-sm font-medium text-gray-700 mb-1">{fieldName}</label>
          {fieldSchema.description && (
            <p className="text-xs text-gray-500 mb-1">{fieldSchema.description}</p>
          )}
          {renderField(fieldName, fieldSchema)}
        </>
      );
    }

    // destination_credentials_url and destination_credentials_env_var are
    // mutually exclusive on the component side -- it checks the URL first
    // and only falls back to the env var if the URL is empty (see
    // component.py's _resolve_destination). Showing both editable at once
    // let you fill in both and have one silently ignored with no indication
    // why. Make the choice explicit instead: one or the other, and switching
    // clears whichever isn't active so a save can never leave both set.
    const envVarField = destFields.related_env_var_field as string | undefined;
    const envVarFieldSchema = envVarField ? properties[envVarField] : undefined;
    const inferredMode: 'structured' | 'env_var' =
      envVarField && formData[envVarField] && !formData[fieldName] ? 'env_var' : 'structured';
    const mode = credentialInputMode[fieldName] ?? inferredMode;

    const switchMode = (next: 'structured' | 'env_var') => {
      setCredentialInputMode((prev) => ({ ...prev, [fieldName]: next }));
      if (next === 'env_var') {
        handleFieldChange(fieldName, '');
      } else if (envVarField) {
        handleFieldChange(envVarField, '');
        // Re-assemble from whatever's already been typed into the
        // structured sub-fields for this destination (state persists across
        // toggles) rather than leaving the target field blank until the
        // next keystroke -- switching back shouldn't silently drop
        // already-entered credentials.
        const existingValues = destCredFieldValues[destination] || {};
        handleFieldChange(fieldName, assembleDestinationUrl(option, existingValues));
      }
    };

    const destinationLabel = destination.charAt(0).toUpperCase() + destination.slice(1);

    if (mode === 'env_var' && envVarField) {
      return (
        <>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {envVarFieldSchema?.label || envVarField}
          </label>
          {envVarFieldSchema?.description && (
            <p className="text-xs text-gray-500 mb-1">{envVarFieldSchema.description}</p>
          )}
          {renderField(envVarField, envVarFieldSchema || { type: 'string' })}
          <button
            type="button"
            onClick={() => switchMode('structured')}
            className="text-xs text-blue-600 hover:text-blue-800 mt-1"
          >
            Enter {destinationLabel} credentials directly instead
          </button>
        </>
      );
    }

    // Some destinations (BigQuery confirmed via dlt's own
    // GcpServiceAccountCredentials.parse_native_representation, which
    // accepts a raw JSON string or file path as a native value) don't take
    // a connection-string URI at all -- their `credentials=` argument IS
    // the service-account JSON, used verbatim. Collecting it field-by-field
    // and reassembling via assembleDestinationUrl would be actively wrong
    // here: that helper calls encodeURIComponent on every value, which
    // would corrupt a private key's real embedded newlines/quotes into
    // percent-escapes, producing invalid JSON. A single textarea bound
    // straight to the target field, used as-is, is both simpler and the
    // only actually-correct option.
    if (option.credential_format === 'json_blob') {
      let parseError: string | null = null;
      const raw = formData[fieldName] || '';
      if (raw.trim()) {
        try { JSON.parse(raw); } catch { parseError = 'Not valid JSON'; }
      }
      return (
        <>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {destinationLabel} service account JSON
          </label>
          {option.description && (
            <p className="text-xs text-gray-500 mb-1">{option.description}</p>
          )}
          <textarea
            value={raw}
            onChange={(e) => handleFieldChange(fieldName, e.target.value)}
            placeholder={option.placeholder || '{ "type": "service_account", ... }'}
            rows={10}
            className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {parseError && (
            <p className="text-xs text-red-600 mt-1">{parseError}</p>
          )}
          {envVarField && (
            <button
              type="button"
              onClick={() => switchMode('env_var')}
              className="text-xs text-blue-600 hover:text-blue-800 mt-1"
            >
              Reference an environment variable instead
            </button>
          )}
        </>
      );
    }

    const values = destCredFieldValues[destination] || {};
    const updateSubField = (subName: string, value: string) => {
      const nextValues = { ...values, [subName]: value };
      setDestCredFieldValues((prev) => ({ ...prev, [destination]: nextValues }));
      handleFieldChange(fieldName, assembleDestinationUrl(option, nextValues));
    };

    return (
      <>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          {destinationLabel} credentials
        </label>
        <div className="space-y-3 pl-3 border-l-2 border-blue-200">
          {(option.fields || []).map((f: any) => (
            <div key={f.name}>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                {f.label}
                {f.required && <span className="text-red-500 ml-1">*</span>}
              </label>
              <input
                type={f.widget === 'password' ? 'password' : 'text'}
                value={values[f.name] || ''}
                onChange={(e) => updateSubField(f.name, e.target.value)}
                placeholder={f.description || f.default || f.label}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          ))}
        </div>
        <p className="text-xs text-gray-400 mt-2">
          Assembled into <code className="bg-gray-100 px-1 rounded">{fieldName}</code>.
        </p>
        {envVarField && (
          <button
            type="button"
            onClick={() => switchMode('env_var')}
            className="text-xs text-blue-600 hover:text-blue-800 mt-1"
          >
            Reference an environment variable instead
          </button>
        )}
      </>
    );
  };

  const renderField = (fieldName: string, fieldSchema: any) => {
    // Check if there's a display version of this field (e.g., project_path_display)
    const displayFieldName = `${fieldName}_display`;
    const hasDisplayVersion = displayFieldName in formData;
    const value = formData[fieldName] || '';
    const displayValue = hasDisplayVersion ? formData[displayFieldName] : value;
    const fieldType = fieldSchema.type;

    // Smart widget dispatch — happens BEFORE the plain-text fallback so
    // column-name fields don't drop back to a bare input.
    const widget = pickWidget(fieldName, fieldSchema);
    if (widget === 'column') {
      const cols = upstreamColumnsForField();
      if (cols.length > 0) {
        return (
          <select
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => handleFieldChange(fieldName, e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">— pick a column —</option>
            {cols.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        );
      }
      // No cached schema yet — fall through to the text input with a
      // helpful placeholder so the user can still type a column name.
    }
    if (widget === 'columns') {
      const cols = upstreamColumnsForField();
      if (cols.length > 0) {
        const selected = String(value)
          .split(',')
          .map((s: string) => s.trim())
          .filter(Boolean);
        // Write back in whatever shape the schema actually declares --
        // this widget is reused for many different fields (group_by,
        // sort_by, partition_by, order_by, *_columns, ...) across many
        // components, some of which schema this as `array` and some as a
        // comma-separated `string`. Always joining to a string used to
        // silently corrupt an array-typed field back into a string on
        // every edit (the same failure class as the upstream_asset_keys
        // incidents, just for this field family).
        const isArrayField = fieldType === 'array';
        const commit = (next: string[]) => handleFieldChange(fieldName, isArrayField ? next : next.join(', '));
        return (
          <div>
            <div className="flex flex-wrap gap-1 mb-1.5">
              {selected.map((c: string) => (
                <span key={c} className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-blue-50 border border-blue-200 rounded text-blue-700">
                  {c}
                  <button
                    type="button"
                    onClick={() => commit(selected.filter((x: string) => x !== c))}
                    className="hover:text-blue-900"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
            <select
              value=""
              onChange={(e) => {
                const c = e.target.value;
                if (!c || selected.includes(c)) return;
                commit([...selected, c]);
              }}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">+ add a column…</option>
              {cols.filter((c) => !selected.includes(c)).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
        );
      }
    }
    if (widget === 'date') {
      return (
        <input
          type="date"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => handleFieldChange(fieldName, e.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      );
    }
    if (widget === 'cron') {
      // Cron widget = text input with common presets + a link to a
      // human-readable interpretation via crontab.guru. No dependency
      // on a full parser — the user picks a preset or types their own.
      const presets: { label: string; value: string }[] = [
        { label: 'Every 15 min', value: '*/15 * * * *' },
        { label: 'Hourly', value: '0 * * * *' },
        { label: 'Daily 2am', value: '0 2 * * *' },
        { label: 'Weekdays 9am', value: '0 9 * * 1-5' },
        { label: 'Weekly Mon 6am', value: '0 6 * * 1' },
        { label: 'Monthly (1st 3am)', value: '0 3 1 * *' },
      ];
      const currentStr = typeof value === 'string' ? value : '';
      return (
        <div className="space-y-1">
          <input
            type="text"
            value={currentStr}
            onChange={(e) => handleFieldChange(fieldName, e.target.value)}
            placeholder="e.g. 0 9 * * 1-5"
            className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <div className="flex flex-wrap gap-1">
            {presets.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => handleFieldChange(fieldName, p.value)}
                className={`px-1.5 py-0.5 text-[10px] rounded border ${
                  currentStr === p.value
                    ? 'bg-primary/10 border-primary/40 text-primary'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
                title={p.value}
              >
                {p.label}
              </button>
            ))}
            {currentStr && (
              <a
                href={`https://crontab.guru/#${encodeURIComponent(currentStr.replace(/\s+/g, '_'))}`}
                target="_blank"
                rel="noreferrer"
                className="ml-auto text-[10px] text-blue-600 hover:underline"
              >
                explain ↗
              </a>
            )}
          </div>
        </div>
      );
    }

    if (widget === 'asset-selection') {
      // Dagster asset selection: a string parsed by the selection DSL
      // (`AssetSelection.from_string`). Multiple keys are joined with
      // ` or ` (the DSL's union operator) — NOT commas. `,` in a
      // selection string is a hard parse error.
      //
      // Tokenize on ` or ` first (canonical), then also split on `,`
      // as a legacy path so drafts stored under the old comma format
      // still render correctly.
      const currentStr = typeof value === 'string' ? value : '';
      const tokens = currentStr
        .split(/\s+or\s+|,/)
        .map((s) => s.trim())
        .filter(Boolean);
      const tokenSet = new Set(tokens);
      const remaining = availableAssets.filter((a: string) => !tokenSet.has(a));
      const joinTokens = (ts: string[]) => ts.join(' or ');
      return (
        <div className="space-y-2">
          <input
            type="text"
            value={currentStr}
            onChange={(e) => handleFieldChange(fieldName, e.target.value)}
            placeholder="e.g. * — or key:my_asset or group:analytics or +downstream_of*"
            className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {tokens.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {tokens.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-blue-50 border border-blue-200 rounded text-blue-700"
                >
                  {t}
                  <button
                    type="button"
                    onClick={() => handleFieldChange(fieldName, joinTokens(tokens.filter((x) => x !== t)))}
                    className="hover:text-blue-900"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          {availableAssets.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                const k = e.target.value;
                if (!k || tokenSet.has(k)) return;
                handleFieldChange(fieldName, joinTokens([...tokens, k]));
              }}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              <option value="">
                + add asset ({remaining.length} available)…
              </option>
              {remaining.map((k: string) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          )}
          <p className="text-xs text-gray-500">
            Dagster selection syntax: multi-key = <code>a or b or c</code>;
            operators: <code>*</code>, <code>key:name</code>, <code>group:g</code>,
            <code>tag:k=v</code>, <code>+asset</code> (downstream), <code>asset+</code> (upstream).
          </p>
        </div>
      );
    }

    if (widget === 'job' || widget === 'schedule' || widget === 'sensor') {
      // Single-select picker for primitive names + a free-form input
      // so authors can also type a name that doesn't exist yet (useful
      // when a component *creates* a new job / schedule / sensor with
      // this attribute controlling the name).
      const options =
        widget === 'job' ? availableJobs :
        widget === 'schedule' ? availableSchedules :
        availableSensors;
      const label =
        widget === 'job' ? 'job' :
        widget === 'schedule' ? 'schedule' :
        'sensor';
      const currentStr = typeof value === 'string' ? value : '';
      return (
        <div className="space-y-1">
          <input
            type="text"
            value={currentStr}
            onChange={(e) => handleFieldChange(fieldName, e.target.value)}
            placeholder={`e.g. ${options[0] ?? `existing_${label}_name_or_new_${label}_name`}`}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {options.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) handleFieldChange(fieldName, e.target.value);
              }}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              <option value="">
                pick from {options.length} existing {label}{options.length === 1 ? '' : 's'} in the target deployment…
              </option>
              {options.map((n: string) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          )}
          <p className="text-xs text-gray-500">
            Existing {label} name (component targets it) or a new one (component creates it). The
            list reflects what's registered in the target deployment + location right now.
          </p>
        </div>
      );
    }

    console.log('[ComponentConfigModal] Rendering field:', fieldName, 'type:', fieldType, 'has properties:', !!fieldSchema.properties, 'hasDisplayVersion:', hasDisplayVersion);

    // Special handling for sql_template field - allow choosing between inline SQL or file path
    if (fieldName === 'sql_template') {
      return (
        <div className="space-y-2">
          <div className="flex items-center space-x-4 mb-2">
            <label className="flex items-center space-x-2 cursor-pointer">
              <input
                type="radio"
                checked={sqlMode === 'inline'}
                onChange={() => {
                  setSqlMode('inline');
                  if (typeof value === 'string' && value.endsWith('.sql')) {
                    handleFieldChange(fieldName, '');
                  }
                }}
                className="w-4 h-4 text-blue-600"
              />
              <span className="text-sm text-gray-700">Inline SQL</span>
            </label>
            <label className="flex items-center space-x-2 cursor-pointer">
              <input
                type="radio"
                checked={sqlMode === 'file'}
                onChange={() => {
                  setSqlMode('file');
                  handleFieldChange(fieldName, '');
                }}
                className="w-4 h-4 text-blue-600"
              />
              <span className="text-sm text-gray-700">SQL File Path</span>
            </label>
          </div>

          {sqlMode === 'inline' ? (
            <textarea
              value={typeof value === 'string' ? value : ''}
              onChange={(e) => handleFieldChange(fieldName, e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              placeholder="SELECT * FROM my_table WHERE ..."
              rows={10}
            />
          ) : (
            <input
              type="text"
              value={typeof value === 'string' ? value : ''}
              onChange={(e) => handleFieldChange(fieldName, e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="queries/my_query.sql"
            />
          )}
          <p className="text-xs text-gray-500">
            {sqlMode === 'inline'
              ? 'Write your SQL query directly (supports Jinja2 templating)'
              : 'Path to SQL file relative to project root'}
          </p>
        </div>
      );
    }

    // Special handling for a top-level `resource_key` field -- the
    // established reverse_etl/ingestion convention for "which registered
    // resource provides this destination's auth" (e.g. braze_sink's
    // resource_key referencing a BrazeResourceComponent instance).
    // Previously a plain text input: no indication of which resources
    // already exist in the project, no way to tell it apart from the
    // SEPARATE `source.resource_key` (warehouse connection, handled in
    // the `source` block below) other than reading the description
    // closely. `availableResourceKeys` already aggregates every
    // component in the project that declares its own `resource_key`
    // attribute (how a resource component registers itself), so this is
    // a real picker, not a guess. Placed here (before the generic
    // `fieldType === 'string'` fallback below) -- it was previously
    // positioned AFTER that fallback, which is a plain string type and
    // so intercepted every resource_key field first, exactly the same
    // ordering mistake the `source` field special case had.
    if (fieldName === 'resource_key' && fieldType !== 'object' && !isResourceComponentType) {
      return (
        <div className="space-y-1.5">
          <select
            value={value || ''}
            onChange={(e) => handleFieldChange(fieldName, e.target.value)}
            className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Select a resource...</option>
            {/* The current value might not be in availableResourceKeys (e.g.
                its resource instance was deleted, or hasn't loaded into the
                project yet) -- show it anyway so editing an existing
                instance never looks like its value silently vanished. */}
            {value && !availableResourceKeys.includes(value) && (
              <option value={value}>{value} (not found in project)</option>
            )}
            {availableResourceKeys.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
          {availableResourceKeys.length === 0 && (
            <p className="text-xs text-amber-600">
              No resources configured in this project yet.
            </p>
          )}
          <button
            type="button"
            onClick={() => { setCreatingResourceCallback(() => (key: string) => handleFieldChange(fieldName, key)); setCreatingResourceType(null); }}
            className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
          >
            <Plus className="w-3 h-3" />
            Create new resource
          </button>
        </div>
      );
    }

    // Same idea as the upstream_asset_keys case below, but for the many
    // single-input community components (mostly "transformation" category
    // — R Script, Outlier Clipper, and dozens more) that take exactly one
    // upstream DataFrame and so declare a singular `upstream_asset_key`
    // field instead of a plural one. Without this it fell through to a
    // plain text box with no indication of what a valid value even looks
    // like.
    if (fieldName === 'upstream_asset_key') {
      const acceptsDataFrames = isDataFrameType(componentSchema?.schema?.['x-dagster-io']?.inputs?.type) ||
                                 (componentSchema?.schema?.['x-dagster-io']?.inputs?.accepts || []).some(isDataFrameType);

      let filteredAssets = availableAssets;
      if (acceptsDataFrames) {
        // io_output_type comes straight from the producing component's own
        // x-dagster-io.outputs.type schema field (see
        // asset_introspection_service.py) -- the actual declared contract,
        // not a guess. A hardcoded list of component_type substrings used
        // to stand in here, but that can only ever recognize the exact
        // component types someone thought to list, and (worse) silently
        // treats everything else — including dbt models, which produce
        // database tables, not DataFrames — as unfiltered, so they show up
        // as valid inputs even though they aren't.
        filteredAssets = availableAssets.filter((assetKey: string) => {
          const assetNode = currentProject?.graph.nodes.find(
            (n: any) => (n.data.asset_key === assetKey || n.data.label === assetKey || n.id === assetKey)
          );
          return isDataFrameType(assetNode?.data.io_output_type);
        });
      }

      return (
        <div className="space-y-1">
          <select
            value={value || ''}
            onChange={(e) => handleFieldChange(fieldName, e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Select an asset…</option>
            {filteredAssets.map((assetKey: string) => (
              <option key={assetKey} value={assetKey}>
                {assetKey}
              </option>
            ))}
          </select>
          {filteredAssets.length === 0 && (
            <p className="text-xs text-gray-500">
              {acceptsDataFrames
                ? 'No DataFrame-producing assets available. Add a data source component first.'
                : 'No assets available'}
            </p>
          )}
        </div>
      );
    }

    // Special handling for upstream_asset_keys - show multi-select dropdown filtered by output type
    if (fieldName === 'upstream_asset_keys') {
      // See parseUpstreamAssetKeys -- accepts either a real array (the
      // schema type every component we've seen declares) or a legacy
      // comma-separated string.
      const selectedValues = parseUpstreamAssetKeys(value);

      // Check if component only accepts DataFrame inputs
      const acceptsDataFrames = isDataFrameType(componentSchema?.schema?.['x-dagster-io']?.inputs?.type) ||
                                 (componentSchema?.schema?.['x-dagster-io']?.inputs?.accepts || []).some(isDataFrameType);

      // Filter available assets based on what the component accepts.
      // io_output_type is the producing component's own declared
      // x-dagster-io.outputs.type (see asset_introspection_service.py) --
      // the real contract, not a guess from a hardcoded list of
      // component_type substrings (which used to live here, and which
      // couldn't tell a dbt model -- a database table, not a DataFrame --
      // from an actual DataFrame producer).
      let filteredAssets = availableAssets;
      if (acceptsDataFrames) {
        filteredAssets = availableAssets.filter((assetKey: string) => {
          const assetNode = currentProject?.graph.nodes.find(
            (n: any) => (n.data.asset_key === assetKey || n.data.label === assetKey || n.id === assetKey)
          );
          return isDataFrameType(assetNode?.data.io_output_type);
        });
      }

      return (
        <div className="space-y-2">
          <select
            multiple
            value={selectedValues}
            onChange={(e) => {
              const selected = Array.from(e.target.selectedOptions, (option) => option.value);
              // Keep as a real array -- the schema type this field
              // actually declares (see the parse comment above).
              handleFieldChange(fieldName, selected);
            }}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            size={Math.min(6, Math.max(3, filteredAssets.length))}
          >
            {filteredAssets.length === 0 ? (
              <option disabled>
                {acceptsDataFrames
                  ? 'No DataFrame-producing assets available. Add a data source component first.'
                  : 'No assets available'}
              </option>
            ) : (
              filteredAssets.map((assetKey: string) => (
                <option key={assetKey} value={assetKey}>
                  {assetKey}
                </option>
              ))
            )}
          </select>
          <p className="text-xs text-gray-500">
            {acceptsDataFrames
              ? 'Hold Cmd/Ctrl to select multiple DataFrame assets. Only showing assets that output DataFrames.'
              : 'Hold Cmd/Ctrl to select multiple assets'}
          </p>
          {selectedValues.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {selectedValues.map((assetKey: string) => (
                <span
                  key={assetKey}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-blue-50 border border-blue-200 rounded text-blue-700"
                >
                  {assetKey}
                  <button
                    onClick={() => {
                      const newSelected = selectedValues.filter((k: string) => k !== assetKey);
                      handleFieldChange(fieldName, newSelected);
                    }}
                    className="hover:text-blue-900"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      );
    }

    // Check if field has enum values - render as dropdown. If not
    // declared, try to infer from a description like "fail, replace, or
    // append" — community templates often put the choice list only in
    // the description text.
    const declaredEnum: string[] | undefined = fieldSchema.enum && Array.isArray(fieldSchema.enum) && fieldSchema.enum.length > 0
      ? fieldSchema.enum
      : undefined;
    const inferredEnum = declaredEnum ? null : inferEnumFromDescription(fieldSchema.description);
    const enumValues = declaredEnum ?? inferredEnum;
    if (enumValues && enumValues.length > 0) {
      return (
        <select
          value={value || ''}
          onChange={(e) => handleFieldChange(fieldName, e.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
        >
          <option value="">Select {fieldName}...</option>
          {enumValues.map((option: string) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    }

    if (fieldType === 'string') {
      // Check if this is a multiline field (like code)
      if (fieldSchema.multiline) {
        return (
          <textarea
            value={displayValue}
            onChange={(e) => handleFieldChange(fieldName, e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
            placeholder={fieldSchema.description || fieldName}
            rows={10}
          />
        );
      }

      // For column-picker fields where we haven't cached a schema yet,
      // hint the user in the placeholder so they know they can preview
      // the upstream to unlock a proper dropdown.
      const columnWidget = widget === 'column' || widget === 'columns';
      const placeholder = columnWidget
        ? (widget === 'columns' ? 'e.g. col_a, col_b (preview upstream to enable dropdown)' : 'e.g. my_column (preview upstream to enable dropdown)')
        : (fieldSchema.description || fieldName);

      // No cached upstream schema yet (so the chip-picker above bailed
      // out), but the field is still array-typed -- parse the typed
      // comma-separated text before writing back instead of the plain
      // fallback's raw-string write, which would corrupt an array-typed
      // field the same way the chip-picker used to.
      if (widget === 'columns' && fieldType === 'array') {
        const displayText = Array.isArray(value) ? value.join(', ') : (typeof value === 'string' ? value : '');
        return (
          <input
            type="text"
            value={displayText}
            onChange={(e) => handleFieldChange(
              fieldName,
              e.target.value.split(',').map((s) => s.trim()).filter(Boolean)
            )}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder={placeholder}
          />
        );
      }

      return (
        <input
          type="text"
          value={displayValue}
          onChange={(e) => handleFieldChange(fieldName, e.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder={placeholder}
          readOnly={hasDisplayVersion}
          title={hasDisplayVersion ? `Actual path: ${value}` : undefined}
        />
      );
    }

    if (fieldType === 'number' || fieldType === 'integer') {
      return (
        <input
          type="number"
          value={value}
          onChange={(e) => handleFieldChange(fieldName, parseFloat(e.target.value))}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder={fieldSchema.description || fieldName}
        />
      );
    }

    if (fieldType === 'boolean') {
      return (
        <label className="flex items-center space-x-2 cursor-pointer">
          <input
            type="checkbox"
            checked={value || false}
            onChange={(e) => handleFieldChange(fieldName, e.target.checked)}
            className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
          />
          <span className="text-sm text-gray-700">
            {fieldSchema.description || 'Enable'}
          </span>
        </label>
      );
    }

    if (fieldType === 'array') {
      // Special handling for `sinks` (array of {kind, resource_key, table,
      // schema, if_exists, mode, match} objects, per the sinks-capable
      // components -- rest_api_fetcher, dataframe_from_csv, database_query,
      // okta_system_log_ingestion, redis_reader). The generic array
      // renderer below (join('\n')/split('\n')) is built for string lists
      // and silently corrupts an array of objects -- editing would show
      // literal "[object Object]" text and turn every sink into a plain
      // string on save. Render real per-sink fields instead.
      if (fieldName === 'sinks' && fieldSchema.items?.type === 'object') {
        const sinksList: any[] = Array.isArray(value) ? value : [];
        const updateSink = (index: number, patch: Record<string, any>) => {
          const next = sinksList.map((s, i) => (i === index ? { ...s, ...patch } : s));
          handleFieldChange(fieldName, next);
        };
        const removeSink = (index: number) => {
          handleFieldChange(fieldName, sinksList.filter((_, i) => i !== index));
        };
        const addSink = () => {
          handleFieldChange(fieldName, [
            ...sinksList,
            { kind: 'table', resource_key: '', table: '', if_exists: 'append' },
          ]);
        };

        return (
          <div className="space-y-3">
            {sinksList.length === 0 && (
              <p className="text-xs text-gray-500">
                No sinks configured — the asset just returns its DataFrame.
              </p>
            )}
            {sinksList.map((sink, index) => (
              <div key={index} className="border border-gray-200 rounded-md p-3 space-y-2 bg-gray-50">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-700">Sink {index + 1}</span>
                  <button
                    type="button"
                    onClick={() => removeSink(index)}
                    className="text-gray-400 hover:text-red-600"
                    title="Remove sink"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Resource Key <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    list={`sink-resource-keys-${index}`}
                    value={sink.resource_key || ''}
                    onChange={(e) => updateSink(index, { resource_key: e.target.value })}
                    placeholder="e.g. snowflake_resource"
                    className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <datalist id={`sink-resource-keys-${index}`}>
                    {availableResourceKeys.map((k) => (
                      <option key={k} value={k} />
                    ))}
                  </datalist>
                  {availableResourceKeys.length === 0 && (
                    <p className="text-xs text-gray-400 mt-0.5">
                      Must match the resource_key of a resource component instance
                      already configured in this project (e.g. snowflake_resource).
                    </p>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      Table <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={sink.table || ''}
                      onChange={(e) => updateSink(index, { table: e.target.value })}
                      placeholder="destination_table"
                      className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Schema</label>
                    <input
                      type="text"
                      value={sink.schema || ''}
                      onChange={(e) => updateSink(index, { schema: e.target.value || undefined })}
                      placeholder="(optional)"
                      className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">If Exists</label>
                    <select
                      value={sink.if_exists || 'append'}
                      onChange={(e) => updateSink(index, { if_exists: e.target.value })}
                      className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                    >
                      <option value="append">append</option>
                      <option value="replace">replace</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Mode</label>
                    <select
                      value={sink.mode || ''}
                      onChange={(e) => {
                        const mode = e.target.value || undefined;
                        updateSink(index, mode ? { mode } : { mode: undefined });
                      }}
                      className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                    >
                      <option value="">(none — plain append/replace)</option>
                      <option value="upsert_on_match">upsert_on_match</option>
                    </select>
                  </div>
                </div>
                {sink.mode === 'upsert_on_match' && (
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      Match Columns <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={Array.isArray(sink.match) ? sink.match.join(', ') : ''}
                      onChange={(e) =>
                        updateSink(index, {
                          match: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                        })
                      }
                      placeholder="id, partition_date"
                      className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <p className="text-xs text-gray-400 mt-0.5">
                      Comma-separated column names used to match existing rows before
                      delete + insert (partition-rewrite idempotency).
                    </p>
                  </div>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={addSink}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-blue-600 border border-blue-200 rounded-md hover:bg-blue-50"
            >
              <Plus className="w-3.5 h-3.5" />
              Add sink
            </button>
          </div>
        );
      }

      // Special handling for deps and asset_selection fields - show multi-select dropdown
      if (fieldName === 'deps' || fieldName === 'asset_selection') {
        const selectedValues = Array.isArray(value) ? value : [];

        return (
          <div className="space-y-2">
            <select
              multiple
              value={selectedValues}
              onChange={(e) => {
                const selected = Array.from(e.target.selectedOptions, (option) => option.value);
                handleFieldChange(fieldName, selected);
              }}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              size={Math.min(6, Math.max(3, availableAssets.length))}
            >
              {availableAssets.map((assetKey: string) => (
                <option key={assetKey} value={assetKey}>
                  {assetKey}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500">
              Hold Cmd/Ctrl to select multiple assets
            </p>
            {selectedValues.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {selectedValues.map((dep: string) => (
                  <span
                    key={dep}
                    className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-blue-50 border border-blue-200 rounded text-blue-700"
                  >
                    {dep}
                    <button
                      onClick={() => {
                        handleFieldChange(
                          fieldName,
                          selectedValues.filter((d: string) => d !== dep)
                        );
                      }}
                      className="hover:text-blue-900"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      }

      // Default array rendering for other fields. Same object-vs-scalar
      // split as the nested-field variant above — objects need JSON so
      // they don't render as `[object Object]`.
      const topLevelHasObjects = Array.isArray(value) && value.some((v) => v !== null && typeof v === 'object');
      if (topLevelHasObjects) {
        return (
          <textarea
            value={Array.isArray(value) ? JSON.stringify(value, null, 2) : ''}
            onChange={(e) => {
              try {
                const parsed = JSON.parse(e.target.value);
                if (Array.isArray(parsed)) {
                  handleFieldChange(fieldName, parsed);
                }
              } catch {
                // Invalid JSON, ignore — user is mid-edit
              }
            }}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
            placeholder="[]"
            rows={Math.min(30, Math.max(8, JSON.stringify(value ?? [], null, 2).split('\n').length))}
          />
        );
      }
      return (
        <textarea
          value={Array.isArray(value) ? value.join('\n') : ''}
          onChange={(e) =>
            handleFieldChange(fieldName, e.target.value.split('\n').filter(Boolean))
          }
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
          placeholder="One item per line"
          rows={4}
        />
      );
    }

    // Special handling for the reverse-ETL "polymorphic source" field --
    // the established shape across the community reverse_etl catalog
    // (confirmed: ~60 of 60 components share it): mutually exclusive
    // with an `upstream_asset_key`-style field, taking exactly one of
    // {kind: sql, resource_key|database_url_env_var, query},
    // {kind: csv, path}, {kind: inline, rows}. Previously fell through
    // to a raw JSON textarea -- no resource picker, no SQL editor, no
    // indication of which shape is expected. (Was briefly miswired
    // inside the `fieldType === 'array'` block above, where it was dead
    // code for this object-typed field -- confirmed live via browser
    // console logging that fieldType really is 'object' here, so this
    // top-level placement is the fix.)
    if (fieldName === 'source' && fieldType === 'object') {
      const sourceValue: Record<string, any> = (value && typeof value === 'object') ? value : {};
      const hasUpstreamAssetKey = properties.upstream_asset_key !== undefined;
      const upstreamAssetKeyValue: string = formData['upstream_asset_key'] || '';
      // Unified mode: 'upstream_asset' sits alongside sql/csv/inline as a
      // 4th option on the SAME dropdown, since upstream_asset_key and
      // source are mutually exclusive across the whole reverse_etl
      // catalog -- previously these rendered as two separate, unrelated
      // fields with no indication of that relationship. Default to
      // upstream_asset on a fresh add (no value in either field yet):
      // "connect to another asset" is the simpler, more common start
      // than an empty SQL editor.
      const kind = hasUpstreamAssetKey && upstreamAssetKeyValue
        ? 'upstream_asset'
        : (sourceValue.kind || (hasUpstreamAssetKey ? 'upstream_asset' : 'sql'));
      // A presence check, not a truthiness check -- the radio toggle
      // below sets database_url_env_var to '' (not undefined) when
      // first switched to, so an empty-string value must still mean
      // "env var mode, not yet typed" rather than falling back to
      // "resource mode" on every re-render until a character is typed.
      const connectionMode = sourceValue.database_url_env_var !== undefined ? 'env_var' : 'resource';

      const updateSource = (patch: Record<string, any>) => {
        handleFieldChange(fieldName, { ...sourceValue, ...patch });
      };

      return (
        <div className="space-y-2 border border-gray-200 rounded-md p-3 bg-gray-50">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Source kind</label>
            <select
              value={kind}
              onChange={(e) => {
                const newKind = e.target.value;
                if (newKind === 'upstream_asset') {
                  // Switching INTO upstream-asset mode: clear `source`
                  // entirely so a stale sql/csv/inline shape doesn't
                  // linger alongside it (the component raises if both
                  // are set).
                  handleFieldChange('source', undefined);
                  handleFieldChange('upstream_asset_key', upstreamAssetKeyValue);
                  return;
                }
                if (hasUpstreamAssetKey) handleFieldChange('upstream_asset_key', undefined);
                // A full replace, not a merge (updateSource merges) --
                // dropping the old shape's fields avoids sending e.g. a
                // stale `query` alongside a csv `path`.
                handleFieldChange(fieldName, { kind: newKind });
              }}
              className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {hasUpstreamAssetKey && (
                <option value="upstream_asset">Upstream Dagster asset (DataFrame)</option>
              )}
              <option value="sql">SQL query (resource or connection string)</option>
              <option value="csv">CSV file</option>
              <option value="inline">Inline rows</option>
            </select>
          </div>

          {kind === 'upstream_asset' && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Upstream asset</label>
              <select
                value={upstreamAssetKeyValue}
                onChange={(e) => handleFieldChange('upstream_asset_key', e.target.value)}
                className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="" disabled>Select an asset...</option>
                {availableAssets.map((assetKey: string) => (
                  <option key={assetKey} value={assetKey}>{assetKey}</option>
                ))}
              </select>
            </div>
          )}

          {kind === 'sql' && (
            <>
              <div className="flex gap-3 text-xs text-gray-600">
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    checked={connectionMode === 'resource'}
                    onChange={() => updateSource({ database_url_env_var: undefined })}
                  />
                  Dagster resource
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    checked={connectionMode === 'env_var'}
                    onChange={() => updateSource({ resource_key: undefined, database_url_env_var: sourceValue.database_url_env_var || '' })}
                  />
                  Connection string (env var)
                </label>
              </div>
              {connectionMode === 'resource' ? (
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Warehouse resource</label>
                  <select
                    value={sourceValue.resource_key || ''}
                    onChange={(e) => updateSource({ resource_key: e.target.value })}
                    className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">Select a resource...</option>
                    {sourceValue.resource_key && !availableResourceKeys.includes(sourceValue.resource_key) && (
                      <option value={sourceValue.resource_key}>{sourceValue.resource_key} (not found in project)</option>
                    )}
                    {availableResourceKeys.map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                  {availableResourceKeys.length === 0 && (
                    <p className="text-xs text-amber-600">
                      No resources configured in this project yet.
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => { setCreatingResourceCallback(() => (key: string) => updateSource({ resource_key: key })); setCreatingResourceType(null); }}
                    className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
                  >
                    <Plus className="w-3 h-3" />
                    Create new resource
                  </button>
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Env var holding the connection URL</label>
                  <input
                    type="text"
                    value={sourceValue.database_url_env_var || ''}
                    onChange={(e) => updateSource({ database_url_env_var: e.target.value })}
                    placeholder="WAREHOUSE_DATABASE_URL"
                    className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">SQL query</label>
                <textarea
                  value={sourceValue.query || ''}
                  onChange={(e) => updateSource({ query: e.target.value })}
                  placeholder="SELECT * FROM marts.customers"
                  rows={3}
                  className="w-full px-3 py-1.5 text-sm font-mono border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </>
          )}

          {kind === 'csv' && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">File path</label>
              <input
                type="text"
                value={sourceValue.path || ''}
                onChange={(e) => updateSource({ path: e.target.value })}
                placeholder="/path/to/file.csv"
                className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}

          {kind === 'inline' && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Rows (JSON array of objects)</label>
              <textarea
                value={typeof sourceValue.rows === 'string' ? sourceValue.rows : JSON.stringify(sourceValue.rows || [], null, 2)}
                onChange={(e) => {
                  try {
                    updateSource({ rows: JSON.parse(e.target.value) });
                  } catch {
                    // Mid-edit invalid JSON -- keep the raw text so typing isn't fought
                    updateSource({ rows: e.target.value });
                  }
                }}
                placeholder='[{"email": "a@b.com", "name": "A"}]'
                rows={4}
                className="w-full px-3 py-1.5 text-sm font-mono border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}
        </div>
      );
    }

    if (fieldType === 'object') {
      // Check if this object has nested properties defined in the schema
      if (fieldSchema.properties && typeof fieldSchema.properties === 'object') {
        const objValue = value || {};
        console.log('[ComponentConfigModal] Rendering nested object fields for:', fieldName, Object.keys(fieldSchema.properties));

        return (
          <div className="space-y-3 pl-4 border-l-2 border-blue-200 bg-blue-50 p-3 rounded">
            <div className="text-xs text-blue-600 font-medium mb-2">
              ↳ Nested fields ({Object.keys(fieldSchema.properties).length})
            </div>
            {Object.entries(fieldSchema.properties).map(([subFieldName, subFieldSchema]: [string, any]) => (
              <div key={subFieldName}>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  {subFieldName}
                  {subFieldSchema.description && (
                    <span className="font-normal text-gray-500 ml-1 text-xs">
                      - {subFieldSchema.description}
                    </span>
                  )}
                </label>
                {renderNestedField(fieldName, subFieldName, subFieldSchema, objValue[subFieldName])}
              </div>
            ))}
          </div>
        );
      }

      // Fallback to JSON textarea for objects without defined properties
      // Special handling for assets field to provide better placeholder
      const isAssetsField = fieldName === 'assets';
      const assetsPlaceholder = `{
  "asset_key_1": {
    "row_count_check": [
      {
        "name": "check_row_count",
        "min_rows": 1
      }
    ]
  }
}`;

      return (
        <div className="space-y-2">
          <textarea
            value={typeof value === 'object' ? JSON.stringify(value, null, 2) : ''}
            onChange={(e) => {
              try {
                handleFieldChange(fieldName, JSON.parse(e.target.value));
              } catch {
                // Invalid JSON, ignore
              }
            }}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
            placeholder={isAssetsField ? assetsPlaceholder : "{}"}
            rows={isAssetsField ? 12 : 6}
          />
          {isAssetsField && (
            <p className="text-xs text-orange-600 bg-orange-50 border border-orange-200 rounded px-2 py-1">
              <strong>Important:</strong> Each check MUST have a unique "name" field. Empty names will cause issues.
            </p>
          )}
        </div>
      );
    }

    return (
      <input
        type="text"
        value={value}
        onChange={(e) => handleFieldChange(fieldName, e.target.value)}
        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    );
  };

  const properties = componentSchema.schema?.properties || {};

  return (
    <>
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-gray-200 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-gray-900 min-w-0 truncate">
            {isNew ? 'Add' : 'Edit'} Component: {componentSchema.name}
          </h2>
          <div className="flex items-center gap-2 flex-shrink-0">
            {!isNew && !isDraftMode && component && onEditWithGenie && AGENTIC_PIPELINE_FAMILY.has(extractComponentId(component.component_type)) && (
              <button
                onClick={() => onEditWithGenie(component)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-violet-700 bg-violet-50 border border-violet-200 rounded-md hover:bg-violet-100"
                title="Describe what to change in plain English instead of editing the raw config"
              >
                <Sparkles className="w-3.5 h-3.5" /> Edit with Genie
              </button>
            )}
            {!isNew && !isDraftMode && component && onReviewExtractions && DOCUMENT_EXTRACTOR_FAMILY.has(extractComponentId(component.component_type)) && (
              <button
                onClick={() => onReviewExtractions(component)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md hover:bg-emerald-100"
                title="See the source image/document next to what got extracted from it"
              >
                <ImageIcon className="w-3.5 h-3.5" /> Review extractions
              </button>
            )}
            <button onClick={onClose}>
              <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Component Label / Instance Name - only show for non-community or multi-asset components.
              Also hidden in draft-authoring mode — Designer auto-generates the component_id there. */}
          {!isDraftMode && (!isCommunityComponent || !hasSingleAssetField) && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {isCommunityComponent ? 'Instance Name' : 'Label'}
                {isCommunityComponent && !hasSingleAssetField && <span className="text-red-500 ml-1">*</span>}
              </label>
              <input
                type="text"
                value={label}
                onChange={(e) => {
                  setLabel(e.target.value);
                  // Clear error when user types
                  if (instanceNameError) {
                    setInstanceNameError(null);
                  }
                }}
                onBlur={(e) => {
                  // Validate on blur for multi-check components
                  if (isNew && isCommunityComponent && !hasSingleAssetField && e.target.value) {
                    validateInstanceName(e.target.value);
                  }
                }}
                className={`w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 ${
                  instanceNameError
                    ? 'border-red-500 focus:ring-red-500'
                    : 'border-gray-300 focus:ring-blue-500'
                }`}
                placeholder={isCommunityComponent ?
                  `Enter unique name (e.g., ${componentSchema.name.toLowerCase().replace(/\s+/g, '_')}_1)` :
                  `${componentSchema.name} Component`}
                required={isCommunityComponent && !hasSingleAssetField}
              />
              {instanceNameError && (
                <p className="text-xs text-red-600 mt-1 flex items-center">
                  <span className="font-semibold mr-1">⚠</span> {instanceNameError}
                </p>
              )}
              {!instanceNameError && isCommunityComponent && !hasSingleAssetField && (
                <p className="text-xs text-gray-500 mt-1">
                  Each instance needs a unique name to avoid overwriting previous configurations
                </p>
              )}
            </div>
          )}

          {/* Component Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Describe what this component does..."
              rows={2}
            />
            <p className="text-xs text-gray-500 mt-1">
              This description will be shown on the component node in the lineage graph
            </p>
          </div>

          {/* Component schema description */}
          {componentSchema.description && (
            <div className="text-sm text-gray-600 bg-blue-50 border border-blue-200 rounded-md p-3">
              {componentSchema.description}
            </div>
          )}

          {/* Visual Editor Notice for DataFrameTransformerComponent */}
          {type.includes('DataFrameTransformerComponent') && (
            <div className="bg-gradient-to-r from-purple-50 to-blue-50 border-2 border-purple-300 rounded-lg p-4">
              <div className="flex items-start space-x-3">
                <div className="flex-shrink-0">
                  <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
                <div className="flex-1">
                  <h4 className="text-sm font-semibold text-purple-900 mb-2">
                    Visual Editor Available
                  </h4>
                  <p className="text-sm text-purple-800 mb-3">
                    This transformer has a powerful visual editor with drag-and-drop configuration for all transformations including pivot/unpivot, aggregations, and more.
                  </p>
                  {(() => {
                    // Get upstream asset key from attributes -- see
                    // parseUpstreamAssetKeys for the shapes this accepts.
                    const upstreamKeys = parseUpstreamAssetKeys(formData.upstream_asset_keys);
                    const firstUpstreamKey = upstreamKeys[0];

                    if (firstUpstreamKey && onOpenVisualEditor) {
                      return (
                        <button
                          onClick={() => onOpenVisualEditor(firstUpstreamKey)}
                          className="w-full px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium rounded-md transition-colors flex items-center justify-center space-x-2"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                          </svg>
                          <span>Open Visual Editor for "{firstUpstreamKey}"</span>
                        </button>
                      );
                    }

                    return (
                      <div className="text-xs text-purple-700 bg-purple-100 border border-purple-200 rounded px-3 py-2">
                        <strong>To access:</strong> Click on the upstream asset in the graph → Click the "View Data" button in the dropdown menu → Configure transformations visually
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>
          )}

          {/* DBT Adapter Status — installs adapters into the local
              project's venv. N/A when authoring for a Dagster+ or
              sandbox target. */}
          {!isDraftMode && isDbtComponent && currentProject && (
            <div className="border border-gray-200 rounded-md p-4 space-y-3">
              <h3 className="text-sm font-semibold text-gray-900 flex items-center">
                <span>DBT Adapter Status</span>
                {loadingAdapterStatus && (
                  <Loader className="w-4 h-4 ml-2 animate-spin text-gray-500" />
                )}
              </h3>

              {!loadingAdapterStatus && adapterInfo.length === 0 && (
                <p className="text-sm text-gray-500">
                  No DBT project detected or adapter information not available.
                </p>
              )}

              {!loadingAdapterStatus && adapterInfo.map((adapter) => (
                <div
                  key={adapter.adapter_type}
                  className={`p-3 rounded-md border ${
                    adapter.installed
                      ? 'bg-green-50 border-green-200'
                      : 'bg-yellow-50 border-yellow-200'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      {adapter.installed ? (
                        <CheckCircle className="w-5 h-5 text-green-600" />
                      ) : (
                        <XCircle className="w-5 h-5 text-yellow-600" />
                      )}
                      <div>
                        <p className="text-sm font-medium text-gray-900">
                          {adapter.package_name}
                          {adapter.version && (
                            <span className="ml-2 text-xs text-gray-500">
                              v{adapter.version}
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-gray-600">
                          {adapter.installed
                            ? 'Adapter is installed and ready to use'
                            : 'Required adapter is not installed'}
                        </p>
                      </div>
                    </div>

                    {!adapter.installed && (
                      <button
                        onClick={() => handleInstallAdapter(adapter.adapter_type)}
                        disabled={installingAdapter === adapter.adapter_type}
                        className="flex items-center space-x-1 px-3 py-1.5 text-xs bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {installingAdapter === adapter.adapter_type ? (
                          <>
                            <Loader className="w-3 h-3 animate-spin" />
                            <span>Installing...</span>
                          </>
                        ) : (
                          <>
                            <Download className="w-3 h-3" />
                            <span>Install</span>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              ))}

              {!loadingAdapterStatus && adapterInfo.length > 0 && (
                <p className="text-xs text-gray-500">
                  DBT adapters are detected from your profiles.yml file and are required to run your DBT models.
                </p>
              )}
            </div>
          )}

          {/* Dynamic fields from schema */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-gray-900">Configuration</h3>

            {/* Special handling for Enhanced Data Quality Checks */}
            {type.includes('EnhancedDataQualityChecks') ? (
              <div className="pt-2 border-t border-gray-200">
                <EnhancedDataQualityChecksBuilder
                  assets={currentProject?.graph.nodes
                    .filter((node: any) => node.node_kind === 'asset' || node.type === 'asset')
                    .map((node: any) => node.data.asset_key || node.id) || []}
                  onConfigChange={(config) => setFormData({ ...formData, ...config })}
                />
              </div>
            ) : (
              <>
                {Object.keys(properties).length === 0 && (
                  <p className="text-sm text-gray-500">No configuration fields available</p>
                )}

                {(() => {
              // Fields "claimed" by another field's x-dagster-destination-fields
              // (its related_env_var_field) are rendered inside that field's own
              // block instead -- skip them here so they don't also show up as a
              // separate, independently-editable entry. Same idea for the
              // reverse-ETL `source`/`upstream_asset_key` pair: ~60 of 60
              // catalog components that have `source` also have
              // `upstream_asset_key` as its DataFrame-mode alternative, but
              // previously they rendered as two unrelated plain fields with
              // no indication they were mutually exclusive -- claim
              // upstream_asset_key here so the unified picker in `source`'s
              // own renderField branch (below) owns both.
              const claimedFieldNames = new Set(
                Object.values(properties)
                  .map((s: any) => s?.['x-dagster-destination-fields']?.related_env_var_field)
                  .filter(Boolean)
              );
              const hasUnifiedSourcePicker = !!properties.source && !!properties.upstream_asset_key;
              if (hasUnifiedSourcePicker) claimedFieldNames.add('upstream_asset_key');
              return Object.entries(properties).map(([fieldName, fieldSchema]: [string, any]) => {
              if (claimedFieldNames.has(fieldName) || commonFieldNames.has(fieldName)) {
                return null;
              }
              if (fieldSchema['x-dagster-destination-fields']) {
                return (
                  <div key={fieldName}>
                    {renderDestinationCredentialsField(fieldName, fieldSchema, fieldSchema['x-dagster-destination-fields'])}
                  </div>
                );
              }
              const isUnifiedSource = fieldName === 'source' && hasUnifiedSourcePicker;
              // Disambiguates from the SEPARATE `source.resource_key` (the
              // warehouse to query FROM, labeled "Warehouse resource"
              // inside the Data source box's SQL mode below) -- without
              // this, a component like BrazeSinkComponent literally shows
              // two fields both labeled bare "resource_key" with nothing
              // to tell them apart, confirmed confusing live.
              const isDestinationResourceKey = fieldName === 'resource_key' && fieldSchema.type !== 'object' && !isResourceComponentType;
              return (
              <div key={fieldName}>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {isUnifiedSource ? 'Data source' : isDestinationResourceKey ? 'Destination resource' : fieldName}
                  {componentSchema.schema?.required?.includes(fieldName) && (
                    <span className="text-red-500 ml-1">*</span>
                  )}
                </label>
                {(isUnifiedSource || fieldSchema.description) && (
                  <p className="text-xs text-gray-500 mb-1">
                    {isUnifiedSource ? 'Where this asset\'s data comes from -- pick exactly one.' : fieldSchema.description}
                  </p>
                )}
                {renderField(fieldName, fieldSchema)}
              </div>
              );
            });
            })()}
              </>
            )}
          </div>

          {/* Common fields Section — universal, backed by post_processing
              via asset_field_overrides, same mechanism as Dependencies
              below. Suppresses the component's own schema field of the
              same name (see commonFieldNames) so there's one input, not
              two, for whichever of these a component's own schema already
              declares. Same existing-component-only gating as
              Dependencies, for the same dangling-target reason. */}
          {!isNew && mode === 'local' && assetName && (
            <div className="border-t border-gray-200 pt-4 mt-4 space-y-3">
              <h3 className="text-sm font-semibold text-gray-900">Common fields</h3>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Group name</label>
                <input
                  type="text"
                  value={commonGroupName}
                  onChange={(e) => setCommonGroupName(e.target.value)}
                  placeholder="my_group"
                  className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Owners (comma-separated)</label>
                <input
                  type="text"
                  value={commonOwners}
                  onChange={(e) => setCommonOwners(e.target.value)}
                  placeholder="team:analytics, nelson@hooli.com"
                  className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Tags (key=value, comma-separated)</label>
                <input
                  type="text"
                  value={commonTags}
                  onChange={(e) => setCommonTags(e.target.value)}
                  placeholder="tier=prod, team=analytics"
                  className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          )}

          {/* Dependencies Section — universal, backed by custom lineage
              (project.custom_lineage / add-custom-lineage / remove-custom-
              lineage), not the component's own native upstream-key
              attribute (upstream_asset_keys / left_asset_key / etc), which
              only some component types even have and which means
              something different per component. Only shown when editing
              an EXISTING component: a brand-new one has no real asset key
              yet for a custom lineage edge to target, and a dangling
              target in the post_processing block this writes to crashes
              loading of the entire project (confirmed directly), so this
              field would otherwise let someone create one by accident. */}
          {!isNew && mode === 'local' && assetName && (
            <div className="border-t border-gray-200 pt-4 mt-4">
              <h3 className="text-sm font-semibold text-gray-900 mb-1">Dependencies</h3>
              <p className="text-xs text-gray-500 mb-2">
                Other assets this one depends on, beyond what this component's own fields declare.
              </p>
              <select
                multiple
                value={lineageDeps}
                onChange={(e) => {
                  const selected = Array.from(e.target.selectedOptions, (option) => option.value);
                  setLineageDeps(selected);
                }}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                size={Math.min(6, Math.max(3, availableAssets.filter((a: string) => a !== assetName).length))}
              >
                {availableAssets.filter((a: string) => a !== assetName).map((assetKey: string) => (
                  <option key={assetKey} value={assetKey}>
                    {assetKey}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-1">
                Hold Cmd/Ctrl to select multiple assets
              </p>
              {lineageDeps.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {lineageDeps.map((dep) => (
                    <span
                      key={dep}
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-blue-50 border border-blue-200 rounded text-blue-700"
                    >
                      {dep}
                      <button
                        type="button"
                        onClick={() => setLineageDeps(lineageDeps.filter((d) => d !== dep))}
                        className="hover:text-blue-900"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Translation Section — universal to all authoring
              contexts (asset-key rewriting works whether the
              component lands locally, in a sandbox, or as a cloud
              draft to be promoted). Collapsed by default: this section
              alone (its own fields + Advanced Options + Examples) was
              taking as much vertical space as the component's own
              actually-required fields, which read as "this dialog isn't
              helpful" when what someone needed (e.g. a sink's fields_map)
              was buried below an always-open, rarely-needed section. */}
          <details className="border-t border-gray-200 pt-4 mt-4">
            <summary className="cursor-pointer text-sm font-semibold text-gray-700 hover:text-gray-900 select-none">
              Advanced: customize how this asset is generated (optional)
            </summary>
            <div className="mt-3">
              <TranslationEditor value={translation} onChange={setTranslation} />
            </div>

            {/* Template variables hint */}
            <div className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-md p-3 mt-3">
              <strong>Tip:</strong> Use template variables like{' '}
              <code className="bg-gray-200 px-1 rounded">{'{{ env.VAR_NAME }}'}</code> for
              environment variables, or{' '}
              <code className="bg-gray-200 px-1 rounded">{'{{ project_root }}/repo-name'}</code> to
              reference cloned git repositories
            </div>
          </details>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 flex justify-end space-x-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex items-center space-x-1 px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700"
          >
            <Save className="w-4 h-4" />
            <span>{isDraftMode ? 'Save' : 'Save Component'}</span>
          </button>
        </div>
      </div>
    </div>

    {/* "+ Create new resource" step 1: pick which resource type. Step 2
        (creatingResourceType set) hands off to a nested ComponentConfigModal
        below instead -- this panel disappears once that's showing. */}
    {creatingResourceCallback && !creatingResourceType && (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60]">
        <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-900">Create a new resource</h3>
          <p className="text-xs text-gray-500">
            Which resource type? It'll be configured next, then its resource key fills in the field you started from.
          </p>
          <select
            value={pickedResourceTemplateId}
            onChange={(e) => setPickedResourceTemplateId(e.target.value)}
            className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="" disabled>Select a resource type...</option>
            {resourceTemplates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          {resourceTemplates.length === 0 && (
            <p className="text-xs text-amber-600">No resource components found in the catalog.</p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => { setCreatingResourceCallback(null); setPickedResourceTemplateId(''); }}
              className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded-md"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={resolvingResourceType || !pickedResourceTemplateId}
              onClick={() => resolveResourceComponentType(pickedResourceTemplateId)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              {resolvingResourceType && <Loader className="w-3.5 h-3.5 animate-spin" />}
              Continue
            </button>
          </div>
        </div>
      </div>
    )}

    {creatingResourceCallback && creatingResourceType && (
      <div className="fixed inset-0 z-[60]">
        <ComponentConfigModal
          component={null}
          componentType={creatingResourceType}
          mode="local"
          onClose={() => { setCreatingResourceCallback(null); setCreatingResourceType(null); setPickedResourceTemplateId(''); }}
          onSave={() => { /* community components never hit this branch -- see onInstanceCreated */ }}
          onInstanceCreated={(instance) => {
            const newResourceKey = instance.attributes?.resource_key;
            if (newResourceKey) creatingResourceCallback(newResourceKey);
          }}
        />
      </div>
    )}
    </>
  );
}
