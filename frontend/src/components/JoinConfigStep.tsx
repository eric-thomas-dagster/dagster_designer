import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Combine, Loader2, ArrowRight, AlertCircle, Play } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { assetsApi, projectsApi } from '@/services/api';
import { notify } from './Notifications';
import { MultiColumnSelect } from './MultiColumnSelect';
import { computeJoinPreview, type JoinHow } from '@/lib/joinPreview';

const HOW_OPTIONS: { id: JoinHow; label: string; description: string }[] = [
  { id: 'inner', label: 'Inner', description: 'Only rows that match on both sides' },
  { id: 'left', label: 'Left', description: 'Every row from the left side, matched right rows or blank' },
  { id: 'right', label: 'Right', description: 'Every row from the right side, matched left rows or blank' },
  { id: 'outer', label: 'Outer', description: 'Every row from both sides' },
  { id: 'cross', label: 'Cross', description: 'Every combination of left × right rows (no keys)' },
];

/**
 * Join builder -- pick a second existing asset, pick the join type and
 * keys, see a live (sample-based) preview, then save as a new
 * dataframe_join asset. Mirrors the Trifacta-style "operations on the
 * left, preview on the right" layout the real Transform UI uses, but this
 * is its own screen rather than a DataPreviewModal op: a join fundamentally
 * needs a SECOND upstream, which the single-asset transformer components
 * can't express.
 */
