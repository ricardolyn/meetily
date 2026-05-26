'use client';

import { useEffect, useState } from 'react';
import { emit } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { ChevronDown, Sparkles } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useLiveNotesContext } from '@/contexts/LiveNotesContext';
import { liveNotesService } from '@/services/liveNotesService';

interface Props {
  /** True while a recording is active; pill is hidden otherwise. */
  isRecording: boolean;
}

export function LiveNotesPill({ isRecording }: Props) {
  const { enabledForMeeting, setEnabledForMeeting } = useLiveNotesContext();
  const [intervalLabel, setIntervalLabel] = useState<string>('1m');

  useEffect(() => {
    liveNotesService.getSettings().then(s => setIntervalLabel(formatInterval(s.intervalSeconds)));
  }, []);

  if (!isRecording) return null;

  async function refreshNow() {
    await emit('live-notes-refresh-request');
  }
  async function openWindow() {
    const win = await WebviewWindow.getByLabel('live-notes');
    if (win) await win.show();
  }

  return (
    <div className="inline-flex items-center gap-1">
      <button
        onClick={() => setEnabledForMeeting(!enabledForMeeting)}
        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border ${
          enabledForMeeting
            ? 'bg-blue-50 text-blue-700 border-blue-200'
            : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
        }`}
        title="Toggle live notes for this meeting"
      >
        <Sparkles className="w-3.5 h-3.5" />
        <span>Live notes</span>
        {enabledForMeeting && <span className="text-blue-500">· {intervalLabel}</span>}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="inline-flex items-center justify-center w-6 h-6 rounded-full hover:bg-gray-100 text-gray-500"
            title="Live notes options"
          >
            <ChevronDown className="w-3 h-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={refreshNow} disabled={!enabledForMeeting}>
            Refresh now
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={openWindow}>
            Open floating window
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}
