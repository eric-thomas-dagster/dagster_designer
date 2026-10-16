import { useEffect, useRef, useState } from 'react';
import { Sparkles, Loader2, CheckCircle2, XCircle, Undo2, Check, ChevronDown, ChevronRight, Square } from 'lucide-react';
import { API_BASE, aiFixApi, type AiFixResult, type AiFixStatus } from '@/services/api';
import { notify } from './Notifications';

/**
 * "Explain / Fix with Claude Code" for a project that fails validation.
 *
 * Runs the user's own Claude Code (with the official dagster-expert skill) on
 * the project folder. Explain is read-only. Fix edits files, but only inside
 * the project, never .env files, with a snapshot taken first -- so the result is
 * always shown as a diff with a one-click Undo. See backend
 * services/ai_fix_service.py for the permission model.
 */

type Phase = 'idle' | 'confirm' | 'running' | 'done';

interface Props {
  projectId: string;
  /** Everything we know about the validation failure (summary + full output). */
  errorText: string;
  /** Called after the user keeps a fix, so the host can re-validate / reload. */
  onKept: () => void;
}

function describeTool(name: string, input: any): string {
  const file = (input?.file_path || input?.path || '').toString().split('/').slice(-3).join('/');
  switch (name) {
    case 'Read': return `Reading ${file}`;
    case 'Edit': case 'MultiEdit': return `Editing ${file}`;
    case 'Write': return `Writing ${file}`;
    case 'Glob': case 'Grep': return `Searching the project…`;
    case 'Bash': return `Running ${(input?.command || '').toString().slice(0, 70)}`;
    case 'Skill': return 'Consulting the dagster-expert skill…';
    default: return `${name}…`;
  }
}

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="text-[11px] leading-snug bg-gray-900 text-gray-200 rounded p-2 overflow-x-auto max-h-64">
      {diff.split('\n').map((l, i) => (
        <div
          key={i}
          className={l.startsWith('+') && !l.startsWith('+++') ? 'text-green-400'
            : l.startsWith('-') && !l.startsWith('---') ? 'text-red-400'
            : l.startsWith('@@') ? 'text-blue-300' : undefined}
        >
          {l || ' '}
        </div>
      ))}
    </pre>
  );
}

