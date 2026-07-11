import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import Editor from '@monaco-editor/react';
import {
  X, ShieldCheck, Loader2, Plus, Clock, Sparkles, MessageSquare, Mail,
  Wand2, Code2, Layers,
} from 'lucide-react';
import { projectsApi } from '@/services/api';
import { notify } from './Notifications';

interface AddMonitorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onSaved?: () => void;
}

type CheckKind =
  | 'freshness' | 'row_count' | 'null_ratio' | 'uniqueness'
  | 'accepted_values' | 'accepted_range' | 'not_null' | 'custom'
  // Broader enhanced-check kinds — free-form params via JSON at
  // config step. The wizard doesn't gatekeep, we just pass through.
  | 'distribution_drift' | 'regex_match' | 'schema_change'
  | 'referential_integrity' | 'duplicate_count' | 'stddev_check'
  | 'mean_shift' | 'quantile_check' | 'zero_count' | 'sum_check'
  | 'min_max_check' | 'anomaly_detection' | 'any';
type Implementation = 'enhanced_check' | 'dbt_test';

interface CheckKindDef {
  id: CheckKind;
  label: string;
  hint: string;
  icon: any;
  implementations: Implementation[];
  requires_column: boolean;
  crushes: string;                    // parity punch
  group: 'core' | 'volume' | 'schema' | 'value' | 'anomaly' | 'custom';
  /** Default JSON params for the "advanced" branch. Empty for
   *  kinds that have first-class forms. */
  default_params?: Record<string, any>;
}

