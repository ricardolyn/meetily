'use client';

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { LiveNotes } from '@/services/liveNotesService';

interface LiveNotesContextValue {
  /** True if live notes should run for the current meeting. */
  enabledForMeeting: boolean;
  /** Override switch (only meaningful during an active recording). */
  setEnabledForMeeting: (v: boolean) => void;
  /** Reset to "use the global default" — called when a recording starts. */
  resetForMeeting: (defaultEnabled: boolean) => void;
  /** Latest result, shared between RecordingControls and the floating window. */
  latest: LiveNotes | null;
  setLatest: (n: LiveNotes | null) => void;
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

  const resetForMeeting = useCallback((defaultEnabled: boolean) => {
    setEnabledForMeeting(defaultEnabled);
    setLatest(null);
  }, []);

  const value = useMemo<LiveNotesContextValue>(
    () => ({ enabledForMeeting, setEnabledForMeeting, resetForMeeting, latest, setLatest }),
    [enabledForMeeting, resetForMeeting, latest]
  );

  return <LiveNotesContext.Provider value={value}>{children}</LiveNotesContext.Provider>;
}
