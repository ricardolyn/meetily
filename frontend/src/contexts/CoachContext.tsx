'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { coachService, type CoachSuggestion } from '@/services/coachService';

export type CoachStatus =
  | { kind: 'idle' }
  | { kind: 'refreshing' }
  | { kind: 'ok'; at: string }
  | { kind: 'error'; message: string };

interface CoachContextValue {
  /** The user's notes about the call. Persisted as the last-used context. */
  context: string;
  setContext: (text: string) => void;
  /** Whether the Coach tab is on for the current meeting. */
  enabledForMeeting: boolean;
  setEnabledForMeeting: (v: boolean) => void;
  /** Clear the suggestion and open the Coach tab if there's context to use. */
  resetForMeeting: () => void;
  latest: CoachSuggestion | null;
  setLatest: (s: CoachSuggestion | null) => void;
  status: CoachStatus;
  setStatus: (s: CoachStatus) => void;
  refresh: () => void;
  registerRefreshFn: (fn: (() => void) | null) => void;
}

const CONTEXT_SAVE_DELAY_MS = 500;

const CoachContext = createContext<CoachContextValue | null>(null);

export function useCoachContext(): CoachContextValue {
  const ctx = useContext(CoachContext);
  if (!ctx) throw new Error('useCoachContext must be used within CoachProvider');
  return ctx;
}

export function CoachProvider({ children }: { children: React.ReactNode }) {
  const [context, setContextState] = useState('');
  const [enabledForMeeting, setEnabledForMeeting] = useState(false);
  const [latest, setLatest] = useState<CoachSuggestion | null>(null);
  const [status, setStatus] = useState<CoachStatus>({ kind: 'idle' });

  const contextRef = useRef(context);
  contextRef.current = context;

  useEffect(() => {
    coachService
      .getLastContext()
      .then(setContextState)
      .catch(e => console.warn('[coach] failed to load last context:', e));
  }, []);

  // Persist edits shortly after the user stops typing.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setContext = useCallback((text: string) => {
    setContextState(text);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      coachService
        .setLastContext(text)
        .catch(e => console.warn('[coach] failed to save context:', e));
    }, CONTEXT_SAVE_DELAY_MS);
  }, []);

  const refreshFnRef = useRef<(() => void) | null>(null);
  const refresh = useCallback(() => {
    refreshFnRef.current?.();
  }, []);
  const registerRefreshFn = useCallback((fn: (() => void) | null) => {
    refreshFnRef.current = fn;
  }, []);

  const resetForMeeting = useCallback(() => {
    setLatest(null);
    setStatus({ kind: 'idle' });
    setEnabledForMeeting(contextRef.current.trim().length > 0);
  }, []);

  const value = useMemo<CoachContextValue>(
    () => ({
      context,
      setContext,
      enabledForMeeting,
      setEnabledForMeeting,
      resetForMeeting,
      latest,
      setLatest,
      status,
      setStatus,
      refresh,
      registerRefreshFn,
    }),
    [context, setContext, enabledForMeeting, resetForMeeting, latest, status, refresh, registerRefreshFn]
  );

  return <CoachContext.Provider value={value}>{children}</CoachContext.Provider>;
}
