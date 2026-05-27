'use client';

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { LiveNotes } from '@/services/liveNotesService';

export type LiveNotesStatus =
  | { kind: 'idle' }
  | { kind: 'refreshing' }
  | { kind: 'ok'; at: string }
  | { kind: 'error'; message: string };

export type LiveNotesPanelMode = 'inline' | 'floating';

interface LiveNotesContextValue {
  enabledForMeeting: boolean;
  setEnabledForMeeting: (v: boolean) => void;
  resetForMeeting: (defaultEnabled: boolean) => void;
  latest: LiveNotes | null;
  setLatest: (n: LiveNotes | null) => void;
  status: LiveNotesStatus;
  setStatus: (s: LiveNotesStatus) => void;
  panelMode: LiveNotesPanelMode;
  setPanelMode: (m: LiveNotesPanelMode) => void;
  refresh: () => void;
  registerRefreshFn: (fn: (() => void) | null) => void;
}

const LiveNotesContext = createContext<LiveNotesContextValue | null>(null);

export function useLiveNotesContext(): LiveNotesContextValue {
  const ctx = useContext(LiveNotesContext);
  if (!ctx) throw new Error('useLiveNotesContext must be used within LiveNotesProvider');
  return ctx;
}

export function LiveNotesProvider({ children }: { children: React.ReactNode }) {
  const [enabledForMeeting, setEnabledForMeeting] = useState(false);
  const [latest, setLatest] = useState<LiveNotes | null>(null);
  const [status, setStatus] = useState<LiveNotesStatus>({ kind: 'idle' });
  const [panelMode, setPanelMode] = useState<LiveNotesPanelMode>('inline');

  // Held in a ref so the hook can update it without forcing a re-render of
  // consumers, and so calling refresh() before the hook mounts is a no-op
  // instead of a crash.
  const refreshFnRef = useRef<(() => void) | null>(null);
  const refresh = useCallback(() => {
    refreshFnRef.current?.();
  }, []);
  const registerRefreshFn = useCallback((fn: (() => void) | null) => {
    refreshFnRef.current = fn;
  }, []);

  const resetForMeeting = useCallback((defaultEnabled: boolean) => {
    setEnabledForMeeting(defaultEnabled);
    setLatest(null);
    setStatus({ kind: 'idle' });
  }, []);

  const value = useMemo<LiveNotesContextValue>(
    () => ({
      enabledForMeeting,
      setEnabledForMeeting,
      resetForMeeting,
      latest,
      setLatest,
      status,
      setStatus,
      panelMode,
      setPanelMode,
      refresh,
      registerRefreshFn,
    }),
    [enabledForMeeting, resetForMeeting, latest, status, panelMode, refresh, registerRefreshFn]
  );

  return <LiveNotesContext.Provider value={value}>{children}</LiveNotesContext.Provider>;
}
