import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Tabs from '@radix-ui/react-tabs';
import * as Dialog from '@radix-ui/react-dialog';
import Editor from '@monaco-editor/react';
import { Launchpad } from './Launchpad';
import { notify } from './Notifications';
import {
  Clock,
  Play,
  Radar,
  CheckCircle,
  Trash2,
  Eye,
  RefreshCw,
  X,
  FileCode,
  Timer,
} from 'lucide-react';
import { primitivesApi, pipelinesApi, assetsApi, type PrimitiveCategory, type PrimitiveItem } from '@/services/api';
import { useProjectStore } from '@/hooks/useProject';
import { CommunityAvailableSection } from './CommunityAvailableSection';
import { InsightMetricCard } from './InsightMetricCard';
import { Loader2 } from 'lucide-react';
import { useIsDarkMode } from '@/hooks/useIsDarkMode';

interface PrimitivesManagerProps {
  onNewPrimitive?: (category: string) => void;
  onOpenFile?: (filePath: string) => void;
  openPrimitive?: { category: string; name: string } | null;
  onOpenPrimitiveConsumed?: () => void;
  /** Jump to a specific asset's detail page (e.g. clicking a target asset
   *  chip on a cloud sensor/job's detail view). */
  onOpenAsset?: (nodeId: string) => void;
}

