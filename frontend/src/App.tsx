import { useState, useEffect } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
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
import { DataPreviewModal } from './components/DataPreviewModal';
import { DagsterAIBar } from './components/DagsterAIBar';
import { DagsterCloudChip } from './components/DagsterCloudChip';
import { NotificationHost, notify, confirmDialog } from './components/Notifications';
import { useProjectStore } from './hooks/useProject';
import { Network, FileCode, Zap, Package, ExternalLink, Settings, Workflow, ChevronDown, Skull, AlertTriangle, X, Loader2, CheckCircle, XCircle, PanelLeftClose, PanelLeft, Clock, Play, Radar, Timer } from 'lucide-react';
import { dagsterUIApi, projectsApi, filesApi, primitivesApi } from './services/api';
import type { ComponentInstance } from './types';

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
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [editingComponent, setEditingComponent] = useState<ComponentInstance | null>(null);
  const [addingComponentType, setAddingComponentType] = useState<string | null>(null);
  const [componentsPanelHeight, setComponentsPanelHeight] = useState(60); // Percentage
  const [isDragging, setIsDragging] = useState(false);
  const [activeMainTab, setActiveMainTab] = useState('assets');
  const [templateBuilderTab, setTemplateBuilderTab] = useState<string | null>(null);
  const [templateBuilderAssetKey, setTemplateBuilderAssetKey] = useState<string | null>(null);
  const [primitiveToOpen, setPrimitiveToOpen] = useState<{ category: string; name: string } | null>(null);
  const [navCollapsed, setNavCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('nav.collapsed') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('nav.collapsed', navCollapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [navCollapsed]);

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
    dismissDependencyInstallStatus
  } = useProjectStore();
  const queryClient = useQueryClient();

  // Clear the selection whenever the currently-selected node vanishes from
  // the graph (typical after Delete Component Instance + project reload).
  useEffect(() => {
    if (!selectedNodeId || !currentProject) return;
    const exists = currentProject.graph.nodes.some((n) => n.id === selectedNodeId);
    if (!exists) setSelectedNodeId(null);
  }, [currentProject, selectedNodeId]);

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
    enabled: !!currentProject && enableValidationCheck && !dismissedValidationError && dependencyInstallStatus !== 'installing',
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
          await fetch(`/api/v1/projects/${currentProject.id}/regenerate-assets/cache`, {
            method: 'DELETE',
          });
        } catch (error) {
          console.warn('Failed to clear asset introspection cache:', error);
        }

        // Call regenerate-assets API
        const response = await fetch(`/api/v1/projects/${currentProject.id}/regenerate-assets`, {
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
      // Remove component from the list
      const updatedComponents = currentProject.components.filter((c) => c.id !== component.id);

      // Remove any graph nodes associated with this component
      const updatedNodes = currentProject.graph.nodes.filter((n) => n.id !== component.id);

      // Update project
      await projectsApi.update(currentProject.id, {
        components: updatedComponents,
        graph: {
          nodes: updatedNodes,
          edges: currentProject.graph.edges,
        },
      });

      // Reload project
      const { loadProject } = useProjectStore.getState();
      await loadProject(currentProject.id);
    } catch (error) {
      console.error('Failed to delete component:', error);
      notify.error('Failed to delete component. Check console for details.');
    }
  };

  const handleOpenDagsterUI = async () => {
    if (!currentProject) return;

    setDagsterUILoading(true);
    try {
      // Check if Dagster UI is running
      const status = await dagsterUIApi.getStatus(currentProject.id);

      if (status.running) {
        // Already running - open in new tab
        window.open(status.url, '_blank');
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
      const response = await fetch(`/api/v1/dagster-ui/kill-all`, {
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

  const navItems = [
    { value: 'assets', label: 'Assets', icon: Network },
    { value: 'pipelines', label: 'Pipelines', icon: Workflow },
    { value: 'primitives', label: 'Automation', icon: Zap },
    { value: 'library', label: 'Library', icon: Package },
    { value: 'code', label: 'Code', icon: FileCode, onHover: handleCodeTabHover },
    { value: 'resources', label: 'Resources', icon: Settings },
  ];

  return (
    <div className="h-screen flex bg-background text-foreground">
      {/* Left vertical nav rail */}
      <nav
        className={`${navCollapsed ? 'w-14' : 'w-56'} transition-[width] duration-150 flex flex-col bg-[hsl(var(--dagster-black))] text-white/80 border-r border-[hsl(var(--dagster-black))]`}
      >
        <div className={`${navCollapsed ? 'px-3 justify-center' : 'px-5 justify-between'} py-4 flex items-center gap-2 border-b border-white/10`}>
          {!navCollapsed && (
            <div className="flex items-center gap-2 min-w-0">
              <BrandMark />
              <span className="text-sm font-semibold text-white tracking-tight truncate">Dagster Designer</span>
            </div>
          )}
          {navCollapsed && <BrandMark />}
        </div>
        {currentProject && (
          <Tabs.Root value={activeMainTab} onValueChange={setActiveMainTab} orientation="vertical" className="flex-1 flex flex-col overflow-hidden">
            <Tabs.List className="flex-1 flex flex-col gap-0.5 px-2 py-3 overflow-y-auto" aria-label="Main navigation">
              {navItems.map(({ value, label, icon: Icon, onHover }) => (
                <Tabs.Trigger
                  key={value}
                  value={value}
                  onMouseEnter={onHover}
                  title={navCollapsed ? label : undefined}
                  className={`group flex items-center ${navCollapsed ? 'justify-center px-2' : 'gap-3 px-3'} py-2 rounded-md text-sm font-medium text-white/70 hover:text-white hover:bg-white/5 data-[state=active]:bg-white/10 data-[state=active]:text-white transition-colors focus:outline-none`}
                >
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  {!navCollapsed && <span>{label}</span>}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
          </Tabs.Root>
        )}
        <div className={`mt-auto border-t border-white/10 flex ${navCollapsed ? 'flex-col items-center py-2 gap-1' : 'items-center justify-between px-3 py-2'}`}>
          <button
            onClick={() => setNavCollapsed((v) => !v)}
            className="p-1.5 rounded text-white/50 hover:text-white hover:bg-white/5 transition-colors"
            title={navCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={navCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {navCollapsed ? <PanelLeft className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          </button>
          {!navCollapsed && <span className="text-[11px] text-white/40">v0.1</span>}
        </div>
      </nav>

      {/* Right side: header + content + status strip */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="h-14 flex-shrink-0 bg-white border-b border-gray-200 px-5 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            {currentProject ? (
              <>
                <span className="text-sm font-semibold text-gray-900 truncate">{currentProject.name}</span>
                <span className="text-xs text-gray-400">/</span>
                <span className="text-sm text-gray-600">
                  {navItems.find((n) => n.value === activeMainTab)?.label ?? activeMainTab}
                </span>
                <span className="text-xs text-gray-400 ml-2">·</span>
                <DagsterCloudChip projectId={currentProject.id} />
              </>
            ) : (
              <span className="text-sm text-gray-500">No project selected</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {currentProject && (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    disabled={dagsterUILoading}
                    className="flex items-center gap-2 px-3.5 py-1.5 bg-primary text-primary-foreground text-sm font-medium rounded-md hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <ExternalLink className="w-4 h-4" />
                    <span>{dagsterUILoading ? 'Starting…' : 'Open Dagster UI'}</span>
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
                    <DropdownMenu.Separator className="h-px bg-gray-200 my-1" />
                    <DropdownMenu.Item
                      className="flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded cursor-pointer outline-none"
                      onSelect={handleKillAllDagsterProcesses}
                    >
                      <Skull className="w-4 h-4" />
                      <span>Kill All Dagster Processes</span>
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )}
            <ProjectManager />
          </div>
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

          {/* Assets Tab Content */}
          <Tabs.Content value="assets" className="flex-1 flex overflow-hidden">
            {/* Left Sidebar - Component Palette + Project Components */}
            <aside
              data-sidebar
              className="w-64 bg-white border-r border-gray-200 flex flex-col overflow-hidden"
            >
              {/* Project Components Section */}
              <div
                className="flex flex-col overflow-hidden border-b border-gray-200"
                style={{ height: `${componentsPanelHeight}%` }}
              >
                <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
                  <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">
                    Project Components
                  </h3>
                </div>
                <div className="flex-1 overflow-y-auto p-4">
                  <ProjectComponentsList
                    onEditComponent={setEditingComponent}
                    onDeleteComponent={handleDeleteComponent}
                  />
                </div>
              </div>

              {/* Resize Handle */}
              <div
                onMouseDown={handleDividerMouseDown}
                className="h-1 bg-gray-200 hover:bg-blue-400 cursor-ns-resize active:bg-blue-500 transition-colors"
                title="Drag to resize"
              />

              {/* Component Palette Section */}
              <div
                className="flex flex-col overflow-hidden"
                style={{ height: `${100 - componentsPanelHeight}%` }}
              >
                <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
                  <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">
                    Add Component
                  </h3>
                </div>
                <div className="flex-1 overflow-y-auto">
                  <ComponentPalette onComponentClick={setAddingComponentType} />
                </div>
              </div>
            </aside>

            {/* Graph Editor */}
            <main className="flex-1 relative">
              <GraphEditor
                onNodeSelect={setSelectedNodeId}
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
              <DagsterAIBar />
            </main>

            {/* Property Panel */}
            {selectedNodeId && (
              <aside className="w-96 bg-white border-l border-gray-200 overflow-y-auto">
                <PropertyPanel
                  nodeId={selectedNodeId}
                  onConfigureComponent={setEditingComponent}
                  onOpenFile={handleOpenFile}
                  onNewPrimitiveForAsset={(category, assetKey) => {
                    setTemplateBuilderAssetKey(assetKey);
                    setTemplateBuilderTab(category);
                  }}
                />
              </aside>
            )}
          </Tabs.Content>

          {/* Pipelines Tab Content */}
          <Tabs.Content value="pipelines" className="flex-1 overflow-hidden">
            <div className="h-full">
              <PipelineBuilder />
            </div>
          </Tabs.Content>

          {/* Code Tab Content */}
          <Tabs.Content value="code" className="flex-1 overflow-hidden">
            <div className="h-full">
              <CodeEditor
                projectId={currentProject.id}
                fileToOpen={fileToOpen}
                onFileOpened={() => setFileToOpen(null)}
              />
            </div>
          </Tabs.Content>

          {/* Automation (Primitives) Tab Content */}
          <Tabs.Content value="primitives" className="flex-1 overflow-hidden">
            <div className="h-full">
              <PrimitivesManager
                onNewPrimitive={(category) => setTemplateBuilderTab(category)}
                onOpenFile={handleOpenFile}
                openPrimitive={primitiveToOpen}
                onOpenPrimitiveConsumed={() => setPrimitiveToOpen(null)}
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
            <Network className="w-16 h-16 mx-auto mb-4 text-gray-400" />
            <p className="text-lg">No project selected</p>
            <p className="text-sm mt-2">Create or open a project to get started</p>
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
            window.open(url, '_blank');
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

      <NotificationHost />
    </div>
  );
}

export default App;
