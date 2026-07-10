import { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  X, Search, Loader2, Database, Cloud, FileText, Boxes, Globe, Sparkles, ArrowRight,
} from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { notify } from './Notifications';

interface ManifestComponent {
  id: string;
  name: string;
  category: string;
  description: string;
  tags?: string[];
}

interface AddDataDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the installed component_type once a source is picked +
   *  installed. Wired to the same setAddingComponentType path the
   *  palette uses so the config modal opens immediately. */
  onSourcePicked: (componentType: string) => void;
}

// Only ingestion-shaped categories from the community manifest — we want
// this dialog to feel like "connect to a data source", not the full palette.
const DATA_CATEGORIES = new Set(['ingestion', 'source']);

// Sub-category bins driven by name heuristics. Ordered — first match wins.
// Left as a table so it's easy to nudge new components into a bucket without
// touching the render logic.
type Bin = { id: string; label: string; icon: any; match: (id: string, name: string) => boolean };
const BINS: Bin[] = [
  {
    id: 'files',
    label: 'Files & object storage',
    icon: FileText,
    match: (id, name) => /csv|excel|xlsx|json|parquet|xml|tsv|feather|orc|avro|txt|file|upload|s3|gcs|gs_|azure_blob|adls|minio|ftp|sftp/i.test(id + ' ' + name),
  },
  {
    id: 'databases',
    label: 'Databases & warehouses',
    icon: Database,
    match: (id, name) => /postgres|mysql|mariadb|sqlserver|mssql|oracle|snowflake|bigquery|redshift|clickhouse|duckdb|databricks|athena|presto|trino|singlestore|cockroach|db2|firebolt|motherduck|sqlite/i.test(id + ' ' + name),
  },
  {
    id: 'saas',
    label: 'SaaS connectors',
    icon: Cloud,
    match: (id, name) => /salesforce|hubspot|servicenow|workday|adobe|google_analytics|google_ads|facebook|linkedin|twitter|shopify|stripe|zendesk|jira|asana|notion|airtable|slack|intercom|marketo|mailchimp|pipedrive|zoho|freshdesk|greenhouse|okta|auth0|braze|iterable|amplitude|segment|mixpanel|heap|posthog|klaviyo|onelogin/i.test(id + ' ' + name),
  },
  {
    id: 'apis',
    label: 'APIs & webhooks',
    icon: Globe,
    match: (id, name) => /rest_api|api_|_api$|webhook|graphql|soap|json_api/i.test(id + ' ' + name),
  },
  {
    id: 'synthetic',
    label: 'Synthetic & demo data',
    icon: Sparkles,
    match: (id, name) => /synthetic|mock|sample|demo|faker|generate/i.test(id + ' ' + name),
  },
];
const OTHER_BIN: Bin = { id: 'other', label: 'Other sources', icon: Boxes, match: () => true };

function classify(comp: ManifestComponent): Bin {
  return BINS.find((b) => b.match(comp.id, comp.name)) ?? OTHER_BIN;
}

