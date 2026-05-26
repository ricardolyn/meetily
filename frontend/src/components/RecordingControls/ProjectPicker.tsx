'use client';

import { FolderOpen } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useProjects } from '@/contexts/ProjectsContext';

const NONE_VALUE = '__none__';

interface ProjectPickerProps {
  disabled?: boolean;
}

/**
 * Compact project picker shown above the recording controls.
 * Lets the user pick which project the next recording belongs to, or
 * "None" to keep using the default recordings folder.
 *
 * Project management itself lives in Settings → Projects.
 */
export function ProjectPicker({ disabled = false }: ProjectPickerProps) {
  const { projects, selectedProject, setSelectedProject, isLoading } = useProjects();

  const handleChange = (value: string) => {
    if (value === NONE_VALUE) {
      setSelectedProject(null);
      return;
    }
    const project = projects.find(p => p.id === value);
    setSelectedProject(project ?? null);
  };

  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-white/90 rounded-full shadow-sm border border-gray-200">
      <FolderOpen className="w-4 h-4 text-gray-500" />
      <span className="text-xs text-gray-600 font-medium">Project</span>
      <Select
        value={selectedProject?.id ?? NONE_VALUE}
        onValueChange={handleChange}
        disabled={disabled || isLoading}
      >
        <SelectTrigger className="h-7 w-48 border-0 shadow-none px-2 py-0 text-sm bg-transparent">
          <SelectValue placeholder="None (default)" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE_VALUE}>None (default folder)</SelectItem>
          {projects.map(project => (
            <SelectItem key={project.id} value={project.id}>
              {project.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
