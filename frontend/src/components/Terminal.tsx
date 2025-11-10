import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { filesApi } from '@/services/api';
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
  const isExecutingRef = useRef(false);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (!terminalRef.current) return;

    // Wait for container to have actual dimensions
    const checkDimensions = () => {
      if (!terminalRef.current) return;

      const rect = terminalRef.current.getBoundingClientRect();
      console.log('Container dimensions:', { width: rect.width, height: rect.height });

      if (rect.width > 0 && rect.height > 0 && !xtermRef.current) {
        console.log('Initializing xterm terminal with dimensions...');

        // Create terminal instance with Dagster brand colors
        const term = new XTerm({
          cursorBlink: true,
          fontSize: 14,
          fontFamily: 'Menlo, Monaco, "Courier New", monospace',
          theme: {
            background: '#121926', // Dagster Gray 900
            foreground: '#F7F7FF', // Dagster White
            cursor: '#4F43DD', // Blurple cursor
            black: '#1B0130', // Dagster Black
            red: '#cd3131',
            green: '#0dbc79',
            yellow: '#e5e510',
            blue: '#4F43DD', // Blurple
            magenta: '#A7A0F8', // Light Blurple
            cyan: '#11a8cd',
            white: '#CDD5DF', // Gray 300
            brightBlack: '#4B5565', // Gray 600
            brightRed: '#f14c4c',
            brightGreen: '#23d18b',
            brightYellow: '#f5f543',
            brightBlue: '#A7A0F8', // Light Blurple
            brightMagenta: '#332AA6', // Deep Blurple
            brightCyan: '#29b8db',
            brightWhite: '#F7F7FF', // Dagster White
          },
          scrollback: 1000,
          convertEol: true,
        });

        // Create fit addon
        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);

        // Store refs
        xtermRef.current = term;
        fitAddonRef.current = fitAddon;

        // Open terminal
        try {
          term.open(terminalRef.current);
          console.log('Terminal opened successfully');

          // Fit to container
          fitAddon.fit();
          console.log('Terminal fitted successfully');

          setIsReady(true);
        } catch (err) {
          console.error('Failed to open terminal:', err);
          return;
        }

        // Welcome message
        term.writeln('\x1b[1;32mDagster Designer Terminal\x1b[0m');
        term.writeln('Type your commands below. Working directory: project root');
        term.writeln('');
        term.write('$ ');

        // Handle terminal input
        term.onData((data) => {
          if (isExecutingRef.current) return;

          const code = data.charCodeAt(0);

          // Handle Enter (execute command)
          if (code === 13) {
            const command = currentLineRef.current.trim();
            if (command) {
              term.write('\r\n');
              isExecutingRef.current = true;

              filesApi.execute(projectId, command)
                .then((result) => {
                  const output = result.success
                    ? result.stdout || 'Command completed successfully'
                    : result.stderr || 'Command failed';

                  if (output) {
                    term.writeln(output);
                  }
                  term.write('\r\n$ ');
                })
                .catch((error) => {
                  term.writeln(`\x1b[31mError: ${error.message}\x1b[0m`);
                  term.write('\r\n$ ');
                })
                .finally(() => {
                  isExecutingRef.current = false;
                  currentLineRef.current = '';
                });
            } else {
              term.write('\r\n$ ');
            }
            currentLineRef.current = '';
            return;
          }

          // Handle Backspace
          if (code === 127) {
            if (currentLineRef.current.length > 0) {
              currentLineRef.current = currentLineRef.current.slice(0, -1);
              term.write('\b \b');
            }
            return;
          }

          // Handle Ctrl+C
          if (code === 3) {
            term.write('^C\r\n$ ');
            currentLineRef.current = '';
            return;
          }

          // Handle Ctrl+L (clear screen)
          if (code === 12) {
            term.clear();
            term.write('$ ' + currentLineRef.current);
            return;
          }

          // Handle printable characters
          if (code >= 32 && code < 127) {
            currentLineRef.current += data;
            term.write(data);
          }
        });
      }
    };

    // Check dimensions multiple times to catch when layout is ready
    const timeouts = [10, 50, 100, 200, 300];
    const timers = timeouts.map(delay => setTimeout(checkDimensions, delay));

    return () => {
      timers.forEach(timer => clearTimeout(timer));
      if (xtermRef.current) {
        xtermRef.current.dispose();
        xtermRef.current = null;
      }
    };
  }, [projectId]);

  // Handle resize after terminal is initialized
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
          try {
            fitAddonRef.current.fit();
            console.log('Terminal resized:', { width, height });
          } catch (err) {
            console.warn('Failed to resize terminal:', err);
          }
        }
      }, 50);
    });

    if (terminalRef.current) {
      resizeObserver.observe(terminalRef.current);
    }

    // Also handle window resize
    const handleWindowResize = () => {
      if (fitAddonRef.current && xtermRef.current) {
        try {
          fitAddonRef.current.fit();
        } catch (err) {
          console.warn('Failed to resize terminal on window resize:', err);
        }
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
      style={{
        minHeight: '200px',
        minWidth: '200px',
        position: 'relative',
      }}
    />
  );
}
