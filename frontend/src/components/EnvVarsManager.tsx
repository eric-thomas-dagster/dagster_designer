import { useState, useEffect, useMemo } from 'react';
import { Plus, Trash2, Eye, EyeOff, Save, RefreshCw, Cloud, HardDrive } from 'lucide-react';
import { envVarsApi, type EnvVariable } from '@/services/api';
import { notify } from './Notifications';

interface EnvVarsManagerProps {
  projectId: string;
}

// A "scope" is either the local .env file or a specific Dagster+ deployment
// (optionally further scoped to a code location).
type LocalScope = { kind: 'local' };
type PlusScope = { kind: 'plus'; deployment: string; codeLocation?: string };
type Scope = LocalScope | PlusScope;

function scopeKey(scope: Scope): string {
  if (scope.kind === 'local') return 'local';
  return `plus:${scope.deployment}:${scope.codeLocation ?? ''}`;
}

function scopeLabel(scope: Scope): string {
  if (scope.kind === 'local') return 'Local (.env)';
  return scope.deployment;
}

interface ScopeState {
  loading: boolean;
  loaded: boolean;
  saving: boolean;
  hasChanges: boolean;
  error: string | null;
  variables: EnvVariable[];
}

const emptyScopeState: ScopeState = {
  loading: false,
  loaded: false,
  saving: false,
  hasChanges: false,
  error: null,
  variables: [],
};

