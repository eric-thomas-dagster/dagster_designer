import { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  X, Search, Loader2, Users, Megaphone, LifeBuoy, BarChart3, GitBranch, ShoppingBag,
  DollarSign, Briefcase, Boxes, ArrowRight,
} from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { notify } from './Notifications';
import { API_BASE } from '@/services/api';

interface ManifestComponent {
  id: string;
  name: string;
  category: string;
  description: string;
  tags?: string[];
}

interface AddActivationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTargetPicked: (componentType: string) => void;
}

// The `reverse_etl` category (added to schema-spec.json's category enum
// once the manifest actually had enough of these to warrant its own
// bucket, not just a `sink` + `reverse-etl` tag combo) -- syncing data
// OUT to a business tool, the mirror image of Ingestions.
const ACTIVATION_CATEGORIES = new Set(['reverse_etl']);

// No authored `vertical` field on these yet (unlike ingestion/source/
// security) -- group by tag instead, since these are curated tags, not
// a name/id guess.
type GroupMeta = { label: string; icon: any; tags: string[] };
const TAG_GROUPS: GroupMeta[] = [
  { label: 'CRM & sales', icon: Users, tags: ['crm'] },
  { label: 'Marketing & engagement', icon: Megaphone, tags: ['customer-engagement', 'marketing'] },
  { label: 'Customer support', icon: LifeBuoy, tags: ['support'] },
  { label: 'Product analytics & CDP', icon: BarChart3, tags: ['product-analytics', 'cdp'] },
  { label: 'DevOps & project management', icon: GitBranch, tags: ['devops', 'itsm', 'project-management'] },
  { label: 'E-commerce', icon: ShoppingBag, tags: ['e-commerce'] },
  { label: 'Finance', icon: DollarSign, tags: ['finance'] },
  { label: 'Productivity & docs', icon: Briefcase, tags: ['google_sheets', 'airtable', 'notion'] },
];
const OTHER_GROUP: GroupMeta = { label: 'Other targets', icon: Boxes, tags: [] };

function classify(comp: ManifestComponent): GroupMeta {
  const tags = new Set(comp.tags || []);
  return TAG_GROUPS.find((g) => g.tags.some((t) => tags.has(t))) ?? OTHER_GROUP;
}

export function AddActivationDialog({ open, onOpenChange, onTargetPicked }: AddActivationDialogProps) {
  const [query, setQuery] = useState('');
  const [installingId, setInstallingId] = useState<string | null>(null);
  const { currentProject } = useProjectStore();
  const queryClient = useQueryClient();

  const { data: manifest, isLoading } = useQuery({
    queryKey: ['community-templates-manifest'],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/templates/manifest`);
      if (!res.ok) throw new Error('Failed to load community manifest');
      return res.json() as Promise<{ components: ManifestComponent[] }>;
    },
    staleTime: 15 * 60 * 1000,
    enabled: open,
  });

  const install = useMutation({
    mutationFn: async (componentId: string) => {
      if (!currentProject) throw new Error('No project selected');
      setInstallingId(componentId);
      const res = await fetch(`${API_BASE}/templates/install-via-cli/${componentId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: currentProject.id, config: {}, template_only: true }),
      });
      const body = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(body.detail || 'Install failed');
      return body as { component_type: string };
    },
    onSuccess: async (data) => {
      notify.success('Activation target added. Configuring…');
      if (currentProject) {
        await queryClient.invalidateQueries({ queryKey: ['installed-components', currentProject.id] });
      }
      onTargetPicked(data.component_type);
      onOpenChange(false);
    },
    onError: (e: Error) => notify.error(`Install failed: ${e.message}`),
    onSettled: () => setInstallingId(null),
  });

  const targetComponents = useMemo(() => {
    const all = manifest?.components ?? [];
    return all.filter((c) => ACTIVATION_CATEGORIES.has((c.category || '').toLowerCase()));
  }, [manifest]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return targetComponents;
    return targetComponents.filter((c) =>
      c.id.toLowerCase().includes(q) ||
      c.name.toLowerCase().includes(q) ||
      (c.description || '').toLowerCase().includes(q) ||
      (c.tags || []).some((t) => t.toLowerCase().includes(q))
    );
  }, [targetComponents, q]);

  const grouped = useMemo(() => {
    const buckets = new Map<string, GroupMeta & { items: ManifestComponent[] }>();
    for (const c of filtered) {
      const g = classify(c);
      if (!buckets.has(g.label)) buckets.set(g.label, { ...g, items: [] });
      buckets.get(g.label)!.items.push(c);
    }
    const order = [...TAG_GROUPS.map((g) => g.label), OTHER_GROUP.label];
    return order.map((label) => buckets.get(label)).filter((v): v is GroupMeta & { items: ManifestComponent[] } => !!v);
  }, [filtered]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-xl z-50 w-[880px] max-w-[95vw] h-[80vh] max-h-[720px] flex flex-col">
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
            <div>
              <Dialog.Title className="text-lg font-semibold text-gray-900">Add activation</Dialog.Title>
              <p className="text-sm text-gray-500 mt-0.5">
                Sync data OUT to a business tool — a CRM, marketing platform, support desk, or CDP.
              </p>
            </div>
            <Dialog.Close asChild>
              <button className="p-2 hover:bg-gray-100 rounded-lg" aria-label="Close">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </Dialog.Close>
          </div>

          <div className="px-6 py-3 border-b border-gray-100">
            <div className="relative">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
                placeholder="Search activation targets — salesforce, braze, hubspot…"
                className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4">
            {isLoading && (
              <div className="flex items-center justify-center h-full text-gray-500 text-sm gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading activation targets…
              </div>
            )}
            {!isLoading && filtered.length === 0 && (
              <div className="text-center text-sm text-gray-500 mt-8">
                No activation targets match "{query}". Try a different term.
              </div>
            )}
            <div className="space-y-6">
              {grouped.map(({ label, icon: Icon, items }) => (
                <section key={label}>
                  <div className="flex items-center gap-2 mb-2">
                    <Icon className="w-4 h-4 text-gray-500" />
                    <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">{label}</h3>
                    <span className="text-xs text-gray-400">{items.length}</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {items.map((comp) => (
                      <button
                        key={comp.id}
                        disabled={install.isPending && installingId === comp.id}
                        onClick={() => install.mutate(comp.id)}
                        className="text-left p-3 border border-gray-200 rounded-lg hover:border-emerald-300 hover:shadow-sm bg-white flex items-start gap-3 disabled:opacity-60 disabled:cursor-progress group"
                      >
                        <div className="w-8 h-8 rounded bg-emerald-50 border border-emerald-100 flex items-center justify-center flex-shrink-0">
                          <Icon className="w-4 h-4 text-emerald-600" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1">
                            <span className="text-sm font-medium text-gray-900 truncate">{comp.name}</span>
                            {installingId === comp.id && <Loader2 className="w-3 h-3 text-gray-400 animate-spin flex-shrink-0" />}
                          </div>
                          {comp.description && <p className="text-xs text-gray-500 line-clamp-2 mt-0.5">{comp.description}</p>}
                        </div>
                        <ArrowRight className="w-4 h-4 text-gray-300 group-hover:text-emerald-500 flex-shrink-0 mt-1" />
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
