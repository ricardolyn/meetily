'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { projectsService } from '@/services/projectsService';
import type { Project } from '@/types';

interface ProjectsContextValue {
  projects: Project[];
  isLoading: boolean;
  error: string | null;
  /** The project the user has selected for the next recording (null = no project). */
  selectedProject: Project | null;
  setSelectedProject: (p: Project | null) => void;
  refreshProjects: () => Promise<void>;
}

const ProjectsContext = createContext<ProjectsContextValue | null>(null);

export function useProjects(): ProjectsContextValue {
  const ctx = useContext(ProjectsContext);
  if (!ctx) {
    throw new Error('useProjects must be used within a ProjectsProvider');
  }
  return ctx;
}

export function ProjectsProvider({ children }: { children: React.ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);

  const refreshProjects = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const list = await projectsService.list();
      setProjects(list);
      // If the currently selected project no longer exists, clear it.
      setSelectedProject(prev => (prev && !list.some(p => p.id === prev.id) ? null : prev));
      // Tray "Start Recording" submenu is built from the project list, so
      // keep it in sync after any CRUD operation.
      try {
        await invoke('refresh_tray_menu');
      } catch (trayErr) {
        // Non-fatal — tray will be stale until next state change but the UI works.
        console.warn('Failed to refresh tray menu:', trayErr);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('Failed to load projects:', msg);
      setError(msg);
      setProjects([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshProjects();
  }, [refreshProjects]);

  const value = useMemo<ProjectsContextValue>(() => ({
    projects,
    isLoading,
    error,
    selectedProject,
    setSelectedProject,
    refreshProjects,
  }), [projects, isLoading, error, selectedProject, refreshProjects]);

  return <ProjectsContext.Provider value={value}>{children}</ProjectsContext.Provider>;
}
