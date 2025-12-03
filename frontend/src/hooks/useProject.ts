import { create } from 'zustand';
import type { Project, GraphNode, GraphEdge, ComponentInstance } from '@/types';
import { projectsApi } from '@/services/api';
import api from '@/services/api';

interface ProjectStore {
  currentProject: Project | null;
  projects: Project[];
  isLoading: boolean;
  error: string | null;
  assetGenerationStatus: 'idle' | 'generating' | 'success' | 'error';
  assetGenerationError: string | null;
  validationStatus: 'idle' | 'validating' | 'success' | 'error';
  validationError: string | null;
  dependencyInstallStatus: 'idle' | 'installing' | 'success' | 'error';
  dependencyInstallError: string | null;
  dependencyInstallOutput: string;

  // Actions
  loadProject: (id: string) => Promise<void>;
  loadProjects: () => Promise<void>;
  createProject: (name: string, description?: string, gitRepo?: string, gitBranch?: string) => Promise<Project>;
  importProject: (path: string) => Promise<Project>;
  updateGraph: (nodes: GraphNode[], edges: GraphEdge[]) => Promise<void>;
  updateComponents: (components: ComponentInstance[]) => Promise<void>;
  setCurrentProject: (project: Project) => void;
  saveProject: () => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  dismissAssetGenerationStatus: () => void;
  dismissValidationStatus: () => void;
  dismissDependencyInstallStatus: () => void;
  pollDependencyStatus: (projectId: string) => Promise<void>;
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  currentProject: null,
  projects: [],
  isLoading: false,
  error: null,
  assetGenerationStatus: 'idle',
  assetGenerationError: null,
  validationStatus: 'idle',
  validationError: null,
  dependencyInstallStatus: 'idle',
  dependencyInstallError: null,
  dependencyInstallOutput: '',

  loadProject: async (id: string) => {
    set({ isLoading: true, error: null });
    try {
      const project = await projectsApi.get(id);
      set({ currentProject: project, isLoading: false });
    } catch (error) {
      set({ error: 'Failed to load project', isLoading: false });
    }
  },

  loadProjects: async () => {
    set({ isLoading: true, error: null });
    try {
      const data = await projectsApi.list();
      set({ projects: data.projects, isLoading: false });
    } catch (error) {
      set({ error: 'Failed to load projects', isLoading: false });
    }
  },

  createProject: async (name: string, description?: string, gitRepo?: string, gitBranch?: string) => {
    set({ isLoading: true, error: null });
    try {
      // Create project (returns immediately, but dependencies and assets generate in background)
      const project = await projectsApi.create({
        name,
        description,
        git_repo: gitRepo,
        git_branch: gitBranch || 'main',
      });

      // Set as current project and navigate (canvas will show loading state)
      set({
        currentProject: project,
        projects: [project, ...get().projects],
        isLoading: false,
      });

      // Start polling for dependency installation status
      // Backend will install dependencies and generate assets automatically
      console.log('🔄 Starting dependency and asset generation...');
      set({ dependencyInstallStatus: 'installing', dependencyInstallError: null });
      get().pollDependencyStatus(project.id);

      return project;
    } catch (error) {
      set({ error: 'Failed to create project', isLoading: false });
      throw error;
    }
  },

  importProject: async (path: string) => {
    set({ isLoading: true, error: null });
    try {
      // Import project (returns immediately without asset generation)
      const project = await projectsApi.import(path);
      set({
        currentProject: project,
        projects: [project, ...get().projects],
        isLoading: false,
      });

      // Trigger asset generation in the background (non-blocking)
      console.log('🔄 Triggering asset generation in background...');
      set({ assetGenerationStatus: 'generating', assetGenerationError: null });

      projectsApi.regenerateAssets(project.id, true).then(() => {
        console.log('✅ Assets generated successfully');
        set({ assetGenerationStatus: 'success', assetGenerationError: null });
        // Reload the project to get the updated graph with assets
        get().loadProject(project.id);
        // Auto-dismiss success message after 3 seconds
        setTimeout(() => {
          if (get().assetGenerationStatus === 'success') {
            set({ assetGenerationStatus: 'idle' });
          }
        }, 3000);
      }).catch(error => {
        console.error('⚠️  Asset generation failed:', error);
        const errorMessage = error?.response?.data?.detail || error?.message || 'Unknown error';
        set({
          assetGenerationStatus: 'error',
          assetGenerationError: errorMessage
        });
        // Don't throw - project was imported successfully, just assets failed to generate
      });

      return project;
    } catch (error) {
      set({ error: 'Failed to import project', isLoading: false });
      throw error;
    }
  },

  updateGraph: async (nodes: GraphNode[], edges: GraphEdge[]) => {
    console.log('[useProject] updateGraph called with', nodes.length, 'nodes');
    const { currentProject } = get();
    if (!currentProject) {
      console.log('[useProject] No current project, skipping update');
      return;
    }

    // Only update local state - save will be triggered manually via Save button
    const updatedProject = {
      ...currentProject,
      graph: { nodes, edges },
    };

    console.log('[useProject] Updating project state');
    set({ currentProject: updatedProject });
  },

