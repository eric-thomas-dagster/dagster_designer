import { useEffect, useState, useRef } from 'react';
import { X, Terminal, CheckCircle, XCircle, Loader } from 'lucide-react';

interface DagsterStartupModalProps {
  projectId: string;
  onClose: () => void;
  onSuccess: (url: string) => void;
}

export function DagsterStartupModal({ projectId, onClose, onSuccess }: DagsterStartupModalProps) {
  const [status, setStatus] = useState<'starting' | 'success' | 'error'>('starting');
  const [command, setCommand] = useState('');
  const [output, setOutput] = useState<string[]>([]);
  const [error, setError] = useState<string>('');
  const outputEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    startDagster();
  }, [projectId]);

  useEffect(() => {
    // Auto-scroll to bottom when new output arrives
    outputEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [output]);

  const startDagster = async () => {
    try {
      setOutput([]);
      setStatus('starting');

      // Show initial output
      setOutput([
        '🚀 Starting Dagster UI...',
        `📍 Project: ${projectId}`,
        '',
        '⏳ Executing command...',
      ]);

      // Make the API call
      const response = await fetch(`/api/v1/dagster-ui/start/${projectId}`, {
        method: 'POST',
      });

      // Get response text first (so we can inspect it)
      const text = await response.text();

      console.log('Response status:', response.status);
      console.log('Response text:', text);
      console.log('Response headers:', Object.fromEntries(response.headers.entries()));

      // Check if response is ok before parsing JSON
      if (!response.ok) {
        // Try to parse error response
        let errorDetail = 'Failed to start Dagster UI';
        let errorData: any = null;

        try {
          if (text) {
            errorData = JSON.parse(text);
            console.log('Parsed error data:', errorData);
            errorDetail = errorData.detail || errorDetail;
          }
        } catch (parseError) {
          console.error('Failed to parse error response as JSON:', parseError);
          // If we can't parse JSON, use the raw text or status
          errorDetail = text || `Server error: ${response.status} ${response.statusText}`;
        }

        // Check for additional error info in headers
        const command = response.headers.get('x-command') || response.headers.get('X-Command');
        const startupLog = response.headers.get('x-startup-log') || response.headers.get('X-Startup-Log');

        // Build error with all available info
        const error: any = new Error(errorDetail);
        error.response = {
          status: response.status,
          statusText: response.statusText,
          data: errorData,
          headers: {
            'x-command': command,
            'x-startup-log': startupLog,
          },
          rawText: text,
        };
        throw error;
      }

      // Parse successful response
      const data = JSON.parse(text);

      // Show the command that was executed (from response if available)
      const cmd = data.command || 'uv run dg dev --port 3000 --host 0.0.0.0';
      setCommand(cmd);

      // Show startup messages
      setOutput([
        '🚀 Starting Dagster UI...',
        `📍 Project: ${projectId}`,
        `💻 Command: ${cmd}`,
        '',
        '⏳ Waiting for server to start...',
        '',
        ...(data.startup_log || []),
        '',
        `✅ Dagster UI started successfully!`,
        `🌐 URL: ${data.url}`,
        `🔢 Port: ${data.port}`,
        `🆔 PID: ${data.pid}`,
      ]);

      setStatus('success');

      // Auto-redirect after 2 seconds
      setTimeout(() => {
        onSuccess(data.url);
      }, 2000);
    } catch (err: any) {
      setStatus('error');

      // Try to extract meaningful error info
      let errorMsg = 'Unknown error occurred';
      let errorDetails: string[] = [];

      console.error('Dagster startup error:', err);

      // Check if it's an error from the fetch response
      if (err.message) {
        errorMsg = err.message;
      }

      // Show response details if available
      if (err.response) {
        errorDetails.push('--- Response Details ---');
        errorDetails.push(`Status: ${err.response.status} ${err.response.statusText}`);
        errorDetails.push('');

        // Show command if available
        const command = err.response.headers?.['x-command'];
        if (command) {
          setCommand(command);
          errorDetails.push('--- Command Executed ---');
          errorDetails.push(command);
          errorDetails.push('');
        }

        // Show startup log from headers
        const startupLog = err.response.headers?.['x-startup-log'];
        if (startupLog) {
          errorDetails.push('--- Startup Log ---');
          errorDetails.push(...startupLog.split('\n'));
          errorDetails.push('');
        }

        // Show data from response body
        if (err.response.data) {
          const data = err.response.data;

          // Handle detailed error object
          if (typeof data === 'object' && data.detail) {
            const detail = data.detail;

            // If detail is an object with error info
            if (typeof detail === 'object') {
              errorMsg = detail.message || detail.error || errorMsg;

              if (detail.error_type) {
                errorDetails.push(`--- Error Type: ${detail.error_type} ---`);
                errorDetails.push('');
              }

              if (detail.error) {
                errorDetails.push('--- Error Message ---');
                errorDetails.push(detail.error);
                errorDetails.push('');
              }

              if (detail.traceback) {
                errorDetails.push('--- Traceback ---');
                errorDetails.push(detail.traceback);
                errorDetails.push('');
              }

              // Show command if available in detail
              if (detail.command) {
                setCommand(detail.command);
              }
            } else {
              // Simple string detail
              errorMsg = detail;
            }
          } else {
            errorMsg = typeof data === 'string' ? data : (data.detail || errorMsg);
          }

          // Handle startup_log from detail object or top-level
          const startupLogArray = (data.detail && typeof data.detail === 'object' && data.detail.startup_log) || data.startup_log;
          if (startupLogArray && Array.isArray(startupLogArray)) {
            errorDetails.push('--- Startup Log ---');
            errorDetails.push(...startupLogArray);
            errorDetails.push('');
          }

          // Show return code if available
          const returncode = (data.detail && typeof data.detail === 'object' && data.detail.returncode);
          if (returncode !== undefined) {
            errorDetails.push(`Process exit code: ${returncode}`);
            errorDetails.push('');
          }
          if (data.stdout) {
            errorDetails.push('--- stdout ---');
            errorDetails.push(data.stdout);
            errorDetails.push('');
          }
          if (data.stderr) {
            errorDetails.push('--- stderr ---');
            errorDetails.push(data.stderr);
            errorDetails.push('');
          }
          if (data.command) {
            setCommand(data.command);
          }
        }

        // Show raw response text if available
        if (err.response.rawText && !err.response.data) {
          errorDetails.push('--- Raw Response ---');
          errorDetails.push(err.response.rawText);
          errorDetails.push('');
        }
      }

      setError(errorMsg);
      setOutput([
        '❌ Failed to start Dagster UI',
        '',
        `Error: ${errorMsg}`,
        '',
        ...errorDetails,
      ]);
    }
  };

  const handleClose = () => {
    if (status === 'starting') {
      if (!confirm('Dagster is still starting. Are you sure you want to close?')) {
        return;
      }
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <div className="flex items-center space-x-2">
            <Terminal className="w-5 h-5 text-gray-700" />
            <h2 className="text-lg font-semibold text-gray-900">Starting Dagster UI</h2>
            {status === 'starting' && <Loader className="w-4 h-4 text-blue-600 animate-spin" />}
            {status === 'success' && <CheckCircle className="w-4 h-4 text-green-600" />}
            {status === 'error' && <XCircle className="w-4 h-4 text-red-600" />}
          </div>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Command */}
        {command && (
          <div className="px-4 pt-4">
            <p className="text-xs font-medium text-gray-500 mb-1">Command:</p>
            <div className="bg-gray-900 text-green-400 p-2 rounded font-mono text-xs overflow-x-auto">
              $ {command}
            </div>
          </div>
        )}

        {/* Output */}
        <div className="flex-1 overflow-y-auto p-4 bg-gray-50">
          <div className="bg-gray-900 text-gray-100 p-4 rounded font-mono text-sm h-full overflow-y-auto">
            {output.length === 0 && (
              <div className="flex items-center space-x-2 text-gray-400">
                <Loader className="w-4 h-4 animate-spin" />
                <span>Initializing...</span>
              </div>
            )}
            {output.map((line, idx) => (
              <div key={idx} className="whitespace-pre-wrap break-words">
                {line}
              </div>
            ))}
            <div ref={outputEndRef} />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-4 border-t border-gray-200 bg-gray-50">
          <div className="text-sm text-gray-600">
            {status === 'starting' && 'Please wait while Dagster UI starts...'}
            {status === 'success' && 'Redirecting to Dagster UI...'}
            {status === 'error' && 'Failed to start. Check the output above for details.'}
          </div>
          <div className="flex space-x-2">
            {status === 'error' && (
              <button
                onClick={() => startDagster()}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700"
              >
                Retry
              </button>
            )}
            <button
              onClick={handleClose}
              className="px-4 py-2 text-sm bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
