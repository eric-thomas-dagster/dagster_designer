import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { API_BASE } from '@/services/api';
// Import xterm CSS
import 'xterm/css/xterm.css';

interface TerminalProps {
  projectId: string;
}

export function Terminal({ projectId }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const currentLineRef = useRef('');
  // Abort controller for the active streaming command
  const abortRef = useRef<AbortController | null>(null);
  const isExecutingRef = useRef(false);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (!terminalRef.current) return;

    const checkDimensions = () => {
      if (!terminalRef.current) return;

      const rect = terminalRef.current.getBoundingClientRect();

      if (rect.width > 0 && rect.height > 0 && !xtermRef.current) {
        const term = new XTerm({
          cursorBlink: true,
          fontSize: 14,
          fontFamily: 'Menlo, Monaco, "Courier New", monospace',
          theme: {
            background: '#121926',
            foreground: '#F7F7FF',
            cursor: '#4F43DD',
            black: '#1B0130',
            red: '#cd3131',
            green: '#0dbc79',
            yellow: '#e5e510',
            blue: '#4F43DD',
            magenta: '#A7A0F8',
            cyan: '#11a8cd',
            white: '#CDD5DF',
            brightBlack: '#4B5565',
            brightRed: '#f14c4c',
            brightGreen: '#23d18b',
            brightYellow: '#f5f543',
            brightBlue: '#A7A0F8',
            brightMagenta: '#332AA6',
            brightCyan: '#29b8db',
            brightWhite: '#F7F7FF',
          },
          scrollback: 1000,
          convertEol: true,
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);

        xtermRef.current = term;
        fitAddonRef.current = fitAddon;

        try {
          term.open(terminalRef.current);
          fitAddon.fit();
          setIsReady(true);
        } catch (err) {
          console.error('Failed to open terminal:', err);
          return;
        }

        term.writeln('\x1b[1;32mDagster Designer Terminal\x1b[0m');
        term.writeln('Working directory: project root');
        term.writeln('\x1b[90mdg · dagster · uv · python · dbt · git · pytest · ruff · black · ls · cat · grep · jq · …\x1b[0m');
        term.writeln('');
        term.write('$ ');

        term.onData((data) => {
          const code = data.charCodeAt(0);

          // Ctrl+C — kill running process or clear line
          if (code === 3) {
            if (isExecutingRef.current && abortRef.current) {
              abortRef.current.abort();
              term.write('^C\r\n$ ');
              currentLineRef.current = '';
              isExecutingRef.current = false;
            } else {
              term.write('^C\r\n$ ');
              currentLineRef.current = '';
            }
            return;
          }

          if (isExecutingRef.current) return;

          // Enter — run command
          if (code === 13) {
            const command = currentLineRef.current.trim();
            currentLineRef.current = '';

            if (!command) {
              term.write('\r\n$ ');
              return;
            }

            term.write('\r\n');

            if (command === 'cd' || command.startsWith('cd ')) {
              term.writeln('\x1b[33mNote: each command runs fresh in the project root — no persistent shell session, so `cd` has nothing to carry forward.\x1b[0m');
              term.writeln('Use a path directly instead, e.g. `ls data` or `dg list defs`.');
              term.write('\r\n$ ');
              return;
            }

            if (command === 'clear' || command === 'cls') {
              term.clear();
              term.write('$ ');
              return;
            }

            isExecutingRef.current = true;
            const abort = new AbortController();
            abortRef.current = abort;

            const url = `${API_BASE}/files/execute-stream/${projectId}?command=${encodeURIComponent(command)}`;
            const source = new EventSource(url);

            source.onmessage = (e) => {
              if (abort.signal.aborted) { source.close(); return; }
              try {
                const msg = JSON.parse(e.data);
                if (msg.type === 'stdout' || msg.type === 'stderr') {
                  term.writeln(msg.data);
                } else if (msg.type === 'exit') {
                  source.close();
                  if (msg.data !== 0) {
                    term.writeln(`\x1b[31m[exited with code ${msg.data}]\x1b[0m`);
                  }
                  term.write('\r\n$ ');
                  isExecutingRef.current = false;
                  abortRef.current = null;
                }
              } catch {
                term.writeln(e.data);
              }
            };

            source.onerror = (_err) => {
              source.close();
              if (!abort.signal.aborted) {
                // Try to surface the error detail from a failed HTTP response.
                // EventSource doesn't expose the response body directly, so
                // fall back to a plain fetch to get the 400/500 detail text.
                fetch(url)
                  .then(async (r) => {
                    if (!r.ok) {
                      const body = await r.json().catch(() => null);
                      const detail = body?.detail || `HTTP ${r.status}`;
                      term.writeln(`\x1b[31mError: ${detail}\x1b[0m`);
                    }
                  })
                  .catch(() => {
                    term.writeln('\x1b[31mError: connection lost\x1b[0m');
                  })
                  .finally(() => {
                    term.write('\r\n$ ');
                    isExecutingRef.current = false;
                    abortRef.current = null;
                  });
              } else {
                term.write('\r\n$ ');
                isExecutingRef.current = false;
                abortRef.current = null;
              }
            };

            // Abort handler — close the EventSource when Ctrl+C fires
            abort.signal.addEventListener('abort', () => {
              source.close();
            });

            return;
          }

          // Backspace
          if (code === 127) {
            if (currentLineRef.current.length > 0) {
              currentLineRef.current = currentLineRef.current.slice(0, -1);
              term.write('\b \b');
            }
            return;
          }

          // Ctrl+L — clear screen
          if (code === 12) {
            term.clear();
            term.write('$ ' + currentLineRef.current);
            return;
          }

          // Printable characters
          if (code >= 32 && code < 127) {
            currentLineRef.current += data;
            term.write(data);
          }
        });
      }
    };

    const timeouts = [10, 50, 100, 200, 300];
    const timers = timeouts.map(delay => setTimeout(checkDimensions, delay));

    return () => {
      timers.forEach(timer => clearTimeout(timer));
      if (abortRef.current) abortRef.current.abort();
      if (xtermRef.current) {
        xtermRef.current.dispose();
        xtermRef.current = null;
      }
    };
  }, [projectId]);

  useEffect(() => {
    if (!isReady) return;

    let resizeTimeout: number;

    const resizeObserver = new ResizeObserver((entries) => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        const entry = entries[0];
        if (!entry) return;
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0 && fitAddonRef.current && xtermRef.current) {
          try { fitAddonRef.current.fit(); } catch {}
        }
      }, 50);
    });

    if (terminalRef.current) resizeObserver.observe(terminalRef.current);

    const handleWindowResize = () => {
      if (fitAddonRef.current && xtermRef.current) {
        try { fitAddonRef.current.fit(); } catch {}
      }
    };
    window.addEventListener('resize', handleWindowResize);

    return () => {
      clearTimeout(resizeTimeout);
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleWindowResize);
    };
  }, [isReady]);

  return (
    <div
      ref={terminalRef}
      className="w-full h-full"
      style={{ minHeight: '200px', minWidth: '200px', position: 'relative' }}
    />
  );
}