  updateComponents: async (components: ComponentInstance[]) => {
    console.log('[useProject] updateComponents called with', components.length, 'components');
    const { currentProject } = get();
    if (!currentProject) {
      console.log('[useProject] No current project, skipping update');
      return;
    }

    // Update local state and save to backend
    const updatedProject = {
      ...currentProject,
      components,
    };

    set({ currentProject: updatedProject });

    // Save to backend
    try {
      await projectsApi.update(currentProject.id, {
        components,
      });
      console.log('[useProject] Components saved to backend');
    } catch (error) {
      console.error('[useProject] Failed to save components:', error);
      set({ error: 'Failed to save components' });
    }
  },

  setCurrentProject: (project: Project) => {
    console.log('[useProject] setCurrentProject called');
    set({ currentProject: project });
  },

  saveProject: async () => {
    const { currentProject } = get();
    if (!currentProject) return;

    set({ isLoading: true, error: null });
    try {
      await projectsApi.update(currentProject.id, {
        graph: currentProject.graph,
      });
      set({ isLoading: false });
    } catch (error) {
      set({ error: 'Failed to save project', isLoading: false });
    }
  },

  deleteProject: async (id: string) => {
    set({ isLoading: true, error: null });
    try {
      await projectsApi.delete(id);
      set({
        projects: get().projects.filter((p) => p.id !== id),
        currentProject: get().currentProject?.id === id ? null : get().currentProject,
        isLoading: false,
      });
    } catch (error) {
      set({ error: 'Failed to delete project', isLoading: false });
    }
  },

  dismissAssetGenerationStatus: () => {
    set({ assetGenerationStatus: 'idle', assetGenerationError: null });
  },

  dismissValidationStatus: () => {
    set({ validationStatus: 'idle', validationError: null });
  },

  dismissDependencyInstallStatus: () => {
    set({ dependencyInstallStatus: 'idle', dependencyInstallError: null });
  },

  pollDependencyStatus: async (projectId: string) => {
    // Poll dependency status until it's done (success or error)
    const poll = async () => {
      try {
        const response = await api.get(`/projects/${projectId}/dependency-status`);
        const { status, error, output } = response.data;

        set({
          dependencyInstallStatus: status,
          dependencyInstallError: error,
          dependencyInstallOutput: output || ''
        });

        if (status === 'installing') {
          // Continue polling every 2 seconds
          setTimeout(poll, 2000);
        } else if (status === 'success') {
          // Dependencies installed! Backend is automatically generating assets
          console.log('✅ Dependencies installed, waiting for automatic asset generation...');

          // Auto-dismiss dependency success after 2 seconds
          setTimeout(() => {
            if (get().dependencyInstallStatus === 'success') {
              set({ dependencyInstallStatus: 'idle' });
            }
          }, 2000);

          // Poll for assets to be ready (backend generates them automatically)
          set({ assetGenerationStatus: 'generating', assetGenerationError: null });

          const checkAssets = async (attempts = 0) => {
            try {
              const project = await projectsApi.get(projectId);
              const hasAssets = project.graph?.nodes && project.graph.nodes.length > 0;
              const hasComponents = project.components && project.components.length > 0;

              if (hasAssets) {
                console.log('✅ Assets generated successfully');
                set({ assetGenerationStatus: 'success', assetGenerationError: null });
                get().loadProject(projectId);
                setTimeout(() => {
                  if (get().assetGenerationStatus === 'success') {
                    set({ assetGenerationStatus: 'idle' });
                  }
                }, 3000);
              } else if (!hasComponents) {
                // Blank project with no components - no assets expected, this is success
                console.log('✅ Blank project ready (no components, no assets)');
                set({ assetGenerationStatus: 'success', assetGenerationError: null });
                get().loadProject(projectId);
                setTimeout(() => {
                  if (get().assetGenerationStatus === 'success') {
                    set({ assetGenerationStatus: 'idle' });
                  }
                }, 2000);
              } else if (attempts < 30) {
                // Has components but no assets yet - keep trying
                setTimeout(() => checkAssets(attempts + 1), 1000);
              } else {
                console.warn('⚠️  Asset generation timed out');
                set({
                  assetGenerationStatus: 'error',
                  assetGenerationError: 'Asset generation timed out'
                });
                // Still load the project even if no assets
                get().loadProject(projectId);
              }
            } catch (error) {
              console.error('⚠️  Failed to check for assets:', error);
              // Still load the project even on error
              get().loadProject(projectId);
            }
          };

          checkAssets();
        }
      } catch (error) {
        console.error('Failed to poll dependency status:', error);
        // Don't set error state, just stop polling
      }
    };

    await poll();
  },
}));
