import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cloud, Download, Loader2 } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { notify } from './Notifications';

interface ManifestComponent {
  id: string;
  name: string;
  category: string;
  description?: string;
  tags?: string[];
}

interface InstalledComponent {
  id: string;
  name: string;
  description: string;
  component_type: string;
  category: string;
}

interface CommunityAvailableSectionProps {
  /** Which manifest categories to include. First entry is used as the empty-state label. */
  categories: string[];
  /** Section title (e.g. "Community asset checks"). */
  title: string;
  /** Called after a successful install so the parent can refresh its list. */
  onInstalled?: (componentType: string) => void;
  /** Optional cap on how many available entries to show (default: unlimited). */
  limit?: number;
}

export function CommunityAvailableSection({
  categories,
  title,
  onInstalled,
  limit,
}: CommunityAvailableSectionProps) {
  const { currentProject, loadProject } = useProjectStore();
  const queryClient = useQueryClient();
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [search, setSearch] = useState('');

  const { data: manifest, isLoading } = useQuery({
    queryKey: ['community-templates-manifest'],
    queryFn: async () => {
      const res = await fetch('/api/v1/templates/manifest');
      if (!res.ok) throw new Error('Failed to load community manifest');
      return res.json() as Promise<{ components: ManifestComponent[] }>;
    },
    staleTime: 15 * 60 * 1000,
  });

  const { data: installed } = useQuery({
    queryKey: ['installed-components', currentProject?.id],
    queryFn: async () => {
      if (!currentProject) return { components: [] as InstalledComponent[] };
      const res = await fetch(`/api/v1/templates/installed/${currentProject.id}`);
      if (!res.ok) return { components: [] as InstalledComponent[] };
      return res.json() as Promise<{ components: InstalledComponent[] }>;
    },
    enabled: !!currentProject,
  });

  const installMutation = useMutation({
    mutationFn: async (componentId: string) => {
      if (!currentProject) throw new Error('No project selected');
      setInstallingId(componentId);
      const res = await fetch(`/api/v1/templates/install-via-cli/${componentId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: currentProject.id, config: {} }),
      });
      const body = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(body.detail || 'Install failed');
      return body as { component_type: string };
    },
    onSuccess: async (data) => {
      notify.success('Component installed.');
      if (currentProject) {
        await queryClient.invalidateQueries({ queryKey: ['installed-components', currentProject.id] });
        await queryClient.invalidateQueries({ queryKey: ['primitives', currentProject.id] });
        await queryClient.invalidateQueries({ queryKey: ['definitions', currentProject.id] });
        await queryClient.invalidateQueries({ queryKey: ['installed-resources', currentProject.id] });
        await loadProject(currentProject.id);
      }
      onInstalled?.(data.component_type);
    },
    onError: (e: Error) => notify.error(`Install failed: ${e.message}`),
    onSettled: () => setInstallingId(null),
  });

  const installedIds = useMemo(
    () => new Set((installed?.components || []).map((c) => c.id)),
    [installed],
  );

  const catSet = useMemo(() => new Set(categories.map((c) => c.toLowerCase())), [categories]);
  const q = search.toLowerCase().trim();
  const filtered = useMemo<ManifestComponent[]>(() => {
    if (!manifest?.components) return [];
    const matches = manifest.components.filter((c) => {
      if (!catSet.has((c.category || '').toLowerCase())) return false;
      if (installedIds.has(c.id)) return false;
      if (!q) return true;
      const hay = `${c.name} ${c.description || ''} ${(c.tags || []).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
    return limit ? matches.slice(0, limit) : matches;
  }, [manifest, installedIds, catSet, q, limit]);

  if (isLoading) {
    return (
      <div className="px-4 py-2 text-xs text-gray-500 flex items-center gap-1.5">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Loading community catalog…
      </div>
    );
  }

  if (filtered.length === 0 && !q) return null;

  return (
    <div className="border-t border-gray-200 mt-2">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider hover:bg-gray-50"
      >
        <span className="flex items-center gap-1.5">
          <Cloud className="w-3.5 h-3.5" />
          {title}
          <span className="text-gray-400 font-normal normal-case tracking-normal">
            · {filtered.length}
          </span>
        </span>
        <span className="text-gray-400">{expanded ? '−' : '+'}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-1.5">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter community components…"
            className="w-full px-2.5 py-1.5 text-sm border border-gray-200 rounded focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
          />
          {filtered.map((comp) => {
            const isInstalling = installingId === comp.id;
            return (
              <button
                key={comp.id}
                onClick={() => !isInstalling && installMutation.mutate(comp.id)}
                disabled={isInstalling}
                title={comp.description || comp.name}
                className="w-full flex items-center gap-2 px-2.5 py-2 border border-dashed border-gray-300 bg-white rounded-md hover:border-primary/50 hover:bg-primary/5 transition-all group text-left disabled:opacity-60"
              >
                <Cloud className="w-4 h-4 text-gray-400 group-hover:text-primary flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-gray-900 truncate">{comp.name}</div>
                  {comp.description && (
                    <div className="text-[11px] text-gray-500 truncate">{comp.description}</div>
                  )}
                </div>
                {isInstalling ? (
                  <Loader2 className="w-3.5 h-3.5 text-primary animate-spin flex-shrink-0" />
                ) : (
                  <Download className="w-3.5 h-3.5 text-gray-400 group-hover:text-primary flex-shrink-0" />
                )}
              </button>
            );
          })}
          {filtered.length === 0 && q && (
            <div className="text-xs text-gray-400 py-2 text-center">No matches</div>
          )}
        </div>
      )}
    </div>
  );
}
