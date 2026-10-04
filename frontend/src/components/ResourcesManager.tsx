import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Database, HardDrive, Key, Download, FileCode, RefreshCw } from 'lucide-react';
import { CommunityAvailableSection } from './CommunityAvailableSection';
import { useProjectStore } from '../hooks/useProject';
import { EnvVarsManager } from './EnvVarsManager';
import { API_BASE } from '@/services/api';
import { useGroupByCodeLocation } from '@/hooks/useGroupByCodeLocation';
import { GroupByLocationToggle } from './GroupByLocationToggle';

interface ResourceListItem {
  name: string;
  file: string;
  line_number: number;
  code_location?: string | null;
  /** Present for a community-component instance (defs.yaml), as opposed
   * to a hand-written function in resources.py. */
  source?: 'community';
}

interface NeedsConfigurationItem {
  component_id: string;
  component_type: string;
  name: string;
  category: 'resource' | 'io_manager';
}

interface ResourcesListResponse {
  project_id: string;
  resources_file: string | null;
  io_managers: ResourceListItem[];
  resources: ResourceListItem[];
  /** Installed component templates with no configured instance yet --
   * e.g. an earlier install attempt where the configure step was
   * cancelled or failed. install-via-cli already marks these as
   * "installed" so the community catalog hides them, but they have no
   * defs.yaml either, so without this they're invisible on both sides. */
  needs_configuration?: NeedsConfigurationItem[];
}

type ResourceType = 'io_manager' | 'resource' | 'env_vars';

interface ResourcesManagerProps {
  onOpenFile?: (filePath: string) => void;
  /** Called right after a community resource/IO-manager template installs
   * (component class only, no instance yet -- see install-via-cli's
   * template_only path). The parent opens the same ComponentConfigModal
   * flow ComponentPalette uses for asset components, so there's an actual
   * way to configure+create an instance instead of a dead end. */
  onComponentInstalled?: (componentType: string) => void;
}

/**
 * Resources + IO managers: an Installed list (hand-written resources.py
 * functions, plus community-component instances) and a community catalog
 * to install new ones from. There used to also be a hand-rolled
 * generate-code-then-save form + Monaco editor here, but the community
 * catalog now covers every vendor it did (and many more) with a richer,
 * schema-validated config modal -- and anyone wanting fully custom code
 * already has the Code tab for that, so keeping a second, narrower way to
 * write Python here was redundant rather than a real alternative.
 */
