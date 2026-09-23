import { useEffect, useRef, useState } from 'react';
import { Sparkles, Loader2, ArrowUp, ExternalLink, X } from 'lucide-react';
import { API_BASE } from '@/services/api';
import { openSettings } from './SettingsDialog';

/**
 * Replaces the third-party `<scout-copilot>` embed (an external SaaS
 * widget loaded from copilot.scoutos.com — unrelated to the user's own
 * Claude/OpenAI setup, and the thing users reported as flaky) with a
 * real chat panel that routes through whatever's actually available:
 *
 *   1. Claude Code CLI + the official dagster-expert skill, if present
 *      (auto-installs the skill into an existing Claude Code setup —
 *      never installs Claude Code itself, that's a bigger ask).
 *   2. A direct Anthropic/OpenAI API call otherwise, if a key is
 *      configured in Designer's own Settings.
 *   3. A prompt to set one of those up.
 */

type Tier = 'checking' | 'cli' | 'fallback' | 'none';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  pending?: boolean;
}

interface DagsterExpertPanelProps {
  onClose?: () => void;
  /** Set by a caller (e.g. "Ask Dagster AI about selected code" in
   *  CodeEditor) to have this panel ask a question on the caller's
   *  behalf as soon as it's ready to send. */
  pendingQuestion?: string | null;
  onPendingQuestionConsumed?: () => void;
}

export function DagsterExpertPanel({ onClose, pendingQuestion, onPendingQuestionConsumed }: DagsterExpertPanelProps) {
  const [tier, setTier] = useState<Tier>('checking');
  const [installing, setInstalling] = useState(false);
  const [referenceDocsAvailable, setReferenceDocsAvailable] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    const checkStatus = async () => {
      try {
        const r = await fetch(`${API_BASE}/ai/dagster-expert/status`);
        const s = await r.json();
        if (cancelled) return;
        setReferenceDocsAvailable(!!s.reference_docs_available);
        if (s.cli_available) {
          if (s.dagster_expert_installed) {
            setTier('cli');
          } else {
            // "I definitely want the dagster skill installed if
            // possible" — try it silently before falling back, rather
            // than just nudging the user to do it themselves.
            setInstalling(true);
            try {
              await fetch(`${API_BASE}/ai/dagster-expert/install`, { method: 'POST' });
              if (cancelled) return;
              setTier('cli');
            } catch {
              if (!cancelled) setTier(s.anthropic_available || s.openai_available ? 'fallback' : 'none');
            } finally {
              if (!cancelled) setInstalling(false);
            }
          }
        } else {
          setTier(s.anthropic_available || s.openai_available ? 'fallback' : 'none');
        }
      } catch {
        if (!cancelled) setTier('none');
      }
    };
    checkStatus();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Auto-send a question handed to us by a caller (e.g. "explain this
  // selected code"), once we actually know which tier to send it
  // through. Consumed exactly once — the parent clears its own state
  // via onPendingQuestionConsumed so re-opening the panel later doesn't
  // replay it.
  useEffect(() => {
    if (!pendingQuestion || tier === 'checking' || tier === 'none' || sending) return;
    onPendingQuestionConsumed?.();
    send(pendingQuestion);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingQuestion, tier]);

  const send = async (override?: string) => {
    const question = (override ?? input).trim();
    if (!question || sending || tier === 'checking' || tier === 'none') return;
    setInput('');
    setSending(true);
    const history = messages.filter((m) => !m.pending).map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, { role: 'user', content: question }, { role: 'assistant', content: '', pending: true }]);

    try {
      if (tier === 'cli') {
        const controller = new AbortController();
        abortRef.current = controller;
        const r = await fetch(`${API_BASE}/ai/dagster-expert/chat-stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, history }),
          signal: controller.signal,
        });
        if (!r.body) throw new Error('No response stream');
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let accumulated = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const evt = JSON.parse(line);
              if (evt.type === 'assistant') {
                const text = (evt.message?.content ?? [])
                  .filter((b: any) => b.type === 'text')
                  .map((b: any) => b.text)
                  .join('');
                if (text) {
                  accumulated += text;
                  const snapshot = accumulated;
                  setMessages((prev) => {
                    const next = [...prev];
                    next[next.length - 1] = { role: 'assistant', content: snapshot, pending: true };
                    return next;
                  });
                }
              } else if (evt.type === 'designer_error') {
                throw new Error(evt.detail || 'Dagster Expert failed');
              }
            } catch { /* partial/non-JSON line — ignore */ }
          }
        }
      } else {
        const r = await fetch(`${API_BASE}/ai/dagster-expert/chat-fallback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, history }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.detail || `Request failed (${r.status})`);
        }
        const data = await r.json();
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = { role: 'assistant', content: data.answer, pending: true };
          return next;
        });
      }
    } catch (e: any) {
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = { role: 'assistant', content: `Error: ${e?.message || String(e)}` };
        return next;
      });
    } finally {
      setMessages((prev) => {
        const next = [...prev];
        if (next.length && next[next.length - 1].role === 'assistant') {
          next[next.length - 1] = { ...next[next.length - 1], pending: false };
        }
        return next;
      });
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-white">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 flex-shrink-0">
        <Sparkles className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold text-gray-900">Dagster AI</span>
        <span className="ml-auto text-[10px] text-gray-400">
          {tier === 'cli' && 'via dagster-expert skill'}
          {tier === 'fallback' && (referenceDocsAvailable ? 'via your AI key + dagster-expert docs' : 'via your configured AI key')}
          {installing && 'installing skill…'}
        </span>
        {onClose && (
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700 rounded" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {tier === 'checking' && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Loader2 className="w-4 h-4 animate-spin" /> Checking what's available…
          </div>
        )}
        {tier === 'none' && (
          <div className="text-sm text-gray-600 space-y-2">
            <p>No AI provider configured yet.</p>
            <p>
              Install{' '}
              <a href="https://claude.com/claude-code" target="_blank" rel="noopener noreferrer" className="text-primary underline inline-flex items-center gap-0.5">
                Claude Code <ExternalLink className="w-3 h-3" />
              </a>
              {' '}for the full Dagster Expert skill, or add an API key to use a direct chat.
            </p>
            <button
              onClick={() => openSettings()}
              className="px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent"
            >
              Open Settings
            </button>
          </div>
        )}
        {messages.length === 0 && (tier === 'cli' || tier === 'fallback') && (
          <p className="text-sm text-gray-400">Ask about Dagster — assets, components, dg CLI, Dagster+ deployment…</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div
              className={`max-w-[90%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-gray-100 text-gray-900'
              }`}
            >
              {m.content || (m.pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '')}
            </div>
          </div>
        ))}
      </div>

      {(tier === 'cli' || tier === 'fallback') && (
        <div className="border-t border-gray-200 p-2 flex-shrink-0">
          <div className="flex items-end gap-1.5">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={2}
              placeholder="Ask Dagster AI…"
              className="flex-1 resize-none px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={() => send()}
              disabled={sending || !input.trim()}
              className="p-2 bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Send"
            >
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUp className="w-4 h-4" />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
