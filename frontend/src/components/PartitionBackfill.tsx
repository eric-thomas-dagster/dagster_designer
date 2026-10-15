import { useState, useEffect, useMemo } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import Editor from '@monaco-editor/react';
import { X, Play, AlertCircle, AlertTriangle, Calendar, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import yaml from 'js-yaml';
import {
  partitionsApi,
  type PartitionDef,
  type BackfillRequest,
  type PartitionStatusResponse,
} from '@/services/api';
import { useIsDarkMode } from '@/hooks/useIsDarkMode';

interface PartitionBackfillProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  assetKey: string;
  onLaunch: (request: BackfillRequest) => Promise<void>;
  /** Overrides the default "Materialize <assetKey>" heading. */
  title?: string;
  /** One line under the title, e.g. what the launch will cover. */
  description?: string;
  launchLabel?: string;
}

type QuickFilter = 'latest' | 'all' | 'missing' | 'failed' | 'custom';

/**
 * A selection is a list of runs: a contiguous span of partition keys, or a
 * single key (start === end). Each run is ONE `dg launch` -- a range costs
 * the same however many partitions it spans -- which is what keeps
 * selections tractable when a Dagster+ asset has hundreds of thousands of
 * partitions. `count` is null when it can't be known client-side (the key
 * list is only a sample).
 */
interface Run {
  start: string;
  end: string;
  count: number | null;
}

