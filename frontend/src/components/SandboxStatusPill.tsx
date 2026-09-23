import { useEffect, useRef, useState } from 'react';
import { Boxes, Loader2, AlertTriangle, CheckCircle2, ChevronDown } from 'lucide-react';
import { useDesignerLoc } from '@/hooks/useDesignerLoc';

/**
 * SandboxStatusPill — a small header indicator for the Designer-managed
 * code location subprocess on Dagster+ projects.
 *
 * The subprocess is a peer data source (not a mode), so this pill is
 * purely informational: it tells the user whether the sandbox is
 * ready to accept authored components (M2). Clicking expands a
 * popover with boot detail for debugging.
 */
interface SandboxStatusPillProps {
  projectId: string | null;
  isDagsterPlus: boolean;
}

export function SandboxStatusPill({ projectId, isDagsterPlus }: SandboxStatusPillProps) {
  const { status } = useDesignerLoc(projectId, isDagsterPlus);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Click-outside dismiss.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!isDagsterPlus || !projectId) return null;

  const s = status?.status ?? 'missing';
  const tone = pillTone(s);
  const icon = pillIcon(s);
  const label = pillLabel(s);

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border ${tone}`}
        title="Designer sandbox — a laptop-hosted Dagster subprocess for safely authoring components"
      >
        {icon}
        <span>Sandbox: {label}</span>
        <ChevronDown className="w-3 h-3 opacity-60" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 w-[420px] bg-white border border-gray-200 rounded-md shadow-lg p-3 text-xs">
          <div className="font-semibold text-gray-900 mb-1">Designer sandbox</div>
          <p className="text-gray-600 mb-2">
            A laptop-hosted Dagster subprocess that scaffolds alongside your
            Dagster+ project. Author new components here — they merge into
            the graph as a peer data source. Nothing hits your cloud
            deployment.
          </p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] mb-2">
            <span className="text-gray-500">Status</span>
            <span className="font-mono">{s}</span>
            {status?.port && (
              <>
                <span className="text-gray-500">Port</span>
                <span className="font-mono">{status.port}</span>
              </>
            )}
            {status?.pid && (
              <>
                <span className="text-gray-500">PID</span>
                <span className="font-mono">{status.pid}</span>
              </>
            )}
            <span className="text-gray-500">Scaffolded</span>
            <span className="font-mono">{status?.scaffolded ? 'yes' : 'no'}</span>
            <span className="text-gray-500">Installed</span>
            <span className="font-mono">{status?.installed ? 'yes' : 'no'}</span>
          </div>
          {status?.error && (
            <div className="mt-2 rounded bg-red-50 border border-red-200 text-red-700 p-2">
              <div className="font-semibold text-[11px] mb-0.5">Error</div>
              <div className="whitespace-pre-wrap break-words">{status.error}</div>
            </div>
          )}
          {status?.log_tail && status.log_tail.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-gray-500 select-none">Boot log ({status.log_tail.length} lines)</summary>
              <pre className="mt-1 max-h-56 overflow-auto bg-gray-50 border border-gray-200 rounded p-2 text-[10px] leading-tight whitespace-pre-wrap">
                {status.log_tail.join('\n')}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function pillTone(status: string): string {
  switch (status) {
    case 'ready':
      return 'bg-emerald-50 border-emerald-200 text-emerald-800';
    case 'error':
      return 'bg-red-50 border-red-200 text-red-800';
    case 'scaffolding':
    case 'installing':
    case 'starting':
      return 'bg-amber-50 border-amber-200 text-amber-800';
    default:
      return 'bg-gray-50 border-gray-200 text-gray-600';
  }
}

function pillIcon(status: string) {
  const cls = 'w-3 h-3';
  switch (status) {
    case 'ready':
      return <CheckCircle2 className={cls} />;
    case 'error':
      return <AlertTriangle className={cls} />;
    case 'scaffolding':
    case 'installing':
    case 'starting':
      return <Loader2 className={`${cls} animate-spin`} />;
    default:
      return <Boxes className={cls} />;
  }
}

function pillLabel(status: string): string {
  switch (status) {
    case 'ready':
      return 'ready';
    case 'error':
      return 'error';
    case 'scaffolding':
      return 'scaffolding';
    case 'installing':
      return 'installing deps';
    case 'starting':
      return 'starting';
    default:
      return 'not started';
  }
}
