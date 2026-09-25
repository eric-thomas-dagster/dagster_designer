import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// The app has a transparent <body> in Tauri (native window vibrancy --
// see main.tsx), and nothing here caught render errors before this. An
// uncaught exception anywhere unmounts the WHOLE React tree, and with a
// transparent body that shows as a plain gray/blurred window with nothing
// on it -- confirmed live (a ComponentConfigModal open that threw looked
// exactly like this: "the UI went gray"). This catches render errors and
// shows a recoverable message with the real error instead of a silent,
// undebuggable blank window.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] Caught render error:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(30, 30, 30, 0.92)',
            color: '#fff',
            padding: 24,
            zIndex: 9999,
          }}
        >
          <div style={{ maxWidth: 560 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
              Something went wrong rendering this screen
            </h2>
            <p style={{ fontSize: 13, opacity: 0.8, marginBottom: 12 }}>
              {this.state.error.message}
            </p>
            <button
              onClick={() => this.setState({ error: null })}
              style={{
                fontSize: 13,
                padding: '6px 12px',
                borderRadius: 6,
                background: '#fff',
                color: '#111',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              Dismiss and try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
