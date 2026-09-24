import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, Loader2 } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { assetsApi, INSIGHTS_BREAKDOWN_METRICS, INSIGHTS_JOB_BREAKDOWN_METRICS } from '@/services/api';
import { InsightMetricCard, formatInsightValue } from './InsightMetricCard';

interface InsightsPanelProps {
  /** Jump to a specific asset's own Insights tab (drill-down). */
  onOpenAsset: (nodeId: string) => void;
  /** Jump to a specific job's detail view -- there's no dedicated job
   *  detail page the way there is for assets, so this opens the same
   *  details dialog the Automation tab's Jobs list already uses. */
  onOpenJob: (jobName: string) => void;
}

// Deployment-wide KPI cards mixed asset-flavored (materializations) and
// job/run-flavored (run successes/failures, duration, step failures)
// metrics in one undifferentiated grid -- tabbed the same way as the
// "Top ..." cards below so the whole page reads through one consistent
// Assets/Jobs lens instead of only the bottom half being split.
const ASSET_DEPLOYMENT_METRICS = new Set([
  '__dagster_materializations', '__dagster_dagster_credits',
  '__dagster_failed_to_materialize', 'row_count',
]);
const JOB_DEPLOYMENT_METRICS = new Set([
  '__dagster_dagster_credits', '__dagster_run_successes', '__dagster_run_failures',
  '__dagster_run_duration_ms', '__dagster_step_failures',
  '__dagster_failed_to_materialize', '__dagster_run_queue_time_ms', '__dagster_observations',
]);

/**
 * Deployment-level Insights — the high-level landing page before drilling
 * into a specific asset's own Insights tab (AssetDetailPage) or a job's
 * detail dialog (Automation tab). Same data source (Dagster+'s hosted MCP
 * server, called directly, no LLM) as the per-asset tab, just scoped to
 * the whole deployment plus a "top ..." card per metric -- same layout
 * Dagster+'s own Insights page uses (several always-visible ranked
 * cards, not one table behind a picker), with one Assets/Jobs toggle
 * that controls both the KPI cards and the ranked cards together.
 */
