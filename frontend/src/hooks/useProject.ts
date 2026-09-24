import { create } from 'zustand';
import type { Project, GraphNode, GraphEdge, ComponentInstance } from '@/types';
import { projectsApi } from '@/services/api';
import api from '@/services/api';
import { useUnsavedChangesStore } from '@/hooks/useUnsavedChanges';

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

// Module-scoped debounce timer for auto-saving graph changes (positions,
// edges) back to the backend. Positions are UI state that must persist —
// without this, arranging + reloading loses the arrangement.
let _graphSaveTimer: ReturnType<typeof setTimeout> | null = null;
const GRAPH_SAVE_DELAY_MS = 1500;

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
    // Clear currentProject when switching to a different project so
    // the loading placeholder actually shows during the fetch.
    // Otherwise the UI keeps rendering the previous project's data
    // (stale graph, wrong tabs) until the new one lands, which is
    // especially confusing right after a fresh Dagster+ connect.
    const prev = get().currentProject;
    if (!prev || prev.id !== id) {
      set({ currentProject: null, isLoading: true, error: null });
    } else {
      set({ isLoading: true, error: null });
    }
    try {
      const project = await projectsApi.get(id);
      // For Dagster+ projects, the backend hydrates project.graph from a
      // live GraphQL call and swallows failures there (so a bad/slow
      // deployment doesn't 500 the whole project load) -- but that means
      // project.graph can silently be stale/empty with no indication why.
      // Surface the specific reason via the existing `error` banner state
      // instead of just showing an empty graph.
      const cloudError = (project as any).is_dagster_plus && (project as any).dagster_plus_last_error;
      set({
        currentProject: project,
        isLoading: false,
        error: cloudError ? `Couldn't load data from Dagster+: ${cloudError}` : null,
      });
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
    const { currentProject } = get();
    if (!currentProject) return;

    // Update local state immediately.
    const updatedProject = {
      ...currentProject,
      graph: { nodes, edges },
    };
    set({ currentProject: updatedProject });

    // Debounced auto-save to backend so node positions, custom edges, etc.
    // survive reloads. Coalesces rapid consecutive edits (e.g. drag events,
    // arrangeGroups laying out dozens of nodes) into a single PUT. Flagged
    // as unsaved for the duration of the debounce so a quit during that
    // ~1.5s window still trips the "quit anyway?" confirmation instead of
    // silently dropping the pending save.
    if (_graphSaveTimer) clearTimeout(_graphSaveTimer);
    useUnsavedChangesStore.getState().setDirty('graph', true);
    _graphSaveTimer = setTimeout(async () => {
      const latest = get().currentProject;
      if (!latest || latest.id !== updatedProject.id) {
        useUnsavedChangesStore.getState().setDirty('graph', false);
        return;
      }
      try {
        await projectsApi.update(latest.id, { graph: latest.graph });
      } catch (e) {
        console.warn('[useProject] Failed to auto-save graph:', e);
      } finally {
        useUnsavedChangesStore.getState().setDirty('graph', false);
      }
    }, GRAPH_SAVE_DELAY_MS);
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

          // Poll the backend's own asset-generation status instead of
          // guessing from the saved project (node count, whether
          // project.components got populated). That heuristic approach had
          // two failure modes, both confirmed live against a real imported
          // Dagster+dbt project (chicago_bulls_analytics): (1) a real
          // imported project's project.components is NEVER populated by
          // that import path regardless of whether it has assets, so
          // treating "no components" as "no assets coming" declared false
          // success before generation started; (2) even after retrying on
          // that signal, a short grace period isn't enough -- this
          // project's first `dg list defs` has to build a dbt manifest from
          // scratch and took ~30s end to end, so a 5s grace period still
          // gave a false "blank project" verdict mid-generation. Polling an
          // explicit status the backend sets itself
          // (_install_dependencies_and_generate_assets in projects.py)
          // removes the guessing entirely.
          const checkAssets = async (attempts = 0) => {
            try {
              const { data: genStatus } = await api.get(`/projects/${projectId}/asset-generation-status`);

              if (genStatus.status === 'success' || (genStatus.status === 'idle' && attempts >= 2)) {
                // 'idle' on the first couple of attempts can just mean the
                // background task hasn't flipped its status to 'generating'
                // yet (a narrow start-of-flow race) -- give it a couple
                // retries before trusting it as "this project never went
                // through the automatic background flow" (e.g. the backend
                // restarted mid-generation and lost its in-memory status)
                // and falling back to whatever's on disk.
                console.log(`✅ Asset generation ${genStatus.status} (${genStatus.node_count ?? '?'} nodes)`);
                set({ assetGenerationStatus: 'success', assetGenerationError: null });
                get().loadProject(projectId);
                setTimeout(() => {
                  if (get().assetGenerationStatus === 'success') {
                    set({ assetGenerationStatus: 'idle' });
                  }
                }, 3000);
              } else if (genStatus.status === 'error') {
                console.warn('⚠️  Asset generation failed:', genStatus.error);
                set({ assetGenerationStatus: 'error', assetGenerationError: genStatus.error || 'Asset generation failed' });
                get().loadProject(projectId);
              } else if (attempts < 180) {
                // status === 'generating' -- keep polling. 180 attempts at
                // 1/sec matches the backend's own `dg list defs` timeout
                // (180s, see asset_introspection_service.py) -- a lower cap
                // here was tuned against Mac's fast subprocess cold-starts and
                // gave false "timed out" errors on Windows, where uv/dg cold
                // starts (antivirus scanning, no bytecode cache yet) commonly
                // take well past 30s on a fresh project.
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
