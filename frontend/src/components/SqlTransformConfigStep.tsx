import { useEffect, useState } from 'react';
import { X, Loader2, Sparkles, Database } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { assetsApi, API_BASE } from '@/services/api';
import { notify } from './Notifications';

/**
 * Just "connect to a source" -- a resource or a bare connection string,
 * plus the query. No op-builder here: that already lives in
 * DataPreviewModal (the real Transform UI -- ops on the left, live
 * preview on the right, a recipe of steps), and having a second, separate
 * place to set filter/sort/group-by before ever reaching that screen was
 * confusing (two different builders for the same thing). This screen's
 * only job is to make the connected table exist; the caller opens the
 * real Transform UI on it immediately after.
 */
export function SqlTransformConfigStep({
  onConnected,
  onClose,
}: {
  onConnected: (assetKey: string) => void;
  onClose: () => void;
}) {
  const { currentProject } = useProjectStore();

  const [resources, setResources] = useState<{ name: string }[]>([]);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [authMode, setAuthMode] = useState<'resource' | 'connection_string'>('resource');
  const [resourceKey, setResourceKey] = useState('');
  const [connectionUrlEnvVar, setConnectionUrlEnvVar] = useState('');
  const [sourceSql, setSourceSql] = useState('');
  const [assetName, setAssetName] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!currentProject || resources.length > 0 || resourcesLoading) return;
    setResourcesLoading(true);
    fetch(`${API_BASE}/templates/resources/${currentProject.id}`)
      .then((r) => r.json())
      .then((body) => setResources(body.resources || []))
      .catch(() => notify.error('Failed to load registered resources.'))
      .finally(() => setResourcesLoading(false));
  }, [currentProject]);

  const canSave = sourceSql.trim().length > 0 && assetName.trim().length > 0
    && (authMode === 'resource' ? !!resourceKey : connectionUrlEnvVar.trim().length > 0);

  const handleSave = async () => {
    if (!currentProject || !canSave || saving) return;
    setSaving(true);
    try {
      await assetsApi.createSqlSourceTransformer(currentProject.id, {
        sourceSql: sourceSql.trim(),
        ...(authMode === 'resource' ? { resourceKey } : { connectionUrlEnvVar: connectionUrlEnvVar.trim() }),
        newAssetName: assetName.trim(),
        transformConfig: {},
      });
      const componentId = assetName.trim().replace(/-/g, '_').replace(/ /g, '_').toLowerCase();
      notify.success(`Connected "${componentId}" — opening the transform builder…`);
      onConnected(componentId);
    } catch (e: any) {
      notify.error(`Failed to connect: ${e?.response?.data?.detail ?? e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <Database className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">Connect to a source</h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          <p className="text-xs text-gray-500">Runs in the warehouse, no data movement. Once connected, the full Transform UI opens on it — filter, sort, group by, and everything else happens there, against real live rows.</p>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Connect via</label>
            <div className="flex gap-2 mb-1.5">
              <button
                onClick={() => setAuthMode('resource')}
                className={`flex-1 px-2.5 py-1.5 text-xs rounded-md border ${authMode === 'resource' ? 'bg-primary text-primary-foreground border-primary' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
              >
                A registered resource
              </button>
              <button
                onClick={() => setAuthMode('connection_string')}
                className={`flex-1 px-2.5 py-1.5 text-xs rounded-md border ${authMode === 'connection_string' ? 'bg-primary text-primary-foreground border-primary' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
              >
                A connection string
              </button>
            </div>
            {authMode === 'resource' ? (
              resourcesLoading ? (
                <div className="flex items-center gap-2 text-xs text-gray-400"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading registered resources…</div>
              ) : resources.length === 0 ? (
                <p className="text-xs text-amber-600">No resources registered in this project yet — add one, or use a connection string instead.</p>
              ) : (
                <select
                  value={resourceKey}
                  onChange={(e) => setResourceKey(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white font-mono"
                >
                  <option value="" disabled>pick a resource</option>
                  {resources.map((r) => (<option key={r.name} value={r.name}>{r.name}</option>))}
                </select>
              )
            ) : (
              <div>
                <input
                  type="text"
                  value={connectionUrlEnvVar}
                  onChange={(e) => setConnectionUrlEnvVar(e.target.value)}
                  placeholder="DATABASE_URL"
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
                <p className="text-[10px] text-gray-400 mt-0.5">Env var holding a bare SQLAlchemy URL — read at runtime, never stored here.</p>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Source SQL</label>
            <textarea
              value={sourceSql}
              onChange={(e) => setSourceSql(e.target.value)}
              rows={5}
              placeholder={`SELECT * FROM raw_orders WHERE region = 'US'`}
              className="w-full px-2.5 py-1.5 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Table name</label>
            <input
              type="text"
              value={assetName}
              onChange={(e) => setAssetName(e.target.value)}
              placeholder="raw_orders"
              className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-200">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-md">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave || saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {saving ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  );
}