export function InsightsPanel({ onOpenAsset, onOpenJob }: InsightsPanelProps) {
  const { currentProject } = useProjectStore();
  const [days, setDays] = useState(30);
  const [view, setView] = useState<'assets' | 'jobs'>('assets');
  const [codeLocationFilter, setCodeLocationFilter] = useState('');
  const isCloud = !!(currentProject as any)?.is_dagster_plus;

  // Asset -> code location, from the already-loaded project graph (no
  // extra fetch needed -- every asset node carries this). Jobs get their
  // code location straight from the breakdown API response instead.
  const assetCodeLocations = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of (currentProject?.graph.nodes || [])) {
      const loc = (n.data as any)?.code_location;
      const key = (n.data as any)?.asset_key;
      if (loc && key) m.set(key, loc);
    }
    return m;
  }, [currentProject?.graph.nodes]);

  const codeLocationOptions = useMemo(
    () => Array.from(new Set(assetCodeLocations.values())).sort(),
    [assetCodeLocations],
  );

  const { data: deployment, isLoading: loadingDeployment, error: deploymentError } = useQuery({
    queryKey: ['deployment-insights', currentProject?.id, days],
    queryFn: () => assetsApi.getDeploymentInsights(currentProject!.id, days),
    enabled: !!currentProject && isCloud,
    staleTime: 60_000,
  });
  const deploymentMetrics = (deployment?.metrics || []).filter((m) =>
    (view === 'assets' ? ASSET_DEPLOYMENT_METRICS : JOB_DEPLOYMENT_METRICS).has(m.metric_name)
  );

  const handleOpenAsset = (assetKey: string) => {
    if (!currentProject) return;
    const node = currentProject.graph.nodes.find((n) => (n.data as any)?.asset_key === assetKey);
    if (node) onOpenAsset(node.id);
  };

  if (!currentProject) return null;

  if (!isCloud) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500">
        <div className="text-center max-w-md px-6">
          <BarChart3 className="w-10 h-10 mx-auto mb-3 text-gray-300" />
          <p className="text-sm font-medium">Insights is a Dagster+-only feature.</p>
          <p className="text-xs text-gray-400 mt-2">
            Usage, cost, and reliability metrics are tracked by Dagster+'s Insights product and aren't
            available for local projects. Connect a Dagster+ deployment to see this here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-gray-50">
      <div className="px-6 py-3 border-b border-gray-200 bg-white flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Insights</h2>
          <p className="text-xs text-gray-500">Deployment-wide usage, cost, and reliability — live from Dagster+.</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {codeLocationOptions.length > 1 && (
            <select
              value={codeLocationFilter}
              onChange={(e) => setCodeLocationFilter(e.target.value)}
              className="pl-2 pr-6 py-1 text-xs border border-gray-300 rounded bg-white text-gray-700"
              title="Filter by code location"
            >
              <option value="">All code locations</option>
              {codeLocationOptions.map((loc) => (
                <option key={loc} value={loc}>{loc}</option>
              ))}
            </select>
          )}
          <div className="inline-flex rounded border border-gray-200 overflow-hidden">
            {[7, 30, 60, 90, 120].map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-2.5 py-1 text-xs font-medium ${days === d ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="p-6 max-w-[1200px] mx-auto space-y-6">
        <div className="flex items-center gap-1">
          {(['assets', 'jobs'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setView(t)}
              className={`px-3 py-1.5 text-xs font-medium rounded capitalize ${
                view === t ? 'bg-gray-900 text-white' : 'text-gray-500 hover:text-gray-800 hover:bg-gray-100'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <section>
          <h3 className="text-[10px] uppercase tracking-wider text-gray-500 font-medium mb-2">Deployment</h3>
          {loadingDeployment ? (
            <div className="p-8 text-center text-gray-500"><Loader2 className="w-5 h-5 mx-auto animate-spin" /></div>
          ) : deploymentError ? (
            <div className="p-8 text-center text-rose-600 text-sm">Failed to load deployment Insights metrics.</div>
          ) : deploymentMetrics.length === 0 ? (
            <p className="text-sm text-gray-500 italic p-4">No deployment-level Insights data for the last {days} days.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {deploymentMetrics.map((m) => <InsightMetricCard key={m.metric_name} metric={m} />)}
            </div>
          )}
        </section>

        <section>
          <h3 className="text-[10px] uppercase tracking-wider text-gray-500 font-medium mb-2">Top {view}</h3>
          {view === 'assets' ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {INSIGHTS_BREAKDOWN_METRICS.map((m) => (
                <TopAssetsCard
                  key={m.name}
                  projectId={currentProject.id}
                  days={days}
                  metricName={m.name}
                  label={m.label}
                  onOpenAsset={handleOpenAsset}
                  codeLocationFilter={codeLocationFilter}
                  assetCodeLocations={assetCodeLocations}
                />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {INSIGHTS_JOB_BREAKDOWN_METRICS.map((m) => (
                <TopJobsCard
                  key={m.name}
                  projectId={currentProject.id}
                  days={days}
                  metricName={m.name}
                  label={m.label}
                  onOpenJob={onOpenJob}
                  codeLocationFilter={codeLocationFilter}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function TopJobsCard({
  projectId, days, metricName, label, onOpenJob, codeLocationFilter,
}: {
  projectId: string;
  days: number;
  metricName: string;
  label: string;
  onOpenJob: (jobName: string) => void;
  codeLocationFilter?: string;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['insights-job-breakdown', projectId, metricName, days],
    queryFn: () => assetsApi.getJobInsightsBreakdown(projectId, metricName, days),
    staleTime: 60_000,
  });
  const allRows = data?.rows || [];
  const filteredRows = codeLocationFilter ? allRows.filter((r) => r.code_location === codeLocationFilter) : allRows;
  const distinctLocs = new Set(allRows.map((r) => r.code_location).filter(Boolean));
  // No location filter picked and rows actually span more than one
  // location -- break the single top-5 ranking into one small table per
  // location instead, so a location with real activity doesn't get
  // crowded out of a global top-5 by a noisier one.
  const grouped = !codeLocationFilter && distinctLocs.size > 1;

  const renderRows = (rows: typeof allRows) => (
    <ul className="divide-y divide-gray-50">
      {rows.map((r, i) => (
        <li
          key={r.job_name}
          onClick={() => onOpenJob(r.job_name)}
          className="flex items-center gap-2 px-4 py-2 hover:bg-gray-50/70 cursor-pointer"
          title={`Open ${r.job_name} in Automation`}
        >
          <span className="text-[10px] text-gray-400 font-mono w-4 flex-shrink-0">{i + 1}</span>
          <span className="flex-1 min-w-0">
            <div className="font-mono text-xs text-gray-800 truncate">{r.job_name}</div>
            {!grouped && r.code_location && <div className="text-[10px] text-gray-400 truncate">{r.code_location}</div>}
          </span>
          <span className="text-xs text-gray-600 tabular-nums flex-shrink-0">{formatInsightValue(r.value, data!.unit)}</span>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-100">
        <h4 className="text-xs font-semibold text-gray-900">Top jobs by {label}</h4>
      </div>
      {isLoading ? (
        <div className="p-6 text-center text-gray-400"><Loader2 className="w-4 h-4 mx-auto animate-spin" /></div>
      ) : filteredRows.length === 0 ? (
        <p className="text-xs text-gray-400 italic p-4 text-center">No data for the last {days} days.</p>
      ) : grouped ? (
        <div className="divide-y-4 divide-gray-50">
          {Array.from(distinctLocs).sort().map((loc) => {
            const locRows = filteredRows.filter((r) => r.code_location === loc).slice(0, 3);
            if (locRows.length === 0) return null;
            return (
              <div key={loc}>
                <div className="px-4 py-1 bg-gray-50 text-[10px] font-medium text-gray-500 truncate">{loc}</div>
                {renderRows(locRows)}
              </div>
            );
          })}
        </div>
      ) : renderRows(filteredRows.slice(0, 5))}
    </div>
  );
}

function TopAssetsCard({
  projectId, days, metricName, label, onOpenAsset, codeLocationFilter, assetCodeLocations,
}: {
  projectId: string;
  days: number;
  metricName: string;
  label: string;
  onOpenAsset: (assetKey: string) => void;
  codeLocationFilter?: string;
  assetCodeLocations: Map<string, string>;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['insights-breakdown', projectId, metricName, days],
    queryFn: () => assetsApi.getInsightsBreakdown(projectId, metricName, days),
    staleTime: 60_000,
  });
  const allRows = data?.rows || [];
  const filteredRows = codeLocationFilter
    ? allRows.filter((r) => assetCodeLocations.get(r.asset_key) === codeLocationFilter)
    : allRows;
  const distinctLocs = new Set(allRows.map((r) => assetCodeLocations.get(r.asset_key)).filter(Boolean) as string[]);
  const grouped = !codeLocationFilter && distinctLocs.size > 1;

  const renderRows = (rows: typeof allRows) => (
    <ul className="divide-y divide-gray-50">
      {rows.map((r, i) => (
        <li
          key={r.asset_key}
          onClick={() => onOpenAsset(r.asset_key)}
          className="flex items-center gap-2 px-4 py-2 hover:bg-gray-50/70 cursor-pointer"
          title={`Open ${r.asset_key}`}
        >
          <span className="text-[10px] text-gray-400 font-mono w-4 flex-shrink-0">{i + 1}</span>
          <span className="flex-1 min-w-0">
            <div className="font-mono text-xs text-gray-800 truncate">{r.asset_key}</div>
            {!grouped && assetCodeLocations.get(r.asset_key) && (
              <div className="text-[10px] text-gray-400 truncate">{assetCodeLocations.get(r.asset_key)}</div>
            )}
          </span>
          <span className="text-xs text-gray-600 tabular-nums flex-shrink-0">{formatInsightValue(r.value, data!.unit)}</span>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-100">
        <h4 className="text-xs font-semibold text-gray-900">Top assets by {label}</h4>
      </div>
      {isLoading ? (
        <div className="p-6 text-center text-gray-400"><Loader2 className="w-4 h-4 mx-auto animate-spin" /></div>
      ) : filteredRows.length === 0 ? (
        <p className="text-xs text-gray-400 italic p-4 text-center">No data for the last {days} days.</p>
      ) : grouped ? (
        <div className="divide-y-4 divide-gray-50">
          {Array.from(distinctLocs).sort().map((loc) => {
            const locRows = filteredRows.filter((r) => assetCodeLocations.get(r.asset_key) === loc).slice(0, 3);
            if (locRows.length === 0) return null;
            return (
              <div key={loc}>
                <div className="px-4 py-1 bg-gray-50 text-[10px] font-medium text-gray-500 truncate">{loc}</div>
                {renderRows(locRows)}
              </div>
            );
          })}
        </div>
      ) : renderRows(filteredRows.slice(0, 5))}
    </div>
  );
}