const CHECK_KINDS: CheckKindDef[] = [
  // Core presets — dedicated forms
  { id: 'freshness',            label: 'Freshness',            hint: 'Fail when the asset hasn\'t been updated for N seconds.',                     icon: Clock,       implementations: ['enhanced_check'],             requires_column: false, crushes: 'Monte Carlo Freshness',      group: 'core' },
  { id: 'row_count',            label: 'Row count',            hint: 'Volume drop / spike (min, max, Z-score anomaly).',                            icon: Layers,      implementations: ['enhanced_check'],             requires_column: false, crushes: 'Monte Carlo Volume',         group: 'volume' },
  { id: 'null_ratio',           label: 'Null ratio',           hint: 'Fail when a column has more than X% nulls.',                                  icon: Sparkles,    implementations: ['enhanced_check'],             requires_column: true,  crushes: 'Monte Carlo Null Rate',      group: 'value' },
  { id: 'uniqueness',           label: 'Uniqueness',           hint: 'Every value in the column must be unique.',                                   icon: ShieldCheck, implementations: ['enhanced_check', 'dbt_test'], requires_column: true,  crushes: 'dbt unique / MC Uniqueness', group: 'value' },
  { id: 'not_null',             label: 'Not null',             hint: 'No null values in this column.',                                              icon: ShieldCheck, implementations: ['dbt_test', 'enhanced_check'], requires_column: true,  crushes: 'dbt not_null',               group: 'value' },
  { id: 'accepted_values',      label: 'Accepted values',      hint: 'Column value must be in a fixed set.',                                        icon: ShieldCheck, implementations: ['dbt_test', 'enhanced_check'], requires_column: true,  crushes: 'dbt accepted_values',        group: 'value' },
  { id: 'accepted_range',       label: 'Accepted range',       hint: 'Numeric column must fall in [min, max].',                                     icon: ShieldCheck, implementations: ['enhanced_check', 'dbt_test'], requires_column: true,  crushes: 'dbt_utils.accepted_range',   group: 'value' },
  // Advanced presets — JSON params
  { id: 'distribution_drift',   label: 'Distribution drift',   hint: 'KS test / PSI against a historical baseline.',                                icon: Sparkles,    implementations: ['enhanced_check'],             requires_column: true,  crushes: 'MC Field Health drift',      group: 'anomaly',  default_params: { column: '<col>', method: 'ks', p_threshold: 0.05, baseline_window: 30 } },
  { id: 'anomaly_detection',    label: 'Anomaly detection',    hint: 'Z-score / IQR against rolling history for any numeric metric.',                icon: Sparkles,    implementations: ['enhanced_check'],             requires_column: false, crushes: 'MC anomaly monitors',        group: 'anomaly',  default_params: { metric: 'row_count', method: 'zscore', threshold: 3.0, window: 30 } },
  { id: 'mean_shift',           label: 'Mean shift',           hint: 'Column mean drift vs historical baseline.',                                    icon: Sparkles,    implementations: ['enhanced_check'],             requires_column: true,  crushes: 'MC Field Health',            group: 'anomaly',  default_params: { column: '<col>', max_delta_pct: 20, baseline_window: 14 } },
  { id: 'stddev_check',         label: 'Stddev check',         hint: 'Column stddev inside an allowed band.',                                        icon: Sparkles,    implementations: ['enhanced_check'],             requires_column: true,  crushes: 'MC Field Health',            group: 'anomaly',  default_params: { column: '<col>', max_stddev: 10 } },
  { id: 'quantile_check',       label: 'Quantile check',       hint: 'P95 / P99 / any quantile against a threshold.',                                icon: Sparkles,    implementations: ['enhanced_check'],             requires_column: true,  crushes: 'MC latency-style monitors',  group: 'anomaly',  default_params: { column: '<col>', quantile: 0.95, max_value: 1000 } },
  { id: 'regex_match',          label: 'Regex match',          hint: 'All values in a column match a regex pattern.',                                icon: Code2,       implementations: ['enhanced_check'],             requires_column: true,  crushes: 'MC pattern checks',          group: 'value',    default_params: { column: '<col>', pattern: '^.+$' } },
  { id: 'schema_change',        label: 'Schema change',        hint: 'Fail if columns / types change vs a snapshot.',                                icon: ShieldCheck, implementations: ['enhanced_check'],             requires_column: false, crushes: 'MC Schema monitors',         group: 'schema',   default_params: { fail_on: ['column_added', 'column_removed', 'type_changed'] } },
  { id: 'referential_integrity',label: 'Referential integrity',hint: 'Every value in col X must exist in ref(other).col Y.',                         icon: ShieldCheck, implementations: ['enhanced_check', 'dbt_test'], requires_column: true,  crushes: 'dbt relationships / MC RI',  group: 'schema',   default_params: { column: '<col>', to_asset: '<other_asset>', to_column: '<col>' } },
  { id: 'duplicate_count',      label: 'Duplicate count',      hint: 'Count of duplicated key(s) below threshold.',                                  icon: ShieldCheck, implementations: ['enhanced_check'],             requires_column: true,  crushes: 'MC dupe monitors',           group: 'value',    default_params: { columns: ['<col>'], max_duplicates: 0 } },
  { id: 'zero_count',           label: 'Zero count',           hint: 'Fail if number of rows with 0 / null / missing key exceeds a threshold.',      icon: ShieldCheck, implementations: ['enhanced_check'],             requires_column: true,  crushes: 'MC zero monitors',           group: 'volume',   default_params: { column: '<col>', max_zeros: 0 } },
  { id: 'sum_check',            label: 'Sum check',            hint: 'Column sum inside an allowed range.',                                          icon: ShieldCheck, implementations: ['enhanced_check'],             requires_column: true,  crushes: 'MC volume + revenue',        group: 'volume',   default_params: { column: '<col>', min_sum: 0 } },
  { id: 'min_max_check',        label: 'Min / max',            hint: 'Column min or max above / below a threshold.',                                 icon: ShieldCheck, implementations: ['enhanced_check'],             requires_column: true,  crushes: 'MC bounds monitors',         group: 'value',    default_params: { column: '<col>', min_of_min: null, max_of_max: null } },
  // Full escape hatches
  { id: 'custom',               label: 'Custom SQL / Python',  hint: 'Write your own logic — SQL for dbt tests, Python for enhanced checks.',        icon: Code2,       implementations: ['enhanced_check', 'dbt_test'], requires_column: false, crushes: 'MC custom monitors',         group: 'custom' },
  { id: 'any',                  label: 'Any kind (advanced)',  hint: 'Type any kind supported by your enhanced-check component. Params as JSON.',    icon: Wand2,       implementations: ['enhanced_check'],             requires_column: false, crushes: 'Anything MC / Sifflet do',   group: 'custom',   default_params: {} },
];

const GROUP_ORDER: Array<{ id: CheckKindDef['group']; label: string }> = [
  { id: 'core',    label: 'Freshness & volume' },
  { id: 'volume',  label: 'Volume + counts' },
  { id: 'value',   label: 'Value integrity' },
  { id: 'schema',  label: 'Schema & referential' },
  { id: 'anomaly', label: 'Anomaly detection' },
  { id: 'custom',  label: 'Custom / escape hatches' },
];

const STARTER_CUSTOM_SQL = `-- Returns rows *when the check should fail*.
-- The asset is passed in as {{ ref('<asset>') }}.
select *
from {{ ref('<asset>') }}
where <predicate that should be false>
`;

const STARTER_CUSTOM_PYTHON = [
  '# The community EnhancedAssetCheck component invokes this with a DataFrame',
  '# named `df` and expects a boolean return: True == pass, False == fail.',
  '# Consult the component docs for the exact signature.',
  'return df["col"].notna().all()',
  '',
].join('\n');