// More separate launches than this is almost certainly a mistake (e.g.
// hand-picking scattered keys) -- point the user at a range instead.
const MAX_LAUNCHES = 200;
const WARN_LAUNCHES = 10;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function daysBetweenInclusive(a: string, b: string): number | null {
  if (!DATE_RE.test(a) || !DATE_RE.test(b)) return null;
  const diff = (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
  return Number.isFinite(diff) ? diff + 1 : null;
}

/** Contiguous runs (by position in the key list) of the given keys. */
function compressKeys(selected: Set<string>, allKeys: string[]): Run[] {
  const runs: Run[] = [];
  let startIdx: number | null = null;
  for (let i = 0; i <= allKeys.length; i++) {
    const on = i < allKeys.length && selected.has(allKeys[i]);
    if (on && startIdx === null) startIdx = i;
    if (!on && startIdx !== null) {
      runs.push({ start: allKeys[startIdx], end: allKeys[i - 1], count: i - startIdx });
      startIdx = null;
    }
  }
  return runs;
}

/**
 * Parse "k1, k2, [a...b], c...d" into runs. With a full key list
 * (keyIndex) every key is validated and ranges are counted exactly;
 * without one (sampled list) tokens are trusted and `dg` validates them.
 */
function parseExpression(
  text: string,
  keyIndex: Map<string, number> | null,
): { runs: Run[]; invalid: string[] } {
  const runs: Run[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const token = raw.trim().replace(/^\[|\]$/g, '').trim();
    if (!token) continue;
    if (token.includes('...')) {
      const [a, b] = token.split('...').map((x) => x.trim());
      if (!a || !b) { invalid.push(token); continue; }
      if (keyIndex) {
        const ia = keyIndex.get(a);
        const ib = keyIndex.get(b);
        if (ia === undefined || ib === undefined) { invalid.push(token); continue; }
        if (ib < ia) { invalid.push(`${token} (end is before start)`); continue; }
        runs.push({ start: a, end: b, count: ib - ia + 1 });
      } else {
        const n = daysBetweenInclusive(a, b);
        if (n !== null && n < 1) { invalid.push(`${token} (end is before start)`); continue; }
        runs.push({ start: a, end: b, count: n });
      }
    } else if (keyIndex && !keyIndex.has(token)) {
      invalid.push(token);
    } else {
      runs.push({ start: token, end: token, count: 1 });
    }
  }
  return { runs, invalid };
}

function runsToExpression(runs: Run[]): string {
  return runs.map((r) => (r.start === r.end ? r.start : `[${r.start}...${r.end}]`)).join(', ');
}

export function PartitionBackfill({
  open,
  onOpenChange,
  projectId,
  assetKey,
  onLaunch,
  title,
  description,
  launchLabel = 'Launch',
}: PartitionBackfillProps) {
  const isDark = useIsDarkMode();
  const [partitionDef, setPartitionDef] = useState<PartitionDef | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Selection state
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('latest');
  // Free-form expression ("a, b, [c...d]") -- the source of truth for Custom
  // in the calendar / dropdown / expression modes.
  const [partitionInput, setPartitionInput] = useState('');
  // Checked keys for the checklist mode (static/dynamic/multi, full key list).
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [keyFilter, setKeyFilter] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  // Per-partition materialization status (needs the local `dg dev` server
  // for its GraphQL). Best-effort: without it, Missing/Failed are hidden.
  const [partitionStatus, setPartitionStatus] = useState<PartitionStatusResponse | null>(null);

  // Config and tags
  const [configYaml, setConfigYaml] = useState<string>('');
  const [tags, setTags] = useState<Record<string, string>>({});
  const [newTagKey, setNewTagKey] = useState('');
  const [newTagValue, setNewTagValue] = useState('');
  const [showTagEditor, setShowTagEditor] = useState(false);
  const [showConfigEditor, setShowConfigEditor] = useState(false);

  // Launch state
  const [isLaunching, setIsLaunching] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  // Load partition info when the dialog opens
  useEffect(() => {
    if (!(open && projectId && assetKey)) return;
    setLoading(true);
    setError(null);
    setQuickFilter('latest');
    setPartitionInput('');
    setChecked(new Set());
    setKeyFilter('');

    partitionsApi
      .getPartitionInfo(projectId, assetKey)
      .then((response) => {
        if (response.is_partitioned && response.partitions_def) {
          setPartitionDef(response.partitions_def);
          const keys = response.partitions_def.partition_keys || [];
          setStartDate(keys[0] || '');
          setEndDate(keys[keys.length - 1] || '');
        } else {
          setError('This asset is not partitioned');
        }
      })
      .catch((err) => setError(`Failed to load partition info: ${err.message}`))
      .finally(() => setLoading(false));
  }, [open, projectId, assetKey]);

  useEffect(() => {
    if (!open || !projectId || !assetKey) return;
    let cancelled = false;
    setPartitionStatus(null);
    partitionsApi
      .getPartitionStatus(projectId, assetKey)
      .then((r) => { if (!cancelled && r.is_partitioned && r.supported) setPartitionStatus(r); })
      .catch(() => { /* dg dev not up yet -- Missing/Failed stay hidden */ });
    return () => { cancelled = true; };
  }, [open, projectId, assetKey]);

  // ---- Derived partition-set facts --------------------------------------
  const allKeys = partitionDef?.partition_keys || [];
  const totalCount = partitionDef?.partition_count ?? allKeys.length;
  // The backend lists only the first/last 100 keys for huge partition sets.
  const sampled = totalCount > allKeys.length;
  const isTimeWindow = !!partitionDef?.start_date;
  // Daily cadence with plain YYYY-MM-DD keys is the one case where calendar
  // pickers produce valid keys; other cadences pick from real keys.
  const isDailyDates =
    isTimeWindow &&
    (partitionDef?.date_format || '%Y-%m-%d') === '%Y-%m-%d' &&
    /^\S+ \S+ \* \* \*$/.test(partitionDef?.cron_schedule || '0 0 * * *');
  type CustomMode = 'daily' | 'select' | 'checklist' | 'expression' | 'none';
  const customMode: CustomMode =
    isDailyDates ? 'daily'
    : allKeys.length === 0 ? 'none'
    : sampled ? 'expression'
    : isTimeWindow ? 'select'
    : 'checklist';

  const keyIndex = useMemo(
    () => (sampled ? null : new Map(allKeys.map((k, i) => [k, i] as [string, number]))),
    [allKeys, sampled],
  );

  // ---- The selection, as runs --------------------------------------------
  const { runs, invalid } = useMemo<{ runs: Run[]; invalid: string[] }>(() => {
    const none = { runs: [] as Run[], invalid: [] as string[] };
    if (allKeys.length === 0) return none;
    const first = allKeys[0];
    const last = allKeys[allKeys.length - 1];
    switch (quickFilter) {
      case 'latest':
        return { runs: [{ start: last, end: last, count: 1 }], invalid: [] };
      case 'all':
        return {
          runs: [{ start: first, end: last, count: totalCount > 0 ? totalCount : null }],
          invalid: [],
        };
      case 'missing':
      case 'failed': {
        const src = quickFilter === 'missing' ? partitionStatus?.missing_runs : partitionStatus?.failed_runs;
        return { runs: (src || []).map((r) => ({ start: r.start, end: r.end, count: r.count })), invalid: [] };
      }
      case 'custom':
        return customMode === 'checklist'
          ? { runs: compressKeys(checked, allKeys), invalid: [] }
          : parseExpression(partitionInput, keyIndex);
    }
  }, [quickFilter, allKeys, totalCount, partitionStatus, customMode, checked, partitionInput, keyIndex]);

  const knownCount = runs.every((r) => r.count !== null)
    ? runs.reduce((n, r) => n + (r.count ?? 0), 0)
    : null;
  const tooManyLaunches = runs.length > MAX_LAUNCHES;

  // "Custom" starts from whatever the previous option had selected.
  const startCustom = () => {
    if (quickFilter !== 'custom') {
      if (customMode === 'checklist' && keyIndex) {
        const next = new Set<string>();
        for (const r of runs) {
          const a = keyIndex.get(r.start);
          const b = keyIndex.get(r.end);
          if (a !== undefined && b !== undefined) for (let i = a; i <= b; i++) next.add(allKeys[i]);
        }
        setChecked(next);
      } else {
        setPartitionInput(runsToExpression(runs));
        if (runs.length > 0) {
          setStartDate(runs[0].start);
          setEndDate(runs[runs.length - 1].end);
        }
      }
    }
    setQuickFilter('custom');
  };

  const setRange = (from: string, to: string) => {
    setStartDate(from);
    setEndDate(to);
    setPartitionInput(from && to ? `[${from}...${to}]` : '');
  };

  const handleConfigChange = (value: string | undefined) => {
    setConfigYaml(value || '');
    if (!value?.trim()) {
      setErrors([]);
      return;
    }
    try {
      yaml.load(value);
      setErrors([]);
    } catch (err: any) {
      setErrors([err.message]);
    }
  };

  const handleLaunchBackfill = async () => {
    let config: Record<string, any> | undefined;
    try {
      if (configYaml.trim()) config = yaml.load(configYaml) as Record<string, any>;
    } catch (err: any) {
      setErrors([`Invalid YAML: ${err.message}`]);
      return;
    }

    const request: BackfillRequest = {
      asset_keys: [assetKey],
      partition_selection: runs.filter((r) => r.start === r.end).map((r) => r.start),
      partition_ranges: runs.filter((r) => r.start !== r.end).map((r) => ({ start: r.start, end: r.end })),
      config,
      tags: Object.keys(tags).length > 0 ? tags : undefined,
    };

    setIsLaunching(true);
    try {
      await onLaunch(request);
      onOpenChange(false);
    } catch (err: any) {
      setErrors([err.message || 'Backfill launch failed']);
    } finally {
      setIsLaunching(false);
    }
  };

  const addTag = () => {
    const k = newTagKey.trim();
    if (!k) return;
    setTags({ ...tags, [k]: newTagValue.trim() });
    setNewTagKey('');
    setNewTagValue('');
  };

  // ---- Rendering -----------------------------------------------------------
  const inputCls = 'w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary/40';
  const canLaunch = !isLaunching && errors.length === 0 && invalid.length === 0 && runs.length > 0 && !tooManyLaunches;
  const hasAdvanced = Object.keys(tags).length > 0 || configYaml.trim().length > 0;
  const visibleKeys = keyFilter ? allKeys.filter((k) => k.toLowerCase().includes(keyFilter.toLowerCase())) : allKeys;

  const filterBtn = (id: QuickFilter, label: string, count?: number) => (
    <button
      type="button"
      onClick={() => (id === 'custom' ? startCustom() : setQuickFilter(id))}
      className={`flex-1 px-3 py-1.5 text-sm font-medium transition-colors ${
        quickFilter === id ? 'bg-white text-gray-900 shadow-sm rounded-md' : 'text-gray-500 hover:text-gray-700'
      }`}
    >
      {label}
      {count !== undefined && <span className="ml-1 text-xs text-gray-400">{count.toLocaleString()}</span>}
    </button>
  );

  const keyOptions = allKeys.map((k) => <option key={k} value={k}>{k}</option>);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-xl shadow-2xl z-50 w-[92vw] max-w-xl max-h-[88vh] flex flex-col">
          {/* Header */}
          <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4">
            <div className="min-w-0">
              <Dialog.Title className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <Calendar className="w-4 h-4 text-gray-400 flex-shrink-0" />
                <span className="truncate">{title ?? `Materialize ${assetKey}`}</span>
              </Dialog.Title>
              <Dialog.Description className="text-sm text-gray-500 mt-1">
                {description ?? 'Choose which partitions to run.'}
              </Dialog.Description>
            </div>
            <Dialog.Close className="p-1.5 -mr-1.5 -mt-1 hover:bg-gray-100 rounded-md text-gray-400">
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>

          {loading && (
            <div className="px-6 py-12 flex items-center justify-center gap-2 text-sm text-gray-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading partitions…
            </div>
          )}

          {error && <div className="px-6 py-10 text-center text-sm text-red-600">{error}</div>}

          {!loading && !error && partitionDef && (
            <>
              <div className="flex-1 overflow-y-auto px-6 pb-4 space-y-4">
                {/* Partition selection */}
                <div className="space-y-3">
                  <div className="flex p-1 bg-gray-100 rounded-lg">
                    {filterBtn('latest', 'Latest')}
                    {filterBtn('all', 'All')}
                    {/* Missing/Failed only appear when there are some (they need
                        partition status, so they're also absent until the local
                        dg dev server is up). */}
                    {(partitionStatus?.missing ?? 0) > 0 && filterBtn('missing', 'Missing', partitionStatus!.missing)}
                    {(partitionStatus?.failed ?? 0) > 0 && filterBtn('failed', 'Failed', partitionStatus!.failed)}
                    {filterBtn('custom', 'Custom')}
                  </div>

                  {quickFilter === 'custom' && (
                    <>
                      {/* Daily time-window: calendar pickers. Work however large
                          the set is -- the range goes to dg as-is. */}
                      {customMode === 'daily' && (
                        <div className="space-y-3">
                          <div className="grid grid-cols-2 gap-3">
                            <label className="block">
                              <span className="block text-xs font-medium text-gray-600 mb-1">From</span>
                              <input
                                type="date"
                                value={startDate}
                                onChange={(e) => setRange(e.target.value, endDate || e.target.value)}
                                className={inputCls}
                              />
                            </label>
                            <label className="block">
                              <span className="block text-xs font-medium text-gray-600 mb-1">To</span>
                              <input
                                type="date"
                                value={endDate}
                                onChange={(e) => setRange(startDate || e.target.value, e.target.value)}
                                className={inputCls}
                              />
                            </label>
                          </div>
                          <label className="block">
                            <span className="block text-xs font-medium text-gray-600 mb-1">
                              Or specific dates / ranges
                            </span>
                            <input
                              type="text"
                              value={partitionInput}
                              onChange={(e) => setPartitionInput(e.target.value)}
                              placeholder="2026-09-01, 2026-09-05  or  [2026-09-01...2026-09-30]"
                              className={`${inputCls} font-mono`}
                            />
                          </label>
                        </div>
                      )}

                      {/* Hourly / weekly / monthly...: dates would give keys that
                          don't exist, so pick from the real ones. */}
                      {customMode === 'select' && (
                        <div className="grid grid-cols-2 gap-3">
                          <label className="block">
                            <span className="block text-xs font-medium text-gray-600 mb-1">From</span>
                            <select
                              value={startDate}
                              onChange={(e) => setRange(e.target.value, endDate || e.target.value)}
                              className={inputCls}
                            >
                              {keyOptions}
                            </select>
                          </label>
                          <label className="block">
                            <span className="block text-xs font-medium text-gray-600 mb-1">To</span>
                            <select
                              value={endDate}
                              onChange={(e) => setRange(startDate || e.target.value, e.target.value)}
                              className={inputCls}
                            >
                              {keyOptions}
                            </select>
                          </label>
                        </div>
                      )}

                      {/* Static / dynamic / multi-dimensional with a full key list. */}
                      {customMode === 'checklist' && (
                        <div className="border border-gray-200 rounded-md">
                          <div className="flex items-center gap-2 p-2 border-b border-gray-100">
                            <input
                              value={keyFilter}
                              onChange={(e) => setKeyFilter(e.target.value)}
                              placeholder={`Filter ${allKeys.length.toLocaleString()} partitions…`}
                              className={`${inputCls} !py-1.5`}
                            />
                            <button
                              type="button"
                              onClick={() => setChecked(new Set([...checked, ...visibleKeys]))}
                              className="px-2 text-xs text-primary hover:underline whitespace-nowrap"
                            >
                              Select {keyFilter ? 'shown' : 'all'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setChecked(new Set())}
                              className="px-2 text-xs text-gray-500 hover:underline"
                            >
                              Clear
                            </button>
                          </div>
                          <div className="max-h-48 overflow-y-auto p-1">
                            {visibleKeys.length === 0 ? (
                              <div className="px-2 py-3 text-xs text-gray-400">No partitions match.</div>
                            ) : (
                              visibleKeys.map((k) => (
                                <label key={k} className="flex items-center gap-2 px-2 py-1 text-sm rounded hover:bg-gray-50 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={checked.has(k)}
                                    onChange={(e) => {
                                      const next = new Set(checked);
                                      if (e.target.checked) next.add(k); else next.delete(k);
                                      setChecked(next);
                                    }}
                                  />
                                  <span className="font-mono text-xs truncate">{k}</span>
                                </label>
                              ))
                            )}
                          </div>
                        </div>
                      )}

                      {/* Too many partitions to list (a sample is all we have):
                          type keys and/or ranges, which dg validates. */}
                      {customMode === 'expression' && (
                        <div className="space-y-1.5">
                          <textarea
                            value={partitionInput}
                            onChange={(e) => setPartitionInput(e.target.value)}
                            rows={3}
                            placeholder={`${allKeys[0]}, ${allKeys[1] ?? allKeys[0]}  or  [${allKeys[0]}...${allKeys[allKeys.length - 1]}]`}
                            className={`${inputCls} font-mono`}
                          />
                          <p className="text-xs text-gray-500">
                            {totalCount.toLocaleString()} partitions -- too many to list. Enter keys, or a range like{' '}
                            <span className="font-mono">[first...last]</span> (one launch, however many partitions it covers).
                          </p>
                        </div>
                      )}

                      {customMode === 'none' && (
                        <p className="text-sm text-gray-500">
                          {partitionDef.type.includes('Dynamic')
                            ? 'No partitions exist yet -- dynamic partitions are added at runtime (by a sensor or an earlier run).'
                            : 'No partition keys could be listed for this asset.'}
                        </p>
                      )}

                      {invalid.length > 0 && (
                        <p className="text-xs text-red-600 break-words">
                          Not a valid partition: {invalid.slice(0, 5).join(', ')}
                          {invalid.length > 5 && ` (+${invalid.length - 5} more)`}
                        </p>
                      )}
                    </>
                  )}

                  {/* Summary of what will run */}
                  <div className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-gray-700 min-w-0">
                        {runs.length === 0 ? (
                          <span className="text-gray-400">No partitions selected</span>
                        ) : knownCount === 1 ? (
                          <>Partition <span className="font-mono font-medium">{runs[0].start}</span></>
                        ) : knownCount !== null ? (
                          <>
                            <span className="font-medium">{knownCount.toLocaleString()}</span> partitions
                            <span className="font-mono text-xs text-gray-500">
                              {' '}· {runs[0].start} → {runs[runs.length - 1].end}
                            </span>
                          </>
                        ) : runs.length === 1 ? (
                          <>Range <span className="font-mono text-xs">{runs[0].start} → {runs[0].end}</span></>
                        ) : (
                          <>{runs.length} selections</>
                        )}
                      </span>
                      <span className="text-xs text-gray-400 whitespace-nowrap">
                        {totalCount.toLocaleString()} total
                      </span>
                    </div>
                    {runs.length > 1 && !tooManyLaunches && (
                      <div className={`mt-1 flex items-center gap-1.5 text-xs ${runs.length > WARN_LAUNCHES ? 'text-amber-600' : 'text-gray-500'}`}>
                        {runs.length > WARN_LAUNCHES && <AlertTriangle className="w-3.5 h-3.5" />}
                        Starts {runs.length} separate launches (contiguous partitions run together as one).
                      </div>
                    )}
                    {tooManyLaunches && (
                      <div className="mt-1 flex items-center gap-1.5 text-xs text-red-600">
                        <AlertCircle className="w-3.5 h-3.5" />
                        {runs.length.toLocaleString()} separate launches is too many -- pick contiguous ranges instead.
                      </div>
                    )}
                  </div>
                </div>

                {/* Advanced: tags + config, collapsed unless already in use */}
                <div className="border-t border-gray-100 pt-3">
                  <button
                    type="button"
                    onClick={() => setShowTagEditor(!showTagEditor)}
                    className="flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
                  >
                    {showTagEditor || hasAdvanced ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    Advanced options
                    {hasAdvanced && <span className="ml-1 text-xs text-primary">(in use)</span>}
                  </button>

                  {(showTagEditor || hasAdvanced) && (
                    <div className="mt-3 space-y-4">
                      <div>
                        <div className="text-xs font-medium text-gray-600 mb-1.5">Run tags</div>
                        {Object.keys(tags).length > 0 && (
                          <div className="flex gap-1.5 flex-wrap mb-2">
                            {Object.entries(tags).map(([key, value]) => (
                              <span key={key} className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 rounded text-xs">
                                <span className="text-gray-500">{key}:</span>
                                <span>{value}</span>
                                <button
                                  type="button"
                                  onClick={() => {
                                    const next = { ...tags };
                                    delete next[key];
                                    setTags(next);
                                  }}
                                  className="text-gray-400 hover:text-gray-700"
                                  aria-label={`Remove tag ${key}`}
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                        <div className="flex gap-2">
                          <input
                            value={newTagKey}
                            onChange={(e) => setNewTagKey(e.target.value)}
                            placeholder="key"
                            className={`${inputCls} !py-1.5`}
                          />
                          <input
                            value={newTagValue}
                            onChange={(e) => setNewTagValue(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && addTag()}
                            placeholder="value"
                            className={`${inputCls} !py-1.5`}
                          />
                          <button
                            type="button"
                            onClick={addTag}
                            disabled={!newTagKey.trim()}
                            className="px-3 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-40"
                          >
                            Add
                          </button>
                        </div>
                      </div>

                      <div>
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="text-xs font-medium text-gray-600">Run config (YAML)</div>
                          <button
                            type="button"
                            onClick={() => setShowConfigEditor(!showConfigEditor)}
                            className="text-xs text-primary hover:underline"
                          >
                            {showConfigEditor || configYaml.trim() ? 'Hide' : 'Add config'}
                          </button>
                        </div>
                        {(showConfigEditor || configYaml.trim()) && (
                          <div className="h-44 border border-gray-300 rounded-md overflow-hidden">
                            <Editor
                              height="100%"
                              defaultLanguage="yaml"
                              value={configYaml}
                              onChange={handleConfigChange}
                              theme={isDark ? 'vs-dark' : 'vs-light'}
                              options={{
                                minimap: { enabled: false },
                                fontSize: 13,
                                lineNumbers: 'off',
                                scrollBeyondLastLine: false,
                                automaticLayout: true,
                                tabSize: 2,
                              }}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {errors.length > 0 && (
                  <div className="space-y-1">
                    {errors.map((e, i) => (
                      <div key={i} className="flex items-start gap-2 text-sm text-red-600">
                        <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                        <span className="break-words min-w-0">{e}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-gray-100">
                <button
                  onClick={() => onOpenChange(false)}
                  className="px-4 py-2 text-sm text-gray-700 rounded-md hover:bg-gray-100"
                >
                  Cancel
                </button>
                <button
                  onClick={handleLaunchBackfill}
                  disabled={!canLaunch}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isLaunching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                  {isLaunching ? 'Launching…' : launchLabel}
                </button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
