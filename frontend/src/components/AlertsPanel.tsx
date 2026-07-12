import { useEffect, useMemo, useState } from 'react';
import {
  Bell, Plus, Trash2, X, Upload, Download, ChevronRight, ChevronLeft,
  Loader2, AlertTriangle, CheckCircle2, Table as TableIcon, Play,
  FolderOpen, Clock, Activity, TrendingUp, Cloud, Info, Copy, Edit3,
} from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { alertsApi, type AlertPolicy, type AlertPolicyType, type AlertsFile } from '@/services/api';
import { notify } from './Notifications';

/**
 * Alert Policies surface -- lists local policies (parsed from the
 * project's YAML file), lets users create / edit / delete, and offers
 * bidirectional sync with Dagster+. Everything hinges on ONE canonical
 * YAML file (usually `alert_policies.yaml` at the project root)
 * because `dg api alert-policy sync <path>` operates on a single file
 * and destructively replaces the org's policy set on push.
 */
export function AlertsPanel() {
  const { currentProject } = useProjectStore();
  const [state, setState] = useState<AlertsFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wizardMode, setWizardMode] = useState<{ mode: 'create' } | { mode: 'edit'; policy: AlertPolicy } | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);

  const isCloudProject = !!(currentProject as any)?.is_dagster_plus;

  const refresh = async () => {
    if (!currentProject) return;
    setLoading(true);
    setError(null);
    try {
      const r = await alertsApi.list(currentProject.id);
      setState(r);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Failed to load alerts.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [currentProject?.id]);

  const handleSave = async (updated: AlertPolicy, isEdit: boolean, originalName?: string) => {
    if (!currentProject || !state) return;
    let next: AlertPolicy[];
    if (isEdit && originalName) {
      next = state.policies.map((p) => (p.name === originalName ? updated : p));
    } else {
      // Reject duplicate name inline (backend also guards).
      if (state.policies.some((p) => p.name === updated.name)) {
        notify.error(`A policy named "${updated.name}" already exists.`);
        return;
      }
      next = [...state.policies, updated];
    }
    try {
      const r = await alertsApi.save(currentProject.id, next);
      setState(r);
      setWizardMode(null);
      notify.success(`Alert policy ${isEdit ? 'updated' : 'created'}: ${updated.name}`);
    } catch (e: any) {
      notify.error(e?.response?.data?.detail || e?.message || 'Failed to save policy.');
    }
  };

  const handleDelete = async (name: string) => {
    if (!currentProject) return;
    if (!confirm(`Delete alert policy "${name}"? This only updates the local YAML -- run Sync to push to Dagster+.`)) return;
    try {
      const r = await alertsApi.remove(currentProject.id, name);
      setState(r);
      notify.success(`Deleted "${name}".`);
    } catch (e: any) {
      notify.error(e?.response?.data?.detail || e?.message || 'Delete failed.');
    }
  };

  if (isCloudProject) {
    return (
      <div className="h-full flex items-center justify-center bg-gray-50">
        <div className="text-center max-w-md p-6">
          <Cloud className="w-10 h-10 mx-auto mb-3 text-blue-500" />
          <h3 className="text-base font-semibold text-gray-900">Alerts live in the repo, not the cloud connection</h3>
          <p className="text-sm text-gray-600 mt-2">
            Alert policies are authored as YAML that gets committed to your Dagster project's repo.
            Open the local project (not this Dagster+ connection) to author or sync alerts.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Slim ribbon -- matches the Automation tab: no big page title
          (the sidebar already labels this view), just contextual meta
          on the left and action buttons on the right. */}
      <div className="flex-shrink-0 bg-white border-b border-gray-200 px-4 py-2 flex items-center justify-between gap-4">
        <div className="text-xs text-gray-500 min-w-0 truncate">
          {state?.path && <>YAML: <span className="font-mono">{state.path}</span></>}
          {state?.policies?.length !== undefined && (
            <span className="ml-2">· {state.policies.length} {state.policies.length === 1 ? 'policy' : 'policies'}</span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => setSyncOpen(true)}
            disabled={!state || state.policies.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-700 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Push local alerts to Dagster+ (destructive) or pull from Dagster+ into the local YAML"
          >
            <Upload className="w-4 h-4" />
            Sync with Dagster+
          </button>
          <button
            onClick={() => setWizardMode({ mode: 'create' })}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-primary-foreground bg-primary rounded-md hover:bg-accent"
          >
            <Plus className="w-4 h-4" />
            Create alert policy
          </button>
        </div>
      </div>

      {/* OSS disclaimer */}
      <div className="mx-4 mt-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-900 flex items-start gap-2">
        <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <div>
          <strong>Alerts are only enforced on Dagster+ deployments.</strong> You can still author policies here for version control,
          but OSS Dagster ignores them at runtime.
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading && <div className="text-center py-12 text-gray-500"><Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />Loading alerts…</div>}
        {error && <div className="p-3 bg-rose-50 border border-rose-200 rounded text-sm text-rose-800">{error}</div>}
        {!loading && !error && state && state.policies.length === 0 && (
          <div className="text-center py-16">
            <Bell className="w-12 h-12 mx-auto mb-4 text-gray-300" />
            <p className="text-base font-medium text-gray-700">No alert policies yet</p>
            <p className="text-sm text-gray-500 mt-1 mb-6">
              Create your first policy to get notified when assets fail, runs error out, agents go down, etc.
            </p>
            <button
              onClick={() => setWizardMode({ mode: 'create' })}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md"
            >
              <Plus className="w-4 h-4" />
              Create alert policy
            </button>
          </div>
        )}
        {!loading && !error && state && state.policies.length > 0 && (
          <PoliciesTable
            policies={state.policies}
            onEdit={(p) => setWizardMode({ mode: 'edit', policy: p })}
            onDelete={handleDelete}
          />
        )}
      </div>

      {wizardMode && (
        <AlertWizard
          initial={wizardMode.mode === 'edit' ? wizardMode.policy : null}
          onClose={() => setWizardMode(null)}
          onSave={(p) =>
            handleSave(
              p,
              wizardMode.mode === 'edit',
              wizardMode.mode === 'edit' ? wizardMode.policy.name : undefined,
            )
          }
        />
      )}
      {syncOpen && (
        <SyncDialog
          onClose={() => setSyncOpen(false)}
          onDone={refresh}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function PoliciesTable({ policies, onEdit, onDelete }: {
  policies: AlertPolicy[];
  onEdit: (p: AlertPolicy) => void;
  onDelete: (name: string) => void;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b border-gray-100">
          <tr>
            <th className="text-left px-4 py-2 text-[10px] font-medium text-gray-600 uppercase tracking-wider">Name</th>
            <th className="text-left px-4 py-2 text-[10px] font-medium text-gray-600 uppercase tracking-wider">Type</th>
            <th className="text-left px-4 py-2 text-[10px] font-medium text-gray-600 uppercase tracking-wider">Trigger</th>
            <th className="text-left px-4 py-2 text-[10px] font-medium text-gray-600 uppercase tracking-wider">Notifies</th>
            <th className="text-left px-4 py-2 text-[10px] font-medium text-gray-600 uppercase tracking-wider">Enabled</th>
            <th className="w-32 px-4 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {policies.map((p) => (
            <tr key={p.name} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50">
              <td className="px-4 py-2">
                <div className="font-mono text-xs text-gray-900">{p.name}</div>
                {p.description && <div className="text-[11px] text-gray-500 mt-0.5">{p.description}</div>}
              </td>
              <td className="px-4 py-2"><TypeBadge type={p.type} /></td>
              <td className="px-4 py-2 text-[11px] text-gray-700">{triggerSummary(p)}</td>
              <td className="px-4 py-2 text-[11px] text-gray-700">{notificationSummary(p)}</td>
              <td className="px-4 py-2 text-xs">
                {p.enabled === false
                  ? <span className="text-gray-400">disabled</span>
                  : <span className="text-emerald-700">enabled</span>}
              </td>
              <td className="px-4 py-2 text-right">
                <div className="flex items-center justify-end gap-1">
                  <button onClick={() => onEdit(p)} className="p-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded" title="Edit">
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => onDelete(p.name)} className="p-1.5 text-gray-500 hover:text-rose-600 hover:bg-rose-50 rounded" title="Delete">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TYPE_META: Record<AlertPolicyType, { label: string; icon: any; color: string }> = {
  asset:            { label: 'Asset',          icon: TableIcon,   color: 'text-indigo-700 bg-indigo-50 border-indigo-200' },
  run:              { label: 'Run',            icon: Play,        color: 'text-blue-700 bg-blue-50 border-blue-200' },
  code_location:    { label: 'Code location',  icon: FolderOpen,  color: 'text-purple-700 bg-purple-50 border-purple-200' },
  automation:       { label: 'Automation',     icon: Clock,       color: 'text-amber-700 bg-amber-50 border-amber-200' },
  agent_downtime:   { label: 'Agent downtime', icon: Activity,    color: 'text-rose-700 bg-rose-50 border-rose-200' },
  insight_metric:   { label: 'Insight metric', icon: TrendingUp,  color: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
};

function TypeBadge({ type }: { type: AlertPolicyType }) {
  const meta = TYPE_META[type];
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-medium rounded border ${meta.color}`}>
      <Icon className="w-3 h-3" />
      {meta.label}
    </span>
  );
}

function triggerSummary(p: AlertPolicy): string {
  switch (p.type) {
    case 'asset': {
      const sel = p.asset?.asset_selection;
      const events = p.asset?.events || [];
      const target = Array.isArray(sel) ? sel.slice(0, 2).join(', ') + (sel.length > 2 ? ` +${sel.length - 2}` : '') : (sel || p.asset?.asset_group || 'all assets');
      return `${target} · ${events.length ? events.join(', ') : 'no events'}`;
    }
    case 'run': {
      const ev = (p.run?.events || []).join(', ');
      return ev || 'no events';
    }
    case 'code_location': return 'load failure';
    case 'automation': return (p.automation?.events || []).join(', ') || 'tick_failure';
    case 'agent_downtime': return 'agent inactive > 5m';
    case 'insight_metric': return `${p.insight_metric?.metric || '—'} ${p.insight_metric?.comparison || 'gt'} ${p.insight_metric?.threshold ?? ''}`.trim();
  }
}

function notificationSummary(p: AlertPolicy): string {
  const n = p.notification_service || {};
  const parts: string[] = [];
  if (n.email) parts.push(`email(${n.email.email_addresses?.length || 0})`);
  if (n.slack) parts.push(`slack #${n.slack.slack_channel_name}`);
  if (n.ms_teams) parts.push('MS Teams');
  if (n.pagerduty) parts.push('PagerDuty');
  if (n.webhook) parts.push('webhook');
  return parts.length ? parts.join(' · ') : '—';
}

// ---------------------------------------------------------------------------
// WIZARD
// ---------------------------------------------------------------------------

type WizardStep = 1 | 2 | 3 | 4;

function AlertWizard({ initial, onClose, onSave }: {
  initial: AlertPolicy | null;
  onClose: () => void;
  onSave: (p: AlertPolicy) => void;
}) {
  const [step, setStep] = useState<WizardStep>(initial ? 2 : 1);
  const [draft, setDraft] = useState<AlertPolicy>(() => initial ? deepClone(initial) : blankPolicy('asset'));

  const canContinue = (): boolean => {
    if (step === 1) return !!draft.type;
    if (step === 2) return isTargetsValid(draft);
    if (step === 3) return true; // notifications optional
    if (step === 4) return !!draft.name.trim();
    return false;
  };

  const next = () => setStep((s) => (Math.min(4, s + 1) as WizardStep));
  const back = () => setStep((s) => (Math.max(1, s - 1) as WizardStep));

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <div className="text-xs text-gray-500">{initial ? 'Edit alert policy' : 'Alert policies / Create alert policy'}</div>
            <h2 className="text-base font-semibold text-gray-900">{initial ? `Edit "${initial.name}"` : 'Create a new alert policy'}</h2>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700 rounded"><X className="w-5 h-5" /></button>
        </div>

        {/* Stepper */}
        <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-6 text-sm">
          <StepPill n={1} label="Policy type" active={step === 1} done={step > 1} />
          <StepPill n={2} label="Targets & events" active={step === 2} done={step > 2} />
          <StepPill n={3} label="Notifications" active={step === 3} done={step > 3} />
          <StepPill n={4} label="Details & review" active={step === 4} done={false} />
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {step === 1 && <Step1Type draft={draft} setDraft={setDraft} />}
          {step === 2 && <Step2Targets draft={draft} setDraft={setDraft} />}
          {step === 3 && <Step3Notifications draft={draft} setDraft={setDraft} />}
          {step === 4 && <Step4Review draft={draft} setDraft={setDraft} />}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-between">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded">Cancel</button>
          <div className="flex items-center gap-2">
            {step > 1 && (
              <button onClick={back} className="inline-flex items-center gap-1 px-3 py-1.5 text-sm text-gray-700 border border-gray-300 rounded hover:bg-gray-50">
                <ChevronLeft className="w-4 h-4" /> Back
              </button>
            )}
            {step < 4 && (
              <button onClick={next} disabled={!canContinue()} className="inline-flex items-center gap-1 px-4 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-50">
                Continue <ChevronRight className="w-4 h-4" />
              </button>
            )}
            {step === 4 && (
              <button onClick={() => onSave(draft)} disabled={!canContinue()} className="inline-flex items-center gap-1 px-4 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-50">
                <CheckCircle2 className="w-4 h-4" /> Save policy
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StepPill({ n, label, active, done }: { n: number; label: string; active: boolean; done: boolean }) {
  return (
    <div className={`flex items-center gap-1.5 text-xs ${active ? 'text-blue-700 font-medium' : done ? 'text-gray-500' : 'text-gray-400'}`}>
      <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${active ? 'bg-blue-600 text-white' : done ? 'bg-emerald-500 text-white' : 'bg-gray-200 text-gray-600'}`}>{done ? '✓' : n}</span>
      {label}
    </div>
  );
}

// ---------- Step 1: Policy type -----------------------------------------

function Step1Type({ draft, setDraft }: { draft: AlertPolicy; setDraft: (d: AlertPolicy) => void }) {
  const OPTIONS: { type: AlertPolicyType; label: string; icon: any; hint: string }[] = [
    { type: 'asset',          label: 'Asset',          icon: TableIcon,   hint: 'Triggers asset materializations and asset checks. Can be scoped to all assets or specific asset group and assets.' },
    { type: 'run',            label: 'Run',            icon: Play,        hint: 'Triggers on job run success, failure, or time limit exceeded and may optionally include a set of configured tags.' },
    { type: 'code_location',  label: 'Code location',  icon: FolderOpen,  hint: 'Triggers when a code location fails to load due to an error.' },
    { type: 'automation',     label: 'Automation',     icon: Clock,       hint: 'Triggers when a tick failure occurs for schedules or sensors in the deployment.' },
    { type: 'agent_downtime', label: 'Agent downtime', icon: Activity,    hint: "Triggers when a Hybrid agent hasn't heartbeated within the last five minutes." },
    { type: 'insight_metric', label: 'Insight metric', icon: TrendingUp,  hint: 'Triggers when a metric limit is exceeded for any deployment in the organization.' },
  ];
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-700 mb-4">Choose the type of alert you want to create</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {OPTIONS.map((o) => {
          const Icon = o.icon;
          const active = draft.type === o.type;
          return (
            <button
              key={o.type}
              onClick={() => setDraft(withType(draft, o.type))}
              className={`text-left p-3 rounded-lg border-2 transition ${
                active ? 'border-blue-500 bg-blue-50/40' : 'border-gray-200 hover:border-gray-300 bg-white'
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <Icon className="w-4 h-4 text-gray-700" />
                <span className="text-sm font-semibold text-gray-900">{o.label}</span>
              </div>
              <p className="text-xs text-gray-600">{o.hint}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Step 2: Targets & events ------------------------------------

function Step2Targets({ draft, setDraft }: { draft: AlertPolicy; setDraft: (d: AlertPolicy) => void }) {
  switch (draft.type) {
    case 'asset':          return <AssetTargets draft={draft} setDraft={setDraft} />;
    case 'run':            return <RunTargets draft={draft} setDraft={setDraft} />;
    case 'code_location':  return <NoConfigNote label="Code location alerts fire automatically when a code location fails to load. No additional configuration needed." />;
    case 'automation':     return <AutomationTargets draft={draft} setDraft={setDraft} />;
    case 'agent_downtime': return <NoConfigNote label="Agent downtime alerts fire when a Hybrid agent hasn't heartbeated within the last 5 minutes. No additional configuration needed." />;
    case 'insight_metric': return <InsightMetricTargets draft={draft} setDraft={setDraft} />;
  }
}

function NoConfigNote({ label }: { label: string }) {
  return (
    <div className="p-4 bg-blue-50 border border-blue-200 rounded text-sm text-blue-900 flex items-start gap-2">
      <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />
      <div>{label}</div>
    </div>
  );
}

const ASSET_EVENT_OPTIONS = [
  { v: 'materialization_success',     label: 'Materialization succeeded' },
  { v: 'materialization_failure',     label: 'Materialization failed' },
  { v: 'asset_check_failed',          label: 'Asset check failed' },
  { v: 'asset_check_severity',        label: 'Asset check warning' },
  { v: 'freshness_slo_violation',     label: 'Freshness SLO violation' },
];

function AssetTargets({ draft, setDraft }: { draft: AlertPolicy; setDraft: (d: AlertPolicy) => void }) {
  const { currentProject } = useProjectStore();
  const allGroups = useMemo(() => {
    const s = new Set<string>();
    for (const n of currentProject?.graph?.nodes || []) {
      if (n.node_kind === 'asset' && (n.data as any)?.group_name) s.add((n.data as any).group_name);
    }
    return Array.from(s).sort();
  }, [currentProject]);
  const allAssets = useMemo(() => {
    const s = new Set<string>();
    for (const n of currentProject?.graph?.nodes || []) {
      if (n.node_kind === 'asset') {
        const k = (n.data as any)?.asset_key;
        if (k) s.add(k);
      }
    }
    return Array.from(s).sort();
  }, [currentProject]);

  const asset = draft.asset || { events: [] };
  const events = new Set(asset.events || []);
  const selMode: 'all' | 'group' | 'keys' =
    asset.asset_group ? 'group' : Array.isArray(asset.asset_selection) ? 'keys' : 'all';

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs font-medium text-gray-700 mb-2">Which assets should this alert cover?</div>
        <div className="grid grid-cols-3 gap-2">
          <RadioCard label="All assets" active={selMode === 'all'} onClick={() =>
            setDraft(withAsset(draft, { ...asset, asset_selection: '*', asset_group: null }))
          } />
          <RadioCard label="Asset group" active={selMode === 'group'} onClick={() =>
            setDraft(withAsset(draft, { ...asset, asset_group: allGroups[0] || '', asset_selection: null }))
          } />
          <RadioCard label="Specific assets" active={selMode === 'keys'} onClick={() =>
            setDraft(withAsset(draft, { ...asset, asset_selection: [], asset_group: null }))
          } />
        </div>
      </div>
      {selMode === 'group' && (
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Group</label>
          <select
            value={asset.asset_group || ''}
            onChange={(e) => setDraft(withAsset(draft, { ...asset, asset_group: e.target.value }))}
            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
          >
            <option value="">Select a group…</option>
            {allGroups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>
      )}
      {selMode === 'keys' && (
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Asset keys ({(asset.asset_selection as string[] | undefined)?.length || 0} selected)</label>
          <MultiPicker
            all={allAssets}
            selected={(asset.asset_selection as string[] | undefined) || []}
            onChange={(next) => setDraft(withAsset(draft, { ...asset, asset_selection: next }))}
          />
        </div>
      )}
      <div>
        <div className="text-xs font-medium text-gray-700 mb-2">Events</div>
        <div className="space-y-1.5">
          {ASSET_EVENT_OPTIONS.map((ev) => (
            <label key={ev.v} className="flex items-center gap-2 text-sm text-gray-800">
              <input
                type="checkbox"
                checked={events.has(ev.v)}
                onChange={() => {
                  const next = new Set(events);
                  if (next.has(ev.v)) next.delete(ev.v); else next.add(ev.v);
                  setDraft(withAsset(draft, { ...asset, events: Array.from(next) }));
                }}
              />
              {ev.label} <span className="text-[10px] text-gray-400 font-mono ml-1">{ev.v}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

const RUN_EVENT_OPTIONS = [
  { v: 'run_success', label: 'Run succeeded' },
  { v: 'run_failure', label: 'Run failed' },
  { v: 'run_time_limit_exceeded', label: 'Run time limit exceeded' },
];

function RunTargets({ draft, setDraft }: { draft: AlertPolicy; setDraft: (d: AlertPolicy) => void }) {
  const run = draft.run || { events: [] };
  const events = new Set(run.events || []);
  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs font-medium text-gray-700 mb-2">Events</div>
        <div className="space-y-1.5">
          {RUN_EVENT_OPTIONS.map((ev) => (
            <label key={ev.v} className="flex items-center gap-2 text-sm text-gray-800">
              <input
                type="checkbox"
                checked={events.has(ev.v)}
                onChange={() => {
                  const next = new Set(events);
                  if (next.has(ev.v)) next.delete(ev.v); else next.add(ev.v);
                  setDraft(withRun(draft, { ...run, events: Array.from(next) }));
                }}
              />
              {ev.label} <span className="text-[10px] text-gray-400 font-mono ml-1">{ev.v}</span>
            </label>
          ))}
        </div>
      </div>
      {events.has('run_time_limit_exceeded') && (
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Time limit (seconds)</label>
          <input
            type="number"
            value={run.time_limit_seconds ?? ''}
            onChange={(e) => setDraft(withRun(draft, { ...run, time_limit_seconds: e.target.value ? Number(e.target.value) : null }))}
            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
            placeholder="e.g. 3600"
          />
        </div>
      )}
      <TagsEditor
        label="Only fire on runs with these tags (optional)"
        tags={run.tags || null}
        onChange={(next) => setDraft(withRun(draft, { ...run, tags: next }))}
      />
    </div>
  );
}

function AutomationTargets({ draft, setDraft }: { draft: AlertPolicy; setDraft: (d: AlertPolicy) => void }) {
  const auto = draft.automation || { events: ['tick_failure'], include_schedules: true, include_sensors: true };
  const events = new Set(auto.events || []);
  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs font-medium text-gray-700 mb-2">Events</div>
        <label className="flex items-center gap-2 text-sm text-gray-800">
          <input
            type="checkbox"
            checked={events.has('tick_failure')}
            onChange={() => {
              const next = new Set(events);
              if (next.has('tick_failure')) next.delete('tick_failure'); else next.add('tick_failure');
              setDraft(withAutomation(draft, { ...auto, events: Array.from(next) }));
            }}
          />
          Tick failure <span className="text-[10px] text-gray-400 font-mono">tick_failure</span>
        </label>
      </div>
      <div>
        <div className="text-xs font-medium text-gray-700 mb-2">Scope</div>
        <label className="flex items-center gap-2 text-sm text-gray-800">
          <input type="checkbox" checked={auto.include_schedules !== false} onChange={(e) => setDraft(withAutomation(draft, { ...auto, include_schedules: e.target.checked }))} />
          Include schedules
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-800">
          <input type="checkbox" checked={auto.include_sensors !== false} onChange={(e) => setDraft(withAutomation(draft, { ...auto, include_sensors: e.target.checked }))} />
          Include sensors
        </label>
      </div>
    </div>
  );
}

function InsightMetricTargets({ draft, setDraft }: { draft: AlertPolicy; setDraft: (d: AlertPolicy) => void }) {
  const im = draft.insight_metric || { metric: 'dagster_credits', comparison: 'gt', threshold: 0 };
  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Metric</label>
        <input
          type="text"
          value={im.metric}
          onChange={(e) => setDraft(withInsightMetric(draft, { ...im, metric: e.target.value }))}
          placeholder="e.g. dagster_credits"
          className="w-full text-sm font-mono border border-gray-300 rounded px-2 py-1.5"
        />
      </div>
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="block text-xs font-medium text-gray-700 mb-1">Comparison</label>
          <select
            value={im.comparison || 'gt'}
            onChange={(e) => setDraft(withInsightMetric(draft, { ...im, comparison: e.target.value }))}
            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
          >
            <option value="gt">&gt; (greater than)</option>
            <option value="gte">&ge; (greater or equal)</option>
            <option value="lt">&lt; (less than)</option>
            <option value="lte">&le; (less or equal)</option>
          </select>
        </div>
        <div className="flex-1">
          <label className="block text-xs font-medium text-gray-700 mb-1">Threshold</label>
          <input
            type="number"
            value={im.threshold ?? ''}
            onChange={(e) => setDraft(withInsightMetric(draft, { ...im, threshold: e.target.value ? Number(e.target.value) : null }))}
            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
          />
        </div>
      </div>
    </div>
  );
}

// ---------- Step 3: Notifications --------------------------------------

function Step3Notifications({ draft, setDraft }: { draft: AlertPolicy; setDraft: (d: AlertPolicy) => void }) {
  const notif = draft.notification_service || {};
  const setNotif = (n: NonNullable<AlertPolicy['notification_service']>) =>
    setDraft({ ...draft, notification_service: n });
  const currentChannel: 'email' | 'slack' | 'ms_teams' | 'pagerduty' | 'webhook' | null =
    notif.email ? 'email'
    : notif.slack ? 'slack'
    : notif.ms_teams ? 'ms_teams'
    : notif.pagerduty ? 'pagerduty'
    : notif.webhook ? 'webhook'
    : null;

  const pickChannel = (c: 'email' | 'slack' | 'ms_teams' | 'pagerduty' | 'webhook' | null) => {
    if (c === null) return setNotif({});
    // Exactly one channel per policy.
    if (c === 'email')     return setNotif({ email: { email_addresses: [] } });
    if (c === 'slack')     return setNotif({ slack: { slack_channel_name: '' } });
    if (c === 'ms_teams')  return setNotif({ ms_teams: { ms_teams_webhook_url: '' } });
    if (c === 'pagerduty') return setNotif({ pagerduty: { integration_key: '' } });
    if (c === 'webhook')   return setNotif({ webhook: { url: '' } });
  };

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs font-medium text-gray-700 mb-2">Notification channel</div>
        <div className="grid grid-cols-5 gap-2">
          {(['email', 'slack', 'ms_teams', 'pagerduty', 'webhook'] as const).map((c) => (
            <RadioCard key={c} label={c.replace('_', ' ')} active={currentChannel === c} onClick={() => pickChannel(c)} />
          ))}
        </div>
      </div>
      {currentChannel === 'email' && (
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Email addresses (comma or newline separated)</label>
          <textarea
            value={(notif.email?.email_addresses || []).join('\n')}
            onChange={(e) => setNotif({ email: { email_addresses: e.target.value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) } })}
            rows={3}
            className="w-full text-sm font-mono border border-gray-300 rounded px-2 py-1.5"
            placeholder="alice@example.com&#10;bob@example.com"
          />
        </div>
      )}
      {currentChannel === 'slack' && (
        <div className="space-y-2">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Slack channel</label>
            <input
              type="text"
              value={notif.slack?.slack_channel_name || ''}
              onChange={(e) => setNotif({ slack: { ...notif.slack!, slack_channel_name: e.target.value } })}
              placeholder="#data-alerts"
              className="w-full text-sm font-mono border border-gray-300 rounded px-2 py-1.5"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Slack workspace (optional)</label>
            <input
              type="text"
              value={notif.slack?.slack_workspace_name || ''}
              onChange={(e) => setNotif({ slack: { ...notif.slack!, slack_workspace_name: e.target.value } })}
              placeholder="acme"
              className="w-full text-sm font-mono border border-gray-300 rounded px-2 py-1.5"
            />
          </div>
        </div>
      )}
      {currentChannel === 'ms_teams' && (
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">MS Teams webhook URL</label>
          <input
            type="text"
            value={notif.ms_teams?.ms_teams_webhook_url || ''}
            onChange={(e) => setNotif({ ms_teams: { ms_teams_webhook_url: e.target.value } })}
            className="w-full text-sm font-mono border border-gray-300 rounded px-2 py-1.5"
            placeholder="https://outlook.office.com/webhook/..."
          />
        </div>
      )}
      {currentChannel === 'pagerduty' && (
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">PagerDuty integration key</label>
          <input
            type="text"
            value={notif.pagerduty?.integration_key || ''}
            onChange={(e) => setNotif({ pagerduty: { integration_key: e.target.value } })}
            className="w-full text-sm font-mono border border-gray-300 rounded px-2 py-1.5"
          />
        </div>
      )}
      {currentChannel === 'webhook' && (
        <div className="space-y-2">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Webhook URL</label>
            <input
              type="text"
              value={notif.webhook?.url || ''}
              onChange={(e) => setNotif({ webhook: { ...notif.webhook!, url: e.target.value } })}
              placeholder="https://example.com/dagster-alerts"
              className="w-full text-sm font-mono border border-gray-300 rounded px-2 py-1.5"
            />
          </div>
        </div>
      )}
      {currentChannel === null && (
        <p className="text-xs text-gray-500 italic">
          No notification channel selected. The policy will be saved but won't route anywhere until you pick one.
        </p>
      )}
    </div>
  );
}

// ---------- Step 4: Details & review -----------------------------------

function Step4Review({ draft, setDraft }: { draft: AlertPolicy; setDraft: (d: AlertPolicy) => void }) {
  const { currentProject } = useProjectStore();
  const [yamlPreview, setYamlPreview] = useState<string>('');
  useEffect(() => {
    if (!currentProject) return;
    alertsApi.preview(currentProject.id, [draft]).then((r) => setYamlPreview(r.yaml)).catch(() => setYamlPreview(''));
  }, [currentProject, draft]);

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Policy name (snake_case)</label>
        <input
          type="text"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="orders_pipeline_failures"
          className="w-full text-sm font-mono border border-gray-300 rounded px-2 py-1.5"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Description (optional)</label>
        <textarea
          value={draft.description || ''}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          rows={2}
          className="w-full text-sm border border-gray-300 rounded px-2 py-1.5"
          placeholder="Human-readable description of what this alert catches"
        />
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-800">
        <input type="checkbox" checked={draft.enabled !== false} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
        Enabled
      </label>
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs font-medium text-gray-700">YAML preview</label>
          <button
            onClick={() => { navigator.clipboard.writeText(yamlPreview); notify.success('YAML copied'); }}
            className="inline-flex items-center gap-1 text-[11px] text-blue-700 hover:text-blue-900"
          >
            <Copy className="w-3 h-3" /> Copy
          </button>
        </div>
        <pre className="text-[11px] font-mono bg-gray-900 text-gray-100 rounded p-3 overflow-x-auto max-h-64 whitespace-pre">
          {yamlPreview || '# generating preview…'}
        </pre>
      </div>
    </div>
  );
}

// ---------- Sync dialog -----------------------------------------------

function SyncDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { currentProject } = useProjectStore();
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  if (!currentProject) return null;

  const doPush = async () => {
    if (!confirmed) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await alertsApi.syncToCloud(currentProject.id, true);
      setResult({ ok: r.success, msg: r.detail });
      if (r.success) onDone();
    } catch (e: any) {
      setResult({ ok: false, msg: e?.response?.data?.detail || e?.message || 'Push failed.' });
    } finally {
      setBusy(false);
    }
  };
  const doPull = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await alertsApi.syncFromCloud(currentProject.id);
      setResult({ ok: true, msg: `Pulled ${r.policies.length} ${r.policies.length === 1 ? 'policy' : 'policies'} into ${r.path}.` });
      onDone();
    } catch (e: any) {
      setResult({ ok: false, msg: e?.response?.data?.detail || e?.message || 'Pull failed.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <Cloud className="w-4 h-4 text-blue-600" />
            Sync alerts with Dagster+
          </h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="p-3 bg-amber-50 border border-amber-300 rounded text-xs text-amber-900 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-600" />
            <div>
              <strong>Extreme caution.</strong> There's only one canonical set of alerts per Dagster+ deployment.
              Pushing REPLACES the entire set on Dagster+ with what's in your local YAML. Any policy that exists
              in Dagster+ but not in the file will be deleted. Pulling REPLACES your local YAML with what's currently
              live on Dagster+.
            </div>
          </div>

          <div className="p-3 border border-gray-200 rounded">
            <div className="text-sm font-medium text-gray-900 mb-1 flex items-center gap-1.5">
              <Upload className="w-4 h-4 text-blue-600" /> Push local → Dagster+
            </div>
            <p className="text-xs text-gray-600 mb-2">Runs <code className="font-mono">dg api alert-policy sync</code> against your local alerts YAML.</p>
            <label className="flex items-center gap-2 text-xs text-gray-800 mb-2">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              I understand this will overwrite the entire alert set on the Dagster+ deployment.
            </label>
            <button
              onClick={doPush}
              disabled={!confirmed || busy}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
              Push to Dagster+
            </button>
          </div>

          <div className="p-3 border border-gray-200 rounded">
            <div className="text-sm font-medium text-gray-900 mb-1 flex items-center gap-1.5">
              <Download className="w-4 h-4 text-emerald-600" /> Pull Dagster+ → local
            </div>
            <p className="text-xs text-gray-600 mb-2">Overwrites your local YAML with whatever's currently live on the deployment.</p>
            <button
              onClick={doPull}
              disabled={busy}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
              Pull from Dagster+
            </button>
          </div>

          {result && (
            <div className={`p-3 rounded text-xs ${result.ok ? 'bg-emerald-50 border border-emerald-200 text-emerald-900' : 'bg-rose-50 border border-rose-200 text-rose-900'}`}>
              {result.msg}
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-gray-200 flex justify-end">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded">Close</button>
        </div>
      </div>
    </div>
  );
}

// ---------- Small primitives ------------------------------------------

function RadioCard({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`text-left p-2 rounded border-2 text-sm capitalize transition ${active ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300 bg-white'}`}
    >
      {label}
    </button>
  );
}

function MultiPicker({ all, selected, onChange }: { all: string[]; selected: string[]; onChange: (next: string[]) => void }) {
  const [q, setQ] = useState('');
  const shown = q ? all.filter((a) => a.toLowerCase().includes(q.toLowerCase())) : all;
  const sel = new Set(selected);
  return (
    <div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search asset keys…"
        className="w-full text-xs border border-gray-300 rounded px-2 py-1 mb-1.5"
      />
      <div className="max-h-40 overflow-y-auto border border-gray-200 rounded bg-white">
        {shown.slice(0, 200).map((a) => {
          const isSel = sel.has(a);
          return (
            <label key={a} className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-gray-50 cursor-pointer">
              <input
                type="checkbox"
                checked={isSel}
                onChange={() => {
                  const next = new Set(sel);
                  if (isSel) next.delete(a); else next.add(a);
                  onChange(Array.from(next).sort());
                }}
              />
              <span className="font-mono">{a}</span>
            </label>
          );
        })}
        {shown.length === 0 && <div className="p-3 text-xs text-gray-500 italic">No matches.</div>}
      </div>
    </div>
  );
}

function TagsEditor({ label, tags, onChange }: { label: string; tags: Record<string, string> | null; onChange: (next: Record<string, string> | null) => void }) {
  const entries = Object.entries(tags || {});
  const [k, setK] = useState('');
  const [v, setV] = useState('');
  const add = () => {
    if (!k.trim()) return;
    const next = { ...(tags || {}), [k.trim()]: v };
    onChange(next);
    setK(''); setV('');
  };
  const remove = (kk: string) => {
    const next = { ...(tags || {}) };
    delete next[kk];
    onChange(Object.keys(next).length ? next : null);
  };
  return (
    <div>
      <div className="text-xs font-medium text-gray-700 mb-1">{label}</div>
      {entries.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {entries.map(([kk, vv]) => (
            <span key={kk} className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-mono bg-gray-100 border border-gray-200 rounded">
              {kk}={vv}
              <button onClick={() => remove(kk)} className="opacity-60 hover:opacity-100"><X className="w-2.5 h-2.5" /></button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-1">
        <input value={k} onChange={(e) => setK(e.target.value)} placeholder="key" className="flex-1 text-xs border border-gray-300 rounded px-2 py-1 font-mono" />
        <input value={v} onChange={(e) => setV(e.target.value)} placeholder="value" className="flex-1 text-xs border border-gray-300 rounded px-2 py-1 font-mono" />
        <button onClick={add} className="px-2 text-xs font-medium text-blue-700 hover:bg-blue-50 rounded">Add</button>
      </div>
    </div>
  );
}

// ---------- helpers ---------------------------------------------------

function deepClone<T>(x: T): T { return JSON.parse(JSON.stringify(x)); }

function blankPolicy(type: AlertPolicyType): AlertPolicy {
  const base: AlertPolicy = { name: '', type, enabled: true, notification_service: {} };
  return withType(base, type);
}

function withType(p: AlertPolicy, type: AlertPolicyType): AlertPolicy {
  // Reset the type-specific sub-config so no stale fields leak into the YAML.
  const clean: AlertPolicy = { ...p, type, asset: null, run: null, code_location: null, automation: null, agent_downtime: null, insight_metric: null };
  if (type === 'asset')          clean.asset = { asset_selection: '*', events: [] };
  if (type === 'run')            clean.run = { events: [] };
  if (type === 'code_location')  clean.code_location = {};
  if (type === 'automation')     clean.automation = { events: ['tick_failure'], include_schedules: true, include_sensors: true };
  if (type === 'agent_downtime') clean.agent_downtime = {};
  if (type === 'insight_metric') clean.insight_metric = { metric: '', comparison: 'gt', threshold: 0 };
  return clean;
}

function withAsset(p: AlertPolicy, asset: NonNullable<AlertPolicy['asset']>): AlertPolicy {
  return { ...p, asset };
}
function withRun(p: AlertPolicy, run: NonNullable<AlertPolicy['run']>): AlertPolicy {
  return { ...p, run };
}
function withAutomation(p: AlertPolicy, automation: NonNullable<AlertPolicy['automation']>): AlertPolicy {
  return { ...p, automation };
}
function withInsightMetric(p: AlertPolicy, insight_metric: NonNullable<AlertPolicy['insight_metric']>): AlertPolicy {
  return { ...p, insight_metric };
}

function isTargetsValid(p: AlertPolicy): boolean {
  switch (p.type) {
    case 'asset':          return (p.asset?.events?.length || 0) > 0;
    case 'run':            return (p.run?.events?.length || 0) > 0;
    case 'code_location':  return true;
    case 'automation':     return (p.automation?.events?.length || 0) > 0;
    case 'agent_downtime': return true;
    case 'insight_metric': return !!p.insight_metric?.metric && p.insight_metric?.threshold !== null && p.insight_metric?.threshold !== undefined;
  }
}