export function PrimitivesManager({
  onNewPrimitive,
  onOpenFile,
  openPrimitive,
  onOpenAsset,
  onOpenPrimitiveConsumed,
}: PrimitivesManagerProps = {}) {
  const isDark = useIsDarkMode();
  const { currentProject } = useProjectStore();
  const [activeTab, setActiveTab] = useState<PrimitiveCategory>('schedule');
  const [selectedPrimitive, setSelectedPrimitive] = useState<PrimitiveItem | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [showLaunchpad, setShowLaunchpad] = useState(false);
  const [selectedJobName, setSelectedJobName] = useState<string>('');
  const queryClient = useQueryClient();

  // Fetch all primitives (template-created only)
  const { data: allPrimitives, refetch: refetchPrimitives } = useQuery({
    queryKey: ['primitives', currentProject?.id],
    queryFn: () => currentProject ? primitivesApi.listAll(currentProject.id) : Promise.reject('No project'),
    enabled: !!currentProject,
  });

  // Fetch all definitions (from dg list defs - includes everything)
  const { data: allDefinitions, refetch: refetchDefinitions } = useQuery({
    queryKey: ['definitions', currentProject?.id],
    queryFn: () => currentProject ? primitivesApi.getAllDefinitions(currentProject.id) : Promise.reject('No project'),
    enabled: !!currentProject,
  });

  // Combine refetch functions
  const refetch = () => {
    refetchPrimitives();
    refetchDefinitions();
  };

  // Fetch primitive details
  const { data: primitiveDetails, error: primitiveDetailsError, isLoading: primitiveDetailsLoading } = useQuery({
    queryKey: ['primitive-details', currentProject?.id, activeTab, selectedPrimitive?.name],
    queryFn: () =>
      currentProject && selectedPrimitive
        ? primitivesApi.getDetails(currentProject.id, activeTab, selectedPrimitive.name)
        : Promise.reject('No selection'),
    enabled: !!currentProject && !!selectedPrimitive && detailsOpen,
    retry: false,
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: ({ category, name }: { category: PrimitiveCategory; name: string }) =>
      currentProject
        ? primitivesApi.delete(currentProject.id, category, name)
        : Promise.reject('No project'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['primitives', currentProject?.id] });
      queryClient.invalidateQueries({ queryKey: ['definitions', currentProject?.id] });
      setSelectedPrimitive(null);
      setDetailsOpen(false);
    },
  });

  const handleViewDetails = (primitive: PrimitiveItem) => {
    setSelectedPrimitive(primitive);
    setDetailsOpen(true);
  };

  const handleDelete = (category: PrimitiveCategory, name: string) => {
    if (confirm(`Are you sure you want to delete ${category} "${name}"?`)) {
      deleteMutation.mutate({ category, name });
    }
  };

  // Search for a discovered primitive's source file or open YAML file directly
  const handleSearchAndOpen = async (primitiveType: string, name: string, filePath?: string) => {
    if (!currentProject) return;

    // For asset checks, always go through the backend search — it knows how to
    // resolve dbt-derived checks to their real location in the dbt project's
    // schema.yml (dg list defs' `source` for dbt checks points at the empty
    // component defs.yaml, which is not useful).
    if (primitiveType !== 'asset_check') {
      // If the primitive is defined in a YAML file (e.g., defs.yaml), open it directly.
      if (filePath && (filePath.includes('.yaml') || filePath.includes('.yml'))) {
        if (onOpenFile) {
          onOpenFile(filePath);
        }
        return;
      }
    }

    // For Python-based primitives, search for the definition
    try {
      const result = await primitivesApi.searchPrimitiveDefinition(
        currentProject.id,
        primitiveType,
        name
      );

      if (result.found && result.file_path && onOpenFile) {
        // Include line number if available
        const fullFilePath = result.line_number
          ? `${result.file_path}:${result.line_number}`
          : result.file_path;
        onOpenFile(fullFilePath);
      } else {
        notify.error(`Could not find source code for ${name}`);
      }
    } catch (error) {
      console.error('Failed to search for primitive:', error);
      notify.error('Failed to search for source code');
    }
  };

  const handleLaunchJob = (jobName: string) => {
    setSelectedJobName(jobName);
    setShowLaunchpad(true);
  };

  const handleLaunchpadSubmit = async (config?: Record<string, any>, tags?: Record<string, string>) => {
    if (!currentProject || !selectedJobName) return;
    try {
      const result = await pipelinesApi.launch(currentProject.id, selectedJobName, config, tags);
      if (result.success) {
        notify.success(`Job ${selectedJobName} launched successfully!`);
      } else {
        notify.error(`Failed to launch job ${selectedJobName}`);
      }
    } catch (error) {
      console.error('Launch failed:', error);
      throw error;
    }
  };

  // Merge template-created primitives with discovered definitions
  const getMergedPrimitives = (category: PrimitiveCategory): Array<PrimitiveItem & { isManaged: boolean }> => {
    const categoryKey = category === 'schedule' ? 'schedules'
      : category === 'job' ? 'jobs'
      : category === 'sensor' ? 'sensors'
      : category === 'asset_check' ? 'asset_checks'
      : 'freshness_policies';

    // Get primitives from the fast /list endpoint (includes template-created + stored graph data)
    const primitives = allPrimitives?.primitives?.[categoryKey] || [];

    // For asset_checks, the /list endpoint now returns them from the stored graph
    // so we don't need to fetch from the slow /definitions endpoint
    if (category === 'asset_check') {
      // All asset checks from /list are considered "discovered" (from stored graph)
      const result = primitives.map(p => ({
        ...p,
        asset: (p as any).asset_key || p.asset, // Ensure asset field is set
        isManaged: false, // Asset checks from stored graph are "discovered"
      }));
      return result;
    }

    // For other categories (jobs, schedules, sensors), merge with definitions if available
    const templatePrimitives = primitives;
    const definitionPrimitives = allDefinitions?.[categoryKey] || [];

    // Mark template primitives as managed
    const managed = templatePrimitives.map(p => ({ ...p, isManaged: true }));

    // Add discovered primitives that aren't already in template primitives
    const managedNames = new Set(managed.map(p => p.name));
    const discovered = definitionPrimitives
      .filter(d => !managedNames.has(d.name))
      .map(d => ({
        name: d.name,
        description: (d as any).description || '',
        file: (d as any).source || 'N/A',
        cron_schedule: (d as any).cron_schedule,
        asset: (d as any).asset_key, // For asset checks
        isManaged: false,
      } as PrimitiveItem & { isManaged: boolean }));

    return [...managed, ...discovered];
  };

  // When a badge is clicked in the asset graph, switch to the right category
  // and open the details modal for that primitive.
  useEffect(() => {
    if (!openPrimitive || !currentProject) return;
    const { category, name } = openPrimitive;
    const validCategories: PrimitiveCategory[] = ['schedule', 'job', 'sensor', 'asset_check', 'freshness_policy'];
    if (!validCategories.includes(category as PrimitiveCategory)) {
      onOpenPrimitiveConsumed?.();
      return;
    }
    setActiveTab(category as PrimitiveCategory);
    const items = getMergedPrimitives(category as PrimitiveCategory);
    const match = items.find((p) => p.name === name);
    if (match) {
      setSelectedPrimitive(match);
      setDetailsOpen(true);
    } else {
      notify.info(`Couldn't find ${category} "${name}" — it may not be discovered yet. Try refreshing.`);
    }
    onOpenPrimitiveConsumed?.();
  }, [openPrimitive?.category, openPrimitive?.name, currentProject?.id]);

  const renderPrimitivesList = (primitives: Array<PrimitiveItem & { isManaged: boolean }>, category: PrimitiveCategory) => {
    const isCloud = !!(currentProject as any)?.is_dagster_plus;
    if (!primitives || primitives.length === 0) {
      return (
        <div className="flex items-center justify-center h-64 text-gray-500">
          <div className="text-center">
            <p className="text-sm font-medium mb-2">No {category}s found</p>
            {isCloud ? (
              <p className="text-xs text-gray-600">
                Dagster+ deployments define {category}s in code; none are visible for the selected deployment.
              </p>
            ) : (
              <>
                <p className="text-xs text-gray-600 mb-4">Create a new {category} to get started</p>
                <button
                  onClick={() => onNewPrimitive?.(category)}
                  className="inline-flex items-center px-3 py-2 text-sm font-medium text-white bg-primary rounded-md hover:bg-accent"
                >
                  New {category}
                </button>
              </>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="divide-y divide-gray-200">
        {primitives.map((primitive) => (
          <div
            key={primitive.name}
            className="p-4 hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-gray-900">{primitive.name}</h3>
                  {!primitive.isManaged && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
                      Discovered
                    </span>
                  )}
                </div>
                {primitive.description && (
                  <p className="text-xs text-gray-600 mt-1">{primitive.description}</p>
                )}
                <div className="flex items-center space-x-4 mt-2">
                  {primitive.file && primitive.file !== 'N/A' && (
                    <span className="text-xs text-gray-500">
                      File: {primitive.file.split('/').pop()}
                    </span>
                  )}
                  {category === 'schedule' && primitive.cron_schedule && (
                    <span className="text-xs text-gray-500">
                      Cron: {primitive.cron_schedule}
                    </span>
                  )}
                  {category === 'schedule' && primitive.job_name && (
                    <span className="text-xs text-gray-500">
                      Job: {primitive.job_name}
                    </span>
                  )}
                  {category === 'job' && primitive.selection && (
                    <span className="text-xs text-gray-500">
                      Assets: {primitive.selection.length}
                    </span>
                  )}
                  {category === 'sensor' && primitive.job_name && (
                    <span className="text-xs text-gray-500">
                      Triggers: {primitive.job_name}
                    </span>
                  )}
                  {category === 'asset_check' && primitive.asset && (
                    <span className="text-xs text-gray-500">
                      Asset: {primitive.asset}
                    </span>
                  )}
                  {category === 'freshness_policy' && primitive.asset_key && (
                    <span className="text-xs text-gray-500">
                      Asset: {primitive.asset_key}
                    </span>
                  )}
                  {category === 'freshness_policy' && primitive.status && (
                    <span className={`text-xs font-medium ${
                      primitive.status === 'HEALTHY' ? 'text-emerald-600'
                        : primitive.status === 'DEGRADED' ? 'text-red-600'
                        : primitive.status === 'WARNING' ? 'text-amber-600'
                        : 'text-gray-500'
                    }`}>
                      {primitive.status}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center space-x-2 ml-4">
                {(isCloud || (primitive.isManaged && primitive.file && primitive.file !== 'N/A')) && (
                  <button
                    onClick={() => handleViewDetails(primitive)}
                    className="p-1.5 text-blue-600 hover:bg-blue-50 rounded"
                    title={isCloud ? 'View details' : 'View code'}
                  >
                    <Eye className="w-4 h-4" />
                  </button>
                )}
                {!isCloud && !primitive.isManaged && (
                  <button
                    onClick={() => handleSearchAndOpen(
                      category === 'schedule' ? 'schedule' : category === 'job' ? 'job' : category === 'sensor' ? 'sensor' : 'asset_check',
                      primitive.name,
                      primitive.file !== 'N/A' ? primitive.file : undefined
                    )}
                    className="p-1.5 text-blue-600 hover:bg-blue-50 rounded"
                    title="Find and open source code"
                  >
                    <FileCode className="w-4 h-4" />
                  </button>
                )}
                {category === 'job' && (
                  <button
                    onClick={() => handleLaunchJob(primitive.name)}
                    className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition-colors"
                    title="Launch job"
                  >
                    <Play className="w-4 h-4" />
                  </button>
                )}
                {!isCloud && primitive.isManaged && (
                  <button
                    onClick={() => handleDelete(category, primitive.name)}
                    className="p-1.5 text-red-600 hover:bg-red-50 rounded"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  if (!currentProject) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        <div className="text-center">
          <Clock className="w-12 h-12 mx-auto mb-2 text-gray-400" />
          <p className="text-sm">Select a project to manage automation</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-white">
      <Tabs.Root
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as PrimitiveCategory)}
        className="flex-1 flex flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between border-b border-gray-200 bg-white">
          <Tabs.List className="flex">
          {([
            { value: 'schedule', label: 'Schedules', Icon: Clock },
            { value: 'job', label: 'Jobs', Icon: Play },
            { value: 'sensor', label: 'Sensors', Icon: Radar },
            { value: 'asset_check', label: 'Asset Checks', Icon: CheckCircle },
            { value: 'freshness_policy', label: 'Freshness Policies', Icon: Timer },
          ] as const).map(({ value, label, Icon }) => {
            const count = getMergedPrimitives(value as PrimitiveCategory).length;
            return (
              <Tabs.Trigger
                key={value}
                value={value}
                className="flex items-center gap-2 px-4 py-3 text-sm text-gray-600 hover:text-gray-900 border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-primary"
              >
                <Icon className="w-4 h-4" />
                <span>{label}</span>
                {count > 0 && (
                  <span className="text-xs text-gray-400 data-[state=active]:text-primary">{count}</span>
                )}
              </Tabs.Trigger>
            );
          })}
        </Tabs.List>
          <div className="flex items-center gap-1 pr-3">
            {!(currentProject as any)?.is_dagster_plus && (
              <button
                onClick={() => onNewPrimitive?.(activeTab)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-primary-foreground bg-primary rounded-md hover:bg-accent transition-colors"
                title={`Create a new ${activeTab.replace(/_/g, ' ')}`}
              >
                <span className="text-base leading-none">+</span>
                <span>New {activeTab.replace(/_/g, ' ')}</span>
              </button>
            )}
            <button
              onClick={() => refetch()}
              className="flex items-center space-x-1 px-2 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded"
              title="Refresh"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
      </div>

        <Tabs.Content value="schedule" className="flex-1 overflow-y-auto">
          {renderPrimitivesList(getMergedPrimitives('schedule'), 'schedule')}
          {/* Schedules aren't in the community manifest — this tab shows only
              locally-created + dg-discovered schedules. */}
        </Tabs.Content>

        <Tabs.Content value="job" className="flex-1 overflow-y-auto">
          {renderPrimitivesList(getMergedPrimitives('job'), 'job')}
          {/* Community sections are for browsing / installing templates,
              which requires local write access. Hidden for Dagster+
              cloud projects (read-only). */}
          {!(currentProject as any)?.is_dagster_plus && (
            <CommunityAvailableSection categories={['jobs', 'job']} title="Community jobs" />
          )}
        </Tabs.Content>

        <Tabs.Content value="sensor" className="flex-1 overflow-y-auto">
          {renderPrimitivesList(getMergedPrimitives('sensor'), 'sensor')}
          {!(currentProject as any)?.is_dagster_plus && (
            <CommunityAvailableSection categories={['sensor', 'sensors']} title="Community sensors" />
          )}
        </Tabs.Content>

        <Tabs.Content value="asset_check" className="flex-1 overflow-y-auto">
          {renderPrimitivesList(getMergedPrimitives('asset_check'), 'asset_check')}
          {!(currentProject as any)?.is_dagster_plus && (
            <CommunityAvailableSection
              categories={['check', 'checks', 'asset_check', 'asset_checks']}
              title="Community asset checks"
            />
          )}
        </Tabs.Content>

        <Tabs.Content value="freshness_policy" className="flex-1 overflow-y-auto">
          {renderPrimitivesList(getMergedPrimitives('freshness_policy'), 'freshness_policy')}
          {/* Freshness policies aren't in the community manifest either. */}
        </Tabs.Content>
      </Tabs.Root>

      {/* Details Dialog */}
      <Dialog.Root open={detailsOpen} onOpenChange={setDetailsOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50" />
          <Dialog.Content className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-xl w-[90vw] h-[80vh] flex flex-col">
            <div className="p-4 border-b border-gray-200 flex items-center justify-between">
              <Dialog.Title className="text-lg font-semibold text-gray-900">
                {selectedPrimitive?.name}
              </Dialog.Title>
              <Dialog.Close className="p-1 hover:bg-gray-100 rounded">
                <X className="w-5 h-5 text-gray-500" />
              </Dialog.Close>
            </div>

            <div className="flex-1 overflow-hidden">
              {primitiveDetailsError ? (
                <div className="flex items-center justify-center h-full p-6 text-center">
                  <div>
                    <p className="text-sm text-rose-600 font-medium">Failed to load details.</p>
                    <p className="text-xs text-gray-500 mt-1">
                      {(primitiveDetailsError as any)?.response?.data?.detail || (primitiveDetailsError as any)?.message || String(primitiveDetailsError)}
                    </p>
                  </div>
                </div>
              ) : primitiveDetailsLoading || !primitiveDetails ? (
                <div className="flex items-center justify-center h-full">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                </div>
              ) : (currentProject as any)?.is_dagster_plus ? (
                <div className="h-full overflow-y-auto">
                  <CloudPrimitiveDetail
                    category={activeTab}
                    primitive={primitiveDetails.primitive}
                    projectId={currentProject!.id}
                    onOpenAsset={onOpenAsset ? (assetKey: string) => {
                      const node = currentProject?.graph.nodes.find((n) => (n.data as any)?.asset_key === assetKey);
                      if (node) onOpenAsset(node.id);
                    } : undefined}
                  />
                </div>
              ) : (
                <Editor
                  height="100%"
                  language="python"
                  value={primitiveDetails.primitive.code}
                  theme={isDark ? 'vs-dark' : 'vs-light'}
                  options={{
                    readOnly: true,
                    minimap: { enabled: true },
                    fontSize: 13,
                    lineNumbers: 'on',
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                  }}
                />
              )}
            </div>

            <div className="p-4 border-t border-gray-200 flex justify-between items-center">
              <div className="text-sm text-gray-600">
                {(currentProject as any)?.is_dagster_plus
                  ? 'Defined in your Dagster+ deployment -- read-only here.'
                  : `File: ${selectedPrimitive?.file}`}
              </div>
              <div className="flex items-center space-x-2">
                <Dialog.Close className="px-4 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50">
                  Close
                </Dialog.Close>
                {!(currentProject as any)?.is_dagster_plus && (
                  <button
                    onClick={() =>
                      selectedPrimitive && handleDelete(activeTab, selectedPrimitive.name)
                    }
                    className="px-4 py-2 text-sm bg-red-600 text-white rounded-md hover:bg-red-700"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Launchpad for job execution */}
      {currentProject && selectedJobName && (
        <Launchpad
          open={showLaunchpad}
          onOpenChange={setShowLaunchpad}
          projectId={currentProject.id}
          mode="job"
          jobName={selectedJobName}
          onLaunch={handleLaunchpadSubmit}
          defaultConfig={{}}
          configSchema={{}}
        />
      )}
    </div>
  );
}

// ---------- Cloud primitive detail (no local file/code -- structured
// summary of whatever the Dagster+ hydration captured instead) ----------

function AssetKeyChip({ assetKey, onOpenAsset }: { assetKey: string; onOpenAsset?: (assetKey: string) => void }) {
  const clickable = !!onOpenAsset;
  return (
    <span
      onClick={clickable ? () => onOpenAsset!(assetKey) : undefined}
      className={`px-1.5 py-0.5 text-[11px] font-mono rounded bg-gray-100 text-gray-700 ${
        clickable ? 'cursor-pointer hover:bg-blue-50 hover:text-blue-700' : ''
      }`}
      title={clickable ? `Open ${assetKey}` : undefined}
    >
      {assetKey}
    </span>
  );
}

function CloudPrimitiveDetail({
  category, primitive, projectId, onOpenAsset,
}: {
  category: PrimitiveCategory;
  primitive: any;
  projectId: string;
  onOpenAsset?: (assetKey: string) => void;
}) {
  const rows: Array<{ label: string; value: any }> = [];
  if (primitive.description) rows.push({ label: 'Description', value: primitive.description });

  // Jobs had nothing beyond "targets N assets" -- the eyeball icon in
  // Automation was basically a no-op. Real Insights metrics (credits,
  // run health, duration) give this an actual reason to click through.
  const { data: jobInsights, isLoading: jobInsightsLoading } = useQuery({
    queryKey: ['job-insights-metrics', projectId, primitive.name],
    queryFn: () => assetsApi.getJobInsightsMetrics(projectId, primitive.name, 30),
    enabled: category === 'job' && !!primitive.name,
    staleTime: 60_000,
    retry: false,
  });

  if (category === 'schedule') {
    if (primitive.cron) rows.push({ label: 'Cron schedule', value: <span className="font-mono">{primitive.cron}</span> });
    if (primitive.pipeline_name) rows.push({ label: 'Job', value: primitive.pipeline_name });
    if (primitive.status) rows.push({ label: 'Status', value: primitive.status });
    if (primitive.repository) rows.push({ label: 'Code location', value: primitive.repository });
  } else if (category === 'sensor') {
    if (primitive.sensor_type) rows.push({ label: 'Sensor type', value: primitive.sensor_type });
    if (primitive.status) rows.push({ label: 'Status', value: primitive.status });
    if (primitive.repository) rows.push({ label: 'Code location', value: primitive.repository });
    if (Array.isArray(primitive.linked_asset_keys) && primitive.linked_asset_keys.length > 0) {
      rows.push({
        label: `Targets ${primitive.linked_asset_keys.length} asset${primitive.linked_asset_keys.length === 1 ? '' : 's'}`,
        value: (
          <div className="flex flex-wrap gap-1 mt-1">
            {primitive.linked_asset_keys.map((k: string) => (
              <AssetKeyChip key={k} assetKey={k} onOpenAsset={onOpenAsset} />
            ))}
          </div>
        ),
      });
    }
  } else if (category === 'job') {
    if (Array.isArray(primitive.asset_keys) && primitive.asset_keys.length > 0) {
      rows.push({
        label: `Targets ${primitive.asset_keys.length} asset${primitive.asset_keys.length === 1 ? '' : 's'}`,
        value: (
          <div className="flex flex-wrap gap-1 mt-1">
            {primitive.asset_keys.map((k: string) => (
              <AssetKeyChip key={k} assetKey={k} onOpenAsset={onOpenAsset} />
            ))}
          </div>
        ),
      });
    }
  } else if (category === 'asset_check') {
    if (primitive.asset_key) rows.push({ label: 'Asset', value: <AssetKeyChip assetKey={primitive.asset_key} onOpenAsset={onOpenAsset} /> });
    if (primitive.key) rows.push({ label: 'Check key', value: <span className="font-mono text-xs">{primitive.key}</span> });
  } else if (category === 'freshness_policy') {
    if (primitive.asset_key) rows.push({ label: 'Asset', value: <AssetKeyChip assetKey={primitive.asset_key} onOpenAsset={onOpenAsset} /> });
    if (primitive.status) rows.push({ label: 'Status', value: primitive.status });
    const p = primitive.policy;
    if (p) {
      rows.push({ label: 'Policy type', value: p.type === 'time_window' ? 'Time window' : 'Cron deadline' });
      if (p.fail_window_seconds) rows.push({ label: 'Fails after', value: _formatDurationSeconds(p.fail_window_seconds) + ' stale' });
      if (p.warn_window_seconds) rows.push({ label: 'Warns after', value: _formatDurationSeconds(p.warn_window_seconds) + ' stale' });
      if (p.deadline_cron) rows.push({ label: 'Deadline cron', value: <span className="font-mono">{p.deadline_cron}</span> });
      if (p.timezone) rows.push({ label: 'Timezone', value: p.timezone });
    }
  }

  return (
    <div className="p-6 max-w-2xl">
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500 italic">No additional details available for this {category.replace('_', ' ')}.</p>
      ) : (
        <dl className="space-y-3">
          {rows.map((r, i) => (
            <div key={i}>
              <dt className="text-[10px] uppercase tracking-wider text-gray-500 font-medium mb-0.5">{r.label}</dt>
              <dd className="text-sm text-gray-800">{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {category === 'job' && (
        <div className="mt-6">
          <h4 className="text-[10px] uppercase tracking-wider text-gray-500 font-medium mb-2">
            Insights — last 30 days
          </h4>
          {jobInsightsLoading ? (
            <div className="p-6 text-center text-gray-400"><Loader2 className="w-4 h-4 mx-auto animate-spin" /></div>
          ) : !jobInsights || jobInsights.metrics.length === 0 ? (
            <p className="text-xs text-gray-400 italic">No Insights data for this job in the last 30 days.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {jobInsights.metrics.map((m) => <InsightMetricCard key={m.metric_name} metric={m} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function _formatDurationSeconds(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes && !days) parts.push(`${minutes}m`);
  return parts.join(' ') || '0m';
}
