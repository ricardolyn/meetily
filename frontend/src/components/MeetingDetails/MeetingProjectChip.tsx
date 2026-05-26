'use client';

import { useEffect, useState } from 'react';
import { Check, ChevronDown, FolderOpen, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useProjects } from '@/contexts/ProjectsContext';
import { projectsService } from '@/services/projectsService';

interface MeetingProjectChipProps {
  meetingId: string;
  currentProjectId: string | null | undefined;
  onAssigned?: (projectId: string | null) => void;
}

/**
 * Compact chip on the meeting details page that shows which project the
 * meeting belongs to and lets the user reassign or clear it.
 *
 * Reassignment only updates the database link; existing files on disk are
 * left where they are.
 */
export function MeetingProjectChip({
  meetingId,
  currentProjectId,
  onAssigned,
}: MeetingProjectChipProps) {
  const { projects, refreshProjects } = useProjects();
  const [pendingProjectId, setPendingProjectId] = useState<string | null | undefined>(undefined);
  const [isAssigning, setIsAssigning] = useState(false);
  // Local override of currentProjectId after a successful move, so the chip
  // updates immediately without waiting for the parent meeting object to
  // re-fetch (which it currently doesn't do).
  const [localProjectId, setLocalProjectId] = useState<string | null | undefined>(undefined);

  // Reset the override whenever the parent re-renders with a new meeting
  // (handles navigation between meetings within the same mounted chip).
  useEffect(() => {
    setLocalProjectId(undefined);
  }, [meetingId, currentProjectId]);

  const effectiveProjectId =
    localProjectId !== undefined ? localProjectId : currentProjectId ?? null;

  const currentProject = effectiveProjectId
    ? projects.find(p => p.id === effectiveProjectId) ?? null
    : null;

  function startAssign(projectId: string | null) {
    if (projectId === effectiveProjectId) return;
    setPendingProjectId(projectId);
  }

  async function confirmAssign() {
    if (pendingProjectId === undefined) return;
    setIsAssigning(true);
    try {
      // moveMeeting updates DB association AND moves the on-disk folder
      // (the recording, transcripts.json, metadata.json end up inside the
      // new project's folder).
      await projectsService.moveMeeting(meetingId, pendingProjectId);
      // Set local override so the chip reflects the new project immediately,
      // even though the parent's `meeting.project_id` prop is still stale.
      setLocalProjectId(pendingProjectId);
      await refreshProjects();
      onAssigned?.(pendingProjectId);
      toast.success(
        pendingProjectId
          ? `Moved to "${projects.find(p => p.id === pendingProjectId)?.name ?? 'project'}"`
          : 'Removed from project'
      );
      setPendingProjectId(undefined);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to move meeting');
    } finally {
      setIsAssigning(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1 text-xs text-gray-700 hover:bg-gray-50"
          >
            <FolderOpen className="w-3.5 h-3.5 text-gray-500" />
            <span>{currentProject ? currentProject.name : 'No project'}</span>
            <ChevronDown className="w-3 h-3 text-gray-400" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel>Move to project</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => startAssign(null)}>
            <span className="flex-1">No project</span>
            {!currentProject && <Check className="w-3.5 h-3.5" />}
          </DropdownMenuItem>
          {projects.length === 0 ? (
            <DropdownMenuItem disabled>
              No projects yet — create one in Settings
            </DropdownMenuItem>
          ) : (
            projects.map(project => (
              <DropdownMenuItem key={project.id} onSelect={() => startAssign(project.id)}>
                <span className="flex-1 truncate">{project.name}</span>
                {currentProject?.id === project.id && <Check className="w-3.5 h-3.5" />}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={pendingProjectId !== undefined}
        onOpenChange={open => !open && setPendingProjectId(undefined)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingProjectId
                ? `Move meeting to "${projects.find(p => p.id === pendingProjectId)?.name ?? 'project'}"?`
                : 'Remove meeting from project?'}
            </DialogTitle>
            <DialogDescription>
              The meeting's folder — including the recording, transcripts and
              metadata — will be moved into the destination project's folder
              on disk. If a folder with the same name already exists at the
              destination, the move will fail with an error.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingProjectId(undefined)} disabled={isAssigning}>
              Cancel
            </Button>
            <Button onClick={confirmAssign} disabled={isAssigning}>
              {isAssigning && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
