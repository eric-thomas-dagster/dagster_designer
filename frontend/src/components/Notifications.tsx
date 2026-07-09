import { useEffect, useState } from 'react';
import { CheckCircle, AlertCircle, AlertTriangle, Info, X } from 'lucide-react';

type ToastKind = 'success' | 'error' | 'info' | 'warning';

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ConfirmRequest {
  id: number;
  message: string;
  title: string;
  destructive: boolean;
  resolve: (ok: boolean) => void;
}

type ToastListener = (toasts: Toast[]) => void;
type ConfirmListener = (req: ConfirmRequest | null) => void;

let toasts: Toast[] = [];
let toastListeners: ToastListener[] = [];
let toastSeq = 0;

let activeConfirm: ConfirmRequest | null = null;
let confirmListeners: ConfirmListener[] = [];
let confirmSeq = 0;

function emitToasts() {
  toastListeners.forEach((l) => l(toasts));
}

function emitConfirm() {
  confirmListeners.forEach((l) => l(activeConfirm));
}

function pushToast(kind: ToastKind, message: string, durationMs = 4000) {
  const id = ++toastSeq;
  toasts = [...toasts, { id, kind, message }];
  emitToasts();
  if (durationMs > 0) {
    setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
      emitToasts();
    }, durationMs);
  }
}

export const notify = {
  success: (message: string) => pushToast('success', message),
  error: (message: string) => pushToast('error', message, 6000),
  info: (message: string) => pushToast('info', message),
  warning: (message: string) => pushToast('warning', message, 5000),
};

export function confirmDialog(
  message: string,
  opts: { title?: string; destructive?: boolean } = {}
): Promise<boolean> {
  return new Promise((resolve) => {
    if (activeConfirm) {
      activeConfirm.resolve(false);
    }
    activeConfirm = {
      id: ++confirmSeq,
      message,
      title: opts.title ?? 'Confirm',
      destructive: opts.destructive ?? false,
      resolve,
    };
    emitConfirm();
  });
}

const toastStyles: Record<ToastKind, { icon: typeof CheckCircle; bg: string; border: string; iconColor: string; textColor: string }> = {
  success: {
    icon: CheckCircle,
    bg: 'bg-white',
    border: 'border-emerald-200',
    iconColor: 'text-emerald-600',
    textColor: 'text-gray-900',
  },
  error: {
    icon: AlertCircle,
    bg: 'bg-white',
    border: 'border-red-200',
    iconColor: 'text-red-600',
    textColor: 'text-gray-900',
  },
  warning: {
    icon: AlertTriangle,
    bg: 'bg-white',
    border: 'border-amber-200',
    iconColor: 'text-amber-600',
    textColor: 'text-gray-900',
  },
  info: {
    icon: Info,
    bg: 'bg-white',
    border: 'border-blue-200',
    iconColor: 'text-blue-600',
    textColor: 'text-gray-900',
  },
};

export function NotificationHost() {
  const [items, setItems] = useState<Toast[]>(toasts);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(activeConfirm);

  useEffect(() => {
    const tl: ToastListener = (next) => setItems(next);
    const cl: ConfirmListener = (next) => setConfirm(next);
    toastListeners.push(tl);
    confirmListeners.push(cl);
    return () => {
      toastListeners = toastListeners.filter((l) => l !== tl);
      confirmListeners = confirmListeners.filter((l) => l !== cl);
    };
  }, []);

  const dismiss = (id: number) => {
    toasts = toasts.filter((t) => t.id !== id);
    emitToasts();
  };

  const respond = (ok: boolean) => {
    if (!activeConfirm) return;
    activeConfirm.resolve(ok);
    activeConfirm = null;
    emitConfirm();
  };

  return (
    <>
      <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2 pointer-events-none">
        {items.map((t) => {
          const s = toastStyles[t.kind];
          const Icon = s.icon;
          return (
            <div
              key={t.id}
              className={`${s.bg} ${s.border} ${s.textColor} border rounded-md shadow-lg px-4 py-3 flex items-start gap-3 min-w-[320px] max-w-md pointer-events-auto`}
              role="status"
            >
              <Icon className={`w-5 h-5 flex-shrink-0 mt-0.5 ${s.iconColor}`} />
              <div className="flex-1 text-sm whitespace-pre-wrap break-words">{t.message}</div>
              <button
                onClick={() => dismiss(t.id)}
                className="text-gray-400 hover:text-gray-600 flex-shrink-0"
                aria-label="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          );
        })}
      </div>

      {confirm && (
        <div
          className="fixed inset-0 bg-black/40 z-[110] flex items-center justify-center p-4"
          onClick={() => respond(false)}
        >
          <div
            className="bg-white rounded-lg shadow-xl w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-gray-200">
              <h3 className="text-base font-semibold text-gray-900">{confirm.title}</h3>
            </div>
            <div className="px-6 py-4 text-sm text-gray-700 whitespace-pre-wrap">{confirm.message}</div>
            <div className="px-6 py-3 border-t border-gray-200 flex justify-end gap-2">
              <button
                onClick={() => respond(false)}
                className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-md"
              >
                Cancel
              </button>
              <button
                onClick={() => respond(true)}
                className={`px-4 py-2 text-sm font-medium text-white rounded-md ${
                  confirm.destructive
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-blue-600 hover:bg-blue-700'
                }`}
              >
                {confirm.destructive ? 'Delete' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
