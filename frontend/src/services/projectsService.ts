/**
 * Projects Service
 *
 * Thin wrapper around the Tauri `api_*_project*` commands that read/write the
 * local SQLite database. Each method maps 1:1 to a Tauri command.
 */

import { invoke } from '@tauri-apps/api/core';
import type { Project } from '@/types';

export interface CreateProjectInput {
  name: string;
  folder_path: string;
}

export interface UpdateProjectInput {
  name?: string;
  folder_path?: string;
}

export const projectsService = {
  list(): Promise<Project[]> {
    return invoke<Project[]>('api_get_projects');
  },

  get(projectId: string): Promise<Project | null> {
    return invoke<Project | null>('api_get_project', { projectId });
  },

  create(input: CreateProjectInput): Promise<Project> {
    // `request` matches the Rust `request: CreateProjectRequest` argument name.
    // Inner fields stay snake_case because they're deserialized by serde, not
    // by Tauri's command-arg name resolver.
    return invoke<Project>('api_create_project', { request: input });
  },

  update(projectId: string, input: UpdateProjectInput): Promise<Project> {
    return invoke<Project>('api_update_project', {
      projectId,
      request: input,
    });
  },

  delete(projectId: string): Promise<{ status: string }> {
    return invoke<{ status: string }>('api_delete_project', { projectId });
  },

  assignMeeting(meetingId: string, projectId: string | null): Promise<{ status: string }> {
    return invoke<{ status: string }>('api_assign_meeting_to_project', {
      request: {
        meeting_id: meetingId,
        project_id: projectId,
      },
    });
  },

  /** Opens a native directory picker. Returns the chosen path or null if cancelled. */
  pickFolder(): Promise<string | null> {
    return invoke<string | null>('pick_project_folder');
  },
};
