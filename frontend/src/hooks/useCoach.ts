import { useCallback, useEffect, useRef } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useCoachContext } from '@/contexts/CoachContext';
import { coachService } from '@/services/coachService';
import { resolveSummaryModelConfig } from '@/services/modelConfig';
import { buildTranscriptText } from '@/lib/transcriptText';

/**
 * Drives the Live Coach from the main window. Refreshes only on request
 * (Coach tab button, or the floating window), using the user's context plus
 * the whole transcript so far. Results go to the inline panel via context and
 * to the floating window via `coach-*` events.
 */
export function useCoach(meetingId: string | null) {
  const { transcripts } = useTranscripts();
  const { isRecording } = useRecordingState();
  const {
    context,
    resetForMeeting,
    setEnabledForMeeting,
    setLatest,
    setStatus,
    registerRefreshFn,
  } = useCoachContext();

  // Refs give the refresh fresh values without re-creating it on every
  // transcript update or keystroke in the context box.
  const transcriptsRef = useRef(transcripts);
  const contextRef = useRef(context);
  const inFlightRef = useRef(false);
  transcriptsRef.current = transcripts;
  contextRef.current = context;

  useEffect(() => {
    if (isRecording) resetForMeeting();
  }, [isRecording, resetForMeeting]);

  const fail = useCallback(
    (message: string) => {
      setStatus({ kind: 'error', message });
      void emit('coach-error', message).catch(() => {});
    },
    [setStatus]
  );

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    const transcript = buildTranscriptText(transcriptsRef.current);
    const userContext = contextRef.current;
    if (!userContext.trim() && !transcript.trim()) {
      fail('Add some context, or wait for the conversation to start.');
      return;
    }
    const modelConfig = await resolveSummaryModelConfig();
    if (!modelConfig) {
      fail('No LLM provider configured. Set one up in Settings.');
      return;
    }

    inFlightRef.current = true;
    setStatus({ kind: 'refreshing' });
    void emit('coach-refreshing').catch(() => {});
    try {
      const suggestion = await coachService.suggest(
        meetingId ?? '',
        userContext,
        transcript,
        modelConfig
      );
      setLatest(suggestion);
      setStatus({ kind: 'ok', at: suggestion.generated_at });
      void emit('coach-update', suggestion).catch(() => {});
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('[coach] refresh failed:', message);
      fail(message);
    } finally {
      inFlightRef.current = false;
    }
  }, [meetingId, fail, setLatest, setStatus]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    registerRefreshFn(() => {
      void refreshRef.current();
    });
    return () => registerRefreshFn(null);
  }, [registerRefreshFn]);

  // Requests from the floating window's Coach tab.
  useEffect(() => {
    let mounted = true;
    const unlistenRefreshP = listen<void>('coach-refresh-request', () => {
      if (mounted) void refreshRef.current();
    });
    const unlistenCloseP = listen<void>('coach-close-request', () => {
      if (mounted) setEnabledForMeeting(false);
    });
    return () => {
      mounted = false;
      unlistenRefreshP.then(u => u()).catch(() => {});
      unlistenCloseP.then(u => u()).catch(() => {});
    };
  }, [setEnabledForMeeting]);
}