export function EnvVarsManager({ projectId }: EnvVarsManagerProps) {
  const [activeScope, setActiveScope] = useState<Scope>({ kind: 'local' });
  const [scopeData, setScopeData] = useState<Record<string, ScopeState>>({});
  const [maskedValues, setMaskedValues] = useState<Set<string>>(new Set());
  const [availableDeployments, setAvailableDeployments] = useState<string[]>([]);
  const [availableCodeLocations, setAvailableCodeLocations] = useState<string[]>([]);
  const [dagsterPlusAuthed, setDagsterPlusAuthed] = useState<boolean>(false);

  const activeKey = scopeKey(activeScope);
  const activeState = scopeData[activeKey] ?? emptyScopeState;

  const updateActive = (patch: Partial<ScopeState>) => {
    setScopeData((prev) => ({
      ...prev,
      [activeKey]: { ...(prev[activeKey] ?? emptyScopeState), ...patch },
    }));
  };

  // Fetch Dagster+ deployments/locations on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v1/env/${projectId}/dagster-plus-scope`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        setAvailableDeployments(data.deployments || []);
        setAvailableCodeLocations(data.code_locations || []);
        setDagsterPlusAuthed(!!data.authenticated);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Load whichever scope is active if it hasn't been loaded yet.
  useEffect(() => {
    if (activeState.loaded || activeState.loading) return;
    loadScope(activeScope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  const loadScope = async (scope: Scope) => {
    const key = scopeKey(scope);
    setScopeData((prev) => ({
      ...prev,
      [key]: { ...(prev[key] ?? emptyScopeState), loading: true, error: null },
    }));
    try {
      let vars: EnvVariable[] = [];
      if (scope.kind === 'local') {
        const response = await envVarsApi.get(projectId);
        vars = response.variables;
      } else {
        const res = await fetch(`/api/v1/env/${projectId}/scoped-fetch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deployment: scope.deployment,
            code_location: scope.codeLocation || undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Fetch failed');
        vars = data.variables || [];
      }

      // Mask sensitive values by default.
      setMaskedValues((prev) => {
        const next = new Set(prev);
        vars.filter((v) => v.is_sensitive).forEach((v) => next.add(`${key}:${v.key}`));
        return next;
      });

      setScopeData((prev) => ({
        ...prev,
        [key]: {
          ...emptyScopeState,
          loading: false,
          loaded: true,
          variables: vars,
        },
      }));
    } catch (err: any) {
      setScopeData((prev) => ({
        ...prev,
        [key]: {
          ...(prev[key] ?? emptyScopeState),
          loading: false,
          error: err?.message || 'Failed to load environment variables',
        },
      }));
    }
  };

  const handleAddVariable = () => {
    updateActive({
      variables: [...activeState.variables, { key: '', value: '', is_sensitive: false }],
      hasChanges: true,
    });
  };

  const handleRemoveVariable = (index: number) => {
    updateActive({
      variables: activeState.variables.filter((_, i) => i !== index),
      hasChanges: true,
    });
  };

  const handleUpdateVariable = (index: number, field: keyof EnvVariable, value: string | boolean) => {
    const next = [...activeState.variables];
    next[index] = { ...next[index], [field]: value };
    updateActive({ variables: next, hasChanges: true });
  };

  const toggleMask = (variableKey: string) => {
    const cacheKey = `${activeKey}:${variableKey}`;
    setMaskedValues((prev) => {
      const next = new Set(prev);
      if (next.has(cacheKey)) next.delete(cacheKey);
      else next.add(cacheKey);
      return next;
    });
  };

  const handleSave = async () => {
    // Validate.
    for (const v of activeState.variables) {
      if (!v.key.trim()) {
        updateActive({ error: 'All variables must have a key' });
        return;
      }
    }

    updateActive({ saving: true, error: null });
    try {
      if (activeScope.kind === 'local') {
        await envVarsApi.update(projectId, activeState.variables);
        notify.success('Local .env saved');
      } else {
        const res = await fetch(`/api/v1/env/${projectId}/scoped-push`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope: {
              deployment: activeScope.deployment,
              code_location: activeScope.codeLocation || undefined,
            },
            variables: activeState.variables,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Push failed');
        notify.success(data.message || `Pushed to Dagster+ (${activeScope.deployment})`);
      }
      updateActive({ hasChanges: false, saving: false });
    } catch (err: any) {
      updateActive({
        saving: false,
        error: err?.message || 'Failed to save',
      });
      notify.error(err?.message || 'Save failed');
    }
  };

  // Tabs to render: Local + one per deployment.
  const tabs: Scope[] = useMemo(() => {
    const t: Scope[] = [{ kind: 'local' }];
    for (const d of availableDeployments) {
      t.push({ kind: 'plus', deployment: d });
    }
    return t;
  }, [availableDeployments]);

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Scope tabs */}
      <div className="bg-white border-b border-gray-200 flex items-center overflow-x-auto">
        {tabs.map((scope) => {
          const key = scopeKey(scope);
          const isActive = key === activeKey;
          const Icon = scope.kind === 'local' ? HardDrive : Cloud;
          return (
            <button
              key={key}
              onClick={() => setActiveScope(scope)}
              className={`flex items-center gap-2 px-4 py-3 text-sm border-b-2 transition-colors whitespace-nowrap ${
                isActive
                  ? 'border-primary text-primary'
                  : 'border-transparent text-gray-600 hover:text-gray-900'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{scopeLabel(scope)}</span>
              {scope.kind === 'plus' && (
                <span className="text-[10px] uppercase tracking-wider text-gray-400">Dagster+</span>
              )}
            </button>
          );
        })}
        {!dagsterPlusAuthed && (
          <span className="ml-auto pr-4 text-xs text-gray-500">
            Sign in with <code className="bg-gray-100 px-1 rounded">dg plus login</code> to see Dagster+ scopes
          </span>
        )}
      </div>

      {/* Action bar */}
      <div className="bg-white border-b border-gray-200 px-4 py-2 flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          {activeScope.kind === 'local' ? (
            <>Editing <code className="bg-gray-100 px-1 rounded">.env</code> — read by <code className="bg-gray-100 px-1 rounded">dagster dev</code></>
          ) : (
            <>
              Editing Dagster+ deployment <code className="bg-gray-100 px-1 rounded">{activeScope.deployment}</code>
              {availableCodeLocations.length > 0 && (
                <>
                  {' · '}
                  <select
                    value={activeScope.codeLocation || ''}
                    onChange={(e) => {
                      const codeLocation = e.target.value || undefined;
                      const nextScope: PlusScope = {
                        kind: 'plus',
                        deployment: activeScope.deployment,
                        codeLocation,
                      };
                      setActiveScope(nextScope);
                    }}
                    className="text-xs bg-white border border-gray-300 rounded px-1.5 py-0.5"
                  >
                    <option value="">Code location: (any)</option>
                    {availableCodeLocations.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => loadScope(activeScope)}
            disabled={activeState.loading}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${activeState.loading ? 'animate-spin' : ''}`} />
            <span>Reload</span>
          </button>
          <button
            onClick={handleSave}
            disabled={activeState.saving || !activeState.hasChanges || activeState.loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
            title={
              activeScope.kind === 'local'
                ? 'Save to .env file'
                : `Push to Dagster+ (${activeScope.deployment})`
            }
          >
            <Save className="w-4 h-4" />
            <span>
              {activeState.saving
                ? 'Saving…'
                : activeScope.kind === 'local'
                ? 'Save'
                : 'Push to Dagster+'}
            </span>
          </button>
        </div>
      </div>

      {/* Error banner */}
      {activeState.error && (
        <div className="mx-4 mt-3 p-3 bg-red-50 border border-red-200 rounded-md">
          <p className="text-sm text-red-800 whitespace-pre-wrap">{activeState.error}</p>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-6 pb-8">
        {activeState.loading && !activeState.loaded ? (
          <div className="flex items-center justify-center h-64 text-gray-500 text-sm">
            <RefreshCw className="w-5 h-5 mr-2 animate-spin" />
            Loading…
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-gray-200">
            {/* Table header */}
            <div className="grid grid-cols-12 gap-4 px-4 py-3 bg-gray-50 border-b border-gray-200 font-medium text-xs text-gray-700 uppercase tracking-wider">
              <div className="col-span-4">Variable Name</div>
              <div className="col-span-6">Value</div>
              <div className="col-span-2 text-right">Actions</div>
            </div>

            {activeState.variables.length === 0 ? (
              <div className="p-8 text-center text-gray-500">
                <p>No environment variables in this scope.</p>
                <p className="text-sm mt-2">Click "Add variable" to create one.</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-200">
                {activeState.variables.map((variable, index) => (
                  <div key={index} className="grid grid-cols-12 gap-4 px-4 py-3 items-center">
                    <div className="col-span-4">
                      <input
                        type="text"
                        value={variable.key}
                        onChange={(e) => handleUpdateVariable(index, 'key', e.target.value)}
                        placeholder="VARIABLE_NAME"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary font-mono text-sm"
                      />
                    </div>
                    <div className="col-span-6">
                      <div className="relative">
                        <input
                          type={maskedValues.has(`${activeKey}:${variable.key}`) && variable.is_sensitive ? 'password' : 'text'}
                          value={variable.value}
                          onChange={(e) => handleUpdateVariable(index, 'value', e.target.value)}
                          placeholder="value"
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary font-mono text-sm pr-10"
                        />
                        {variable.is_sensitive && (
                          <button
                            onClick={() => toggleMask(variable.key)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                            title={maskedValues.has(`${activeKey}:${variable.key}`) ? 'Show value' : 'Hide value'}
                          >
                            {maskedValues.has(`${activeKey}:${variable.key}`) ? (
                              <Eye className="w-4 h-4" />
                            ) : (
                              <EyeOff className="w-4 h-4" />
                            )}
                          </button>
                        )}
                      </div>
                      {variable.is_sensitive && (
                        <p className="text-xs text-amber-600 mt-1">Sensitive value — handle with care</p>
                      )}
                    </div>
                    <div className="col-span-2 flex items-center justify-end space-x-2">
                      <button
                        onClick={() => handleRemoveVariable(index)}
                        className="p-2 text-red-600 hover:bg-red-50 rounded-md transition-colors"
                        title="Remove variable"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="px-4 py-2 bg-gray-50 border-t border-gray-200">
              <button
                onClick={handleAddVariable}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-sm text-primary hover:bg-primary/5 rounded-md transition-colors"
              >
                <Plus className="w-4 h-4" />
                <span>Add variable</span>
              </button>
            </div>
          </div>
        )}

        {/* About */}
        <div className="mt-6 mb-4 p-4 bg-blue-50 border border-blue-200 rounded-md">
          <h3 className="text-sm font-medium text-blue-900 mb-2">About environment variables</h3>
          <ul className="text-sm text-blue-800 space-y-1">
            <li>• <strong>Local</strong> tab edits the <code className="bg-white px-1 rounded">.env</code> file at the project root (loaded by <code className="bg-white px-1 rounded">dagster dev</code> / <code className="bg-white px-1 rounded">dg dev</code>)</li>
            <li>• Each <strong>Dagster+</strong> tab reads and writes that deployment's env vars via <code className="bg-white px-1 rounded">dg plus env</code>. Editing one scope does <em>not</em> affect the others.</li>
            <li>• Sensitive keys (containing "password", "secret", "key", "token") are masked in the UI</li>
            <li>
              •{' '}
              <a
                href="https://docs.dagster.io/deployment/dagster-plus/full-deployments/managing-environment-variables"
                target="_blank"
                rel="noreferrer"
                className="underline hover:no-underline font-medium"
              >
                Docs: Dagster+ environment variables
              </a>
              {' · '}
              <a
                href="https://docs.dagster.io/api/clis/dg-cli/dg-plus#env-1"
                target="_blank"
                rel="noreferrer"
                className="underline hover:no-underline"
              >
                dg plus env pull
              </a>
              {' · '}
              <a
                href="https://docs.dagster.io/api/clis/dg-cli/dg-plus#env"
                target="_blank"
                rel="noreferrer"
                className="underline hover:no-underline"
              >
                dg plus env push
              </a>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
