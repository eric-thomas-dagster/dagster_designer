import { useState, useEffect } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { GraphEditor } from './components/GraphEditor';
import { ComponentPalette } from './components/ComponentPalette';
import { ProjectComponentsList } from './components/ProjectComponentsList';
import { ComponentConfigModal } from './components/ComponentConfigModal';
import { PropertyPanel } from './components/PropertyPanel';
import { ProjectManager } from './components/ProjectManager';
import { CodeEditor } from './components/CodeEditor';
import { TemplateBuilder } from './components/TemplateBuilder';
import { PrimitivesManager } from './components/PrimitivesManager';
import { IntegrationCatalog } from './components/IntegrationCatalog';
import { ResourcesManager } from './components/ResourcesManager';
import { PipelineBuilder } from './components/PipelineBuilder';
import { DagsterStartupModal } from './components/DagsterStartupModal';
import { useProjectStore } from './hooks/useProject';
import { Network, FileCode, Wand2, Zap, Package, ExternalLink, Settings, Workflow, ChevronDown, Skull, FileText, GitBranch } from 'lucide-react';
import { dagsterUIApi, projectsApi, filesApi } from './services/api';
import type { ComponentInstance } from './types';

function App() {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [editingComponent, setEditingComponent] = useState<ComponentInstance | null>(null);
  const [addingComponentType, setAddingComponentType] = useState<string | null>(null);
  const [componentsPanelHeight, setComponentsPanelHeight] = useState(60); // Percentage
  const [isDragging, setIsDragging] = useState(false);
  const [activeMainTab, setActiveMainTab] = useState('assets');
  const [dagsterUILoading, setDagsterUILoading] = useState(false);
  const [showDagsterStartupModal, setShowDagsterStartupModal] = useState(false);
  const [fileToOpen, setFileToOpen] = useState<string | null>(null);
  const { currentProject, updateComponents} = useProjectStore();

  // Handler to navigate to code tab and open a file
  const handleOpenFile = (filePath: string) => {
    setActiveMainTab('code');
    setFileToOpen(filePath);
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
      alert('Failed to save component. Check console for details.');
      return;
    }

    // Close modal
    setEditingComponent(null);
    setAddingComponentType(null);

    // Trigger asset regeneration if it's an asset factory
    if (component.is_asset_factory) {
      try {
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

    const confirmed = window.confirm(
      `Are you sure you want to delete "${component.label}"? This will remove the component and its definition files.`
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
      alert('Failed to delete component. Check console for details.');
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

    const confirmed = window.confirm(
      'This will kill all running Dagster processes. Are you sure?'
    );
    if (!confirmed) return;

    try {
      const response = await fetch(`/api/v1/dagster-ui/kill-all`, {
        method: 'POST',
      });

      if (response.ok) {
        alert('All Dagster processes have been terminated.');
      } else {
        const error = await response.json();
        throw new Error(error.detail || 'Failed to kill processes');
      }
    } catch (error) {
      console.error('Failed to kill Dagster processes:', error);
      alert('Failed to kill Dagster processes. Check console for details.');
    }
  };

  const handleScaffoldBuildArtifacts = async () => {
    if (!currentProject) return;

    try {
      const result = await filesApi.execute(currentProject.id, 'dg scaffold build-artifacts', 60);

      if (result.success) {
        alert('Successfully generated Dockerfile!\n\nCheck the project root directory for the generated Dockerfile.');
      } else {
        throw new Error(result.stderr || 'Failed to scaffold build artifacts');
      }
    } catch (error) {
      console.error('Failed to scaffold build artifacts:', error);
      alert('Failed to generate Dockerfile. Check console for details.');
    }
  };

  const handleScaffoldGithubActions = () => {
    alert(
      'GitHub Actions Scaffolding\n\n' +
      'The "dg scaffold github-actions" command requires interactive input:\n' +
      '  • Dagster Plus organization name\n' +
      '  • Default deployment name\n' +
      '  • Deployment agent type (serverless/hybrid)\n\n' +
      'Please use the Terminal tab to run this command interactively:\n' +
      '  dg scaffold github-actions'
    );
  };

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <h1 className="text-xl font-bold text-gray-900">Dagster Designer</h1>
          {currentProject && (
            <span className="text-sm text-gray-600">
              {currentProject.name}
            </span>
          )}
        </div>
        <div className="flex items-center space-x-3">
          {currentProject && (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  disabled={dagsterUILoading}
                  className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <ExternalLink className="w-4 h-4" />
                  <span>{dagsterUILoading ? 'Starting...' : 'Open Dagster UI'}</span>
                  <ChevronDown className="w-4 h-4 ml-1" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="min-w-[200px] bg-white rounded-md shadow-lg border border-gray-200 p-1"
                  sideOffset={5}
                  align="end"
                >
                  <DropdownMenu.Item
                    className="flex items-center space-x-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded cursor-pointer outline-none"
                    onSelect={handleOpenDagsterUI}
                  >
                    <ExternalLink className="w-4 h-4" />
                    <span>Open Dagster UI</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator className="h-px bg-gray-200 my-1" />
                  <DropdownMenu.Item
                    className="flex items-center space-x-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded cursor-pointer outline-none"
                    onSelect={handleScaffoldBuildArtifacts}
                  >
                    <FileText className="w-4 h-4" />
                    <span>Generate Dockerfile</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="flex items-center space-x-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded cursor-pointer outline-none"
                    onSelect={handleScaffoldGithubActions}
                  >
                    <GitBranch className="w-4 h-4" />
                    <span>Generate GitHub Actions</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator className="h-px bg-gray-200 my-1" />
                  <DropdownMenu.Item
                    className="flex items-center space-x-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded cursor-pointer outline-none"
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

      {/* Main content with tabs */}
      {currentProject ? (
        <Tabs.Root value={activeMainTab} onValueChange={setActiveMainTab} className="flex-1 flex flex-col overflow-hidden">
          {/* Tab List */}
          <Tabs.List className="flex items-center space-x-1 px-4 border-b border-gray-200 bg-white">
            <Tabs.Trigger
              value="assets"
              className="flex items-center space-x-2 px-4 py-3 text-sm font-medium text-gray-600 hover:text-gray-900 border-b-2 border-transparent data-[state=active]:border-blue-600 data-[state=active]:text-blue-600"
            >
              <Network className="w-4 h-4" />
              <span>Assets</span>
            </Tabs.Trigger>
            <Tabs.Trigger
              value="pipelines"
              className="flex items-center space-x-2 px-4 py-3 text-sm font-medium text-gray-600 hover:text-gray-900 border-b-2 border-transparent data-[state=active]:border-blue-600 data-[state=active]:text-blue-600"
            >
              <Workflow className="w-4 h-4" />
              <span>Pipelines</span>
            </Tabs.Trigger>
            <Tabs.Trigger
              value="code"
              className="flex items-center space-x-2 px-4 py-3 text-sm font-medium text-gray-600 hover:text-gray-900 border-b-2 border-transparent data-[state=active]:border-blue-600 data-[state=active]:text-blue-600"
            >
              <FileCode className="w-4 h-4" />
              <span>Code</span>
            </Tabs.Trigger>
            <Tabs.Trigger
              value="templates"
              className="flex items-center space-x-2 px-4 py-3 text-sm font-medium text-gray-600 hover:text-gray-900 border-b-2 border-transparent data-[state=active]:border-blue-600 data-[state=active]:text-blue-600"
            >
              <Wand2 className="w-4 h-4" />
              <span>Templates</span>
            </Tabs.Trigger>
            <Tabs.Trigger
              value="primitives"
              className="flex items-center space-x-2 px-4 py-3 text-sm font-medium text-gray-600 hover:text-gray-900 border-b-2 border-transparent data-[state=active]:border-blue-600 data-[state=active]:text-blue-600"
            >
              <Zap className="w-4 h-4" />
              <span>Automation</span>
            </Tabs.Trigger>
            <Tabs.Trigger
              value="integrations"
              className="flex items-center space-x-2 px-4 py-3 text-sm font-medium text-gray-600 hover:text-gray-900 border-b-2 border-transparent data-[state=active]:border-blue-600 data-[state=active]:text-blue-600"
            >
              <Package className="w-4 h-4" />
              <span>Integrations</span>
            </Tabs.Trigger>
            <Tabs.Trigger
              value="resources"
              className="flex items-center space-x-2 px-4 py-3 text-sm font-medium text-gray-600 hover:text-gray-900 border-b-2 border-transparent data-[state=active]:border-blue-600 data-[state=active]:text-blue-600"
            >
              <Settings className="w-4 h-4" />
              <span>Resources</span>
            </Tabs.Trigger>
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
              <GraphEditor onNodeSelect={setSelectedNodeId} />
            </main>

            {/* Property Panel */}
            {selectedNodeId && (
              <aside className="w-96 bg-white border-l border-gray-200 overflow-y-auto">
                <PropertyPanel
                  nodeId={selectedNodeId}
                  onConfigureComponent={setEditingComponent}
                  onOpenFile={handleOpenFile}
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

          {/* Templates Tab Content */}
          <Tabs.Content value="templates" className="flex-1 overflow-hidden">
            <div className="h-full">
              <TemplateBuilder />
            </div>
          </Tabs.Content>

          {/* Primitives Tab Content */}
          <Tabs.Content value="primitives" className="flex-1 overflow-hidden">
            <div className="h-full">
              <PrimitivesManager
                onNavigateToTemplates={() => setActiveMainTab('templates')}
                onOpenFile={handleOpenFile}
              />
            </div>
          </Tabs.Content>

          {/* Integrations Tab Content */}
          <Tabs.Content value="integrations" className="flex-1 overflow-hidden">
            <div className="h-full">
              <IntegrationCatalog projectId={currentProject.id} />
            </div>
          </Tabs.Content>

          {/* Resources Tab Content */}
          <Tabs.Content value="resources" className="flex-1 overflow-hidden">
            <div className="h-full">
              <ResourcesManager />
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

      {/* Component Config Modal */}
      {(editingComponent || addingComponentType) && (
        <ComponentConfigModal
          component={editingComponent}
          componentType={addingComponentType || undefined}
          onSave={handleSaveComponent}
          onClose={() => {
            setEditingComponent(null);
            setAddingComponentType(null);
          }}
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
    </div>
  );
}

export default App;
