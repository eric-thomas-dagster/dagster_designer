import { Fragment, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Loader2, Play, AlertTriangle } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { API_BASE, assetsApi } from '@/services/api';
import { alwaysEmptyFields, fileName, formatCell, settingsSignature, summarize, type TryResult, type TrySettings } from '@/lib/extractionTry';

const MAX_SAMPLES = 5;

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
}: {
  sourcePath?: string;
  upstreamAssetKey?: string;
  settings: TrySettings;
  apiKeyEnvVar: string;
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

  const empty = alwaysEmptyFields(results, settings.outputFields);

  return (
    <div className="border-t border-gray-200 bg-gray-50">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-1.5 px-6 py-2 text-xs font-medium text-gray-700 hover:bg-gray-100">
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        Try on samples
        {results.length > 0 && <span className="font-normal text-gray-400">· {summarize(results)}</span>}
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
                              settings.outputFields.map((f) => {
                                const c = formatCell(r.fields![f]);
                                return (
                                  <td key={f} className={`px-2 py-1.5 font-mono ${c.missing ? 'text-gray-300' : 'text-gray-800'}`} title={c.full}>
                                    {c.text}
                                  </td>
                                );
                              })
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