export function AiFixPanel({ projectId, errorText, onKept }: Props) {
  const [status, setStatus] = useState<AiFixStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [mode, setMode] = useState<'explain' | 'fix'>('explain');
  const [activity, setActivity] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [cost, setCost] = useState<number | null>(null);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [result, setResult] = useState<AiFixResult | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [reverted, setReverted] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    aiFixApi.status().then(setStatus).catch(() => setStatus(null));
    return () => abortRef.current?.abort();
  }, []);

  const run = async (m: 'explain' | 'fix') => {
    setMode(m); setPhase('running'); setActivity([]); setText(''); setError(null);
    setCost(null); setSnapshotId(null); setResult(null); setReverted(false); setOpen(new Set());
    const controller = new AbortController();
    abortRef.current = controller;
    let snap: string | null = null;
    let finalText = '';
    let fatal: string | null = null;
    try {
      const r = await fetch(`${API_BASE}/projects/${projectId}/ai-fix/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: m, error_text: errorText }),
        signal: controller.signal,
      });
      if (!r.ok || !r.body) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.detail || `Request failed (${r.status})`);
      }
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let evt: any;
          try { evt = JSON.parse(line); } catch { continue; }
          if (evt.type === 'designer' && evt.event === 'started') {
            snap = evt.snapshot_id ?? null; setSnapshotId(snap);
          } else if (evt.type === 'designer' && evt.event === 'finished') {
            if (evt.timed_out) fatal = 'Claude Code took too long and was stopped.';
            else if (evt.returncode && !finalText) fatal = evt.stderr || `Claude Code exited with code ${evt.returncode}.`;
          } else if (evt.type === 'designer_error') {
            fatal = evt.detail || 'Claude Code failed.';
          } else if (evt.type === 'assistant') {
            for (const b of evt.message?.content ?? []) {
              if (b.type === 'tool_use') setActivity((a) => [...a.slice(-5), describeTool(b.name, b.input)]);
              else if (b.type === 'text' && b.text) { finalText = b.text; setText(b.text); }
            }
          } else if (evt.type === 'result') {
            if (evt.result) { finalText = evt.result; setText(evt.result); }
            if (typeof evt.total_cost_usd === 'number') setCost(evt.total_cost_usd);
            if (evt.is_error && !fatal) fatal = evt.result || 'Claude Code reported an error.';
          }
        }
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') fatal = e?.message || String(e);
    }
    if (fatal) setError(fatal);
    if (m === 'fix' && snap) {
      try { setResult(await aiFixApi.result(projectId, snap)); }
      catch (e: any) { setError((x) => x ?? (e?.response?.data?.detail || e?.message || 'Could not read the result.')); }
    }
    setPhase('done');
  };

  const stop = () => abortRef.current?.abort();

  const keep = async () => {
    if (!snapshotId) return;
    setBusy(true);
    try { await aiFixApi.keep(projectId, snapshotId); setSnapshotId(null); onKept(); }
    catch (e: any) { notify.error(e?.response?.data?.detail || e?.message || 'Failed to keep the changes.'); }
    finally { setBusy(false); }
  };

  const undo = async () => {
    if (!snapshotId) return;
    setBusy(true);
    try {
      const r = await aiFixApi.undo(projectId, snapshotId);
      setSnapshotId(null); setReverted(true);
      notify.success(`Reverted ${r.restored.length} file${r.restored.length === 1 ? '' : 's'}.`);
    } catch (e: any) { notify.error(e?.response?.data?.detail || e?.message || 'Failed to undo.'); }
    finally { setBusy(false); }
  };

  // ---- not available: stay out of the way, but say how to get it ---------
  if (!status) return null;
  if (!status.can_run) {
    return (
      <div className="mb-4 p-3 bg-gray-50 border border-dashed border-gray-300 rounded-md text-xs text-gray-600 flex items-center justify-between gap-3">
        <span className="flex items-center gap-2"><Sparkles className="w-3.5 h-3.5 text-gray-400" />
          {status.reason} Install it to get AI-assisted fixes here.</span>
        {status.claude_found && !status.skill_installed && (
          <button
            disabled={installing}
            onClick={async () => {
              setInstalling(true);
              try { await aiFixApi.installSkill(); setStatus(await aiFixApi.status()); }
              catch (e: any) { notify.error(e?.response?.data?.detail || 'Failed to install the skill.'); }
              finally { setInstalling(false); }
            }}
            className="px-2 py-1 text-xs font-medium text-primary border border-primary/40 rounded hover:bg-primary/5 disabled:opacity-50 flex-shrink-0"
          >{installing ? 'Installing…' : 'Install dagster-expert skill'}</button>
        )}
      </div>
    );
  }

  return (
    <div className="mb-4 p-4 border border-primary/30 bg-primary/5 rounded-md">
      <div className="flex items-center gap-2 mb-1">
        <Sparkles className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold text-gray-900">Fix with Claude Code</h3>
      </div>

      {phase === 'idle' && (
        <>
          <p className="text-xs text-gray-600 mb-3">
            Uses your Claude Code and the dagster-expert skill on this project. <b>Explain</b> is read-only.
            <b> Fix</b> edits files inside this project only (never <code>.env</code>), and you review the diff and can undo.
          </p>
          <div className="flex gap-2">
            <button onClick={() => run('explain')} className="px-3 py-1.5 text-xs font-medium border border-primary text-primary rounded hover:bg-primary/10">
              Explain this error
            </button>
            <button onClick={() => setPhase('confirm')} className="px-3 py-1.5 text-xs font-medium text-white bg-primary rounded hover:opacity-90">
              Fix it…
            </button>
          </div>
        </>
      )}

      {phase === 'confirm' && (
        <div className="text-xs text-gray-700">
          <p className="mb-2">
            Claude Code will edit files in this project to fix the error. A snapshot is taken first, so you can review
            every change and undo it. It runs on your Claude account and usually takes one to a few minutes.
          </p>
          <div className="flex gap-2">
            <button onClick={() => run('fix')} className="px-3 py-1.5 font-medium text-white bg-primary rounded hover:opacity-90">Start fixing</button>
            <button onClick={() => setPhase('idle')} className="px-3 py-1.5 font-medium border border-gray-300 rounded hover:bg-gray-100">Cancel</button>
          </div>
        </div>
      )}

      {phase === 'running' && (
        <div className="text-xs">
          <div className="flex items-center justify-between mb-2">
            <span className="flex items-center gap-2 text-gray-700">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {mode === 'fix' ? 'Claude Code is working on a fix…' : 'Claude Code is investigating…'}
            </span>
            <button onClick={stop} className="flex items-center gap-1 px-2 py-1 border border-gray-300 rounded hover:bg-gray-100">
              <Square className="w-3 h-3" /> Stop
            </button>
          </div>
          {activity.length > 0 && (
            <ul className="mb-2 text-[11px] text-gray-500 font-mono space-y-0.5">
              {activity.map((a, i) => <li key={i} className="truncate">• {a}</li>)}
            </ul>
          )}
          {text && <p className="whitespace-pre-wrap text-gray-800">{text}</p>}
        </div>
      )}

      {phase === 'done' && (
        <div className="text-xs">
          {error && (
            <p className="mb-2 flex items-start gap-1.5 text-red-700"><XCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />{error}</p>
          )}
          {text && <p className="whitespace-pre-wrap text-gray-800 mb-3">{text}</p>}

          {mode === 'fix' && result && !reverted && (
            <div className="mb-3">
              <p className={`mb-2 flex items-center gap-1.5 font-medium ${result.valid ? 'text-green-700' : 'text-amber-700'}`}>
                {result.valid ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                {result.valid ? 'The project validates now.' : 'The project still fails validation.'}
              </p>
              {!result.valid && result.validation_error && (
                <pre className="mb-2 text-[11px] bg-red-50 text-red-900 border border-red-200 rounded p-2 max-h-32 overflow-auto whitespace-pre-wrap">{result.validation_error.slice(0, 1500)}</pre>
              )}
              {result.changes.length === 0 ? (
                <p className="text-gray-600">No files were changed.</p>
              ) : (
                <ul className="space-y-1">
                  {result.changes.map((c) => {
                    const isOpen = open.has(c.path);
                    return (
                      <li key={c.path} className="border border-gray-200 bg-white rounded">
                        <button
                          onClick={() => setOpen((s) => { const n = new Set(s); n.has(c.path) ? n.delete(c.path) : n.add(c.path); return n; })}
                          className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-gray-50"
                        >
                          {isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                          <code className="flex-1 truncate">{c.path}</code>
                          <span className={`text-[10px] uppercase font-semibold ${c.status === 'added' ? 'text-green-700' : c.status === 'deleted' ? 'text-red-700' : 'text-blue-700'}`}>{c.status}</span>
                        </button>
                        {isOpen && <div className="p-2 pt-0"><DiffView diff={c.diff} /></div>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {reverted && <p className="mb-3 text-gray-700">Changes reverted. The project is back to how it was.</p>}

          <div className="flex items-center gap-2">
            {mode === 'fix' && snapshotId && !reverted && (
              <>
                <button disabled={busy} onClick={keep} className="flex items-center gap-1 px-3 py-1.5 font-medium text-white bg-green-600 rounded hover:bg-green-700 disabled:opacity-50">
                  <Check className="w-3.5 h-3.5" /> Keep changes
                </button>
                <button disabled={busy} onClick={undo} className="flex items-center gap-1 px-3 py-1.5 font-medium border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-50">
                  <Undo2 className="w-3.5 h-3.5" /> Undo
                </button>
              </>
            )}
            {(!snapshotId || reverted) && (
              <button onClick={() => { setPhase('idle'); setText(''); setError(null); }} className="px-3 py-1.5 font-medium border border-gray-300 rounded hover:bg-gray-100">
                Start over
              </button>
            )}
            {cost != null && <span className="ml-auto text-[10px] text-gray-400">~${cost.toFixed(2)}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