export function AddDataDialog({ open, onOpenChange, onSourcePicked }: AddDataDialogProps) {
  const [query, setQuery] = useState('');
  const [installingId, setInstallingId] = useState<string | null>(null);
  const { currentProject } = useProjectStore();
  const queryClient = useQueryClient();

  const { data: manifest, isLoading } = useQuery({
    queryKey: ['community-templates-manifest'],
    queryFn: async () => {
      const res = await fetch('/api/v1/templates/manifest');
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
      notify.success('Data source added. Configuring…');
      if (currentProject) {
        await queryClient.invalidateQueries({ queryKey: ['installed-components', currentProject.id] });
      }
      onSourcePicked(data.component_type);
      onOpenChange(false);
    },
    onError: (e: Error) => notify.error(`Install failed: ${e.message}`),
    onSettled: () => setInstallingId(null),
  });

  const dataComponents = useMemo(() => {
    const all = manifest?.components ?? [];
    return all.filter((c) => DATA_CATEGORIES.has((c.category || '').toLowerCase()));
  }, [manifest]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return dataComponents;
    return dataComponents.filter((c) =>
      c.id.toLowerCase().includes(q) ||
      c.name.toLowerCase().includes(q) ||
      (c.description || '').toLowerCase().includes(q) ||
      (c.tags || []).some((t) => t.toLowerCase().includes(q))
    );
  }, [dataComponents, q]);

  const grouped = useMemo(() => {
    const buckets = new Map<string, { bin: Bin; items: ManifestComponent[] }>();
    for (const c of filtered) {
      const bin = classify(c);
      if (!buckets.has(bin.id)) buckets.set(bin.id, { bin, items: [] });
      buckets.get(bin.id)!.items.push(c);
    }
    // Keep BINS order, then Other last.
    const order = [...BINS.map((b) => b.id), OTHER_BIN.id];
    return order
      .map((id) => buckets.get(id))
      .filter((v): v is { bin: Bin; items: ManifestComponent[] } => !!v);
  }, [filtered]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-xl z-50 w-[880px] max-w-[95vw] h-[80vh] max-h-[720px] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
            <div>
              <Dialog.Title className="text-lg font-semibold text-gray-900">
                Add data
              </Dialog.Title>
              <p className="text-sm text-gray-500 mt-0.5">
                Connect to a data source — a database, warehouse, SaaS app, file, or API — and drop it onto the graph.
              </p>
            </div>
            <Dialog.Close asChild>
              <button className="p-2 hover:bg-gray-100 rounded-lg" aria-label="Close">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </Dialog.Close>
          </div>

          {/* Search */}
          <div className="px-6 py-3 border-b border-gray-100">
            <div className="relative">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
                placeholder="Search data sources — postgres, salesforce, s3, servicenow…"
                className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {isLoading && (
              <div className="flex items-center justify-center h-full text-gray-500 text-sm gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading data sources…
              </div>
            )}
            {!isLoading && filtered.length === 0 && (
              <div className="text-center text-sm text-gray-500 mt-8">
                No data sources match “{query}”. Try a different term or browse the Component Palette.
              </div>
            )}
            <div className="space-y-6">
              {grouped.map(({ bin, items }) => {
                const Icon = bin.icon;
                return (
                  <section key={bin.id}>
                    <div className="flex items-center gap-2 mb-2">
                      <Icon className="w-4 h-4 text-gray-500" />
                      <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">
                        {bin.label}
                      </h3>
                      <span className="text-xs text-gray-400">{items.length}</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {items.slice(0, 24).map((comp) => (
                        <button
                          key={comp.id}
                          disabled={install.isPending && installingId === comp.id}
                          onClick={() => install.mutate(comp.id)}
                          className="text-left p-3 border border-gray-200 rounded-lg hover:border-blue-300 hover:shadow-sm bg-white flex items-start gap-3 disabled:opacity-60 disabled:cursor-progress group"
                        >
                          <div className="w-8 h-8 rounded bg-blue-50 border border-blue-100 flex items-center justify-center flex-shrink-0">
                            <Icon className="w-4 h-4 text-blue-600" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1">
                              <span className="text-sm font-medium text-gray-900 truncate">
                                {comp.name}
                              </span>
                              {installingId === comp.id && (
                                <Loader2 className="w-3 h-3 text-gray-400 animate-spin flex-shrink-0" />
                              )}
                            </div>
                            {comp.description && (
                              <p className="text-xs text-gray-500 line-clamp-2 mt-0.5">
                                {comp.description}
                              </p>
                            )}
                          </div>
                          <ArrowRight className="w-4 h-4 text-gray-300 group-hover:text-blue-500 flex-shrink-0 mt-1" />
                        </button>
                      ))}
                    </div>
                    {items.length > 24 && (
                      <p className="text-xs text-gray-400 mt-1">
                        Showing top 24 of {items.length} — narrow with search.
                      </p>
                    )}
                  </section>
                );
              })}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