export function ResourcesManager({ onOpenFile, onComponentInstalled }: ResourcesManagerProps = {}) {
  const { currentProject } = useProjectStore();
  const isCloudProject = !!(currentProject as any)?.is_dagster_plus;
  const [activeTab, setActiveTab] = useState<ResourceType>('io_manager');
  const [resourceLocationFilter, setResourceLocationFilter] = useState<string>('all');
  const [groupByLocationPref, setGroupByLocationPref] = useGroupByCodeLocation();

  // Fetch installed resources + IO managers so the user can see what's already
  // in the project and jump to their source in the Code tab.
  const { data: installed, refetch: refetchInstalled } = useQuery({
    queryKey: ['installed-resources', currentProject?.id],
    queryFn: async (): Promise<ResourcesListResponse | null> => {
      if (!currentProject) return null;
      const res = await fetch(`${API_BASE}/templates/resources/${currentProject.id}`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!currentProject,
  });

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Top-level tabs — no big page title; the app header breadcrumb covers that */}
      <div className="flex items-center border-b border-gray-200 bg-white">
        {([
          { value: 'io_manager', label: 'IO Managers', Icon: HardDrive },
          { value: 'resource', label: 'Resources', Icon: Database },
          { value: 'env_vars', label: 'Environment Variables', Icon: Key },
        ] as const).map(({ value, label, Icon }) => (
          <button
            key={value}
            onClick={() => setActiveTab(value)}
            className={`flex items-center gap-2 px-4 py-3 text-sm border-b-2 transition-colors ${
              activeTab === value
                ? 'border-primary text-primary'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            <Icon className="w-4 h-4" />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {/* Existing items — mirrors Automation's list style */}
      {activeTab !== 'env_vars' && installed && (() => {
        const items = activeTab === 'io_manager' ? installed.io_managers : installed.resources;
        const locationOptions = isCloudProject
          ? Array.from(new Set(items.map((i) => i.code_location).filter((l): l is string => !!l))).sort()
          : [];
        const filteredItems = resourceLocationFilter === 'all'
          ? items
          : items.filter((i) => i.code_location === resourceLocationFilter);
        const groupByLocation = isCloudProject && groupByLocationPref && resourceLocationFilter === 'all' && locationOptions.length > 1;
        const pendingCount = (installed.needs_configuration || []).filter((c) => c.category === activeTab).length;
        const chip = (item: ResourceListItem) => (
          <button
            key={item.name}
            onClick={() => {
              // item.file is already the right relative path for either
              // source -- using installed.resources_file unconditionally
              // here used to work by coincidence (every item used to come
              // from that one file); a community-installed item lives in
              // its own defs.yaml instead and would silently open the
              // wrong file at the wrong line.
              if (!onOpenFile || !item.file) return;
              onOpenFile(`${item.file}:${item.line_number}`);
            }}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs bg-white border border-gray-200 rounded-md hover:border-primary/40 hover:bg-primary/5"
            title={`Open ${item.file}:${item.line_number}`}
          >
            {item.source === 'community' ? (
              <Download className="w-3 h-3 text-indigo-400" />
            ) : (
              <FileCode className="w-3 h-3 text-gray-400" />
            )}
            <span className="font-mono">{item.name}</span>
          </button>
        );
        return (
          <div className="flex-shrink-0 bg-white border-b border-gray-200 px-4 py-2 flex flex-col gap-2 max-h-48 overflow-y-auto">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Installed
              </span>
              {locationOptions.length > 1 && (
                <select
                  value={resourceLocationFilter}
                  onChange={(e) => setResourceLocationFilter(e.target.value)}
                  className="text-xs border border-gray-300 rounded px-2 py-0.5"
                  title="Filter by code location"
                >
                  <option value="all">All code locations</option>
                  {locationOptions.map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
              )}
              {locationOptions.length > 1 && (
                <GroupByLocationToggle value={groupByLocationPref} onChange={setGroupByLocationPref} />
              )}
              <button
                onClick={() => refetchInstalled()}
                className="ml-auto p-1 text-gray-400 hover:text-gray-600 rounded"
                title="Refresh list"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
            {filteredItems.length === 0 ? (
              <span className="text-xs text-gray-400">
                {isCloudProject
                  ? 'None found in this deployment.'
                  : pendingCount > 0
                  // Contradicted itself otherwise: "None yet" right above
                  // a very non-empty "installed, not configured" section
                  // for the same tab reads as a bug, not as two different
                  // states (no FINISHED instance vs. installs awaiting
                  // configuration).
                  ? `No configured instances yet — ${pendingCount} install${pendingCount === 1 ? '' : 's'} below ${pendingCount === 1 ? 'is' : 'are'} waiting to be configured.`
                  : 'None yet — install one from the community catalog below.'}
              </span>
            ) : groupByLocation ? (
              locationOptions.map((loc) => {
                const locItems = filteredItems.filter((i) => i.code_location === loc);
                if (locItems.length === 0) return null;
                return (
                  <div key={loc} className="flex items-start gap-2 flex-wrap">
                    <span className="text-[10px] text-gray-400 pt-1.5 flex-shrink-0 w-32 truncate" title={loc}>{loc}</span>
                    <div className="flex items-start gap-2 flex-wrap flex-1">
                      {locItems.map(chip)}
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="flex items-start gap-2 flex-wrap">
                {filteredItems.map(chip)}
              </div>
            )}
          </div>
        );
      })()}

      {/* Installed-but-never-configured templates -- see
          needs_configuration's docstring in templates.py. Without this,
          an install whose configure step got cancelled or failed is
          invisible everywhere: hidden from the catalog (already
          "installed") and absent from the list above (no instance). */}
      {!isCloudProject && installed?.needs_configuration && installed.needs_configuration.some((c) => c.category === activeTab) && (
        <div className="flex-shrink-0 bg-amber-50 border-b border-amber-200 px-4 py-2 flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-amber-800 uppercase tracking-wider">
            Installed, not configured yet
          </span>
          <div className="flex items-start gap-2 flex-wrap">
            {installed.needs_configuration.filter((c) => c.category === activeTab).map((c) => (
              <button
                key={c.component_id}
                onClick={() => onComponentInstalled?.(c.component_type)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs bg-white border border-amber-300 rounded-md hover:border-amber-500 hover:bg-amber-100"
                title={`${c.name} was installed but never configured -- click to finish setting it up`}
              >
                <Download className="w-3 h-3 text-amber-500" />
                <span>{c.name}</span>
                <span className="text-amber-600 underline decoration-dotted">Configure</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Community catalog for the currently-selected tab.

          Cloud-gated: creating a NEW resource/IO manager means writing
          Python source into a repo Dagster+ has no equivalent for (see
          _list_cloud_resources's own docstring) -- offering an "Install"
          button here for a cloud project used to lead to a dead end. */}
      {activeTab === 'io_manager' && !isCloudProject && (
        <div className="flex-1 overflow-y-auto min-h-0 bg-white">
          <CommunityAvailableSection
            categories={['io_manager', 'io_managers']}
            title="Community IO managers"
            onInstalled={(componentType) => {
              refetchInstalled();
              onComponentInstalled?.(componentType);
            }}
          />
        </div>
      )}
      {activeTab === 'resource' && !isCloudProject && (
        <div className="flex-1 overflow-y-auto min-h-0 bg-white">
          <CommunityAvailableSection
            categories={['resource', 'resources']}
            title="Community resources"
            onInstalled={(componentType) => {
              refetchInstalled();
              onComponentInstalled?.(componentType);
            }}
          />
        </div>
      )}

      {/* Main Content */}
      {activeTab === 'env_vars' ? (
        currentProject && <EnvVarsManager projectId={currentProject.id} />
      ) : isCloudProject ? (
        // Creating a resource/IO manager means writing Python source --
        // fundamentally local-only, Dagster+ has no equivalent. The
        // "Installed" list above this already shows real ones (see
        // list_resources_and_io_managers' cloud branch).
        <div className="text-sm text-gray-500 text-center px-6 py-4">
          Resources and IO managers are defined in this deployment's code — add new ones from the source repo.
        </div>
      ) : (
        // Just a static hint, not interactive content -- flex-1 here used
        // to stretch this to fill all remaining page height and center
        // the text in the middle of that empty space, which read as "a
        // lot of dead space" rather than a compact note.
        <div className="text-xs text-gray-400 text-center px-6 py-3">
          Install a resource or IO manager from the community catalog above and configure it there. Need something fully custom? Write it directly in the Code tab.
        </div>
      )}
    </div>
  );
}
