import { useState, useEffect } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { GraphEditor } from './components/GraphEditor';
import { Library } from './components/Library';
import { ComponentPalette } from './components/ComponentPalette';
import { ProjectComponentsList } from './components/ProjectComponentsList';
import { ComponentConfigModal } from './components/ComponentConfigModal';
import { PropertyPanel } from './components/PropertyPanel';
import { ProjectManager } from './components/ProjectManager';
import { CodeEditor } from './components/CodeEditor';
import { TemplateBuilder } from './components/TemplateBuilder';
import { PrimitivesManager } from './components/PrimitivesManager';
import { ResourcesManager } from './components/ResourcesManager';
import { PipelineBuilder } from './components/PipelineBuilder';
import { DagsterStartupModal } from './components/DagsterStartupModal';
import { AssetDetailPage, type Tab as AssetDetailTab } from './components/AssetDetailPage';
import { AlertsPanel } from './components/AlertsPanel';
import { RunsPanel } from './components/RunsPanel';
import { DataPreviewModal } from './components/DataPreviewModal';
import { DagsterCloudChip } from './components/DagsterCloudChip';
import { SandboxStatusPill } from './components/SandboxStatusPill';
import { GitCommitDialog } from './components/GitCommitDialog';
import { PublishServerlessDialog } from './components/PublishServerlessDialog';
import { AddMonitorDialog } from './components/AddMonitorDialog';
import { AddComponentModal, type ConfigureAuthoringPayload } from './components/AddComponentModal';
import { DraftsPanel } from './components/DraftsPanel';
import { useDrafts } from './hooks/useDrafts';
import { NotificationHost, notify, confirmDialog } from './components/Notifications';
import { SettingsHost } from './components/SettingsDialog';
import { useProjectStore } from './hooks/useProject';
import { useRunNotifications } from './hooks/useRunNotifications';
import { setActiveTabGlobal } from './services/activeTab';
import { onMenuAction, onQuitRequested, confirmQuit, openExternalUrl, openInVSCode, getProjectsDir, getPlatform, isTauri } from './services/tauri';
import { WindowsCaptionButtons } from './components/WindowsCaptionButtons';
import { hasUnsavedChanges } from './hooks/useUnsavedChanges';
import { Network, FileCode, Zap, Package, ExternalLink, Settings, Workflow, ChevronDown, Skull, AlertTriangle, X, Loader2, CheckCircle, XCircle, PanelLeftClose, PanelLeft, Clock, Play, Radar, Timer, Download, Database, ShieldCheck, Cloud, Bell, BarChart3 } from 'lucide-react';
import { IngestionsPanel } from './components/IngestionsPanel';
import { InsightsPanel } from './components/InsightsPanel';
import { DbtPanel } from './components/DbtPanel';
import { MonitorsPanel } from './components/MonitorsPanel';
import { AiAssistantPanel } from './components/AiAssistantPanel';
import { projectsApi as _projectsApi } from './services/api';
import { dagsterUIApi, projectsApi, filesApi, primitivesApi, dagsterPlusOrgBaseUrl } from './services/api';
import type { ComponentInstance } from './types';
import { API_BASE } from '@/services/api';

