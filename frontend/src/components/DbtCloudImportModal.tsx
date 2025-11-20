import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { X, Cloud, CheckCircle, AlertCircle, Loader } from 'lucide-react';

interface DbtCloudProject {
  id: number;
  name: string;
  repository_url?: string;
  state?: string;
}

interface DbtCloudConnectionResponse {
  success: boolean;
  projects: DbtCloudProject[];
  jobs_count: number;
  environments_count: number;
  message?: string;
}

interface DbtCloudImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (projectId: string) => void;
}

export function DbtCloudImportModal({ isOpen, onClose, onSuccess }: DbtCloudImportModalProps) {
  const [step, setStep] = useState<'credentials' | 'projects' | 'name' | 'importing'>('credentials');
  const [apiKey, setApiKey] = useState('');
  const [accountId, setAccountId] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [useCustomUrl, setUseCustomUrl] = useState(false);
  const [connectionResponse, setConnectionResponse] = useState<DbtCloudConnectionResponse | null>(null);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<number>>(new Set());
  const [projectName, setProjectName] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Test connection mutation
  const testConnectionMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/v1/dbt-cloud/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          account_id: parseInt(accountId),
          base_url: useCustomUrl ? baseUrl : null,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to connect to dbt Cloud');
      }

      return response.json();
    },
    onSuccess: (data: DbtCloudConnectionResponse) => {
      setConnectionResponse(data);
      setError(null);
      setStep('projects');
    },
    onError: (error: Error) => {
      setError(error.message);
    },
  });

  // Import mutation
  const importMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/v1/dbt-cloud/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          account_id: parseInt(accountId),
          base_url: useCustomUrl ? baseUrl : null,
          project_ids: Array.from(selectedProjectIds),
          dagster_project_name: projectName,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to import projects');
      }

      return response.json();
    },
    onSuccess: (data) => {
      setStep('importing');
      setTimeout(() => {
        onSuccess(data.project_id);
        handleClose();
      }, 2000);
    },
    onError: (error: Error) => {
      setError(error.message);
    },
  });

  const handleClose = () => {
    setStep('credentials');
    setApiKey('');
    setAccountId('');
    setBaseUrl('');
    setUseCustomUrl(false);
    setConnectionResponse(null);
    setSelectedProjectIds(new Set());
    setProjectName('');
    setError(null);
    onClose();
  };

  const handleTestConnection = () => {
    if (!apiKey || !accountId) {
      setError('Please provide API key and account ID');
      return;
    }
    testConnectionMutation.mutate();
  };

  const toggleProjectSelection = (projectId: number) => {
    const newSelection = new Set(selectedProjectIds);
    if (newSelection.has(projectId)) {
      newSelection.delete(projectId);
    } else {
      newSelection.add(projectId);
    }
    setSelectedProjectIds(newSelection);
  };

  const handleContinueToNaming = () => {
    if (selectedProjectIds.size === 0) {
      setError('Please select at least one project');
      return;
    }
    setError(null);
    setStep('name');
  };

  const handleImport = () => {
    if (!projectName.trim()) {
      setError('Please provide a project name');
      return;
    }
    importMutation.mutate();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b">
          <div className="flex items-center gap-2">
            <Cloud className="w-5 h-5 text-blue-600" />
            <h2 className="text-xl font-semibold">Import from dbt Cloud</h2>
          </div>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600"
            disabled={importMutation.isPending}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Progress indicator */}
        <div className="flex items-center justify-center gap-2 p-4 bg-gray-50 border-b">
          <div className={`flex items-center gap-1 ${step === 'credentials' ? 'text-blue-600 font-medium' : step !== 'credentials' ? 'text-green-600' : 'text-gray-400'}`}>
            {step !== 'credentials' ? <CheckCircle className="w-4 h-4" /> : <div className="w-4 h-4 rounded-full border-2 border-current" />}
            <span className="text-sm">Credentials</span>
          </div>
          <div className="w-8 h-px bg-gray-300" />
          <div className={`flex items-center gap-1 ${step === 'projects' ? 'text-blue-600 font-medium' : step === 'name' || step === 'importing' ? 'text-green-600' : 'text-gray-400'}`}>
            {step === 'name' || step === 'importing' ? <CheckCircle className="w-4 h-4" /> : <div className="w-4 h-4 rounded-full border-2 border-current" />}
            <span className="text-sm">Select Projects</span>
          </div>
          <div className="w-8 h-px bg-gray-300" />
          <div className={`flex items-center gap-1 ${step === 'name' ? 'text-blue-600 font-medium' : step === 'importing' ? 'text-green-600' : 'text-gray-400'}`}>
            {step === 'importing' ? <CheckCircle className="w-4 h-4" /> : <div className="w-4 h-4 rounded-full border-2 border-current" />}
            <span className="text-sm">Name Project</span>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Step 1: Credentials */}
          {step === 'credentials' && (
            <div className="space-y-4">
              <p className="text-sm text-gray-600 mb-4">
                Connect to your dbt Cloud account to import projects into Dagster Designer.
              </p>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  API Key *
                </label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="dbt Cloud API key or service token"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Service tokens are recommended for system operations
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Account ID *
                </label>
                <input
                  type="text"
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="e.g., 123456"
                />
                <p className="text-xs text-gray-500 mt-1">
                  6-8 digit identifier from Account Settings or URL
                </p>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="useCustomUrl"
                  checked={useCustomUrl}
                  onChange={(e) => setUseCustomUrl(e.target.checked)}
                  className="rounded border-gray-300"
                />
                <label htmlFor="useCustomUrl" className="text-sm text-gray-700">
                  Use custom API URL (multi-tenant accounts)
                </label>
              </div>

              {useCustomUrl && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Custom API Base URL
                  </label>
                  <input
                    type="text"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="https://YOUR_PREFIX.us1.dbt.com/api/v2"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Must end with <code className="bg-gray-100 px-1 rounded">/api/v2</code> (e.g., https://lm759.us1.dbt.com/api/v2)
                  </p>
                </div>
              )}

              {error && (
                <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-md">
                  <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
                  <span className="text-sm text-red-700">{error}</span>
                </div>
              )}
            </div>
          )}

          {/* Step 2: Project Selection */}
          {step === 'projects' && connectionResponse && (
            <div className="space-y-4">
              <div className="bg-blue-50 border border-blue-200 rounded-md p-3 mb-4">
                <p className="text-sm text-blue-700">
                  Connected successfully! Found {connectionResponse.projects.length} project(s), {connectionResponse.jobs_count} job(s), and {connectionResponse.environments_count} environment(s).
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Select projects to import:
                </label>
                <div className="space-y-2 max-h-96 overflow-y-auto border border-gray-200 rounded-md p-3">
                  {connectionResponse.projects.map((project) => (
                    <label
                      key={project.id}
                      className="flex items-start gap-3 p-2 hover:bg-gray-50 rounded cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selectedProjectIds.has(project.id)}
                        onChange={() => toggleProjectSelection(project.id)}
                        className="mt-1 rounded border-gray-300"
                      />
                      <div className="flex-1">
                        <div className="font-medium text-sm">{project.name}</div>
                        {project.repository_url && (
                          <div className="text-xs text-gray-500 truncate">
                            {project.repository_url}
                          </div>
                        )}
                      </div>
                      {project.state && (
                        <span className={`text-xs px-2 py-1 rounded ${
                          String(project.state) === 'active' || String(project.state) === '1' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'
                        }`}>
                          {String(project.state) === '1' ? 'active' : String(project.state)}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  {selectedProjectIds.size} project(s) selected
                </p>
              </div>

              {error && (
                <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-md">
                  <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
                  <span className="text-sm text-red-700">{error}</span>
                </div>
              )}
            </div>
          )}

          {/* Step 3: Name Project */}
          {step === 'name' && (
            <div className="space-y-4">
              <div className="bg-blue-50 border border-blue-200 rounded-md p-3 mb-4">
                <p className="text-sm text-blue-700">
                  Selected {selectedProjectIds.size} project(s) for import
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Dagster Project Name *
                </label>
                <input
                  type="text"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="my-dagster-project"
                />
                <p className="text-xs text-gray-500 mt-1">
                  This will be the name of your new Dagster Designer project
                </p>
              </div>

              {error && (
                <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-md">
                  <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
                  <span className="text-sm text-red-700">{error}</span>
                </div>
              )}
            </div>
          )}

          {/* Step 4: Importing */}
          {step === 'importing' && (
            <div className="flex flex-col items-center justify-center py-8">
              <Loader className="w-12 h-12 text-blue-600 animate-spin mb-4" />
              <p className="text-lg font-medium text-gray-900">Importing projects...</p>
              <p className="text-sm text-gray-600 mt-2">Cloning repositories and setting up dbt components</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-6 border-t bg-gray-50">
          <button
            onClick={handleClose}
            className="px-4 py-2 text-sm text-gray-700 hover:text-gray-900"
            disabled={testConnectionMutation.isPending || importMutation.isPending}
          >
            Cancel
          </button>
          <div className="flex gap-2">
            {step === 'projects' && (
              <button
                onClick={() => setStep('credentials')}
                className="px-4 py-2 text-sm text-gray-700 hover:text-gray-900"
              >
                Back
              </button>
            )}
            {step === 'name' && (
              <button
                onClick={() => setStep('projects')}
                className="px-4 py-2 text-sm text-gray-700 hover:text-gray-900"
                disabled={importMutation.isPending}
              >
                Back
              </button>
            )}
            {step === 'credentials' && (
              <button
                onClick={handleTestConnection}
                disabled={testConnectionMutation.isPending}
                className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {testConnectionMutation.isPending ? (
                  <>
                    <Loader className="w-4 h-4 animate-spin" />
                    Connecting...
                  </>
                ) : (
                  'Connect'
                )}
              </button>
            )}
            {step === 'projects' && (
              <button
                onClick={handleContinueToNaming}
                className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700"
              >
                Continue
              </button>
            )}
            {step === 'name' && (
              <button
                onClick={handleImport}
                disabled={importMutation.isPending}
                className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {importMutation.isPending ? (
                  <>
                    <Loader className="w-4 h-4 animate-spin" />
                    Importing...
                  </>
                ) : (
                  'Import Projects'
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
