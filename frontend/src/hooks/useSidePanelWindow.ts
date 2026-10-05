import { useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useLiveNotesContext } from '@/contexts/LiveNotesContext';
import { useCoachContext } from '@/contexts/CoachContext';

/** Which side-panel tabs are on; sent to the floating window. */
export interface SidePanelState {
  notesEnabled: boolean;
  coachEnabled: boolean;
}

/**
 * Owns the floating side-panel window from the main window: shows it when
 * the panel is popped out and Live notes or Coach is on, docks it back on
 * request, and keeps the floating window's tabs and content in sync (it has
 * no React context of its own, only events).
 */
export function useSidePanelWindow() {
  const { isRecording } = useRecordingState();
  const {
    enabledForMeeting: notesEnabled,
    latest: latestNotes,
    panelMode,
    setPanelMode,
  } = useLiveNotesContext();
  const { enabledForMeeting: coachEnabled, latest: latestCoach } = useCoachContext();

  const syncFloating = useCallback(async () => {
    const state: SidePanelState = { notesEnabled, coachEnabled };
    await emit('side-panel-state', state);
    if (latestNotes) await emit('live-notes-update', latestNotes);
    if (latestCoach) await emit('coach-update', latestCoach);
  }, [notesEnabled, coachEnabled, latestNotes, latestCoach]);

  const syncRef = useRef(syncFloating);
  syncRef.current = syncFloating;

  const shouldShow = isRecording && panelMode === 'floating' && (notesEnabled || coachEnabled);

  // Driven through a Rust command so a single log trail lands in meetily.log
  // even when devtools is unavailable in release builds.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (shouldShow) await syncRef.current();
        if (cancelled) return;
        await invoke('api_set_live_notes_window_visible', { visible: shouldShow });
      } catch (e) {
        console.error('[side-panel] floating window toggle failed:', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shouldShow]);

  useEffect(() => {
    const state: SidePanelState = { notesEnabled, coachEnabled };
    void emit('side-panel-state', state).catch(() => {});
  }, [notesEnabled, coachEnabled]);

  useEffect(() => {
    let mounted = true;
    const unlistenStateP = listen<void>('side-panel-state-request', () => {
      if (mounted) void syncRef.current().catch(() => {});
    });
    const unlistenDockP = listen<void>('live-notes-dock-request', () => {
      if (mounted) setPanelMode('inline');
    });
    return () => {
      mounted = false;
      unlistenStateP.then(u => u()).catch(() => {});
      unlistenDockP.then(u => u()).catch(() => {});
    };
  }, [setPanelMode]);
}