export function JoinConfigStep({
  initialLeftAssetKey,
  onDone,
  onClose,
}: {
  initialLeftAssetKey?: string;
  onDone: () => void;
  onClose: () => void;
}) {
  const { currentProject, loadProject } = useProjectStore();
  const [leftAssetKey, setLeftAssetKey] = useState<string>(initialLeftAssetKey || '');
  const [rightAssetKey, setRightAssetKey] = useState<string>('');
  const [how, setHow] = useState<JoinHow>('inner');
  const [keyMode, setKeyMode] = useState<'same' | 'different'>('same');
  const [onColumn, setOnColumn] = useState<string>('');
  const [leftOnColumn, setLeftOnColumn] = useState<string>('');
  const [rightOnColumn, setRightOnColumn] = useState<string>('');
  const [assetName, setAssetName] = useState<string>('');
  const [saving, setSaving] = useState(false);

  const existingAssets = useMemo(() => {
    if (!currentProject) return [];
    return currentProject.graph.nodes
      .filter((n) => n.type === 'asset' || (n.data as any)?.asset_key)
      .map((n) => ({
        assetKey: (n.data as any)?.asset_key || n.id,
        label: (n.data as any)?.label || (n.data as any)?.asset_key || n.id,
      }));
  }, [currentProject]);

  const leftOptions = existingAssets;
  const rightOptions = useMemo(() => existingAssets.filter((a) => a.assetKey !== leftAssetKey), [existingAssets, leftAssetKey]);

  const leftPreview = useQuery({
    queryKey: ['join-left-preview', currentProject?.id, leftAssetKey],
    queryFn: () => assetsApi.previewData(currentProject!.id, leftAssetKey, { sampleLimit: 50 }),
    enabled: !!currentProject && !!leftAssetKey,
  });
  const rightPreview = useQuery({
    queryKey: ['join-right-preview', currentProject?.id, rightAssetKey],
    queryFn: () => assetsApi.previewData(currentProject!.id, rightAssetKey, { sampleLimit: 50 }),
    enabled: !!currentProject && !!rightAssetKey,
  });

  const leftColumns = leftPreview.data?.columns || [];
  const rightColumns = rightPreview.data?.columns || [];
  const sharedColumns = useMemo(() => leftColumns.filter((c) => rightColumns.includes(c)), [leftColumns, rightColumns]);

  // Both sides run their asset function fresh to read real columns (no
  // materialization required) -- while that's in flight, or if one side's
  // execution genuinely fails, the column pickers below would otherwise
  // just render as empty selects with no explanation, indistinguishable
  // from "broken" (confirmed live: this read as "columns never load").
  const columnsLoading = (!!leftAssetKey && leftPreview.isLoading) || (!!rightAssetKey && rightPreview.isLoading);
  // Which side is actually failing -- so the "materialize it for me" button
  // below targets the right asset key, not a guess. A required-resource
  // asset (e.g. a warehouse sink) can't be previewed via a live in-process
  // call at all -- the preview endpoint deliberately won't open a real
  // connection -- but it CAN read an already-materialized destination
  // directly, so materializing once here is the actual fix, not a
  // workaround; this is the exact same preview call the Transform UI uses,
  // there's no separate/smarter path it has that this one lacks.
  const columnsErrorSide: 'left' | 'right' | null =
    (leftPreview.data?.success === false || leftPreview.error) ? 'left'
      : (rightPreview.data?.success === false || rightPreview.error) ? 'right'
        : null;
  const columnsErrorMessage = columnsErrorSide === 'left'
    ? (leftPreview.data?.error || (leftPreview.error as Error | null)?.message || 'failed to preview')
    : columnsErrorSide === 'right'
      ? (rightPreview.data?.error || (rightPreview.error as Error | null)?.message || 'failed to preview')
      : null;

  const [materializing, setMaterializing] = useState<'left' | 'right' | null>(null);
  const handleMaterialize = async (side: 'left' | 'right') => {
    if (!currentProject) return;
    const key = side === 'left' ? leftAssetKey : rightAssetKey;
    if (!key || materializing) return;
    setMaterializing(side);
    try {
      const result = await projectsApi.materialize(currentProject.id, [`+${key}`]);
      if (result.success) {
        notify.success(`Materialized ${key}.`);
        (side === 'left' ? leftPreview : rightPreview).refetch();
      } else {
        const tail = (result.stderr || result.stdout || '').split('\n').slice(-4).join(' | ');
        notify.error(`Materialize failed: ${tail || 'unknown error'}`);
      }
    } catch (e) {
      notify.error(`Materialize failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMaterializing(null);
    }
  };

  const needsKeys = how !== 'cross';
  const keysReady = !needsKeys || (keyMode === 'same' ? !!onColumn : !!leftOnColumn && !!rightOnColumn);
  const canSave = !!leftAssetKey && !!rightAssetKey && assetName.trim().length > 0 && keysReady;

  const preview = useMemo(() => {
    if (!leftPreview.data?.data || !rightPreview.data?.data || !keysReady) return null;
    return computeJoinPreview({
      leftRows: leftPreview.data.data,
      leftColumns,
      rightRows: rightPreview.data.data,
      rightColumns,
      how,
      on: needsKeys && keyMode === 'same' ? [onColumn] : undefined,
      leftOn: needsKeys && keyMode === 'different' ? [leftOnColumn] : undefined,
      rightOn: needsKeys && keyMode === 'different' ? [rightOnColumn] : undefined,
      maxRows: 100,
    });
  }, [leftPreview.data, rightPreview.data, leftColumns, rightColumns, how, keyMode, onColumn, leftOnColumn, rightOnColumn, keysReady, needsKeys]);

  // Which of the joined result's columns to actually keep -- defaults to
  // "everything" (empty array = no restriction, matching the backend's
  // keep_only_columns=None meaning "keep all") the first time a real
  // preview resolves, then only becomes a real filter once the user
  // deselects something. Reset whenever the join shape changes (a
  // different key/how can rename columns via suffixing), since a stale
  // keep-list from a previous shape could silently drop a column that
  // still exists under the same name by coincidence.
  const [keepColumns, setKeepColumns] = useState<string[]>([]);
  const [keepColumnsTouched, setKeepColumnsTouched] = useState(false);
  useEffect(() => {
    setKeepColumnsTouched(false);
    setKeepColumns(preview?.columns || []);
  }, [preview?.columns.join(',')]);

  const displayColumns = useMemo(() => {
    if (!preview) return [];
    return keepColumnsTouched ? preview.columns.filter((c) => keepColumns.includes(c)) : preview.columns;
  }, [preview, keepColumnsTouched, keepColumns]);

  // Rename map for conflict columns only (e.g. "name_x" -> "customer_name")
  // -- keyed by the ORIGINAL (pre-rename) column name throughout, so
  // keep/shading logic never has to chase a moving target. Reset whenever
  // the join shape changes, same reasoning as keepColumns above.
  const [renameMap, setRenameMap] = useState<Record<string, string>>({});
  useEffect(() => {
    setRenameMap({});
  }, [preview?.conflictColumns.join(',')]);
  const displayName = (c: string) => renameMap[c]?.trim() || c;
  // Only real, non-empty renames -- an untouched or blanked-out input
  // should fall back to the original name, not send an empty string.
  const effectiveRenameMap = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [from, to] of Object.entries(renameMap)) {
      const trimmed = to.trim();
      if (trimmed && trimmed !== from) out[from] = trimmed;
    }
    return out;
  }, [renameMap]);

  const handleSave = async () => {
    if (!currentProject || !canSave || saving) return;
    setSaving(true);
    try {
      await assetsApi.createJoinAsset(currentProject.id, {
        leftAssetKey,
        rightAssetKey,
        newAssetName: assetName.trim(),
        how,
        on: needsKeys && keyMode === 'same' ? [onColumn] : undefined,
        leftOn: needsKeys && keyMode === 'different' ? [leftOnColumn] : undefined,
        rightOn: needsKeys && keyMode === 'different' ? [rightOnColumn] : undefined,
        // dataframe_join applies rename BEFORE keep_only_columns, so a kept
        // column that was also renamed has to be referenced by its NEW
        // name -- the component's own exact-match resolution wouldn't find
        // the old "name_x" once it's been renamed to "customer_name".
        rename: Object.keys(effectiveRenameMap).length > 0 ? effectiveRenameMap : undefined,
        keepColumns: keepColumnsTouched && preview && keepColumns.length < preview.columns.length
          ? keepColumns.map((c) => effectiveRenameMap[c] || c)
          : undefined,
        leftColumns,
        rightColumns,
      });
      notify.success(`Created "${assetName.trim()}" — joining ${leftAssetKey} and ${rightAssetKey}.`);
      await loadProject(currentProject.id);
      onDone();
    } catch (e: any) {
      notify.error(`Failed to create join: ${e?.response?.data?.detail ?? e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60]">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <Combine className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">Join two assets</h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>

        <div className="flex-1 overflow-hidden grid grid-cols-1 sm:grid-cols-[380px_1fr]">
          <div className="space-y-4 overflow-y-auto px-6 py-4 border-r border-gray-100">
            <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Left asset</label>
                <select
                  value={leftAssetKey}
                  onChange={(e) => { setLeftAssetKey(e.target.value); setOnColumn(''); setLeftOnColumn(''); }}
                  className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md bg-white font-mono"
                >
                  <option value="" disabled>pick one</option>
                  {leftOptions.map((a) => <option key={a.assetKey} value={a.assetKey}>{a.label}</option>)}
                </select>
              </div>
              <ArrowRight className="w-4 h-4 text-gray-300 mb-2" />
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Right asset</label>
                <select
                  value={rightAssetKey}
                  onChange={(e) => { setRightAssetKey(e.target.value); setOnColumn(''); setRightOnColumn(''); }}
                  className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md bg-white font-mono"
                >
                  <option value="" disabled>pick one</option>
                  {rightOptions.map((a) => <option key={a.assetKey} value={a.assetKey}>{a.label}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Join type</label>
              <div className="grid grid-cols-2 gap-1.5">
                {HOW_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => setHow(opt.id)}
                    title={opt.description}
                    className={`px-2 py-1.5 text-xs rounded-md border text-left ${how === opt.id ? 'bg-primary text-primary-foreground border-primary' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-gray-400 mt-1">{HOW_OPTIONS.find((o) => o.id === how)?.description}</p>
            </div>

            {needsKeys && (
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Join on</label>
                <div className="flex gap-2 mb-2">
                  <button
                    onClick={() => setKeyMode('same')}
                    className={`flex-1 px-2 py-1 text-xs rounded-md border ${keyMode === 'same' ? 'bg-primary text-primary-foreground border-primary' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                  >
                    Same column name
                  </button>
                  <button
                    onClick={() => setKeyMode('different')}
                    className={`flex-1 px-2 py-1 text-xs rounded-md border ${keyMode === 'different' ? 'bg-primary text-primary-foreground border-primary' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                  >
                    Different names
                  </button>
                </div>

                {columnsLoading ? (
                  <p className="text-[11px] text-gray-400 flex items-center gap-1.5">
                    <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" /> Loading columns — running each asset to read its real schema…
                  </p>
                ) : columnsErrorMessage ? (
                  <div className="space-y-1.5">
                    <p className="text-[11px] text-red-600 flex items-start gap-1">
                      <AlertCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />
                      {columnsErrorSide === 'left' ? 'Left asset: ' : 'Right asset: '}{columnsErrorMessage}
                    </p>
                    <button
                      onClick={() => handleMaterialize(columnsErrorSide!)}
                      disabled={!!materializing}
                      className="inline-flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50"
                    >
                      {materializing === columnsErrorSide ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                      {materializing === columnsErrorSide ? 'Materializing…' : `Materialize ${columnsErrorSide} asset`}
                    </button>
                  </div>
                ) : keyMode === 'same' ? (
                  sharedColumns.length > 0 ? (
                    <select
                      value={onColumn}
                      onChange={(e) => setOnColumn(e.target.value)}
                      className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md bg-white font-mono"
                    >
                      <option value="" disabled>pick a shared column</option>
                      {sharedColumns.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  ) : (
                    <p className="text-[11px] text-amber-600 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3 flex-shrink-0" /> No column name is shared by both sides — use "Different names" instead.
                    </p>
                  )
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <select
                      value={leftOnColumn}
                      onChange={(e) => setLeftOnColumn(e.target.value)}
                      className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md bg-white font-mono"
                    >
                      <option value="" disabled>left column</option>
                      {leftColumns.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <select
                      value={rightOnColumn}
                      onChange={(e) => setRightOnColumn(e.target.value)}
                      className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md bg-white font-mono"
                    >
                      <option value="" disabled>right column</option>
                      {rightColumns.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                )}
              </div>
            )}

            {preview && (
              <div className="relative">
                <label className="block text-xs font-medium text-gray-700 mb-1">Columns to keep</label>
                <MultiColumnSelect
                  columns={preview.columns}
                  value={keepColumnsTouched ? keepColumns : preview.columns}
                  onChange={(next) => { setKeepColumns(next); setKeepColumnsTouched(true); }}
                  placeholder="All columns"
                />
                <p className="text-[10px] text-gray-400 mt-0.5">Defaults to everything — remove any you don't want in the joined result.</p>
              </div>
            )}

            {preview && preview.conflictColumns.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Rename conflicting columns</label>
                <p className="text-[10px] text-gray-400 mb-1.5">
                  Both sides had a column with the same name — pick clearer names instead of the auto-added {'_x'}/{'_y'}.
                </p>
                <div className="space-y-1.5">
                  {preview.conflictColumns.filter((c) => !keepColumnsTouched || keepColumns.includes(c)).map((c) => (
                    <div key={c} className="flex items-center gap-1.5">
                      <span
                        className={`text-[10px] font-mono px-1.5 py-1 rounded flex-shrink-0 w-24 truncate ${preview.columnSource[c] === 'right' ? 'bg-violet-50 text-violet-700' : 'bg-gray-50 text-gray-500'}`}
                        title={c}
                      >
                        {c}
                      </span>
                      <input
                        type="text"
                        value={renameMap[c] || ''}
                        onChange={(e) => setRenameMap((prev) => ({ ...prev, [c]: e.target.value }))}
                        placeholder={c}
                        className="flex-1 min-w-0 px-2 py-1 text-xs border border-gray-300 rounded-md font-mono"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">New asset name</label>
              <input
                type="text"
                value={assetName}
                onChange={(e) => setAssetName(e.target.value)}
                placeholder="e.g., customers_with_orders"
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
            </div>
          </div>

          <div className="overflow-y-auto overflow-x-hidden px-6 py-4 bg-gray-50">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Preview (based on a sample of both sides)</h3>
              {(leftPreview.isFetching || rightPreview.isFetching) && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />}
            </div>

            {!leftAssetKey || !rightAssetKey ? (
              <p className="text-sm text-gray-400 text-center py-12">Pick a left and right asset to preview the join.</p>
            ) : needsKeys && !keysReady ? (
              <p className="text-sm text-gray-400 text-center py-12">Pick join keys to preview the result.</p>
            ) : columnsErrorMessage ? (
              <div className="text-center py-12 space-y-2">
                <p className="text-sm text-red-600 flex items-center justify-center gap-1.5">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  {columnsErrorSide === 'left' ? 'Left asset: ' : 'Right asset: '}{columnsErrorMessage}
                </p>
                <button
                  onClick={() => handleMaterialize(columnsErrorSide!)}
                  disabled={!!materializing}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50"
                >
                  {materializing === columnsErrorSide ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  {materializing === columnsErrorSide ? 'Materializing…' : `Materialize ${columnsErrorSide} asset`}
                </button>
              </div>
            ) : preview ? (
              <>
                <p className="text-xs text-gray-500 mb-2">
                  {preview.rows.length} row{preview.rows.length === 1 ? '' : 's'}{preview.truncated ? '+' : ''} · {displayColumns.length} column{displayColumns.length === 1 ? '' : 's'}
                  {keepColumnsTouched && displayColumns.length < preview.columns.length && ` (of ${preview.columns.length})`}
                  {preview.truncated && <span className="text-amber-600"> (preview capped — the real join will process everything)</span>}
                </p>
                <p className="text-[10px] text-gray-400 flex items-center gap-3 mb-1.5">
                  <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm inline-block bg-violet-100 border border-violet-200" /> from the right asset</span>
                  <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm inline-block bg-white border border-gray-300" /> from the left asset / join key</span>
                </p>
                <div className="overflow-x-auto border border-gray-200 rounded-md bg-white">
                  <table className="text-xs">
                    <thead>
                      <tr className="border-b border-gray-200">
                        {displayColumns.map((c) => (
                          <th
                            key={c}
                            className={`px-2 py-1.5 text-left font-mono font-medium text-gray-600 whitespace-nowrap ${preview.columnSource[c] === 'right' ? 'bg-violet-50' : 'bg-gray-50'}`}
                          >
                            {displayName(c)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.slice(0, 30).map((row, i) => (
                        <tr key={i} className="border-b border-gray-100 last:border-0">
                          {displayColumns.map((c) => (
                            <td
                              key={c}
                              className={`px-2 py-1 text-gray-800 whitespace-nowrap max-w-[220px] truncate ${preview.columnSource[c] === 'right' ? 'bg-violet-50/40' : ''}`}
                            >
                              {row[c] === null || row[c] === undefined ? <span className="text-gray-300">—</span> : String(row[c])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center py-12 text-gray-400"><Loader2 className="w-5 h-5 animate-spin" /></div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-200">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-md">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave || saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Combine className="w-3.5 h-3.5" />}
            {saving ? 'Creating…' : 'Create joined asset'}
          </button>
        </div>
      </div>
    </div>
  );
}
