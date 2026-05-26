'use client';

import { FormEvent, useEffect, useState } from 'react';
import { FolderOpen, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useProjects } from '@/contexts/ProjectsContext';
import { projectsService } from '@/services/projectsService';
import type { Project } from '@/types';

interface ProjectFormState {
  name: string;
  folderPath: string;
}

const emptyForm: ProjectFormState = { name: '', folderPath: '' };

export function ProjectsSettings() {
  const { projects, refreshProjects, isLoading } = useProjects();

  const [createForm, setCreateForm] = useState<ProjectFormState>(emptyForm);
  const [isCreating, setIsCreating] = useState(false);

  const [editing, setEditing] = useState<Project | null>(null);
  const [editForm, setEditForm] = useState<ProjectFormState>(emptyForm);

  const [deleting, setDeleting] = useState<Project | null>(null);

  useEffect(() => {
    if (editing) {
      setEditForm({ name: editing.name, folderPath: editing.folder_path });
    }
  }, [editing]);

  async function pickFolder(target: 'create' | 'edit') {
    try {
      const path = await projectsService.pickFolder();
      if (!path) return;
      if (target === 'create') {
        setCreateForm(prev => ({ ...prev, folderPath: path }));
      } else {
        setEditForm(prev => ({ ...prev, folderPath: path }));
      }
    } catch (e) {
      toast.error('Could not open folder picker', {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (!createForm.name.trim() || !createForm.folderPath.trim()) {
      toast.error('Project name and folder are both required');
      return;
    }
    setIsCreating(true);
    try {
      await projectsService.create({
        name: createForm.name.trim(),
        folder_path: createForm.folderPath.trim(),
      });
      setCreateForm(emptyForm);
      await refreshProjects();
      toast.success('Project created');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create project');
    } finally {
      setIsCreating(false);
    }
  }

  async function handleEditSave() {
    if (!editing) return;
    const name = editForm.name.trim();
    const folderPath = editForm.folderPath.trim();
    if (!name || !folderPath) {
      toast.error('Project name and folder are both required');
      return;
    }
    try {
      await projectsService.update(editing.id, { name, folder_path: folderPath });
      await refreshProjects();
      toast.success('Project updated');
      setEditing(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update project');
    }
  }

  async function handleDeleteConfirm() {
    if (!deleting) return;
    try {
      await projectsService.delete(deleting.id);
      await refreshProjects();
      toast.success(`Project "${deleting.name}" deleted`);
      setDeleting(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete project');
    }
  }

  return (
    <div className="space-y-8 py-6">
      <section>
        <h2 className="text-xl font-semibold mb-1">Projects</h2>
        <p className="text-sm text-gray-600">
          Organize meetings by project. Each project points to a folder on disk where its
          recordings, transcripts and summaries are saved.
        </p>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h3 className="text-sm font-semibold mb-3">New project</h3>
        <form className="space-y-4" onSubmit={handleCreate}>
          <div className="space-y-1.5">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              placeholder="e.g. Acme Inc."
              value={createForm.name}
              onChange={event => setCreateForm(prev => ({ ...prev, name: event.target.value }))}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-folder">Folder</Label>
            <div className="flex gap-2">
              <Input
                id="project-folder"
                placeholder="/Users/you/Documents/AcmeMeetings"
                value={createForm.folderPath}
                onChange={event =>
                  setCreateForm(prev => ({ ...prev, folderPath: event.target.value }))
                }
                required
              />
              <Button type="button" variant="outline" onClick={() => pickFolder('create')}>
                <FolderOpen className="w-4 h-4 mr-1.5" />
                Browse…
              </Button>
            </div>
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={isCreating}>
              <Plus className="w-4 h-4 mr-1.5" />
              {isCreating ? 'Creating…' : 'Create project'}
            </Button>
          </div>
        </form>
      </section>

      <section>
        <h3 className="text-sm font-semibold mb-3">Existing projects</h3>
        {isLoading && projects.length === 0 ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : projects.length === 0 ? (
          <p className="text-sm text-gray-500">
            No projects yet. Create one above to start grouping meetings.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border border-gray-200 bg-white">
            {projects.map(project => (
              <li key={project.id} className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <div className="font-medium truncate">{project.name}</div>
                  <div className="text-xs text-gray-500 truncate" title={project.folder_path}>
                    {project.folder_path}
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    {project.meeting_count} meeting{project.meeting_count === 1 ? '' : 's'}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button variant="outline" size="sm" onClick={() => setEditing(project)}>
                    <Pencil className="w-3.5 h-3.5 mr-1.5" />
                    Edit
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setDeleting(project)}>
                    <Trash2 className="w-3.5 h-3.5 mr-1.5 text-red-600" />
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Edit dialog */}
      <Dialog open={editing !== null} onOpenChange={open => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit project</DialogTitle>
            <DialogDescription>
              Renaming or repointing a project does not move existing meeting files on disk.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="edit-name">Name</Label>
              <Input
                id="edit-name"
                value={editForm.name}
                onChange={event => setEditForm(prev => ({ ...prev, name: event.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-folder">Folder</Label>
              <div className="flex gap-2">
                <Input
                  id="edit-folder"
                  value={editForm.folderPath}
                  onChange={event =>
                    setEditForm(prev => ({ ...prev, folderPath: event.target.value }))
                  }
                />
                <Button type="button" variant="outline" onClick={() => pickFolder('edit')}>
                  <FolderOpen className="w-4 h-4 mr-1.5" />
                  Browse…
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={handleEditSave}>Save changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={deleting !== null} onOpenChange={open => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete project?</DialogTitle>
            <DialogDescription>
              {deleting && (
                <>
                  &quot;{deleting.name}&quot; will be removed. Meetings already recorded under
                  this project will keep their files on disk and remain visible, but lose
                  their project association.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteConfirm}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
