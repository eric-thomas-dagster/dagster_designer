import { Fragment, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Loader2, Play, AlertTriangle, Check, X as XIcon } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { API_BASE, assetsApi } from '@/services/api';
import { alwaysEmptyFields, fileName, formatCell, formatPercent, scoreResults, settingsSignature, summarize, withMark, type TryResult, type TrySettings } from '@/lib/extractionTry';

const MAX_SAMPLES = 5;

/** One value in the results table. Hover for ✓ (the model got it right) / ✗ (it's wrong -- type the right value); a marked cell shows
 * whether the model agrees with what was marked, and what was expected when it doesn't. */
function FieldCell({
  result,
  field,
  canMark,
  onRight,
  onWrong,
  onClear,
}: {
  result: TryResult;
  field: string;
  canMark: boolean;
  onRight: () => void;
  onWrong: (text: string) => void;
  onClear: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const cell = formatCell(result.ok ? result.fields?.[field] : undefined);
  const marked = !!result.expected && field in result.expected;
  const match = result.match?.[field];
  const tone = marked ? (match ? 'bg-emerald-50' : 'bg-red-50') : '';
  const submit = () => {
    onWrong(text);
    setEditing(false);
    setText('');
  };
  return (
    <td className={`px-2 py-1.5 font-mono align-top group ${tone}`}>
      <div className="flex items-start gap-1">
        <span className={cell.missing ? 'text-gray-300' : 'text-gray-800'} title={cell.full}>{cell.text}</span>
        {marked && (match ? <Check className="w-3 h-3 text-emerald-600 flex-shrink-0 mt-0.5" /> : <XIcon className="w-3 h-3 text-red-600 flex-shrink-0 mt-0.5" />)}
      </div>
      {marked && !match && (
        <div className="text-[10px] text-red-700" title={formatCell(result.expected![field], 400).full}>expected: {formatCell(result.expected![field], 40).text}</div>
      )}
      {canMark && !editing && (
        <div className="mt-0.5 flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity font-sans">
          {result.ok && !(marked && match) && (
            <button onClick={onRight} title="The model got this right" className="text-[10px] px-1 rounded border border-emerald-200 text-emerald-700 hover:bg-emerald-100">✓ right</button>
          )}
          <button onClick={() => { setEditing(true); setText(''); }} title="Type the right value" className="text-[10px] px-1 rounded border border-red-200 text-red-700 hover:bg-red-100">✗ wrong</button>
          {marked && <button onClick={onClear} title="Remove this mark" className="text-[10px] px-1 text-gray-400 hover:text-gray-600">clear</button>}
        </div>
      )}
      {editing && (
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') setEditing(false);
          }}
          onBlur={() => setEditing(false)}
          placeholder="right value (blank = empty)"
          className="mt-1 w-40 px-1.5 py-0.5 text-[11px] border border-gray-300 rounded font-sans focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      )}
    </td>
  );
}

/**
 * "Try on samples": run the extractor, as currently configured, on a few real documents and show what comes back -- before
 * anything is saved or materialized. The backend calls the installed component's own extraction function, so a result here is
 * what the real asset would produce for that document.
 */
export function ExtractionTryPanel({
  sourcePath,
  upstreamAssetKey,
  settings,
  apiKeyEnvVar,
  assetName,
  onResults,
}: {
  sourcePath?: string;
  upstreamAssetKey?: string;
  settings: TrySettings;
  apiKeyEnvVar: string;
  /** Names the extraction so marks are saved (and scored) per extraction. */
  assetName?: string;
  /** Called whenever the shown results change (a run, or a value marked right/wrong). */
  onResults?: (results: TryResult[]) => void;
}) {
  const { currentProject } = useProjectStore();
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [results, setResults] = useState<TryResult[]>([]);
  const [ranWith, setRanWith] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const resolvedPath = useMemo(() => {
    if (sourcePath) return sourcePath;
    if (upstreamAssetKey && currentProject) {
      const comp = currentProject.components.find((c) => (c.attributes?.asset_name || c.id) === upstreamAssetKey);
      return (comp?.attributes?.path as string | undefined) || undefined;
    }
    return undefined;
  }, [sourcePath, upstreamAssetKey, currentProject]);

  // Same query (key + limit) as DocumentPreviewPanel, so this reuses its listing instead of asking again.
  const { data: sample } = useQuery({
    queryKey: ['document-preview-sample', currentProject?.id, resolvedPath],
    queryFn: () => assetsApi.sampleFiles(currentProject!.id, resolvedPath!, 12),
    enabled: !!currentProject && !!resolvedPath,
  });
  const files = sample?.files || [];
  useEffect(() => {
    if (selected.length === 0 && files.length > 0) setSelected(files.slice(0, 3).map((f) => f.path));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files.length]);

  const signature = settingsSignature(settings);
  const stale = ranWith !== null && ranWith !== signature;
  const canRun = !!currentProject && selected.length > 0 && settings.outputFields.length > 0 && !running;

  const toggle = (path: string) =>
    setSelected((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : prev.length >= MAX_SAMPLES ? prev : [...prev, path]));

  const run = async (useCache: boolean) => {
    if (!currentProject || !canRun) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/projects/${currentProject.id}/extraction/try`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asset_name: assetName?.trim() || null,
          files: selected,
          output_fields: settings.outputFields,
          document_type: settings.documentType,
          model: settings.model,
          api_key_env_var: apiKeyEnvVar || null,
          api_base_env_var: settings.apiBaseEnvVar || null,
          field_regions: settings.fieldRegions && Object.keys(settings.fieldRegions).length > 0 ? settings.fieldRegions : null,
          use_cache: useCache,
        }),
      });
      const body = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        const d = body.detail;
        setError(typeof d === 'object' && d ? { code: d.code, message: d.message } : { message: String(d || `HTTP ${res.status}`) });
        return;
      }
      setResults(body.results as TryResult[]);
      setRanWith(signature);
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : String(e) });
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    onResults?.(results);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results]);

  const canMark = !!currentProject && !!assetName?.trim();
  const goldenUrl = currentProject ? `${API_BASE}/projects/${currentProject.id}/extraction/golden` : '';

  const mark = async (r: TryResult, field: string, body: { value?: unknown; value_text?: string }) => {
    if (!r.digest || !canMark) return;
    try {
      const res = await fetch(goldenUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset_name: assetName, digest: r.digest, path: r.file, field, extracted: r.ok ? (r.fields?.[field] ?? null) : null, ...body }),
      });
      const out = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        setError({ message: out?.detail?.message || `Couldn't save that mark (HTTP ${res.status}).` });
        return;
      }
      setResults((prev) => withMark(prev, r.file, field, { expected: out.expected?.[field] ?? null, match: !!out.match }));
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : String(e) });
    }
  };
  const clearMark = async (r: TryResult, field: string) => {
    if (!r.digest || !canMark) return;
    try {
      const qs = new URLSearchParams({ asset_name: assetName!, digest: r.digest, field });
      const res = await fetch(`${goldenUrl}?${qs}`, { method: 'DELETE' });
      if (res.ok) setResults((prev) => withMark(prev, r.file, field, null));
    } catch {
      /* a failed clear just leaves the mark visible; nothing to roll back */
    }
  };

  const score = scoreResults(results);
  const empty = alwaysEmptyFields(results, settings.outputFields);

  return (
    <div className="border-t border-gray-200 bg-gray-50">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-1.5 px-6 py-2 text-xs font-medium text-gray-700 hover:bg-gray-100">
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        Try on samples
        {results.length > 0 && <span className="font-normal text-gray-400">· {summarize(results)}</span>}
        {score.marked > 0 && (
          <span className={`font-medium ${score.accuracy! >= 0.9 ? 'text-emerald-600' : score.accuracy! >= 0.7 ? 'text-amber-600' : 'text-red-600'}`}>
            · accuracy {formatPercent(score.accuracy)} <span className="font-normal text-gray-400">({score.correct}/{score.marked} marked)</span>
          </span>
        )}
        {stale && <span className="ml-1 inline-flex items-center gap-1 text-amber-600 font-normal"><AlertTriangle className="w-3 h-3" />settings changed since this run</span>}
      </button>

      {open && (
        <div className="px-6 pb-3 space-y-2">
          {!resolvedPath ? (
            <p className="text-xs text-gray-400">Needs a source with files to sample from.</p>
          ) : (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] text-gray-500">Run on (up to {MAX_SAMPLES}):</span>
                {files.map((f) => (
                  <label key={f.path} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] cursor-pointer ${selected.includes(f.path) ? 'bg-violet-50 border-violet-200 text-violet-800' : 'bg-white border-gray-200 text-gray-500'}`}>
                    <input type="checkbox" className="w-3 h-3" checked={selected.includes(f.path)} onChange={() => toggle(f.path)} />
                    <span className="max-w-[140px] truncate">{f.name}</span>
                  </label>
                ))}
                <div className="ml-auto flex gap-1.5">
                  {results.length > 0 && (
                    <button onClick={() => run(false)} disabled={!canRun} title="Call the model again even for documents already run with these settings" className="px-2 py-1 text-xs text-gray-600 border border-gray-300 rounded-md hover:bg-white disabled:opacity-50">
                      Re-run all
                    </button>
                  )}
                  <button onClick={() => run(true)} disabled={!canRun} className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50">
                    {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                    {running ? 'Running…' : `Run on ${selected.length} sample${selected.length === 1 ? '' : 's'}`}
                  </button>
                </div>
              </div>

              {error && (
                <div className="text-xs rounded px-2.5 py-2 bg-amber-50 text-amber-800">
                  {error.message}
                </div>
              )}

              {results.length > 0 && (
                <div className={`overflow-auto max-h-56 rounded-md border bg-white ${stale ? 'opacity-60' : ''}`}>
                  <table className="text-xs w-full">
                    <thead className="sticky top-0 bg-gray-100 text-gray-600">
                      <tr>
                        <th className="text-left font-medium px-2 py-1.5 whitespace-nowrap">Document</th>
                        {settings.outputFields.map((f) => (
                          <th key={f} className="text-left font-medium px-2 py-1.5 font-mono whitespace-nowrap">{f}</th>
                        ))}
                        <th className="px-2 py-1.5" />
                      </tr>
                    </thead>
                    <tbody>
                      {results.map((r) => (
                        <Fragment key={r.file}>
                          <tr className="border-t border-gray-100 align-top">
                            <td className="px-2 py-1.5 whitespace-nowrap text-gray-700" title={r.file}>
                              {fileName(r.file)}
                              {r.cached && <span className="ml-1 text-[10px] text-gray-400">cached</span>}
                            </td>
                            {r.ok && r.fields ? (
                              settings.outputFields.map((f) => (
                                <FieldCell
                                  key={f}
                                  result={r}
                                  field={f}
                                  canMark={canMark && !!r.digest}
                                  onRight={() => mark(r, f, { value: r.fields?.[f] ?? null })}
                                  onWrong={(text) => mark(r, f, { value_text: text })}
                                  onClear={() => clearMark(r, f)}
                                />
                              ))
                            ) : (
                              <td colSpan={settings.outputFields.length} className="px-2 py-1.5 text-red-600">{r.error}</td>
                            )}
                            <td className="px-2 py-1.5 text-right whitespace-nowrap">
                              <button onClick={() => setExpanded(expanded === r.file ? null : r.file)} className="text-[10px] text-gray-400 hover:text-gray-600">
                                {expanded === r.file ? 'hide reply' : 'model reply'}
                              </button>
                            </td>
                          </tr>
                          {expanded === r.file && (
                            <tr className="bg-gray-50">
                              <td colSpan={settings.outputFields.length + 2} className="px-2 py-1.5">
                                <pre className="whitespace-pre-wrap text-[10px] text-gray-600 max-h-32 overflow-auto">{r.raw || r.error}</pre>
                                {r.warnings && r.warnings.length > 0 && <div className="text-[10px] text-amber-700 mt-1">{r.warnings.join('; ')}</div>}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {results.length > 0 && score.marked === 0 && (
                <p className="text-[11px] text-gray-500">
                  {canMark
                    ? 'Hover a value and click ✓ right or ✗ wrong. What you mark is saved as this extraction\'s golden set, and the accuracy above is measured against it every time you re-run.'
                    : 'Name the extraction (Asset name) to mark values right or wrong.'}
                </p>
              )}
              {score.marked > 0 && (
                <p className="text-[11px] text-gray-500">
                  By field:{' '}
                  {Object.entries(score.byField).map(([f, v], i) => (
                    <span key={f}>
                      {i > 0 && ' · '}
                      <span className="font-mono">{f}</span> <span className={v.accuracy === 1 ? 'text-emerald-600' : v.accuracy >= 0.5 ? 'text-amber-600' : 'text-red-600'}>{formatPercent(v.accuracy)}</span>
                      <span className="text-gray-400"> ({v.correct}/{v.marked})</span>
                    </span>
                  ))}
                </p>
              )}

              {empty.length > 0 && (
                <p className="text-[11px] text-amber-700">
                  Empty on every document: <span className="font-mono">{empty.join(', ')}</span> — the model may not know what to look for. Try a clearer field name, or mark where it appears.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