export function AddMonitorDialog({ open, onOpenChange, projectId, onSaved }: AddMonitorDialogProps) {
  // Step state — a very lightweight wizard. We show all sections at
  // once but scope validation to what's currently active.
  const [step, setStep] = useState<'kind' | 'target' | 'config' | 'schedule' | 'review'>('kind');
  const [assets, setAssets] = useState<string[]>([]);
  const [dbtProjects, setDbtProjects] = useState<Array<{ relative_path: string; name: string }>>([]);
  const [dbtModels, setDbtModels] = useState<Array<{ unique_id: string; name: string; columns: string[] }>>([]);

  // Core config
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [checkKind, setCheckKind] = useState<CheckKind>('freshness');
  const [implementation, setImplementation] = useState<Implementation>('enhanced_check');
  const [severity, setSeverity] = useState<'error' | 'warn' | 'info'>('error');
  const [targetAsset, setTargetAsset] = useState<string>('');
  const [column, setColumn] = useState<string>('');
  const [dbtProjectPath, setDbtProjectPath] = useState<string>('');
  const [dbtModelUid, setDbtModelUid] = useState<string>('');

  // Kind-specific config
  const [maxAgeSeconds, setMaxAgeSeconds] = useState<string>('3600');
  const [minRowCount, setMinRowCount] = useState<string>('');
  const [maxRowCount, setMaxRowCount] = useState<string>('');
  const [rowZScore, setRowZScore] = useState<string>('');
  const [maxNullRatio, setMaxNullRatio] = useState<string>('0.05');
  const [acceptedValues, setAcceptedValues] = useState<string[]>([]);
  const [pendingValue, setPendingValue] = useState('');
  const [minValue, setMinValue] = useState<string>('');
  const [maxValue, setMaxValue] = useState<string>('');
  const [customSql, setCustomSql] = useState<string>(STARTER_CUSTOM_SQL);
  const [customPython, setCustomPython] = useState<string>(STARTER_CUSTOM_PYTHON);
  const [customLang, setCustomLang] = useState<'sql' | 'python'>('sql');
  // Advanced JSON params — used by any kind with `default_params`
  // that doesn't have a dedicated form. Also used by the "any" kind
  // where the user types the kind name themselves.
  const [advancedKindName, setAdvancedKindName] = useState<string>('');
  const [advancedParamsJson, setAdvancedParamsJson] = useState<string>('{}');

  // Schedule + routing
  const [scheduleMode, setScheduleMode] = useState<'none' | 'cron' | 'interval'>('none');
  const [scheduleCron, setScheduleCron] = useState<string>('0 * * * *');
  const [scheduleInterval, setScheduleInterval] = useState<string>('60');
  const [runOnMaterialize, setRunOnMaterialize] = useState<boolean>(true);
  const [slackChannel, setSlackChannel] = useState<string>('');
  const [email, setEmail] = useState<string>('');

  const [saving, setSaving] = useState(false);

  const kindDef = useMemo(() => CHECK_KINDS.find((k) => k.id === checkKind)!, [checkKind]);

  useEffect(() => {
    // If the current implementation isn't compatible with the picked
    // kind, snap to a compatible one.
    if (!kindDef.implementations.includes(implementation)) {
      setImplementation(kindDef.implementations[0]);
    }
  }, [checkKind, kindDef, implementation]);

  // Load all project assets on open (so target picker is populated).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Assets come from the project graph — reuse listDbtProjects endpoint
    // to also give us the dbt options, and pull assets from window (we
    // don't have a dedicated /assets endpoint returning bare keys, so
    // parse from listDbtModels' target-asset-keys shape).
    Promise.all([
      projectsApi.listDbtProjects(projectId).catch(() => ({ projects: [] as any[] })),
      projectsApi.listMonitors(projectId).catch(() => ({ monitors: [] as any[], stats: {} })),
    ]).then(([dp, mon]) => {
      if (cancelled) return;
      setDbtProjects((dp as any).projects || []);
      const s = new Set<string>();
      for (const m of ((mon as any).monitors || [])) for (const t of m.target_asset_keys) s.add(t);
      setAssets(Array.from(s).sort());
    });
    return () => { cancelled = true; };
  }, [open, projectId]);

  // When the user picks a dbt project (for dbt_test impl), fetch its models
  useEffect(() => {
    if (implementation !== 'dbt_test' || !dbtProjectPath) return;
    let cancelled = false;
    projectsApi.listDbtModels(projectId, dbtProjectPath).then((r) => {
      if (cancelled) return;
      setDbtModels(r.models.map((m) => ({ unique_id: m.unique_id, name: m.name, columns: Object.keys(m.columns ?? {}) })));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [implementation, dbtProjectPath, projectId]);

  const selectedDbtModel = dbtModels.find((m) => m.unique_id === dbtModelUid);
  const columnCandidates = implementation === 'dbt_test'
    ? (selectedDbtModel?.columns ?? [])
    : []; // enhanced checks: user types column name freely

  const reset = () => {
    setStep('kind'); setName(''); setDescription(''); setCheckKind('freshness');
    setImplementation('enhanced_check'); setSeverity('error');
    setTargetAsset(''); setColumn(''); setDbtProjectPath(''); setDbtModelUid('');
    setMaxAgeSeconds('3600'); setMinRowCount(''); setMaxRowCount(''); setRowZScore('');
    setMaxNullRatio('0.05'); setAcceptedValues([]); setPendingValue('');
    setMinValue(''); setMaxValue('');
    setCustomSql(STARTER_CUSTOM_SQL); setCustomPython(STARTER_CUSTOM_PYTHON); setCustomLang('sql');
    setScheduleMode('none'); setScheduleCron('0 * * * *'); setScheduleInterval('60');
    setRunOnMaterialize(true); setSlackChannel(''); setEmail('');
  };

  const submit = async () => {
    if (!name.trim()) { notify.error('Name is required.'); setStep('review'); return; }
    if (implementation === 'enhanced_check' && !targetAsset.trim()) { notify.error('Pick a target asset.'); setStep('target'); return; }
    if (implementation === 'dbt_test' && (!dbtProjectPath || !dbtModelUid)) { notify.error('Pick a dbt model.'); setStep('target'); return; }
    if (kindDef.requires_column && !column.trim() && implementation === 'enhanced_check') { notify.error('Pick a column.'); setStep('config'); return; }
    if (kindDef.requires_column && !column.trim() && implementation === 'dbt_test') { notify.error('Pick a column.'); setStep('config'); return; }
    // For advanced kinds (anything with default_params), send the
    // JSON blob rather than the flat form fields — that way the
    // wizard doesn't have to know every possible params schema.
    let paramsJson: Record<string, any> | null = null;
    let checkKindOverride: string | null = null;
    if (kindDef.default_params !== undefined) {
      try {
        paramsJson = advancedParamsJson.trim() ? JSON.parse(advancedParamsJson) : {};
      } catch (e) {
        notify.error('Params JSON is invalid — fix syntax and try again.');
        setStep('config');
        return;
      }
      if (checkKind === 'any') {
        if (!advancedKindName.trim()) {
          notify.error("Enter the kind name your enhanced-check component expects.");
          setStep('config');
          return;
        }
        checkKindOverride = advancedKindName.trim();
      }
    }
    setSaving(true);
    try {
      await projectsApi.addMonitor(projectId, {
        implementation,
        name: name.trim(),
        target_asset_key: implementation === 'dbt_test' ? (selectedDbtModel?.name ?? targetAsset) : targetAsset.trim(),
        check_kind: checkKind,
        params_json: paramsJson ?? undefined,
        check_kind_override: checkKindOverride ?? undefined,
        description: description.trim() || undefined,
        severity,
        max_age_seconds: checkKind === 'freshness' ? Number(maxAgeSeconds) : undefined,
        min_row_count: checkKind === 'row_count' && minRowCount ? Number(minRowCount) : undefined,
        max_row_count: checkKind === 'row_count' && maxRowCount ? Number(maxRowCount) : undefined,
        row_count_z_score: checkKind === 'row_count' && rowZScore ? Number(rowZScore) : undefined,
        column: kindDef.requires_column ? column.trim() : undefined,
        max_null_ratio: checkKind === 'null_ratio' ? Number(maxNullRatio) : undefined,
        accepted_values: checkKind === 'accepted_values' ? acceptedValues : undefined,
        min_value: checkKind === 'accepted_range' && minValue ? Number(minValue) : undefined,
        max_value: checkKind === 'accepted_range' && maxValue ? Number(maxValue) : undefined,
        custom_sql: checkKind === 'custom' && customLang === 'sql' ? customSql : undefined,
        custom_python: checkKind === 'custom' && customLang === 'python' ? customPython : undefined,
        schedule_cron: scheduleMode === 'cron' ? scheduleCron : undefined,
        schedule_interval_minutes: scheduleMode === 'interval' ? Number(scheduleInterval) : undefined,
        run_on_materialization: runOnMaterialize,
        slack_channel: slackChannel.trim() || undefined,
        email: email.trim() || undefined,
        dbt_relative_path: implementation === 'dbt_test' ? dbtProjectPath : undefined,
        dbt_model_unique_id: implementation === 'dbt_test' ? dbtModelUid : undefined,
      });
      notify.success(`Created monitor "${name}"`);
      onSaved?.();
      onOpenChange(false);
      reset();
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      if (e?.response?.status === 404) notify.error('Endpoint not found — restart the backend so the new /monitors endpoint loads.');
      else notify.error(detail || e?.message || 'Failed to create monitor.');
    } finally { setSaving(false); }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-xl shadow-2xl w-[860px] max-w-[96vw] max-h-[92vh] flex flex-col overflow-hidden z-50">
          <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between bg-gradient-to-b from-white to-gray-50/50">
            <div>
              <Dialog.Title className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center">
                  <ShieldCheck className="w-4 h-4 text-indigo-600" />
                </div>
                New monitor
              </Dialog.Title>
              <p className="text-xs text-gray-500 mt-0.5 ml-10">Data-quality check — dbt test or enhanced asset check, scheduled + routed.</p>
            </div>
            <Dialog.Close className="p-1.5 hover:bg-gray-100 rounded text-gray-400 hover:text-gray-700">
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>

          {/* Steps */}
          <div className="border-b border-gray-100 flex items-center px-5 gap-1 text-xs">
            {(['kind', 'target', 'config', 'schedule', 'review'] as const).map((s, i) => (
              <button
                key={s}
                onClick={() => setStep(s)}
                className={`px-3 py-2.5 border-b-2 -mb-px capitalize ${
                  step === s
                    ? 'text-blue-600 border-blue-600 font-medium'
                    : 'text-gray-600 border-transparent hover:text-gray-900'
                }`}
              >
                <span className="text-gray-400 mr-1">{i + 1}.</span>
                {s === 'kind' ? 'What' : s === 'target' ? 'Where' : s === 'config' ? 'How' : s === 'schedule' ? 'When' : 'Review'}
              </button>
            ))}
          </div>

          <div className="p-5 overflow-y-auto flex-1 space-y-5">
            {step === 'kind' && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-gray-900">What are we checking for?</h3>
                <p className="text-[11px] text-gray-500 -mt-2">
                  Enhanced Asset Checks support many more kinds than we can fit on one screen — the picker below is a
                  curated jumping-off point. Use <span className="font-mono">Any kind (advanced)</span> at the bottom to
                  configure any kind name + params your component supports.
                </p>
                {GROUP_ORDER.map((g) => {
                  const kinds = CHECK_KINDS.filter((k) => k.group === g.id);
                  if (kinds.length === 0) return null;
                  return (
                    <div key={g.id}>
                      <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 font-medium">{g.label}</div>
                      <div className="grid grid-cols-3 gap-2">
                        {kinds.map((k) => (
                          <button
                            key={k.id}
                            type="button"
                            onClick={() => {
                              setCheckKind(k.id);
                              if (k.default_params) {
                                setAdvancedParamsJson(JSON.stringify(k.default_params, null, 2));
                              }
                              if (k.id === 'any') {
                                setAdvancedKindName('');
                                setAdvancedParamsJson('{}');
                              }
                            }}
                            className={`text-left p-2.5 border rounded transition ${
                              checkKind === k.id
                                ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                                : 'border-gray-200 bg-white hover:border-gray-300'
                            }`}
                          >
                            <div className={`text-xs font-semibold flex items-center gap-1 ${checkKind === k.id ? 'text-primary' : 'text-gray-900'}`}>
                              <k.icon className="w-3.5 h-3.5" />
                              {k.label}
                            </div>
                            <div className="text-[10px] text-gray-500 mt-0.5 leading-snug">{k.hint}</div>
                            <div className="text-[9px] text-emerald-700 mt-1 font-medium">→ {k.crushes}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {step === 'target' && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-gray-900">Where does it run?</h3>
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Implementation</label>
                  <div className="grid grid-cols-2 gap-2">
                    {kindDef.implementations.map((impl) => (
                      <button
                        key={impl}
                        type="button"
                        onClick={() => setImplementation(impl)}
                        className={`text-left p-2.5 border rounded transition ${
                          implementation === impl
                            ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                            : 'border-gray-200 bg-white hover:border-gray-300'
                        }`}
                      >
                        <div className="text-xs font-semibold text-gray-900 flex items-center gap-1.5">
                          {impl === 'dbt_test' ? <Wand2 className="w-3.5 h-3.5" /> : <Sparkles className="w-3.5 h-3.5" />}
                          {impl === 'dbt_test' ? 'dbt test' : 'Enhanced asset check'}
                        </div>
                        <div className="text-[10px] text-gray-500 mt-0.5">
                          {impl === 'dbt_test'
                            ? 'Writes to schema.yml under a dbt model.'
                            : 'Writes a component instance yaml — works on any asset.'}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {implementation === 'enhanced_check' && (
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Target asset key</label>
                    <input
                      list="mon-assets"
                      value={targetAsset}
                      onChange={(e) => setTargetAsset(e.target.value)}
                      placeholder="e.g. jaffle_shop/customers"
                      className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded"
                    />
                    <datalist id="mon-assets">
                      {assets.map((a) => <option key={a} value={a} />)}
                    </datalist>
                    <p className="text-[10px] text-gray-500 mt-0.5">Free text or pick from the datalist of known assets in this project.</p>
                  </div>
                )}

                {implementation === 'dbt_test' && (
                  <>
                    <div>
                      <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">dbt project</label>
                      <select
                        value={dbtProjectPath}
                        onChange={(e) => setDbtProjectPath(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded bg-white"
                      >
                        <option value="">— pick a dbt project —</option>
                        {dbtProjects.map((p) => <option key={p.relative_path} value={p.relative_path}>{p.name} ({p.relative_path})</option>)}
                      </select>
                    </div>
                    {dbtProjectPath && (
                      <div>
                        <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">dbt model</label>
                        <select
                          value={dbtModelUid}
                          onChange={(e) => setDbtModelUid(e.target.value)}
                          className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded bg-white"
                        >
                          <option value="">— pick a model —</option>
                          {dbtModels.map((m) => <option key={m.unique_id} value={m.unique_id}>{m.name}</option>)}
                        </select>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {step === 'config' && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-gray-900">How does it fail?</h3>

                {/* Advanced JSON params — for kinds without a dedicated
                    form (or the "any" kind with a free-text kind name).
                    The community EnhancedAssetCheckComponent owns the
                    schema; we're just a text editor with sensible defaults. */}
                {kindDef.default_params !== undefined && (
                  <div className="space-y-3">
                    {checkKind === 'any' && (
                      <div>
                        <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Kind name</label>
                        <input value={advancedKindName} onChange={(e) => setAdvancedKindName(e.target.value)}
                          placeholder="e.g. distribution_drift"
                          className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded" />
                        <p className="text-[10px] text-gray-500 mt-0.5">Exact kind name your enhanced-check component expects.</p>
                      </div>
                    )}
                    <div>
                      <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">
                        Params (JSON)
                      </label>
                      <div className="border border-gray-200 rounded overflow-hidden">
                        <Editor
                          height="220px"
                          defaultLanguage="json"
                          value={advancedParamsJson}
                          onChange={(v) => setAdvancedParamsJson(v ?? '')}
                          theme="vs-light"
                          options={{ minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, wordWrap: 'on' }}
                        />
                      </div>
                      <p className="text-[10px] text-gray-500 mt-0.5">
                        Written verbatim to <code className="bg-gray-100 px-1 rounded">attributes.params</code> in the yaml.
                        Placeholder values (<code>&lt;col&gt;</code>) are for guidance — replace them.
                      </p>
                    </div>
                  </div>
                )}

                {kindDef.default_params === undefined && kindDef.requires_column && (
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Column</label>
                    {implementation === 'dbt_test' && columnCandidates.length > 0 ? (
                      <select value={column} onChange={(e) => setColumn(e.target.value)}
                        className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded bg-white">
                        <option value="">— pick a column —</option>
                        {columnCandidates.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    ) : (
                      <input value={column} onChange={(e) => setColumn(e.target.value)} placeholder="column_name"
                        className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded" />
                    )}
                  </div>
                )}

                {checkKind === 'freshness' && (
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Max age (seconds)</label>
                    <input value={maxAgeSeconds} onChange={(e) => setMaxAgeSeconds(e.target.value)} placeholder="3600"
                      className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded" />
                    <p className="text-[10px] text-gray-500 mt-0.5">Fail if the last materialization was more than this many seconds ago. Common: 3600 (1h), 86400 (24h).</p>
                  </div>
                )}

                {checkKind === 'row_count' && (
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Min rows</label>
                      <input value={minRowCount} onChange={(e) => setMinRowCount(e.target.value)} placeholder="—"
                        className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded" />
                    </div>
                    <div>
                      <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Max rows</label>
                      <input value={maxRowCount} onChange={(e) => setMaxRowCount(e.target.value)} placeholder="—"
                        className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded" />
                    </div>
                    <div>
                      <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block" title="Anomaly detection: fail when the row count is N standard deviations from a rolling mean.">Z-score alert</label>
                      <input value={rowZScore} onChange={(e) => setRowZScore(e.target.value)} placeholder="3.0"
                        className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded" />
                    </div>
                    <p className="col-span-3 text-[10px] text-gray-500">Any subset works. Z-score is anomaly detection against recent runs (crushes Monte Carlo volume monitors).</p>
                  </div>
                )}

                {checkKind === 'null_ratio' && (
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Max null ratio (0..1)</label>
                    <input value={maxNullRatio} onChange={(e) => setMaxNullRatio(e.target.value)} placeholder="0.05"
                      className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded" />
                    <p className="text-[10px] text-gray-500 mt-0.5">0.05 = fail when more than 5% of rows have null in this column.</p>
                  </div>
                )}

                {checkKind === 'accepted_values' && (
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Accepted values</label>
                    <div className="flex items-center gap-1 mb-2">
                      <input value={pendingValue} onChange={(e) => setPendingValue(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && pendingValue.trim()) { e.preventDefault(); setAcceptedValues([...acceptedValues, pendingValue.trim()]); setPendingValue(''); } }}
                        placeholder="value (Enter to add)"
                        className="flex-1 px-2 py-1 text-sm font-mono border border-gray-300 rounded" />
                      <button type="button" onClick={() => { if (pendingValue.trim()) { setAcceptedValues([...acceptedValues, pendingValue.trim()]); setPendingValue(''); } }}
                        className="px-3 py-1 text-xs bg-primary text-primary-foreground rounded">Add</button>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {acceptedValues.map((v, i) => (
                        <span key={i} className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded bg-emerald-50 border border-emerald-200 text-emerald-700 font-mono">
                          {v}
                          <button type="button" onClick={() => setAcceptedValues(acceptedValues.filter((_, j) => j !== i))} className="hover:text-rose-600">×</button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {checkKind === 'accepted_range' && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Min value</label>
                      <input value={minValue} onChange={(e) => setMinValue(e.target.value)} placeholder="0"
                        className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded" />
                    </div>
                    <div>
                      <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Max value</label>
                      <input value={maxValue} onChange={(e) => setMaxValue(e.target.value)} placeholder="—"
                        className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded" />
                    </div>
                  </div>
                )}

                {checkKind === 'custom' && (
                  <>
                    {implementation === 'enhanced_check' && (
                      <div className="flex items-center gap-0.5 bg-gray-100 rounded p-0.5 w-fit">
                        {(['sql', 'python'] as const).map((l) => (
                          <button key={l} type="button" onClick={() => setCustomLang(l)}
                            className={`px-2.5 py-1 text-xs rounded ${customLang === l ? 'bg-white shadow-sm font-medium text-gray-900' : 'text-gray-600'}`}>
                            {l.toUpperCase()}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="border border-gray-200 rounded overflow-hidden">
                      <Editor
                        height="220px"
                        defaultLanguage={customLang === 'python' && implementation === 'enhanced_check' ? 'python' : 'sql'}
                        language={customLang === 'python' && implementation === 'enhanced_check' ? 'python' : 'sql'}
                        value={customLang === 'python' && implementation === 'enhanced_check' ? customPython : customSql}
                        onChange={(v) => {
                          if (customLang === 'python' && implementation === 'enhanced_check') setCustomPython(v ?? '');
                          else setCustomSql(v ?? '');
                        }}
                        theme="vs-light"
                        options={{ minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, wordWrap: 'on' }}
                      />
                    </div>
                    <p className="text-[10px] text-gray-500">
                      {implementation === 'dbt_test'
                        ? 'Written as a singular dbt test — returns rows when the test fails.'
                        : 'Passed through to the enhanced-check component. Adjust the yaml after save if your component expects a different signature.'}
                    </p>
                  </>
                )}
              </div>
            )}

            {step === 'schedule' && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-gray-900">When does it run?</h3>
                <div className="space-y-2">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input type="checkbox" checked={runOnMaterialize} onChange={(e) => setRunOnMaterialize(e.target.checked)} className="mt-0.5 w-4 h-4" />
                    <div>
                      <div className="text-sm text-gray-900 font-medium">On every materialization of the target</div>
                      <div className="text-[11px] text-gray-500">Runs the check right after the asset updates. Best default for most monitors.</div>
                    </div>
                  </label>
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Also on a schedule</label>
                  <div className="flex items-center gap-0.5 bg-gray-100 rounded p-0.5 w-fit mb-2">
                    {(['none', 'cron', 'interval'] as const).map((m) => (
                      <button key={m} type="button" onClick={() => setScheduleMode(m)}
                        className={`px-2.5 py-1 text-xs rounded ${scheduleMode === m ? 'bg-white shadow-sm font-medium text-gray-900' : 'text-gray-600'}`}>
                        {m === 'none' ? 'No extra schedule' : m === 'cron' ? 'Cron' : 'Every N minutes'}
                      </button>
                    ))}
                  </div>
                  {scheduleMode === 'cron' && (
                    <input value={scheduleCron} onChange={(e) => setScheduleCron(e.target.value)} placeholder="0 * * * *"
                      className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded" />
                  )}
                  {scheduleMode === 'interval' && (
                    <input value={scheduleInterval} onChange={(e) => setScheduleInterval(e.target.value)} placeholder="60"
                      className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded" />
                  )}
                </div>

                <div className="border-t border-gray-100 pt-4">
                  <h4 className="text-xs font-semibold text-gray-800 mb-2">Alert routing</h4>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 flex items-center gap-1"><MessageSquare className="w-3 h-3" /> Slack channel</label>
                      <input value={slackChannel} onChange={(e) => setSlackChannel(e.target.value)} placeholder="#data-alerts"
                        className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded" />
                    </div>
                    <div>
                      <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 flex items-center gap-1"><Mail className="w-3 h-3" /> Email</label>
                      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="team@company.com"
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded" />
                    </div>
                  </div>
                  <p className="text-[10px] text-gray-500 mt-1">Wire your Slack workspace / SMTP once, referenced by channel/address here.</p>
                </div>
              </div>
            )}

            {step === 'review' && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-gray-900">Review + save</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Name</label>
                    <input value={name} onChange={(e) => setName(e.target.value)} placeholder="check_customers_freshness"
                      className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded" />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Severity</label>
                    <select value={severity} onChange={(e) => setSeverity(e.target.value as any)}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded bg-white">
                      <option value="error">Error</option>
                      <option value="warn">Warn</option>
                      <option value="info">Info</option>
                    </select>
                  </div>
                  <div className="col-span-2">
                    <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Description (optional)</label>
                    <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this monitor protects against"
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded" />
                  </div>
                </div>
                <div className="p-3 bg-gray-50 border border-gray-200 rounded text-xs space-y-1">
                  <div className="flex items-baseline gap-2"><span className="text-gray-500 w-32">Check</span> <span className="font-mono">{kindDef.label}</span></div>
                  <div className="flex items-baseline gap-2"><span className="text-gray-500 w-32">Implementation</span> <span className="font-mono">{implementation}</span></div>
                  <div className="flex items-baseline gap-2"><span className="text-gray-500 w-32">Target</span> <span className="font-mono">{implementation === 'dbt_test' ? (selectedDbtModel?.name ?? '?') : targetAsset || '?'}</span></div>
                  {kindDef.requires_column && <div className="flex items-baseline gap-2"><span className="text-gray-500 w-32">Column</span> <span className="font-mono">{column || '?'}</span></div>}
                  <div className="flex items-baseline gap-2"><span className="text-gray-500 w-32">Schedule</span> <span className="font-mono">
                    {runOnMaterialize && 'on-materialize'}{runOnMaterialize && scheduleMode !== 'none' && ' + '}
                    {scheduleMode === 'cron' && `cron ${scheduleCron}`}
                    {scheduleMode === 'interval' && `every ${scheduleInterval}m`}
                    {!runOnMaterialize && scheduleMode === 'none' && 'manual only'}
                  </span></div>
                  {(slackChannel || email) && <div className="flex items-baseline gap-2"><span className="text-gray-500 w-32">Alert</span> <span className="font-mono">{[slackChannel, email].filter(Boolean).join(', ')}</span></div>}
                </div>
                <p className="text-[10px] text-gray-500 italic">
                  {implementation === 'dbt_test'
                    ? 'Will be written to your dbt project\'s schema.yml (custom SQL → tests/*.sql).'
                    : 'Will be written to src/<project>/defs/monitors/<name>/defs.yaml — re-run Dagster to pick it up.'}
                </p>
              </div>
            )}
          </div>

          <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-between gap-2">
            <button
              onClick={() => {
                const seq = ['kind', 'target', 'config', 'schedule', 'review'] as const;
                const i = seq.indexOf(step);
                if (i > 0) setStep(seq[i - 1]);
              }}
              disabled={step === 'kind'}
              className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded disabled:opacity-40"
            >
              Back
            </button>
            <div className="flex items-center gap-2">
              <button onClick={() => onOpenChange(false)} className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded">Cancel</button>
              {step !== 'review' ? (
                <button
                  onClick={() => {
                    const seq = ['kind', 'target', 'config', 'schedule', 'review'] as const;
                    const i = seq.indexOf(step);
                    if (i < seq.length - 1) setStep(seq[i + 1]);
                  }}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded"
                >
                  Next
                </button>
              ) : (
                <button
                  onClick={submit}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded disabled:opacity-50"
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  {saving ? 'Saving…' : 'Create monitor'}
                </button>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
