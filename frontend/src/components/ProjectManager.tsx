import { useState, useEffect } from 'react';
import { useProjectStore } from '@/hooks/useProject';
import { codegenApi, projectsApi, filesApi, pipelinesApi } from '@/services/api';
import { DbtCloudImportModal } from './DbtCloudImportModal';
import { Launchpad } from './Launchpad';
import {
  FolderOpen,
  Plus,
  Save,
  Download,
  FileCode,
  X,
  Play,
  ChevronDown,
  MoreVertical,
  RefreshCw,
  Trash2,
  CheckCircle,
  FileText,
  GitBranch,
  Cloud,
  Workflow,
} from 'lucide-react';

export function ProjectManager() {
  const {
    currentProject,
    projects,
    loadProjects,
    loadProject,
    createProject,
    importProject,
    saveProject,
  } = useProjectStore();

  const [showNewDialog, setShowNewDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showDbtCloudImportDialog, setShowDbtCloudImportDialog] = useState(false);
  const [showProjectsDialog, setShowProjectsDialog] = useState(false);
  const [showCodePreview, setShowCodePreview] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectGitRepo, setNewProjectGitRepo] = useState('');
  const [newProjectGitBranch, setNewProjectGitBranch] = useState('main');
  const [importPath, setImportPath] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [codePreview, setCodePreview] = useState<Record<string, string>>({});
  const [isCreating, setIsCreating] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isMaterializingAll, setIsMaterializingAll] = useState(false);
  const [materializeAllResult, setMaterializeAllResult] = useState<{ success: boolean; message: string } | null>(null);
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const [showActionsMenu, setShowActionsMenu] = useState(false);
  const [isRegeneratingLineage, setIsRegeneratingLineage] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [isDiscoveringComponents, setIsDiscoveringComponents] = useState(false);
  const [showValidationDialog, setShowValidationDialog] = useState(false);
  const [validationResult, setValidationResult] = useState<any>(null);
  const [showLaunchpad, setShowLaunchpad] = useState(false);
  const [launchpadMode, setLaunchpadMode] = useState<'materialize' | 'job'>('materialize');
  const [selectedJobName, setSelectedJobName] = useState<string>('');
  const [availableJobs, setAvailableJobs] = useState<any[]>([]);
  const [showJobsMenu, setShowJobsMenu] = useState(false);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    // Fetch available jobs when project changes
    if (currentProject) {
      pipelinesApi.list(currentProject.id).then((data) => {
        setAvailableJobs(data.pipelines || []);
      }).catch((error) => {
        console.error('Failed to fetch jobs:', error);
      });
    }
  }, [currentProject]);

  const handleCreateProject = async () => {
    if (!newProjectName.trim()) return;

    try {
      setIsCreating(true);
      await createProject(newProjectName, undefined, newProjectGitRepo || undefined, newProjectGitBranch);
      setNewProjectName('');
      setNewProjectGitRepo('');
      setNewProjectGitBranch('main');
      setSelectedTemplate(null);
      setShowNewDialog(false);
    } catch (error) {
      console.error('Failed to create project:', error);
      alert('Failed to create project. Check the console for details.');
    } finally {
      setIsCreating(false);
    }
  };

  const handleImportProject = async () => {
    if (!importPath.trim()) return;

    try {
      setIsImporting(true);
      await importProject(importPath);
      setImportPath('');
      setShowImportDialog(false);
      alert('Project imported successfully!');
    } catch (error) {
      console.error('Failed to import project:', error);
      alert('Failed to import project. Check the console for details.');
    } finally {
      setIsImporting(false);
    }
  };

  const loadExampleProject = (example: 'jaffle' | 'snowflake_quickstart') => {
    setSelectedTemplate(example);
    if (example === 'jaffle') {
      setNewProjectName('Jaffle Shop');
      setNewProjectGitRepo('https://github.com/dbt-labs/jaffle-shop-classic.git');
      setNewProjectGitBranch('main');
    } else if (example === 'snowflake_quickstart') {
      setNewProjectName('Snowflake Quickstart');
      setNewProjectGitRepo('https://github.com/dbt-labs/dbt-init.git');
      setNewProjectGitBranch('main');
    }
  };

  const handleExport = async () => {
    if (!currentProject) return;

    try {
      const blob = await codegenApi.generate(currentProject.id);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${currentProject.name.replace(/\s+/g, '_')}.zip`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Export failed:', error);
      alert('Failed to export project');
    }
  };

  const handlePreview = async () => {
    if (!currentProject) return;

    try {
      const result = await codegenApi.preview(currentProject.id);
      setCodePreview(result.files);
      setShowCodePreview(true);
    } catch (error) {
      console.error('Preview failed:', error);
      alert('Failed to generate preview');
    }
  };

  const handleMaterializeAll = async () => {
    if (!currentProject) return;

    setIsMaterializingAll(true);
    setMaterializeAllResult(null);

    try {
      // Call materialize without asset_keys to materialize all assets
      const result = await projectsApi.materialize(currentProject.id);

      setMaterializeAllResult({
        success: result.success,
        message: result.message,
      });

      if (result.success) {
        console.log('Materialization output:', result.stdout);
        alert('All assets materialized successfully!');
      } else {
        console.error('Materialization failed:', result.stderr);
        alert('Materialization failed. Check console for details.');
      }
    } catch (error) {
      console.error('Materialize all failed:', error);
      setMaterializeAllResult({
        success: false,
        message: 'Failed to materialize assets. Check console for details.',
      });
      alert('Failed to materialize assets. Check console for details.');
    } finally {
      setIsMaterializingAll(false);
    }
  };

  const handleLaunchpadSubmit = async (config?: Record<string, any>, tags?: Record<string, string>) => {
    if (!currentProject) return;

    setIsMaterializingAll(true);
    setMaterializeAllResult(null);

    try {
      if (launchpadMode === 'materialize') {
        const result = await projectsApi.materialize(currentProject.id, undefined, config, tags);

        setMaterializeAllResult({
          success: result.success,
          message: result.message,
        });

        if (result.success) {
          console.log('Materialization output:', result.stdout);
          alert('Assets materialized successfully!');
        } else {
          console.error('Materialization failed:', result.stderr);
          alert('Materialization failed. Check console for details.');
        }
      } else if (launchpadMode === 'job') {
        const result = await pipelinesApi.launch(currentProject.id, selectedJobName, config, tags);

        if (result.success) {
          console.log('Job launch output:', result.stdout);
          alert('Job launched successfully!');
        } else {
          console.error('Job launch failed:', result.stderr);
          alert('Job launch failed. Check console for details.');
        }
      }
    } catch (error) {
      console.error('Launch failed:', error);
      setMaterializeAllResult({
        success: false,
        message: 'Failed to launch. Check console for details.',
      });
      throw error; // Re-throw so Launchpad can handle the error
    } finally {
      setIsMaterializingAll(false);
    }
  };

  const handleRegenerateLineage = async () => {
    if (!currentProject) return;

    setIsRegeneratingLineage(true);

    // Update asset generation status in store to show banner
    const projectStore = useProjectStore.getState();
    projectStore.assetGenerationStatus = 'generating';
    projectStore.assetGenerationError = null;

    try {
      // Regenerate with layout recalculation to keep the graph beautiful
      await projectsApi.regenerateAssets(currentProject.id, true);

      // Update status to success immediately after API call completes
      projectStore.assetGenerationStatus = 'success';
      projectStore.assetGenerationError = null;

      // Reload project to get updated graph (with timeout protection)
      const loadPromise = loadProject(currentProject.id);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Load timeout')), 30000)
      );

      await Promise.race([loadPromise, timeoutPromise]).catch((error) => {
        console.error('Failed to reload project after regeneration:', error);
        // Don't fail the whole operation if reload fails - regeneration was successful
      });

      // Auto-dismiss success banner after 3 seconds
      setTimeout(() => {
        const currentStatus = useProjectStore.getState().assetGenerationStatus;
        if (currentStatus === 'success') {
          useProjectStore.getState().dismissAssetGenerationStatus();
        }
      }, 3000);
    } catch (error: any) {
      console.error('Failed to regenerate lineage:', error);
      const errorMessage = error?.response?.data?.detail || error?.message || 'Unknown error';

      // Update status to error
      projectStore.assetGenerationStatus = 'error';
      projectStore.assetGenerationError = errorMessage;

      // Auto-dismiss error banner after 5 seconds
      setTimeout(() => {
        const currentStatus = useProjectStore.getState().assetGenerationStatus;
        if (currentStatus === 'error') {
          useProjectStore.getState().dismissAssetGenerationStatus();
        }
      }, 5000);
    } finally {
      setIsRegeneratingLineage(false);
    }
  };

  const handleDiscoverComponents = async () => {
    if (!currentProject) return;

    setIsDiscoveringComponents(true);

    try {
      const updatedProject = await projectsApi.discoverComponents(currentProject.id);

      // Reload project to get updated components
      await loadProject(currentProject.id);

      alert(`Components discovered successfully! Found ${updatedProject.components.length} component(s).`);
    } catch (error) {
      console.error('Failed to discover components:', error);
      alert('Failed to discover components. Check console for details.');
    } finally {
      setIsDiscoveringComponents(false);
    }
  };

  const handleValidateProject = async () => {
    if (!currentProject) return;

    setIsValidating(true);

    // Update validation status in store to show banner
    const projectStore = useProjectStore.getState();
    projectStore.validationStatus = 'validating';
    projectStore.validationError = null;

    try {
      const result = await projectsApi.validate(currentProject.id);
      setValidationResult(result);
      setShowValidationDialog(true);

      // Update status based on validation result
      if (result.valid) {
        projectStore.validationStatus = 'success';
        projectStore.validationError = null;
        // Auto-dismiss success banner after 3 seconds
        setTimeout(() => {
          const currentStatus = useProjectStore.getState().validationStatus;
          if (currentStatus === 'success') {
            useProjectStore.getState().dismissValidationStatus();
          }
        }, 3000);
      } else {
        projectStore.validationStatus = 'error';
        projectStore.validationError = result.error || 'Validation failed';
      }
    } catch (error: any) {
      console.error('Failed to validate project:', error);
      const errorMessage = error?.response?.data?.detail || error?.message || 'Failed to validate project';
      projectStore.validationStatus = 'error';
      projectStore.validationError = errorMessage;
    } finally {
      setIsValidating(false);
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
    <>
      <div className="flex items-center space-x-2">
        {/* Project Menu */}
        <div className="relative">
          <button
            onClick={() => setShowProjectMenu(!showProjectMenu)}
            className="flex items-center space-x-1 px-3 py-1.5 text-sm bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50"
          >
            <FolderOpen className="w-4 h-4" />
            <span>Project</span>
            <ChevronDown className="w-3 h-3" />
          </button>

          {showProjectMenu && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setShowProjectMenu(false)}
              />
              <div className="absolute right-0 mt-1 w-56 bg-white border border-gray-200 rounded-md shadow-lg z-20">
                <button
                  onClick={() => {
                    setShowNewDialog(true);
                    setShowProjectMenu(false);
                  }}
                  className="w-full flex items-center space-x-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <Plus className="w-4 h-4" />
                  <span>New Project</span>
                </button>
                <button
                  onClick={() => {
                    setShowImportDialog(true);
                    setShowProjectMenu(false);
                  }}
                  className="w-full flex items-center space-x-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <Download className="w-4 h-4" />
                  <span>Import Project</span>
                </button>
                <button
                  onClick={() => {
                    setShowDbtCloudImportDialog(true);
                    setShowProjectMenu(false);
                  }}
                  className="w-full flex items-center space-x-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <Cloud className="w-4 h-4" />
                  <span>Import from dbt Cloud</span>
                </button>
                <button
                  onClick={() => {
                    setShowProjectsDialog(true);
                    setShowProjectMenu(false);
                  }}
                  className="w-full flex items-center space-x-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <FolderOpen className="w-4 h-4" />
                  <span>Open Project</span>
                </button>
                {currentProject && (
                  <>
                    <div className="border-t border-gray-200 my-1" />
                    <button
                      onClick={() => {
                        saveProject();
                        setShowProjectMenu(false);
                      }}
                      className="w-full flex items-center space-x-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                    >
                      <Save className="w-4 h-4" />
                      <span>Save</span>
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {/* Actions Menu (only shown when project is open) */}
        {currentProject && (
          <div className="relative">
            <button
              onClick={() => setShowActionsMenu(!showActionsMenu)}
              className="flex items-center space-x-1 px-3 py-1.5 text-sm bg-white border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50"
            >
              <MoreVertical className="w-4 h-4" />
              <span>Actions</span>
              <ChevronDown className="w-3 h-3" />
            </button>

            {showActionsMenu && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setShowActionsMenu(false)}
                />
                <div className="absolute right-0 mt-1 w-56 bg-white border border-gray-200 rounded-md shadow-lg z-20">
                  <button
                    onClick={() => {
                      handleMaterializeAll();
                      setShowActionsMenu(false);
                    }}
                    disabled={isMaterializingAll}
                    className="w-full flex items-center space-x-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Play className="w-4 h-4" />
                    <span>{isMaterializingAll ? 'Materializing...' : 'Materialize All Assets'}</span>
                  </button>
                  <button
                    onClick={() => {
                      setLaunchpadMode('materialize');
                      setShowLaunchpad(true);
                      setShowActionsMenu(false);
                    }}
                    className="w-full flex items-center space-x-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <FileCode className="w-4 h-4" />
                    <span>Open Launchpad (Assets)</span>
                  </button>
                  <div className="relative">
                    <button
                      onClick={() => setShowJobsMenu(!showJobsMenu)}
                      className="w-full flex items-center justify-between px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 border-b border-gray-200"
                    >
                      <div className="flex items-center space-x-2">
                        <Play className="w-4 h-4" />
                        <span>Launch Job</span>
                      </div>
                      <ChevronDown className="w-3 h-3" />
                    </button>
                    {showJobsMenu && (
                      <div className="absolute left-full top-0 ml-1 w-56 bg-white border border-gray-200 rounded-md shadow-lg z-30">
                        {availableJobs.length === 0 ? (
                          <div className="px-4 py-2 text-sm text-gray-500">No jobs found</div>
                        ) : (
                          availableJobs.map((job) => (
                            <button
                              key={job.id}
                              onClick={() => {
                                setSelectedJobName(job.name);
                                setLaunchpadMode('job');
                                setShowLaunchpad(true);
                                setShowJobsMenu(false);
                                setShowActionsMenu(false);
                              }}
                              className="w-full flex items-center space-x-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                            >
                              <Workflow className="w-4 h-4" />
                              <span>{job.name}</span>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => {
                      handleRegenerateLineage();
                      setShowActionsMenu(false);
                    }}
                    disabled={isRegeneratingLineage}
                    className="w-full flex items-center space-x-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <RefreshCw className="w-4 h-4" />
                    <span>{isRegeneratingLineage ? 'Regenerating...' : 'Regenerate Lineage'}</span>
                  </button>
                  <button
                    onClick={() => {
                      handleDiscoverComponents();
                      setShowActionsMenu(false);
                    }}
                    disabled={isDiscoveringComponents}
                    className="w-full flex items-center space-x-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Download className="w-4 h-4" />
                    <span>{isDiscoveringComponents ? 'Discovering...' : 'Discover Components'}</span>
                  </button>
                  <button
                    onClick={() => {
                      handleValidateProject();
                      setShowActionsMenu(false);
                    }}
                    disabled={isValidating}
                    className="w-full flex items-center space-x-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <CheckCircle className="w-4 h-4" />
                    <span>{isValidating ? 'Validating...' : 'Validate Project'}</span>
                  </button>
                  <button
                    onClick={() => {
                      handleScaffoldBuildArtifacts();
                      setShowActionsMenu(false);
                    }}
                    className="w-full flex items-center space-x-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <FileText className="w-4 h-4" />
                    <span>Generate Dockerfile</span>
                  </button>
                  <button
                    onClick={() => {
                      handleScaffoldGithubActions();
                      setShowActionsMenu(false);
                    }}
                    className="w-full flex items-center space-x-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <GitBranch className="w-4 h-4" />
                    <span>Generate GitHub Actions</span>
                  </button>
                  <div className="border-t border-gray-200 my-1" />
                  <button
                    onClick={() => {
                      handlePreview();
                      setShowActionsMenu(false);
                    }}
                    className="w-full flex items-center space-x-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <FileCode className="w-4 h-4" />
                    <span>Preview Code</span>
                  </button>
                  <button
                    onClick={() => {
                      handleExport();
                      setShowActionsMenu(false);
                    }}
                    className="w-full flex items-center space-x-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <Download className="w-4 h-4" />
                    <span>Export Project</span>
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* New Project Dialog */}
      {showNewDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6 relative">
            {/* Loading Overlay */}
            {isCreating && (
              <div className="absolute inset-0 bg-white bg-opacity-90 rounded-lg flex flex-col items-center justify-center z-10">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
                <p className="text-gray-700 font-medium">Creating project...</p>
                <p className="text-sm text-gray-500 mt-2 text-center px-4">
                  Scaffolding project structure and<br />
                  installing dependencies
                </p>
                <p className="text-xs text-gray-400 mt-1">This usually takes 10-30 seconds</p>
                <p className="text-xs text-blue-600 mt-2">Assets will be generated in the background after creation</p>
              </div>
            )}

            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">New Project</h2>
              <button
                onClick={() => {
                  setShowNewDialog(false);
                  setSelectedTemplate(null);
                }}
                disabled={isCreating}
              >
                <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Project Name
                </label>
                <input
                  type="text"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleCreateProject()}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="My Dagster Pipeline"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Git Repository (Optional)
                </label>
                <input
                  type="text"
                  value={newProjectGitRepo}
                  onChange={(e) => setNewProjectGitRepo(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="https://github.com/user/repo.git"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Import an existing dbt project or other code from a git repository
                </p>
              </div>

              {newProjectGitRepo && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Git Branch
                  </label>
                  <input
                    type="text"
                    value={newProjectGitBranch}
                    onChange={(e) => setNewProjectGitBranch(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="main"
                  />
                </div>
              )}

              <div className="border-t pt-4">
                <p className="text-sm font-medium text-gray-700 mb-2">Quick Start Templates</p>
                <div className="space-y-2">
                  <button
                    onClick={() => loadExampleProject('jaffle')}
                    className={`w-full text-left px-3 py-2 text-sm border rounded-md transition-all ${
                      selectedTemplate === 'jaffle'
                        ? 'border-blue-600 bg-blue-50 ring-2 ring-blue-200'
                        : 'border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    <div className={`font-medium ${selectedTemplate === 'jaffle' ? 'text-blue-900' : ''}`}>
                      Jaffle Shop
                    </div>
                    <div className={`text-xs ${selectedTemplate === 'jaffle' ? 'text-blue-700' : 'text-gray-600'}`}>
                      Classic dbt example project
                    </div>
                  </button>
                  <button
                    onClick={() => loadExampleProject('snowflake_quickstart')}
                    className={`w-full text-left px-3 py-2 text-sm border rounded-md transition-all ${
                      selectedTemplate === 'snowflake_quickstart'
                        ? 'border-blue-600 bg-blue-50 ring-2 ring-blue-200'
                        : 'border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    <div className={`font-medium ${selectedTemplate === 'snowflake_quickstart' ? 'text-blue-900' : ''}`}>
                      Snowflake Quickstart
                    </div>
                    <div className={`text-xs ${selectedTemplate === 'snowflake_quickstart' ? 'text-blue-700' : 'text-gray-600'}`}>
                      dbt project template for Snowflake
                    </div>
                  </button>
                </div>
              </div>

              <div className="flex justify-end space-x-2">
                <button
                  onClick={() => {
                    setShowNewDialog(false);
                    setSelectedTemplate(null);
                  }}
                  disabled={isCreating}
                  className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateProject}
                  disabled={isCreating}
                  className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Create
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Import Project Dialog */}
      {showImportDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Import Project</h2>
              <button
                onClick={() => setShowImportDialog(false)}
                disabled={isImporting}
              >
                <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Project Path
                </label>
                <input
                  type="text"
                  value={importPath}
                  onChange={(e) => setImportPath(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleImportProject()}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="/path/to/dagster/project"
                  autoFocus
                />
                <p className="text-xs text-gray-500 mt-1">
                  Enter the absolute path to an existing Dagster project directory
                </p>
              </div>

              <div className="flex justify-end space-x-2">
                <button
                  onClick={() => setShowImportDialog(false)}
                  disabled={isImporting}
                  className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Cancel
                </button>
                <button
                  onClick={handleImportProject}
                  disabled={isImporting || !importPath.trim()}
                  className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isImporting ? 'Importing...' : 'Import'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Open Project Dialog */}
      {showProjectsDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Open Project</h2>
              <button onClick={() => setShowProjectsDialog(false)}>
                <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
              </button>
            </div>

            <div className="space-y-2 max-h-96 overflow-y-auto">
              {projects.length === 0 && (
                <p className="text-center text-gray-500 py-8">No projects yet</p>
              )}

              {projects.map((project) => (
                <div
                  key={project.id}
                  className="flex items-center gap-2 p-4 border border-gray-200 rounded-lg hover:border-blue-300 group"
                >
                  <button
                    onClick={() => {
                      loadProject(project.id);
                      setShowProjectsDialog(false);
                    }}
                    className="flex-1 text-left"
                  >
                    <div className="font-medium text-gray-900">{project.name}</div>
                    {project.description && (
                      <div className="text-sm text-gray-600 mt-1">
                        {project.description}
                      </div>
                    )}
                    <div className="text-xs text-gray-400 mt-2">
                      Updated: {new Date(project.updated_at).toLocaleDateString()}
                    </div>
                  </button>
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      const confirmed = window.confirm(
                        `Are you sure you want to delete "${project.name}"? This will remove the project and all its files.`
                      );
                      if (!confirmed) return;

                      try {
                        await projectsApi.delete(project.id);
                        await loadProjects();
                        if (currentProject?.id === project.id) {
                          // If we deleted the current project, clear it
                          window.location.reload();
                        }
                      } catch (error) {
                        console.error('Failed to delete project:', error);
                        alert('Failed to delete project. Check console for details.');
                      }
                    }}
                    className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors opacity-0 group-hover:opacity-100"
                    title="Delete project"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Code Preview Dialog */}
      {showCodePreview && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl h-3/4 flex flex-col">
            <div className="flex items-center justify-between p-6 border-b">
              <h2 className="text-lg font-semibold">Generated Code Preview</h2>
              <button onClick={() => setShowCodePreview(false)}>
                <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {Object.entries(codePreview).map(([path, content]) => (
                <div key={path} className="mb-6">
                  <div className="text-sm font-medium text-gray-700 mb-2 font-mono">
                    {path}
                  </div>
                  <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-sm">
                    {content}
                  </pre>
                </div>
              ))}
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
                {validationResult.valid ? '✅ Validation Successful' : '❌ Validation Failed'}
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
                    <p className="text-sm text-yellow-800">
                      <strong>Tip:</strong> Validation errors usually mean:
                    </p>
                    <ul className="text-sm text-yellow-800 list-disc list-inside mt-2 space-y-1">
                      <li>Component definitions are missing required fields</li>
                      <li>Invalid YAML syntax in component files</li>
                      <li>Missing dependencies or incorrect component types</li>
                    </ul>
                    <p className="text-sm text-yellow-800 mt-2">
                      Try fixing the component configurations or use "Regenerate Lineage" to rebuild from valid components.
                    </p>
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

      {/* dbt Cloud Import Modal */}
      <DbtCloudImportModal
        isOpen={showDbtCloudImportDialog}
        onClose={() => setShowDbtCloudImportDialog(false)}
        onSuccess={(projectId) => {
          // Load the newly created project
          loadProject(projectId);
          setShowDbtCloudImportDialog(false);
        }}
      />

      {/* Launchpad */}
      {currentProject && (
        <Launchpad
          open={showLaunchpad}
          onOpenChange={setShowLaunchpad}
          projectId={currentProject.id}
          mode={launchpadMode}
          assetKeys={launchpadMode === 'materialize'
            ? currentProject.graph.nodes
                .filter(node => node.node_kind === 'asset')
                .map(node => node.data.asset_key || node.id)
            : []}
          jobName={launchpadMode === 'job' ? selectedJobName : undefined}
          onLaunch={handleLaunchpadSubmit}
          defaultConfig={{}}
          configSchema={{}}
        />
      )}
    </>
  );
}
