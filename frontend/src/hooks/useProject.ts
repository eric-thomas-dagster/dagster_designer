import { create } from 'zustand';
import type { Project, GraphNode, GraphEdge, ComponentInstance } from '@/types';
import { projectsApi } from '@/services/api';

interface ProjectStore {
  currentProject: Project | null;
  projects: Project[];
  isLoading: boolean;
  error: string | null;

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
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  currentProject: null,
  projects: [],
  isLoading: false,
  error: null,

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
      const project = await projectsApi.create({
        name,
        description,
        git_repo: gitRepo,
        git_branch: gitBranch || 'main',
      });
      set({
        currentProject: project,
        projects: [project, ...get().projects],
        isLoading: false,
      });
      return project;
    } catch (error) {
      set({ error: 'Failed to create project', isLoading: false });
      throw error;
    }
  },

  importProject: async (path: string) => {
    set({ isLoading: true, error: null });
    try {
      const project = await projectsApi.import(path);
      set({
        currentProject: project,
        projects: [project, ...get().projects],
        isLoading: false,
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

    // Only update local state - don't save to backend on every change
    // User can manually save with saveProject() when ready
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
}));