function BrandMark() {
  const [failed, setFailed] = useState(false);
  if (!failed) {
    return (
      <img
        src="/dagster-logo.svg"
        alt="Dagster"
        className="w-7 h-7 flex-shrink-0"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <svg
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className="w-7 h-7 rounded bg-primary p-1 flex-shrink-0"
      aria-label="Dagster"
    >
      <rect x="3" y="4" width="12" height="3" rx="1" fill="white" />
      <rect x="6" y="10.5" width="12" height="3" rx="1" fill="white" opacity="0.85" />
      <rect x="3" y="17" width="12" height="3" rx="1" fill="white" opacity="0.7" />
    </svg>
  );
}

interface StatusStripProps {
  dependencyInstallStatus: string;
  dependencyInstallError: string | null;
  dependencyInstallOutput: string | null;
  onViewDependencyDetails: () => void;
  onDismissDependency: () => void;
  assetGenerationStatus: string;
  assetGenerationError: string | null;
  onDismissAssetGen: () => void;
  validationStatus: string;
  validationError: string | null;
  onDismissValidation: () => void;
  validationFallback: boolean;
  onViewValidationDetails: () => void;
  onDismissValidationFallback: () => void;
  isValidating: boolean;
}

function StatusStrip(props: StatusStripProps) {
  const items: Array<{
    key: string;
    kind: 'progress' | 'success' | 'error' | 'warning';
    label: string;
    detail?: string | null;
    actionLabel?: string;
    onAction?: () => void;
    onDismiss?: () => void;
    dismissable: boolean;
  }> = [];

  if (props.dependencyInstallStatus === 'installing') {
    items.push({
      key: 'dep-install',
      kind: 'progress',
      label: 'Installing dependencies',
      detail: 'Usually seconds; up to a couple minutes if the uv cache is cold',
      actionLabel: props.dependencyInstallOutput ? 'Details' : undefined,
      onAction: props.dependencyInstallOutput ? props.onViewDependencyDetails : undefined,
      dismissable: false,
    });
  } else if (props.dependencyInstallStatus === 'success') {
    items.push({
      key: 'dep-install',
      kind: 'success',
      label: 'Dependencies installed',
      actionLabel: props.dependencyInstallOutput ? 'Details' : undefined,
      onAction: props.dependencyInstallOutput ? props.onViewDependencyDetails : undefined,
      onDismiss: props.onDismissDependency,
      dismissable: true,
    });
  } else if (props.dependencyInstallStatus === 'error') {
    items.push({
      key: 'dep-install',
      kind: 'error',
      label: 'Dependency install failed',
      detail: props.dependencyInstallError,
      actionLabel: props.dependencyInstallOutput ? 'Details' : undefined,
      onAction: props.dependencyInstallOutput ? props.onViewDependencyDetails : undefined,
      onDismiss: props.onDismissDependency,
      dismissable: true,
    });
  }

  if (props.assetGenerationStatus === 'generating') {
    items.push({
      key: 'asset-gen',
      kind: 'progress',
      label: 'Generating assets',
      detail: '30–180s for large projects',
      dismissable: false,
    });
  } else if (props.assetGenerationStatus === 'success') {
    items.push({
      key: 'asset-gen',
      kind: 'success',
      label: 'Assets generated',
      onDismiss: props.onDismissAssetGen,
      dismissable: true,
    });
  } else if (props.assetGenerationStatus === 'error') {
    items.push({
      key: 'asset-gen',
      kind: 'error',
      label: 'Asset generation failed',
      detail: props.assetGenerationError,
      onDismiss: props.onDismissAssetGen,
      dismissable: true,
    });
  }

  if (props.validationStatus === 'validating') {
    items.push({ key: 'validate', kind: 'progress', label: 'Validating project', dismissable: false });
  } else if (props.validationStatus === 'error') {
    items.push({
      key: 'validate',
      kind: 'error',
      label: 'Validation failed',
      detail: props.validationError,
      onDismiss: props.onDismissValidation,
      dismissable: true,
    });
  }

  if (props.validationFallback) {
    items.push({
      key: 'validation-fallback',
      kind: 'warning',
      label: 'Project validation failed',
      actionLabel: props.isValidating ? 'Loading…' : 'View details',
      onAction: props.isValidating ? undefined : props.onViewValidationDetails,
      onDismiss: props.onDismissValidationFallback,
      dismissable: true,
    });
  }

  if (items.length === 0) return null;

  const kindStyles: Record<'progress' | 'success' | 'error' | 'warning', { icon: typeof Loader2; iconClass: string; badgeClass: string }> = {
    progress: { icon: Loader2, iconClass: 'text-primary animate-spin', badgeClass: 'bg-primary/5 border-primary/20 text-gray-800' },
    success: { icon: CheckCircle, iconClass: 'text-emerald-600', badgeClass: 'bg-emerald-50 border-emerald-200 text-emerald-900' },
    error: { icon: XCircle, iconClass: 'text-red-600', badgeClass: 'bg-red-50 border-red-200 text-red-900' },
    warning: { icon: AlertTriangle, iconClass: 'text-amber-600', badgeClass: 'bg-amber-50 border-amber-200 text-amber-900' },
  };

  return (
    <div className="flex-shrink-0 border-t border-gray-200 bg-white px-4 py-1.5 flex items-center gap-2 overflow-x-auto">
      {items.map((item) => {
        const s = kindStyles[item.kind];
        const Icon = s.icon;
        return (
          <div
            key={item.key}
            className={`flex items-center gap-2 px-2.5 py-1 rounded-md border text-xs ${s.badgeClass}`}
          >
            <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${s.iconClass}`} />
            <span className="font-medium whitespace-nowrap">{item.label}</span>
            {item.detail && (
              <span className="text-gray-500 truncate max-w-xs">{item.detail}</span>
            )}
            {item.actionLabel && item.onAction && (
              <button
                onClick={item.onAction}
                className="underline hover:no-underline font-medium"
              >
                {item.actionLabel}
              </button>
            )}
            {item.dismissable && item.onDismiss && (
              <button
                onClick={item.onDismiss}
                className="text-gray-400 hover:text-gray-600"
                aria-label="Dismiss"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function App() {
  useRunNotifications();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [editingComponent, setEditingComponent] = useState<ComponentInstance | null>(null);
  const [addingComponentType, setAddingComponentType] = useState<string | null>(null);
  const [componentsPanelHeight, setComponentsPanelHeight] = useState(60); // Percentage
  // GraphEditor's graph/catalog toggle is lifted here so App can hide
  // the Project Components sidebar in catalog mode (it only applies to
  // the DAG view -- catalog is a searchable table with no drop zone).
  const [assetsViewMode, setAssetsViewMode] = useState<'graph' | 'catalog'>('graph');
  // Ribbon host node -- GraphEditor portals its ribbon here so it spans
  // full width above the sidebar + graph + property panel (i.e. stops
  // shifting position when the property panel opens on the right).
  const [assetsRibbonHost, setAssetsRibbonHost] = useState<HTMLDivElement | null>(null);
  // Node id currently opened in the full-screen AssetDetailPage.
  // Triggered from catalog rows and the "View full details" button in
  // the PropertyPanel; null means the overlay is closed.
  const [detailNodeId, setDetailNodeId] = useState<string | null>(null);
  // Which tab AssetDetailPage should open on -- set alongside detailNodeId
  // when a caller wants to land somewhere other than Overview (e.g.
  // drilling into an asset's Insights tab from the deployment-level
  // Insights page). Cleared whenever the overlay closes.
  const [detailInitialTab, setDetailInitialTab] = useState<AssetDetailTab | undefined>(undefined);
  const [isDragging, setIsDragging] = useState(false);
  const [activeMainTab, setActiveMainTabState] = useState('assets');
  // Also broadcasts to the module-level activeTab store so page components
  // can tell whether they're the one currently visible (for usePageActions)
  // without this being threaded through as a prop everywhere.
  const setActiveMainTab = (tab: string) => {
    setActiveMainTabState(tab);
    setActiveTabGlobal(tab);
  };
  // Deep-link into the Runs tab from elsewhere (e.g. a materialization
  // event in AssetDetailPage's Events tab) -- seeds RunsPanel's initial
  // selection so it opens straight to that run instead of the list.
  const [runToOpen, setRunToOpen] = useState<string | null>(null);
  const handleOpenRun = (runId: string) => {
    setRunToOpen(runId);
    setActiveMainTab('runs');
  };
  // Radix's Tabs.onValueChange only fires when the clicked trigger's value
  // differs from the current one -- re-clicking the already-active nav item
  // is a no-op by default, so a user drilled into a detail view (a specific
  // run, a specific monitor) who clicks that same nav item again to "go
  // back to the list" saw nothing happen. Each nav trigger's onClick bumps
  // this counter unconditionally; panels with no lifted-up "selected item"
  // state key off it to force a remount back to their default/list view.
  const [tabResetNonce, setTabResetNonce] = useState<Record<string, number>>({});
  const handleNavClick = (value: string) => {
    if (value !== activeMainTab) return;
    if (value === 'assets') {
      setDetailNodeId(null);
      setDetailInitialTab(undefined);
      return;
    }
    if (value === 'runs') setRunToOpen(null);
    setTabResetNonce((prev) => ({ ...prev, [value]: (prev[value] || 0) + 1 }));
  };
  const [templateBuilderTab, setTemplateBuilderTab] = useState<string | null>(null);
  // Windows gets its own drawn caption buttons (see WindowsCaptionButtons)
  // since it has no macOS-style overlay title bar mode -- null until this
  // resolves means they simply don't render for a tick on launch rather
  // than flashing the wrong platform's chrome.
  const [platform, setPlatform] = useState<string | null>(null);
  useEffect(() => { getPlatform().then(setPlatform); }, []);
  const [templateBuilderAssetKey, setTemplateBuilderAssetKey] = useState<string | null>(null);
  // "New asset check" routes to the Monitors wizard instead of
  // TemplateBuilder's own asset-check generator -- that generator writes
  // a much weaker check (see AssetCheckComponent) and the two flows can
  // silently create duplicate/conflicting checks on the same asset with
  // no cross-linking between them.
  const [addMonitorOpen, setAddMonitorOpen] = useState(false);
  const [addMonitorInitialAsset, setAddMonitorInitialAsset] = useState<string | undefined>(undefined);
  const openNewPrimitive = (category: string, assetKey?: string) => {
    if (category === 'asset_check') {
      setAddMonitorInitialAsset(assetKey);
      setAddMonitorOpen(true);
      return;
    }
    if (assetKey) setTemplateBuilderAssetKey(assetKey);
    setTemplateBuilderTab(category);
  };
  const [primitiveToOpen, setPrimitiveToOpen] = useState<{ category: string; name: string } | null>(null);
  const [addComponentOpen, setAddComponentOpen] = useState(false);
  const [addComponentProducesFilter, setAddComponentProducesFilter] = useState<any[] | undefined>(undefined);
  const [draftsPanelOpen, setDraftsPanelOpen] = useState(false);
  // Header-level "Deploy"/"Push to GitHub" — reported as hidden when
  // buried in ProjectManager's "..." Actions menu (local projects) and
  // inside the Sandbox pill's popover (Dagster+ serverless publish).
  // Surfaced as its own always-visible header control instead.
  const [headerGitCommitOpen, setHeaderGitCommitOpen] = useState(false);
  const [publishingServerless, setPublishingServerless] = useState(false);
  // Local-project "Publish to Dagster+" — was reported as simply not
  // existing anywhere for a project that isn't already Dagster+-connected.
  const [localPublishOpen, setLocalPublishOpen] = useState(false);
  // Set when the user clicks "Continue" in the picker — triggers
  // ComponentConfigModal to open in draft mode with the picked schema
  // and target. Reused across sandbox + cloud-loc paths.
  const [draftAuthoring, setDraftAuthoring] = useState<ConfigureAuthoringPayload | null>(null);
  const [navCollapsed, setNavCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('nav.collapsed') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('nav.collapsed', navCollapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [navCollapsed]);
  // The Project Components / Add Component sidebar on the Assets graph --
  // a fixed 256px that eats a lot of a non-maximized window. Collapses to
  // a thin strip, same pattern as the outer nav rail above.
  const [componentsSidebarCollapsed, setComponentsSidebarCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('componentsSidebar.collapsed') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('componentsSidebar.collapsed', componentsSidebarCollapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [componentsSidebarCollapsed]);

  // Clear the selection whenever the currently-selected node disappears from
  // the graph (typically after a delete + project reload). Without this the
  // PropertyPanel + downstream consumers keep pointing at a ghost node id
  // and can crash when they try to look up attributes that no longer exist.
  // Uses useProjectStore subscription rather than a hook here so we don't
  // couple the whole App re-render to every graph edit.
  const [dagsterUILoading, setDagsterUILoading] = useState(false);
  const [showDagsterStartupModal, setShowDagsterStartupModal] = useState(false);
  const [fileToOpen, setFileToOpen] = useState<string | null>(null);
  const [showValidationDialog, setShowValidationDialog] = useState(false);
  const [validationResult, setValidationResult] = useState<any>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [dismissedValidationError, setDismissedValidationError] = useState(false);
  const [enableValidationCheck, setEnableValidationCheck] = useState(false);
  const [showDependencyOutputDialog, setShowDependencyOutputDialog] = useState(false);
  const [showDataPreview, setShowDataPreview] = useState(false);
  const [dataPreviewAssetKey, setDataPreviewAssetKey] = useState<string>('');
  const [dataPreviewAssetName, setDataPreviewAssetName] = useState<string>('');
  const [dataPreviewComponentAttributes, setDataPreviewComponentAttributes] = useState<Record<string, any> | undefined>(undefined);
  const [dataPreviewComponentId, setDataPreviewComponentId] = useState<string | undefined>(undefined);
  const {
    currentProject,
    assetGenerationStatus,
    assetGenerationError,
    dismissAssetGenerationStatus,
    validationStatus,
    validationError,
    dismissValidationStatus,
    dependencyInstallStatus,
    dependencyInstallError,
    dependencyInstallOutput,
    dismissDependencyInstallStatus,
    isLoading: isProjectLoading,
  } = useProjectStore();
  // Loading target — tracks which project id is currently in flight
  // so the cloud-specific "connecting to <org>…" copy can appear.
  // Reads the last isLoading toggle target; may be null on cold load.
  const loadingCloudLabel = isProjectLoading && currentProject && (currentProject as any).is_dagster_plus
    ? `Fetching lineage + checks from ${(currentProject as any).dagster_plus_org}${(currentProject as any).dagster_plus_deployment ? '/' + (currentProject as any).dagster_plus_deployment : ''}…`
    : isProjectLoading
      ? 'Loading project…'
      : null;
  const queryClient = useQueryClient();

  // Clear the selection whenever the currently-selected node vanishes from
  // the graph (typical after Delete Component Instance + project reload).
  useEffect(() => {
    if (!selectedNodeId || !currentProject) return;
    const exists = currentProject.graph.nodes.some((n) => n.id === selectedNodeId);
    if (!exists) setSelectedNodeId(null);
  }, [currentProject, selectedNodeId]);

  // Native "View" menu (Cmd+1-9, see src-tauri/src/main.rs) mirrors the
  // left-nav rail. "Code" isn't in navItems for Dagster+ projects (no local
  // codebase to edit), so ignore it rather than switching to a dead tab.
  // No-op outside Tauri.
  useEffect(() => {
    const isCloudProject = !!currentProject && !!(currentProject as any).is_dagster_plus;
    const unlistenPromise = onMenuAction((id) => {
      if (!id.startsWith('view:')) return;
      const tab = id.slice('view:'.length);
      if (tab === 'code' && isCloudProject) return;
      setActiveMainTab(tab);
    });
    return () => { unlistenPromise.then((unlisten) => unlisten()); };
  }, [currentProject]);

  // Quitting (red button, Cmd+Q, Dock > Quit) is intercepted on the Rust
  // side so it can ask first when there's unsaved work in the Code Editor,
  // Env Vars panel, or a graph edit still in its autosave debounce window --
  // otherwise it quits immediately, matching the old (nag-free) behavior.
  useEffect(() => {
    const unlistenPromise = onQuitRequested(async () => {
      if (!hasUnsavedChanges()) {
        confirmQuit();
        return;
      }
      const ok = await confirmDialog(
        'You have unsaved changes. Quit anyway?',
        { title: 'Quit Dagster Designer', destructive: true }
      );
      if (ok) confirmQuit();
    });
    return () => { unlistenPromise.then((unlisten) => unlisten()); };
  }, []);

  // Delay validation check by 2 seconds after project loads to avoid blocking UI
  useEffect(() => {
    if (currentProject) {
      const timer = setTimeout(() => {
        setEnableValidationCheck(true);
      }, 2000); // 2 second delay
      return () => clearTimeout(timer);
    } else {
      setEnableValidationCheck(false);
    }
  }, [currentProject?.id]);

  // Fetch validation status globally (checks if project validates)
  // This is intentionally delayed to not block initial page load
  // Only runs after dependencies are installed to avoid premature validation errors
  const { data: backgroundValidationStatus } = useQuery({
    queryKey: ['validation-status', currentProject?.id],
    queryFn: async () => {
      if (!currentProject) return Promise.reject('No project');
      const result = await primitivesApi.getAllDefinitions(currentProject.id);
      console.log('[Validation] Project:', currentProject.name, 'using_fallback:', result.using_fallback, 'jobs:', result.jobs?.length, 'schedules:', result.schedules?.length);
      return result;
    },
    // Skip validation entirely for Dagster+ projects — they don't
    // have a local codebase to install deps for or `dg list defs` to
    // run, so the fallback path always triggers and shows a false-
    // positive validation banner.
    enabled: !!currentProject && !(currentProject as any).is_dagster_plus && enableValidationCheck && !dismissedValidationError && dependencyInstallStatus !== 'installing',
    staleTime: 60000, // Consider fresh for 1 minute (matches backend cache)
    refetchInterval: 60000, // Recheck every minute to catch validation changes
    refetchOnWindowFocus: false, // Don't refetch on window focus
    retry: false, // Don't retry on failure
  });

  // Debug: Log when addingComponentType changes
  useEffect(() => {
    console.log('[App] addingComponentType changed:', addingComponentType, 'currentProject:', currentProject?.id);
  }, [addingComponentType, currentProject]);

  // Debug: Log when validation banner should be shown
  useEffect(() => {
    if (currentProject && backgroundValidationStatus) {
      const shouldShowBanner = backgroundValidationStatus.using_fallback && !dismissedValidationError;
      console.log('[Validation Banner]', {
        shouldShow: shouldShowBanner,
        using_fallback: backgroundValidationStatus.using_fallback,
        dismissed: dismissedValidationError,
        project: currentProject.name
      });
    }
  }, [currentProject, backgroundValidationStatus, dismissedValidationError]);

  // Reset dismissed validation error when project changes
  useEffect(() => {
    setDismissedValidationError(false);
  }, [currentProject?.id]);

  const [isDeletingBroken, setIsDeletingBroken] = useState(false);

  // Delete a list of component IDs from the project. Used from the validation
  // dialog as an escape hatch when defs won't load (the graph is empty in that
  // state, so users can't click nodes to delete them). After delete, re-run
  // validation so the user sees whether the project now loads.
  const handleDeleteBrokenComponents = async (componentIds: string[]) => {
    if (!currentProject || !componentIds.length) return;
    const label = componentIds.length === 1
      ? `Delete component "${componentIds[0]}"?`
      : `Delete ${componentIds.length} broken components?`;
    const confirmed = await confirmDialog(
      `${label}\n\nThis removes the component instance and its defs.yaml. You can add it back later.`,
      { title: 'Delete broken components', destructive: true }
    );
    if (!confirmed) return;

    setIsDeletingBroken(true);
    let deleted = 0;
    let failed: string[] = [];
    for (const cid of componentIds) {
      try {
        await projectsApi.deleteComponentInstance(currentProject.id, cid);
        deleted++;
      } catch (e) {
        console.error(`[Validation] Failed to delete ${cid}:`, e);
        failed.push(cid);
      }
    }

    try {
      await useProjectStore.getState().loadProject(currentProject.id);
    } catch (e) {
      console.warn('Reload after delete failed:', e);
    }

    if (failed.length === 0) {
      notify.success(`Deleted ${deleted} component${deleted === 1 ? '' : 's'}. Re-validating…`);
    } else {
      notify.warning(`Deleted ${deleted}; ${failed.length} failed: ${failed.join(', ')}`);
    }

    // Immediately re-validate so the dialog reflects the new state.
    try {
      const result = await projectsApi.validate(currentProject.id);
      setValidationResult(result);
      if (result.valid) {
        setShowValidationDialog(false);
        setDismissedValidationError(false);
        notify.success('Project validates cleanly now.');
      }
    } catch (e) {
      console.warn('Re-validate failed:', e);
    } finally {
      setIsDeletingBroken(false);
    }
  };

  // Handler to run validation and show detailed results
  const handleViewValidationDetails = async () => {
    if (!currentProject) return;

    setIsValidating(true);
    try {
      const result = await projectsApi.validate(currentProject.id);
      setValidationResult(result);
      setShowValidationDialog(true);
    } catch (error) {
      console.error('Failed to validate project:', error);
      notify.error('Failed to validate project. Check console for details.');
    } finally {
      setIsValidating(false);
    }
  };

  // Handler to navigate to code tab and open a file
  const handleOpenFile = (filePath: string) => {
    setActiveMainTab('code');
    setFileToOpen(filePath);
  };

  // "Open in VS Code" -- hands the local project (or one file within it)
  // off to VS Code for engineer-mode editing, complementing the visual
  // builder rather than duplicating it. `relativeFilePath` is relative to
  // the project root, same shape CodeEditor.tsx already tracks.
  const handleOpenInVSCode = async (relativeFilePath?: string) => {
    if (!currentProject?.directory_name) return;
    const projectsDir = await getProjectsDir();
    if (!projectsDir) {
      notify.error("Couldn't resolve the projects folder -- only available in the desktop app.");
      return;
    }
    const projectPath = `${projectsDir}/${currentProject.directory_name}`;
    const target = relativeFilePath ? `${projectPath}/${relativeFilePath}` : projectPath;
    try {
      await openInVSCode(target);
    } catch {
      notify.error("Couldn't open VS Code -- is it installed?");
    }
  };

  // Handler to open visual editor (data preview) for an asset
  const handleOpenVisualEditor = (upstreamAssetKey: string) => {
    // Find the upstream node in the graph to get the display name
    const upstreamNode = currentProject?.graph.nodes.find(n =>
      n.data.asset_key === upstreamAssetKey || n.id === upstreamAssetKey
    );

    // Get the component being edited to pass its attributes to the visual editor
    // This allows the user to edit existing transformations
    let componentAttributes: Record<string, any> | undefined = undefined;
    let componentId: string | undefined = undefined;
    if (editingComponent) {
      // Find the node for the component being edited
      const editingNode = currentProject?.graph.nodes.find(n => n.id === editingComponent.id);
      if (editingNode?.data?.component_attributes) {
        componentAttributes = editingNode.data.component_attributes;
        componentId = editingComponent.id;
        console.log('[App] Opening visual editor for editing component:', componentId, componentAttributes);
      }
    }

    setDataPreviewAssetKey(upstreamAssetKey);
    setDataPreviewAssetName(upstreamNode?.data?.label || upstreamAssetKey);
    setDataPreviewComponentAttributes(componentAttributes);
    setDataPreviewComponentId(componentId);
    setShowDataPreview(true);

    // Close the component config modal
    setEditingComponent(null);
    setAddingComponentType(null);
  };

  // Prefetch file tree when hovering over Code tab
  const handleCodeTabHover = () => {
    if (currentProject?.id) {
      queryClient.prefetchQuery({
        queryKey: ['files', currentProject.id],
        queryFn: () => filesApi.list(currentProject.id),
      });
    }
  };

  const handleDividerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!isDragging) return;

    const sidebar = document.querySelector('[data-sidebar]') as HTMLElement;
    if (!sidebar) return;

    const sidebarRect = sidebar.getBoundingClientRect();
    const newHeight = ((e.clientY - sidebarRect.top) / sidebarRect.height) * 100;

    // Clamp between 20% and 80%
    const clampedHeight = Math.max(20, Math.min(80, newHeight));
    setComponentsPanelHeight(clampedHeight);
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging]);

  const handleSaveComponent = async (component: ComponentInstance) => {
    if (!currentProject) return;

    // Check if this is an edit or new component
    const existingIndex = currentProject.components.findIndex((c) => c.id === component.id);

    let updatedComponents;
    if (existingIndex >= 0) {
      // Update existing
      updatedComponents = [...currentProject.components];
      updatedComponents[existingIndex] = component;
    } else {
      // Add new
      updatedComponents = [...currentProject.components, component];
    }

    // Also update the corresponding graph node if it exists
    const nodeIndex = currentProject.graph.nodes.findIndex((n) => n.id === component.id);
    let updatedNodes = currentProject.graph.nodes;

    if (nodeIndex >= 0) {
      updatedNodes = [...currentProject.graph.nodes];
      updatedNodes[nodeIndex] = {
        ...updatedNodes[nodeIndex],
        data: {
          ...updatedNodes[nodeIndex].data,
          label: component.label,
          description: component.description,
          attributes: component.attributes,
          componentType: component.component_type,
          component_type: component.component_type,
        },
      };
    }

    // Update project with new components AND graph together
    try {
      await projectsApi.update(currentProject.id, {
        components: updatedComponents,
        graph: {
          nodes: updatedNodes,
          edges: currentProject.graph.edges,
        },
      });

      // Update local state
      const { loadProject } = useProjectStore.getState();
      await loadProject(currentProject.id);
    } catch (error) {
      console.error('Failed to save component:', error);
      notify.error('Failed to save component. Check console for details.');
      return;
    }

    // Close modal
    setEditingComponent(null);
    setAddingComponentType(null);

    // Trigger asset regeneration if it's an asset factory
    if (component.is_asset_factory) {
      try {
        // Clear asset introspection cache to force fresh dg list defs
        try {
          await fetch(`${API_BASE}/projects/${currentProject.id}/regenerate-assets/cache`, {
            method: 'DELETE',
          });
        } catch (error) {
          console.warn('Failed to clear asset introspection cache:', error);
        }

        // Call regenerate-assets API
        const response = await fetch(`${API_BASE}/projects/${currentProject.id}/regenerate-assets`, {
          method: 'POST',
        });
        if (response.ok) {
          const updatedProject = await response.json();
          console.log('Assets regenerated:', updatedProject.graph.nodes.length, 'assets');
          // The project will be updated automatically from the backend response
          // Need to trigger a reload
          window.location.reload();
        }
      } catch (error) {
        console.error('Failed to regenerate assets:', error);
      }
    }
  };

  const handleDeleteComponent = async (component: ComponentInstance) => {
    if (!currentProject) return;

    const confirmed = await confirmDialog(
      `Are you sure you want to delete "${component.label}"? This will remove the component and its definition files.`,
      { title: 'Delete component', destructive: true }
    );
    if (!confirmed) return;

    try {
      // Delete the on-disk `defs/<id>/defs.yaml` first. Without this,
      // updating the project JSON alone leaves orphaned component
      // files on disk — the next regenerate creates `<name>_2` variants
      // that collide with the leftovers and blow up with
      // "Duplicate asset key" errors. Best-effort: if the file is
      // already gone (e.g. the user manually cleaned up), swallow the
      // 404 and continue with the JSON-side cleanup.
      try {
        await projectsApi.deleteComponentInstance(currentProject.id, component.id);
      } catch (e: any) {
        if (e?.response?.status !== 404) throw e;
        console.warn(`[delete] no on-disk defs for ${component.id} — continuing with JSON cleanup`);
      }

      // Scrub the component from the project JSON + graph nodes.
      //
      // Multi-asset components: the graph nodes for an `agentic_pipeline`
      // instance aren't stored under `n.id === component.id` — they're
      // the emitted-asset nodes (`issue_resolution_fetch_issue`, etc.),
      // each carrying `data.component_id === component.id`. Filtering
      // only on `n.id !== component.id` leaves the emitted assets
      // hanging in the graph. So filter on BOTH the top-level id AND
      // the component_id tag. Same for edges — drop any that reference
      // an asset id we just removed.
      const updatedComponents = currentProject.components.filter((c) => c.id !== component.id);
      const removedNodeIds = new Set(
        currentProject.graph.nodes
          .filter((n) => n.id === component.id || (n.data as any)?.component_id === component.id)
          .map((n) => n.id)
      );
      const updatedNodes = currentProject.graph.nodes.filter((n) => !removedNodeIds.has(n.id));
      const updatedEdges = currentProject.graph.edges.filter(
        (e) => !removedNodeIds.has(e.source) && !removedNodeIds.has(e.target)
      );

      await projectsApi.update(currentProject.id, {
        components: updatedComponents,
        graph: { nodes: updatedNodes, edges: updatedEdges },
      });

      // Force re-introspection so the graph reflects what Dagster
      // actually sees on disk after the delete. Skipping this leaves
      // whatever we optimistically filtered above as the source of
      // truth — usually right, but the regenerate catches edge cases
      // (partition defs that get orphaned, downstream lineage that
      // needs to be re-computed, etc.).
      try {
        await projectsApi.regenerateAssets(currentProject.id, false);
      } catch (e) {
        console.warn('[delete] regenerate-assets failed after delete — falling back to loadProject', e);
      }

      const { loadProject } = useProjectStore.getState();
      await loadProject(currentProject.id);
    } catch (error) {
      console.error('Failed to delete component:', error);
      notify.error('Failed to delete component. Check console for details.');
    }
  };

  const handleOpenDagsterUI = async () => {
    if (!currentProject) return;

    // Dagster+ (cloud) projects: no local `dagster dev` to spin up.
    // Build the deployment URL directly and open the cloud UI in a
    // new tab. Uses org's default deployment path when the project
    // isn't pinned to a specific one.
    if ((currentProject as any).is_dagster_plus) {
      const base = dagsterPlusOrgBaseUrl(currentProject as any);
      const dep = (currentProject as any).dagster_plus_deployment || '';
      const url = dep ? `${base}/${dep}/home` : `${base}/`;
      openExternalUrl(url);
      return;
    }

    setDagsterUILoading(true);
    try {
      // Check if Dagster UI is running
      const status = await dagsterUIApi.getStatus(currentProject.id);

      if (status.running) {
        // Already running - open in new tab
        openExternalUrl(status.url);
        setDagsterUILoading(false);
      } else {
        // Not running - show startup modal
        setDagsterUILoading(false);
        setShowDagsterStartupModal(true);
      }
    } catch (error) {
      console.error('Failed to check Dagster UI status:', error);
      setDagsterUILoading(false);
      // Show modal anyway to attempt startup
      setShowDagsterStartupModal(true);
    }
  };

  const handleKillAllDagsterProcesses = async () => {
    if (!currentProject) return;

    const confirmed = await confirmDialog(
      'This will kill all running Dagster processes. Are you sure?',
      { title: 'Kill Dagster processes', destructive: true }
    );
    if (!confirmed) return;

    try {
      const response = await fetch(`${API_BASE}/dagster-ui/kill-all`, {
        method: 'POST',
      });

      if (response.ok) {
        notify.success('All Dagster processes have been terminated.');
      } else {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to kill processes');
      }
    } catch (error) {
      console.error('Failed to kill Dagster processes:', error);
      notify.error('Failed to kill Dagster processes. Check console for details.');
    }
  };

  const isCloudProject = !!currentProject && !!(currentProject as any).is_dagster_plus;
  // Not gated on whether any pipelines exist yet -- for local projects
  // this tab IS the entry point for creating the first one (its empty
  // state has the "New Pipeline" button), so hiding it whenever the
  // count is zero would remove the only way to ever get to one. Always
  // shown locally, always hidden for cloud: cloud jobs already have a
  // full home with real detail views in the Automation tab, and this
  // tab's canvas-builder UI (a local-only concept -- there's no
  // Designer-authored "Pipeline" for a live Dagster+ connection) has
  // nothing useful to show for a native job beyond "you can run it".
  const hasPipelines = !isCloudProject;
  const { drafts: allDrafts, refresh: refreshDrafts, refreshKey: draftsRefreshKey } = useDrafts(currentProject?.id ?? null);
  const navItems = [
    { value: 'assets', label: 'Assets', icon: Network },
    { value: 'ingestions', label: 'Ingestions', icon: Download },
    { value: 'dbt', label: 'dbt', icon: Database },
    { value: 'monitors', label: 'Monitors', icon: ShieldCheck },
    { value: 'alerts', label: 'Alerts', icon: Bell },
    { value: 'runs', label: 'Runs', icon: Play },
    // Insights (usage/cost/reliability metrics) only exists for Dagster+
    // connections -- it's tracked by Dagster+'s own Insights product,
    // nothing local to show for a non-cloud project.
    ...(isCloudProject ? [{ value: 'insights', label: 'Insights', icon: BarChart3 }] : []),
    // hasPipelines is always false for cloud (see above) -- this tab is
    // Designer's own pipeline-builder canvas, a local-only concept, so
    // it's only ever shown when the project actually has one.
    ...(hasPipelines ? [{ value: 'pipelines', label: 'Pipelines', icon: Workflow }] : []),
    { value: 'primitives', label: 'Automation', icon: Zap },
    { value: 'library', label: 'Library', icon: Package },
    // Code tab is meaningless for Dagster+ projects (no local codebase
    // to edit -- deployment is read-only via GraphQL). Hide entirely
    // so users don't hit dead links.
    ...(isCloudProject ? [] : [{ value: 'code', label: 'Code', icon: FileCode, onHover: handleCodeTabHover }]),
    { value: 'resources', label: 'Resources', icon: Settings },
  ];

  // No bg-background on the root div in the desktop app: it sits directly
  // between the (transparent, vibrancy-backed) window and the nav rail, so
  // an opaque fill here would paint over the vibrancy before the rail's own
  // translucent color ever reaches it. The content pane below carries its
  // own bg-background instead, so it stays opaque either way.
  return (
    <div className={`h-screen flex text-foreground ${isTauri ? '' : 'bg-background'}`}>
      {/* Global project-load overlay — surfaces mostly for Dagster+
          projects since cloud hydration (assets + checks + schedules +
          sensors) takes 2-6s on typical orgs. Local projects blip
          through it. Non-blocking backdrop so users can still hit
          menus if they need to. */}
      {loadingCloudLabel && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20 backdrop-blur-sm pointer-events-none">
          <div className="bg-white border border-gray-200 rounded-xl shadow-2xl px-6 py-5 flex items-center gap-4 pointer-events-auto">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center flex-shrink-0 relative">
              <Cloud className="w-5 h-5 text-white" />
              <span className="absolute -inset-1 rounded-lg border-2 border-blue-400/40 animate-ping" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-gray-900">Loading project</div>
              <div className="text-xs text-gray-500 mt-0.5">{loadingCloudLabel}</div>
              <div className="mt-2 h-1 w-64 bg-gray-100 rounded overflow-hidden">
                <div className="h-full w-1/3 bg-gradient-to-r from-blue-500 to-cyan-500 rounded animate-pulse" style={{ animation: 'progressSlide 1.4s ease-in-out infinite' }} />
              </div>
            </div>
          </div>
          <style>{`
            @keyframes progressSlide {
              0%   { transform: translateX(-100%); }
              50%  { transform: translateX(50%); }
              100% { transform: translateX(220%); }
            }
          `}</style>
        </div>
      )}

      {/* Left vertical nav rail. In the desktop app it follows the system
          appearance -- a light, subtly-tinted vibrancy panel in light mode
          and the brand's dark navy in dark mode -- same as a native macOS
          sidebar (Finder's own sidebar does the same). A plain browser tab
          has nothing behind the page to blur, so it stays the original
          always-dark-navy look there. */}
      <nav
        className={`${navCollapsed ? (isTauri ? 'w-20' : 'w-14') : 'w-56'} transition-[width] duration-150 flex flex-col ${
          isTauri
            ? 'text-gray-700/90 dark:text-white/80 border-r border-gray-200/70 dark:border-[hsl(var(--dagster-black))] bg-white/40 dark:bg-[hsl(var(--dagster-black)/0.35)] backdrop-blur-xl'
            : 'text-white/80 border-r border-[hsl(var(--dagster-black))] bg-[hsl(var(--dagster-black))]'
        }`}
      >
        <div
          className={`flex-shrink-0 flex flex-col border-b ${isTauri ? 'border-gray-200/70 dark:border-white/10 titlebar-drag-region' : 'border-white/10'}`}
          {...(isTauri ? { 'data-tauri-drag-region': true } : {})}
        >
          {/* Desktop app: no logo/wordmark here at all -- the Dock icon and
              menu bar already say what app this is, so this is just the
              drag strip under macOS's traffic lights, sized to their
              height and nothing else. The web app has neither of those,
              so it keeps the full icon + wordmark lockup. */}
          {isTauri ? (
            <div className="h-10 w-full" data-tauri-drag-region />
          ) : (
            <div className={`h-14 flex items-center gap-2 px-3 ${navCollapsed ? 'justify-center' : ''}`}>
              {!navCollapsed && (
                <div className="flex items-center gap-2 min-w-0">
                  <BrandMark />
                  <span className="text-sm font-semibold tracking-tight truncate text-white">Dagster Designer</span>
                </div>
              )}
              {navCollapsed && <BrandMark />}
            </div>
          )}
        </div>
        {currentProject && (
          <Tabs.Root value={activeMainTab} onValueChange={setActiveMainTab} orientation="vertical" className="flex-1 flex flex-col overflow-hidden">
            <Tooltip.Provider delayDuration={200}>
              <Tabs.List className="flex-1 flex flex-col gap-0.5 px-2 py-3 overflow-y-auto" aria-label="Main navigation">
                {navItems.map(({ value, label, icon: Icon, onHover }) => {
                  const trigger = (
                    <Tabs.Trigger
                      key={value}
                      value={value}
                      onMouseEnter={onHover}
                      onClick={() => handleNavClick(value)}
                      className={`group flex items-center ${navCollapsed ? 'justify-center px-2' : 'gap-3 px-3'} py-2 rounded-md text-sm font-medium transition-colors focus:outline-none ${
                        isTauri
                          ? 'text-gray-600 hover:text-gray-900 hover:bg-black/5 data-[state=active]:bg-indigo-50 data-[state=active]:text-indigo-900 dark:text-white/70 dark:hover:text-white dark:hover:bg-white/5 dark:data-[state=active]:bg-[hsl(var(--selected))] dark:data-[state=active]:text-white'
                          : 'text-white/70 hover:text-white hover:bg-white/5 data-[state=active]:bg-[hsl(var(--selected))] data-[state=active]:text-white'
                      }`}
                    >
                      <Icon className="w-4 h-4 flex-shrink-0" />
                      {!navCollapsed && <span>{label}</span>}
                    </Tabs.Trigger>
                  );
                  if (!navCollapsed) return trigger;
                  return (
                    <Tooltip.Root key={`${value}-tt`}>
                      <Tooltip.Trigger asChild>{trigger}</Tooltip.Trigger>
                      <Tooltip.Portal>
                        <Tooltip.Content
                          side="right"
                          sideOffset={8}
                          className="px-2 py-1 rounded-md bg-gray-900 text-white text-xs font-medium shadow-lg z-50 select-none"
                        >
                          {label}
                          <Tooltip.Arrow className="fill-gray-900" width={8} height={4} />
                        </Tooltip.Content>
                      </Tooltip.Portal>
                    </Tooltip.Root>
                  );
                })}
              </Tabs.List>
            </Tooltip.Provider>
          </Tabs.Root>
        )}
        <div
          className={`mt-auto border-t flex ${navCollapsed ? 'flex-col items-center py-2 gap-1' : 'items-center justify-between px-3 py-2'} ${
            isTauri ? 'border-gray-200/70 dark:border-white/10' : 'border-white/10'
          }`}
        >
          <button
            onClick={() => setNavCollapsed((v) => !v)}
            className={`p-1.5 rounded transition-colors ${
              isTauri
                ? 'text-gray-500 hover:text-gray-900 hover:bg-black/5 dark:text-white/50 dark:hover:text-white dark:hover:bg-white/5'
                : 'text-white/50 hover:text-white hover:bg-white/5'
            }`}
            title={navCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={navCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {navCollapsed ? <PanelLeft className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          </button>
          {!navCollapsed && (
            <span className={`text-[11px] ${isTauri ? 'text-gray-400 dark:text-white/40' : 'text-white/40'}`}>v0.1</span>
          )}
        </div>
      </nav>

      {/* Right side: header + content + status strip */}
      <div className="flex-1 flex flex-col overflow-hidden bg-background">
        <header
          className={`h-14 flex-shrink-0 bg-white border-b border-gray-200 px-5 flex items-center justify-between ${isTauri ? 'titlebar-drag-region' : ''}`}
          {...(isTauri ? { 'data-tauri-drag-region': true } : {})}
        >
          <div className="flex items-center gap-3 min-w-0">
            {currentProject ? (
              <>
                <span className="text-sm font-semibold text-gray-900 truncate">{currentProject.name}</span>
                <span className="text-xs text-gray-400">/</span>
                <span className="text-sm text-gray-600">
                  {navItems.find((n) => n.value === activeMainTab)?.label ?? activeMainTab}
                </span>
                {isTauri && (
                  <button
                    onClick={() => handleOpenInVSCode()}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 whitespace-nowrap"
                    title="Open this project in VS Code"
                  >
                    VS Code
                  </button>
                )}
                {!(currentProject as any)?.is_dagster_plus && (
                  <>
                    <span className="text-xs text-gray-400 ml-2">·</span>
                    <DagsterCloudChip projectId={currentProject.id} />
                    <button
                      onClick={() => setHeaderGitCommitOpen(true)}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 whitespace-nowrap"
                      title="Commit and push this project to GitHub"
                    >
                      Push
                    </button>
                    <button
                      onClick={() => setLocalPublishOpen(true)}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100 whitespace-nowrap"
                      title="Publish this project directly to a Dagster+ Serverless deployment, skipping git"
                    >
                      Publish
                    </button>
                  </>
                )}
                {!!(currentProject as any)?.is_dagster_plus && (
                  <>
                    <span className="text-xs text-gray-400 ml-2">·</span>
                    <SandboxStatusPill
                      projectId={currentProject.id}
                      isDagsterPlus
                      onPromoted={() => {
                        refreshDrafts();
                        setDraftsPanelOpen(true);
                      }}
                    />
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <button
                          className="ml-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border border-indigo-200 bg-indigo-50 text-indigo-800 hover:bg-indigo-100 whitespace-nowrap"
                          title="Author a new component draft"
                        >
                          + Add
                          <ChevronDown className="w-3 h-3 opacity-70" />
                        </button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content
                          className="min-w-[200px] bg-white rounded-md shadow-lg border border-gray-200 p-1 z-50"
                          sideOffset={5}
                          align="start"
                        >
                          <QuickAddItem label="Any component" onSelect={() => { setAddComponentProducesFilter(undefined); setAddComponentOpen(true); }} />
                          <DropdownMenu.Separator className="h-px bg-gray-200 my-1" />
                          <QuickAddItem label="Schedule" onSelect={() => { setAddComponentProducesFilter(['schedule']); setAddComponentOpen(true); }} />
                          <QuickAddItem label="Job" onSelect={() => { setAddComponentProducesFilter(['job']); setAddComponentOpen(true); }} />
                          <QuickAddItem label="Asset" onSelect={() => { setAddComponentProducesFilter(['asset', 'multi_asset']); setAddComponentOpen(true); }} />
                          <QuickAddItem label="Sensor" onSelect={() => { setAddComponentProducesFilter(['sensor']); setAddComponentOpen(true); }} />
                          <QuickAddItem label="Asset check" onSelect={() => { setAddComponentProducesFilter(['asset_check']); setAddComponentOpen(true); }} />
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                    <button
                      onClick={() => setDraftsPanelOpen(true)}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 whitespace-nowrap"
                      title="View drafts pending PR promotion"
                    >
                      Drafts
                      {allDrafts.length > 0 && (
                        <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-gray-800 text-white text-[10px] font-semibold">
                          {allDrafts.length}
                        </span>
                      )}
                    </button>
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <button
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 whitespace-nowrap"
                          title="Land a sandbox component somewhere real"
                        >
                          Publish
                          <ChevronDown className="w-3 h-3 opacity-70" />
                        </button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content
                          className="min-w-[260px] bg-white rounded-md shadow-lg border border-gray-200 p-1 z-50"
                          sideOffset={5}
                          align="start"
                        >
                          <DropdownMenu.Item
                            onSelect={() => setDraftsPanelOpen(true)}
                            className="flex flex-col items-start gap-0.5 px-2.5 py-1.5 text-sm text-gray-700 rounded hover:bg-gray-100 cursor-pointer outline-none"
                          >
                            <span className="font-medium">Promote to PR</span>
                            <span className="text-[11px] text-gray-500">Review drafts, open a pull request against your repo — the recommended path.</span>
                          </DropdownMenu.Item>
                          <DropdownMenu.Separator className="h-px bg-gray-200 my-1" />
                          <DropdownMenu.Item
                            disabled={publishingServerless}
                            onSelect={async () => {
                              const ok = await confirmDialog(
                                'Pushes the sandbox straight to a Serverless deployment — no commit, no PR, no review. Anyone else on this deployment will see it immediately.',
                                { title: 'Publish directly to Serverless?', destructive: true },
                              );
                              if (!ok) return;
                              setPublishingServerless(true);
                              try {
                                const { designerLocApi } = await import('./services/api');
                                const r = await designerLocApi.publishServerless(currentProject.id);
                                notify.success(`Published to Serverless location "${r.location_name}" on ${r.deployment}.`);
                              } catch (e: any) {
                                notify.error(`Publish failed: ${e?.response?.data?.detail || e?.message || String(e)}`);
                              } finally {
                                setPublishingServerless(false);
                              }
                            }}
                            className="flex flex-col items-start gap-0.5 px-2.5 py-1.5 text-sm text-amber-800 rounded hover:bg-amber-50 cursor-pointer outline-none data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed"
                          >
                            <span className="font-medium">{publishingServerless ? 'Publishing…' : 'Publish sandbox directly to Serverless'}</span>
                            <span className="text-[11px] text-amber-700">Skips git entirely — no review, no history. For a demo you'll throw away.</span>
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  </>
                )}
              </>
            ) : (
              <span className="text-sm text-gray-500">No project selected</span>
            )}
          </div>
          <div className={`flex items-center gap-2 ${isTauri ? 'titlebar-no-drag' : ''}`}>
            {currentProject && (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    disabled={dagsterUILoading}
                    className="flex items-center gap-2 px-3.5 py-1.5 bg-primary text-primary-foreground text-sm font-medium rounded-md hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                  >
                    <ExternalLink className="w-4 h-4" />
                    <span>{dagsterUILoading ? 'Starting…' : 'Dagster UI'}</span>
                    <ChevronDown className="w-3.5 h-3.5" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    className="min-w-[220px] bg-white rounded-md shadow-lg border border-gray-200 p-1"
                    sideOffset={5}
                    align="end"
                  >
                    <DropdownMenu.Item
                      className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded cursor-pointer outline-none"
                      onSelect={handleOpenDagsterUI}
                    >
                      <ExternalLink className="w-4 h-4" />
                      <span>Open Dagster UI</span>
                    </DropdownMenu.Item>
                    {/* Killing local Dagster processes is meaningless
                        for Dagster+ (cloud) projects -- nothing runs
                        locally, so hide the option entirely rather
                        than confuse users. */}
                    {!isCloudProject && (
                      <>
                        <DropdownMenu.Separator className="h-px bg-gray-200 my-1" />
                        <DropdownMenu.Item
                          className="flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded cursor-pointer outline-none"
                          onSelect={handleKillAllDagsterProcesses}
                        >
                          <Skull className="w-4 h-4" />
                          <span>Kill All Dagster Processes</span>
                        </DropdownMenu.Item>
                      </>
                    )}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )}
            <ProjectManager />
          </div>
          {isTauri && platform === 'windows' && <WindowsCaptionButtons />}
        </header>


      {/* Main content */}
      {currentProject ? (
        <Tabs.Root value={activeMainTab} onValueChange={setActiveMainTab} className="flex-1 flex flex-col overflow-hidden">
          {/* Hidden Tabs.List to satisfy Radix a11y (real nav is the sidebar) */}
          <Tabs.List className="sr-only" aria-hidden="true">
            {navItems.map(({ value, label }) => (
              <Tabs.Trigger key={value} value={value}>{label}</Tabs.Trigger>
            ))}
          </Tabs.List>

          {/* Assets Tab Content — the same editor works for both local
              and Dagster+ projects: for cloud projects the backend
              hydrates project.graph from the GraphQL API before
              returning, so this UI reads the same shape either way.
              Editing controls (delete, +Add data) hide on cloud since
              cloud is read-only for now. */}
          <Tabs.Content value="assets" className="flex-1 flex flex-col overflow-hidden">
            {/* Ribbon slot -- GraphEditor portals its top toolbar here
                so it stretches from the left nav to the right edge and
                doesn't reflow when the property panel opens. Hidden
                on the detail page since it has its own header. */}
            {!detailNodeId && (
              <div
                ref={setAssetsRibbonHost}
                className="flex-shrink-0"
              />
            )}
            <div className="flex-1 flex overflow-hidden">
            {/* Asset detail view sits alongside the graph/catalog layout
                and only one is visible at a time. We keep GraphEditor
                mounted (via `hidden`) rather than unmounting it so the
                user's view mode (graph vs catalog) survives the detour
                through the detail page -- clicking Back returns them
                exactly where they came from. */}
            {detailNodeId && (
              <div className="flex-1 min-w-0 flex flex-col">
                <AssetDetailPage
                  nodeId={detailNodeId}
                  initialTab={detailInitialTab}
                  onClose={() => { setDetailNodeId(null); setDetailInitialTab(undefined); }}
                  onNavigate={(nextNodeId) => setDetailNodeId(nextNodeId)}
                  onOpenRun={handleOpenRun}
                  onNewPrimitiveForAsset={(category, assetKey) => openNewPrimitive(category, assetKey)}
                />
              </div>
            )}
            <div className={`${detailNodeId ? 'hidden' : 'flex'} flex-1 min-w-0 overflow-hidden`}>
            {/* Left sidebar (Project Components + Component Palette).
                Shown for both local and Dagster+ projects on graph view.
                On Dagster+ the top section becomes a link into the drafts
                drawer and the palette click routes to the sandbox
                authoring flow (same modal, different target). */}
            {assetsViewMode === 'graph' && (
            <aside
              data-sidebar
              className={`${componentsSidebarCollapsed ? 'w-9' : 'w-64'} transition-[width] duration-150 flex-shrink-0 bg-white border-r border-gray-200 flex flex-col overflow-hidden`}
            >
              {componentsSidebarCollapsed ? (
                <button
                  onClick={() => setComponentsSidebarCollapsed(false)}
                  className="flex-1 flex flex-col items-center gap-2 pt-3 text-gray-400 hover:text-gray-700 hover:bg-gray-50 transition-colors"
                  title="Show project components"
                  aria-label="Show project components"
                >
                  <PanelLeft className="w-4 h-4" />
                </button>
              ) : (
              <>
              {/* Top section: on local = Project Components; on cloud = Drafts summary */}
              {isCloudProject ? (
                <div className="flex flex-col overflow-hidden border-b border-gray-200 flex-shrink-0">
                  <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                    <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Drafts
                    </h3>
                    <button
                      onClick={() => setComponentsSidebarCollapsed(true)}
                      className="text-gray-400 hover:text-gray-700 -mr-1 p-0.5 rounded hover:bg-gray-200 transition-colors"
                      title="Collapse sidebar"
                      aria-label="Collapse sidebar"
                    >
                      <PanelLeftClose className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="p-4">
                    <button
                      onClick={() => setDraftsPanelOpen(true)}
                      className="w-full text-left text-xs text-gray-700 hover:text-gray-900 flex items-center justify-between px-2 py-1.5 rounded hover:bg-gray-100"
                    >
                      <span>Pending PR promotions</span>
                      <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-gray-800 text-white text-[10px] font-semibold">
                        {allDrafts.length}
                      </span>
                    </button>
                    <p className="mt-2 text-[10px] text-gray-500 leading-snug">
                      Click a component below to add to your sandbox. Use <span className="font-medium">+ Add component</span> in the header to author against a customer code location instead.
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  <div
                    className="flex flex-col overflow-hidden border-b border-gray-200"
                    style={{ height: `${componentsPanelHeight}%` }}
                  >
                    <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                      <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">
                        Project Components
                      </h3>
                      <button
                        onClick={() => setComponentsSidebarCollapsed(true)}
                        className="text-gray-400 hover:text-gray-700 -mr-1 p-0.5 rounded hover:bg-gray-200 transition-colors"
                        title="Collapse sidebar"
                        aria-label="Collapse sidebar"
                      >
                        <PanelLeftClose className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4">
                      <ProjectComponentsList
                        onEditComponent={setEditingComponent}
                        onDeleteComponent={handleDeleteComponent}
                      />
                    </div>
                  </div>
                  <div
                    onMouseDown={handleDividerMouseDown}
                    className="h-1 bg-gray-200 hover:bg-blue-400 cursor-ns-resize active:bg-blue-500 transition-colors"
                    title="Drag to resize"
                  />
                </>
              )}

              {/* Component Palette Section — always visible on graph view */}
              <div
                className="flex flex-col overflow-hidden flex-1"
                style={!isCloudProject ? { height: `${100 - componentsPanelHeight}%` } : undefined}
              >
                <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
                  <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">
                    {isCloudProject ? 'Add to Sandbox' : 'Add Component'}
                  </h3>
                </div>
                <div className="flex-1 overflow-y-auto">
                  <ComponentPalette
                    onComponentClick={(componentType) => {
                      if (isCloudProject) {
                        // Route to sandbox authoring via the same modal + APIs
                        // the header "+ Add component" flow uses. Schema is
                        // fetched by ComponentConfigModal's useComponent hook.
                        setDraftAuthoring({
                          componentType,
                          displayName: componentType.split('.').pop() || componentType,
                          schema: null,
                          initialAttributes: {},
                          location: '__sandbox__',
                          deployment: null,
                          target: 'sandbox',
                          availableAssets: [],
                          availableJobs: [],
                          availableSchedules: [],
                          availableSensors: [],
                        });
                      } else {
                        setAddingComponentType(componentType);
                      }
                    }}
                  />
                </div>
              </div>
              </>
              )}
            </aside>
            )}

            {/* Graph Editor -- single source of truth for the Assets tab. */}
            <main className="flex-1 min-w-0 relative">
              <GraphEditor
                onNodeSelect={setSelectedNodeId}
                onAddDataSource={setAddingComponentType}
                onViewModeChange={setAssetsViewMode}
                onOpenAssetDetail={setDetailNodeId}
                ribbonHost={assetsRibbonHost}
                onPrimitiveClick={async (category, name) => {
                  // For asset checks — many are dbt-derived and don't live in
                  // our managed primitives list. Route via the backend search
                  // endpoint which knows how to resolve them to schema.yml,
                  // then open the source file in the Code tab.
                  if (category === 'asset_check' && currentProject) {
                    try {
                      const res = await primitivesApi.searchPrimitiveDefinition(
                        currentProject.id,
                        'asset_check',
                        name,
                      );
                      if (res.found && res.file_path) {
                        const path = res.line_number
                          ? `${res.file_path}:${res.line_number}`
                          : res.file_path;
                        handleOpenFile(path);
                        return;
                      }
                    } catch (e) {
                      console.warn('[Asset check] search failed:', e);
                    }
                    // Fallback: still try Automation tab in case it's a managed check.
                  }
                  setActiveMainTab('primitives');
                  setPrimitiveToOpen({ category, name });
                }}
              />
            </main>

            {/* Property Panel */}
            {selectedNodeId && (
              <aside className="w-96 flex-shrink-0 bg-white border-l border-gray-200 overflow-y-auto">
                <PropertyPanel
                  nodeId={selectedNodeId}
                  onConfigureComponent={setEditingComponent}
                  onOpenFile={handleOpenFile}
                  onNewPrimitiveForAsset={(category, assetKey) => openNewPrimitive(category, assetKey)}
                  onOpenDetail={setDetailNodeId}
                />
              </aside>
            )}
            </div>
            </div>
          </Tabs.Content>

          {/* Ingestions Tab Content — Fivetran/Airbyte-style monitoring
              surface over the ingestion-shaped components already in the
              project. Reuses AddDataDialog for the "add" flow. */}
          <Tabs.Content value="ingestions" className="flex-1 overflow-hidden">
            <IngestionsPanel onAddDataSource={setAddingComponentType} onEditComponent={setEditingComponent} />
          </Tabs.Content>

          {/* Insights Tab Content — deployment-level Dagster+ usage/cost/
              reliability metrics, with drill-down into a specific asset's
              own Insights tab. Cloud-only (see navItems). */}
          <Tabs.Content value="insights" className="flex-1 overflow-hidden">
            <InsightsPanel
              onOpenAsset={(nodeId) => {
                // AssetDetailPage's overlay only actually renders inside
                // the Assets tab's content -- without switching there too,
                // detailNodeId gets set but nothing visible happens since
                // Insights' own Tabs.Content stays the active (visible) one.
                // Opens on Overview (the default), not that asset's own
                // Insights tab -- landing straight back on Insights after
                // drilling in from Insights felt like it went nowhere.
                setActiveMainTab('assets');
                setDetailNodeId(nodeId);
              }}
              onOpenJob={(jobName) => {
                // No dedicated job detail page exists -- reuse the same
                // details dialog the Automation tab's Jobs list already
                // has (PrimitivesManager's openPrimitive mechanism).
                setActiveMainTab('primitives');
                setPrimitiveToOpen({ category: 'job', name: jobName });
              }}
            />
          </Tabs.Content>

          {/* dbt Tab Content — model catalog + docs + one-click runs
              over any dbt project (local or cloned) in this project. */}
          <Tabs.Content value="dbt" className="flex-1 overflow-hidden">
            <DbtPanel onOpenFile={handleOpenFile} />
          </Tabs.Content>

          {/* Monitors Tab Content — unified Monte-Carlo-style surface
              across native asset checks, community enhanced checks,
              and dbt tests. Read-only v1 — write flow (schedule / add /
              history / charts) lands next. */}
          <Tabs.Content value="monitors" className="flex-1 overflow-hidden">
            <MonitorsPanel key={tabResetNonce.monitors || 0} onOpenFile={handleOpenFile} onOpenRun={handleOpenRun} />
          </Tabs.Content>

          {/* Alerts Tab Content */}
          <Tabs.Content value="alerts" className="flex-1 overflow-hidden">
            <AlertsPanel />
          </Tabs.Content>

          {/* Runs Tab Content */}
          <Tabs.Content value="runs" className="flex-1 overflow-hidden">
            <RunsPanel
              key={runToOpen ? `run-${runToOpen}` : `runs-${tabResetNonce.runs || 0}`}
              initialRunId={runToOpen ?? undefined}
            />
          </Tabs.Content>

          {/* Pipelines Tab Content */}
          <Tabs.Content value="pipelines" className="flex-1 overflow-hidden">
            <div className="h-full flex flex-col">
              {/* AI Assistant strip — orphans, missing lineage, cost hints.
                  Hidden for Dagster+ (cloud) projects: they're read-only, so
                  the assistant's "add / restructure / schedule" suggestions
                  can't be acted on. */}
              {currentProject && !isCloudProject && (
                <div className="px-4 pt-3">
                  <AiAssistantPanel
                    title="AI Assistant · Pipelines"
                    subtitle="Graph shape, orphan assets, and lineage suggestions."
                    suggestions={[
                      'Are any assets orphaned?',
                      "What's the shape of my pipeline?",
                      'Where should I add automation?',
                      'Any redundant components?',
                    ]}
                    fetchInsights={() => _projectsApi.pageInsights(currentProject.id, 'pipelines') as any}
                    ask={(q, h) => _projectsApi.pageAsk(currentProject.id, 'pipelines', { question: q, history: h }).then(r => ({ answer: r.answer, toolsUsed: r.tools_used }))}
                  />
                </div>
              )}
              <div className="flex-1 min-h-0"><PipelineBuilder /></div>
            </div>
          </Tabs.Content>

          {/* Code Tab Content */}
          <Tabs.Content value="code" className="flex-1 overflow-hidden">
            <div className="h-full">
              <CodeEditor
                projectId={currentProject.id}
                projectDirectoryName={currentProject.directory_name}
                fileToOpen={fileToOpen}
                onFileOpened={() => setFileToOpen(null)}
              />
            </div>
          </Tabs.Content>

          {/* Automation (Primitives) Tab Content */}
          <Tabs.Content value="primitives" className="flex-1 overflow-hidden">
            <div className="h-full flex flex-col overflow-y-auto">
              {/* AI Assistant strip — schedule + sensor + automation-condition coverage.
                  Hidden for cloud (read-only). */}
              {currentProject && !isCloudProject && (
                <div className="px-4 pt-3">
                  <AiAssistantPanel
                    title="AI Assistant · Automation"
                    subtitle="Schedule, sensor, and automation-condition coverage across your assets."
                    suggestions={[
                      'Which assets have no automation?',
                      'Any redundant schedules?',
                      'What should I schedule next?',
                      'Are my sensors covering the right assets?',
                    ]}
                    fetchInsights={() => _projectsApi.pageInsights(currentProject.id, 'automation') as any}
                    ask={(q, h) => _projectsApi.pageAsk(currentProject.id, 'automation', { question: q, history: h }).then(r => ({ answer: r.answer, toolsUsed: r.tools_used }))}
                  />
                </div>
              )}
              <PrimitivesManager
                onNewPrimitive={(category) => openNewPrimitive(category)}
                onOpenFile={handleOpenFile}
                openPrimitive={primitiveToOpen}
                onOpenPrimitiveConsumed={() => setPrimitiveToOpen(null)}
                onOpenAsset={(nodeId) => { setActiveMainTab('assets'); setDetailNodeId(nodeId); }}
              />
            </div>
          </Tabs.Content>

          {/* Library Tab Content (Components + Integrations) */}
          <Tabs.Content value="library" className="flex-1 overflow-hidden">
            <div className="h-full">
              <Library />
            </div>
          </Tabs.Content>

          {/* Resources Tab Content */}
          <Tabs.Content value="resources" className="flex-1 overflow-hidden">
            <div className="h-full">
              <ResourcesManager onOpenFile={handleOpenFile} />
            </div>
          </Tabs.Content>
        </Tabs.Root>
      ) : (
        <div className="flex-1 flex items-center justify-center text-gray-500">
          <div className="text-center">
            {isProjectLoading ? (
              <>
                <div className="inline-block w-10 h-10 border-4 border-gray-200 border-t-indigo-500 rounded-full animate-spin mb-4" />
                <p className="text-lg font-medium text-gray-700">Loading project…</p>
                <p className="text-sm mt-1 text-gray-400">{loadingCloudLabel ? `Talking to ${loadingCloudLabel}` : 'Fetching assets and lineage.'}</p>
              </>
            ) : (
              <>
                <Network className="w-16 h-16 mx-auto mb-4 text-gray-400" />
                <p className="text-lg">No project selected</p>
                <p className="text-sm mt-2">Create or open a project to get started</p>
              </>
            )}
          </div>
        </div>
      )}

        {/* Compact status strip (single line, only when active) */}
        <StatusStrip
          dependencyInstallStatus={dependencyInstallStatus}
          dependencyInstallError={dependencyInstallError}
          dependencyInstallOutput={dependencyInstallOutput}
          onViewDependencyDetails={() => setShowDependencyOutputDialog(true)}
          onDismissDependency={dismissDependencyInstallStatus}
          assetGenerationStatus={assetGenerationStatus}
          assetGenerationError={assetGenerationError}
          onDismissAssetGen={dismissAssetGenerationStatus}
          validationStatus={validationStatus}
          validationError={validationError}
          onDismissValidation={dismissValidationStatus}
          validationFallback={!!backgroundValidationStatus?.using_fallback && !dismissedValidationError}
          onViewValidationDetails={handleViewValidationDetails}
          onDismissValidationFallback={() => setDismissedValidationError(true)}
          isValidating={isValidating}
        />
      </div>
      {/* /right-side column */}

      {/* Component Config Modal */}
      {(editingComponent || addingComponentType) && currentProject && (
        <ComponentConfigModal
          component={editingComponent}
          componentType={addingComponentType || undefined}
          onSave={handleSaveComponent}
          onClose={() => {
            setEditingComponent(null);
            setAddingComponentType(null);
          }}
          onOpenVisualEditor={handleOpenVisualEditor}
        />
      )}

      {/* Dagster Startup Modal */}
      {showDagsterStartupModal && currentProject && (
        <DagsterStartupModal
          projectId={currentProject.id}
          onClose={() => setShowDagsterStartupModal(false)}
          onSuccess={(url) => {
            setShowDagsterStartupModal(false);
            openExternalUrl(url);
          }}
        />
      )}


      {/* Dependency Installation Output Dialog */}
      {showDependencyOutputDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between p-6 border-b">
              <h2 className="text-lg font-semibold">
                {dependencyInstallStatus === 'installing' && 'Dependency installation in progress'}
                {dependencyInstallStatus === 'success' && 'Dependency installation complete'}
                {dependencyInstallStatus === 'error' && 'Dependency installation failed'}
              </h2>
              <button onClick={() => setShowDependencyOutputDialog(false)}>
                <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {dependencyInstallOutput ? (
                <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-xs whitespace-pre-wrap">
                  {dependencyInstallOutput}
                </pre>
              ) : (
                <p className="text-gray-500 text-sm">No output available yet...</p>
              )}
            </div>

            <div className="p-4 border-t flex justify-end">
              <button
                onClick={() => setShowDependencyOutputDialog(false)}
                className="px-4 py-2 text-sm bg-gray-600 text-white rounded-md hover:bg-gray-700"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Validation Results Dialog */}
      {showValidationDialog && validationResult && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between p-6 border-b">
              <h2 className="text-lg font-semibold">
                {validationResult.valid ? 'Validation successful' : 'Validation failed'}
              </h2>
              <button onClick={() => setShowValidationDialog(false)}>
                <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {validationResult.valid ? (
                <div>
                  <p className="text-green-700 mb-4">{validationResult.message}</p>
                  {validationResult.details?.stdout && (
                    <div className="mt-4">
                      <h3 className="text-sm font-semibold text-gray-700 mb-2">Full Output:</h3>
                      <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-xs">
                        {validationResult.details.stdout}
                      </pre>
                    </div>
                  )}
                  {validationResult.details?.warnings && (
                    <div className="mt-4">
                      <h3 className="text-sm font-semibold text-gray-700 mb-2">Warnings:</h3>
                      <pre className="bg-yellow-50 text-yellow-900 p-4 rounded-lg overflow-x-auto text-xs border border-yellow-200">
                        {validationResult.details.warnings}
                      </pre>
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <p className="text-red-700 mb-4 font-medium">{validationResult.error}</p>

                  {(!validationResult.failing_components || validationResult.failing_components.length === 0) &&
                    currentProject && currentProject.components && currentProject.components.length > 0 && (
                    <div className="mb-4 p-4 bg-gray-50 border border-gray-200 rounded-md">
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="text-sm font-semibold text-gray-900">
                          Couldn't parse specific components from the error. Delete broken components manually:
                        </h3>
                        <button
                          onClick={handleViewValidationDetails}
                          disabled={isValidating}
                          className="text-xs text-primary hover:underline font-medium disabled:opacity-50"
                        >
                          {isValidating ? 'Retrying…' : 'Retry validation'}
                        </button>
                      </div>
                      <ul className="space-y-1 max-h-48 overflow-y-auto">
                        {currentProject.components.map((c) => (
                          <li key={c.id} className="flex items-center justify-between text-sm">
                            <span className="min-w-0 truncate">
                              <code className="bg-white px-2 py-0.5 rounded border border-gray-200 text-gray-800">{c.id}</code>
                              <span className="ml-2 text-xs text-gray-500 truncate">{c.component_type}</span>
                            </span>
                            <button
                              onClick={() => handleDeleteBrokenComponents([c.id])}
                              disabled={isDeletingBroken}
                              className="text-xs text-red-600 hover:underline font-medium disabled:opacity-50 ml-3 flex-shrink-0"
                            >
                              Delete
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {validationResult.failing_components?.length > 0 && (
                    <div className="mb-4 p-4 bg-amber-50 border border-amber-200 rounded-md">
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="text-sm font-semibold text-amber-900">
                          {validationResult.failing_components.length} component{validationResult.failing_components.length === 1 ? '' : 's'} appear{validationResult.failing_components.length === 1 ? 's' : ''} in the error:
                        </h3>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={handleViewValidationDetails}
                            disabled={isValidating}
                            className="text-xs text-primary hover:underline font-medium disabled:opacity-50"
                          >
                            {isValidating ? 'Retrying…' : 'Retry validation'}
                          </button>
                          <span className="text-amber-300">·</span>
                          <button
                            onClick={() => handleDeleteBrokenComponents(validationResult.failing_components)}
                            disabled={isDeletingBroken}
                            className="text-xs text-red-600 hover:underline font-medium disabled:opacity-50"
                          >
                            {isDeletingBroken ? 'Deleting…' : 'Delete all these'}
                          </button>
                        </div>
                      </div>
                      <ul className="space-y-1">
                        {validationResult.failing_components.map((cid: string) => (
                          <li key={cid} className="flex items-center justify-between text-sm">
                            <code className="bg-white px-2 py-0.5 rounded border border-amber-200 text-amber-900 truncate max-w-xs">
                              {cid}
                            </code>
                            <div className="flex items-center gap-3">
                              <button
                                onClick={() => {
                                  setShowValidationDialog(false);
                                  const path = `src/${currentProject?.directory_name || ''}/defs/${cid}/defs.yaml`;
                                  handleOpenFile(path);
                                }}
                                className="text-xs text-primary hover:underline font-medium"
                              >
                                Open defs.yaml
                              </button>
                              <button
                                onClick={() => handleDeleteBrokenComponents([cid])}
                                disabled={isDeletingBroken}
                                className="text-xs text-red-600 hover:underline font-medium disabled:opacity-50"
                              >
                                Delete
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                      <p className="text-xs text-amber-800 mt-3">
                        Tip: missing required fields (e.g. <code>file_path</code>, <code>connection_string</code>) are the most common cause. Check for <code>TODO_</code> placeholders left by Dagster AI.
                      </p>
                    </div>
                  )}

                  {validationResult.details?.validation_error && (
                    <div className="mt-4">
                      <h3 className="text-sm font-semibold text-gray-700 mb-2">Error Details:</h3>
                      <pre className="bg-red-50 text-red-900 p-4 rounded-lg overflow-x-auto text-xs border border-red-200">
                        {validationResult.details.validation_error}
                      </pre>
                    </div>
                  )}

                  {validationResult.details?.stderr && (
                    <div className="mt-4">
                      <h3 className="text-sm font-semibold text-gray-700 mb-2">Full Error Output:</h3>
                      <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-xs">
                        {validationResult.details.stderr}
                      </pre>
                    </div>
                  )}

                  <div className="mt-6 p-4 bg-yellow-50 border border-yellow-200 rounded-md">
                    <h4 className="text-sm font-semibold text-yellow-800 mb-2">Common issues:</h4>
                    <ul className="text-sm text-yellow-700 space-y-1 list-disc list-inside">
                      <li>Check for syntax errors in Python files</li>
                      <li>Verify all imports are correct</li>
                      <li>Ensure asset definitions don't have conflicts</li>
                      <li>Check that all required dependencies are installed</li>
                    </ul>
                  </div>
                </div>
              )}
            </div>

            <div className="p-4 border-t flex justify-end">
              <button
                onClick={() => setShowValidationDialog(false)}
                className="px-4 py-2 text-sm bg-gray-600 text-white rounded-md hover:bg-gray-700"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Data Preview Modal (Visual Editor) */}
      {showDataPreview && currentProject && (
        <DataPreviewModal
          isOpen={showDataPreview}
          onClose={() => setShowDataPreview(false)}
          projectId={currentProject.id}
          assetKey={dataPreviewAssetKey}
          assetName={dataPreviewAssetName}
          existingComponentAttributes={dataPreviewComponentAttributes}
          existingComponentId={dataPreviewComponentId}
        />
      )}

      {/* Header-level "Push to GitHub" for local projects — reported as
          hidden when it only lived inside ProjectManager's "..." Actions
          menu. This is a second trigger for the same dialog, not a
          replacement; that one still works too. */}
      {currentProject && !(currentProject as any)?.is_dagster_plus && (
        <GitCommitDialog
          open={headerGitCommitOpen}
          onOpenChange={setHeaderGitCommitOpen}
          projectId={currentProject.id}
          defaultMessage="Update from Dagster Designer"
          defaultRepoName={currentProject.name}
        />
      )}

      {/* Local-project "Publish to Dagster+" — previously didn't exist
          anywhere for a project that isn't already Dagster+-connected;
          the Dagster+-connected version of this lives in the "Publish"
          header dropdown further up (Publish sandbox directly to
          Serverless), which needs org/token/deployment already stored
          on the project record. This collects them inline instead. */}
      {currentProject && !(currentProject as any)?.is_dagster_plus && (
        <PublishServerlessDialog
          open={localPublishOpen}
          onOpenChange={setLocalPublishOpen}
          projectId={currentProject.id}
          projectName={currentProject.name}
        />
      )}

      {/* "New asset check" — routed here instead of TemplateBuilder's own
          asset-check generator (see openNewPrimitive above). */}
      {currentProject && (
        <AddMonitorDialog
          open={addMonitorOpen}
          onOpenChange={(o) => { setAddMonitorOpen(o); if (!o) setAddMonitorInitialAsset(undefined); }}
          projectId={currentProject.id}
          initialTargetAsset={addMonitorInitialAsset}
        />
      )}

      {/* Template Builder Modal — opened from Automation "New" buttons */}
      {templateBuilderTab && currentProject && (
        <div className="fixed inset-0 bg-black/40 z-40 flex items-center justify-center p-6">
          <div
            className="bg-white rounded-lg shadow-2xl w-full max-w-6xl h-[85vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex-shrink-0 flex items-center justify-between px-5 py-3 border-b border-gray-200">
              <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                {(() => {
                  const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
                    schedule: Clock,
                    job: Play,
                    sensor: Radar,
                    asset_check: CheckCircle,
                    freshness_policy: Timer,
                  };
                  const Icon = iconMap[templateBuilderTab];
                  return Icon ? <Icon className="w-4 h-4 text-primary" /> : null;
                })()}
                <span>New {templateBuilderTab.replace(/_/g, ' ')}</span>
                {templateBuilderAssetKey && (
                  <span className="text-xs text-gray-500 font-normal">
                    for <code className="bg-gray-100 px-1.5 py-0.5 rounded">{templateBuilderAssetKey}</code>
                  </span>
                )}
              </h2>
              <button
                onClick={() => {
                  setTemplateBuilderTab(null);
                  setTemplateBuilderAssetKey(null);
                }}
                className="p-1 text-gray-400 hover:text-gray-600 rounded"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              <TemplateBuilder
                initialTab={templateBuilderTab}
                initialAssetKey={templateBuilderAssetKey}
                hideSubNav
              />
            </div>
          </div>
        </div>
      )}

      {isCloudProject && currentProject && (
        <>
          <AddComponentModal
            open={addComponentOpen}
            onOpenChange={setAddComponentOpen}
            projectId={currentProject.id}
            onConfigure={setDraftAuthoring}
            initialProducesFilter={addComponentProducesFilter}
          />
          {draftAuthoring && (
            <ComponentConfigModal
              component={null}
              componentType={draftAuthoring.componentType}
              schemaOverride={draftAuthoring.schema}
              initialAttributes={draftAuthoring.initialAttributes}
              mode="draft"
              availableAssetsOverride={draftAuthoring.availableAssets}
              availableJobs={draftAuthoring.availableJobs}
              availableSchedules={draftAuthoring.availableSchedules}
              availableSensors={draftAuthoring.availableSensors}
              onSave={() => { /* never called in draft mode */ }}
              onSaveDraft={async (attributes) => {
                // Serialise attributes back into a full defs.yaml doc.
                const { default: _yaml } = await import('js-yaml');
                const yamlStr = _yaml.dump(
                  { type: draftAuthoring.componentType, attributes },
                  { lineWidth: 100 },
                );
                if (draftAuthoring.target === 'sandbox') {
                  const { designerLocApi } = await import('./services/api');
                  const r = await designerLocApi.scaffoldComponent(currentProject.id, {
                    component_type: draftAuthoring.componentType,
                    attributes_yaml: yamlStr,
                  });
                  notify.success(
                    r.restarted
                      ? `Installed ${r.package ?? 'component'} + wrote defs.yaml. Sandbox restarting…`
                      : `Wrote defs.yaml — sandbox hot-reloading`,
                  );
                  // The canvas merges sandbox assets from a live query
                  // against the (possibly just-restarted) subprocess —
                  // reload now for the hot-reload case, then poll for
                  // "ready" and reload again so a restart's new asset
                  // shows up without the user having to navigate away
                  // and back.
                  useProjectStore.getState().loadProject(currentProject.id);
                  if (r.restarted) {
                    const deadline = Date.now() + 60_000;
                    while (Date.now() < deadline) {
                      await new Promise((res) => setTimeout(res, 2000));
                      try {
                        const s = await designerLocApi.status(currentProject.id);
                        if (s.status === 'ready') break;
                        if (s.status === 'error') return;
                      } catch { /* keep polling */ }
                    }
                    useProjectStore.getState().loadProject(currentProject.id);
                  }
                } else {
                  const { draftsApi, previewApi } = await import('./services/api');
                  await draftsApi.create(currentProject.id, {
                    location_name: draftAuthoring.location,
                    deployment_name: draftAuthoring.deployment,
                    component_type: draftAuthoring.componentType,
                    attributes: yamlStr,
                  });
                  notify.success('Draft created');
                  refreshDrafts();
                  setDraftsPanelOpen(true);
                  // Fire-and-forget pre-warm: if the target is a long-lived
                  // deployment, backend starts BD creation in the background
                  // so a later Cloud click completes in ~1s. Branch targets
                  // no-op server-side (fast path applies state directly).
                  if (draftAuthoring.deployment) {
                    previewApi.prewarmRemote(
                      currentProject.id,
                      draftAuthoring.deployment,
                      draftAuthoring.location,
                    ).catch(() => { /* prewarm is best-effort */ });
                  }
                }
              }}
              onClose={() => setDraftAuthoring(null)}
            />
          )}
          <DraftsPanel
            open={draftsPanelOpen}
            onOpenChange={setDraftsPanelOpen}
            projectId={currentProject.id}
            refreshKey={draftsRefreshKey}
            onDraftsChanged={refreshDrafts}
          />
        </>
      )}

      <NotificationHost />
      <SettingsHost />
    </div>
  );
}


// Item for the "+ Add" dropdown. Kept local because the dropdown is
// tiny and unique to the header — no reason to build another component.
function QuickAddItem({ label, onSelect }: { label: string; onSelect: () => void }) {
  return (
    <DropdownMenu.Item
      className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded cursor-pointer outline-none"
      onSelect={onSelect}
    >
      {label}
    </DropdownMenu.Item>
  );
}

export default App;
