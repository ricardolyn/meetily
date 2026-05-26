import { useEffect, useRef } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useLiveNotesContext } from '@/contexts/LiveNotesContext';
import {
  liveNotesService,
  type LiveNotes,
  type LiveNotesSettings,
  type LiveNotesModelConfig,
} from '@/services/liveNotesService';

/**
 * Drives the live-notes lifecycle from the main window. Reads recording
 * state + per-meeting override + persisted settings, fires the LLM call
 * on an interval, broadcasts results to the floating window.
 */
export function useLiveNotes(meetingId: string | null) {
  const { transcripts } = useTranscripts();
  const { isRecording, isPaused } = useRecordingState();

  const { enabledForMeeting, setEnabledForMeeting, resetForMeeting, setLatest, latest } =
    useLiveNotesContext();

  const inFlightRef = useRef(false);
  const lastTranscriptCountRef = useRef(0);
  const settingsRef = useRef<LiveNotesSettings | null>(null);
  const latestRef = useRef<LiveNotes | null>(null);
  latestRef.current = latest;

  // Load settings once (refreshed on each recording start in case the
  // user changed them in Settings since this hook mounted).
  useEffect(() => {
    liveNotesService.getSettings().then(s => {
      settingsRef.current = s;
    });
  }, []);

  // When a new recording starts, reset to the global default.
  useEffect(() => {
    if (isRecording) {
      // Re-read settings in case the user changed enabledByDefault since mount.
      liveNotesService.getSettings().then(s => {
        settingsRef.current = s;
        resetForMeeting(s.enabledByDefault);
        lastTranscriptCountRef.current = 0;
      });
    }
  }, [isRecording, resetForMeeting]);

  // Show/hide the floating window in lockstep with enabled+recording.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const win = await WebviewWindow.getByLabel('live-notes');
      if (!win || cancelled) return;
      if (isRecording && enabledForMeeting) {
        await win.show();
      } else {
        await win.hide();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isRecording, enabledForMeeting]);

  // The actual tick.
  useEffect(() => {
    if (!isRecording || !enabledForMeeting || !meetingId) return;
    const intervalMs = (settingsRef.current?.intervalSeconds ?? 60) * 1000;

    const tick = async () => {
      if (inFlightRef.current) return;                    // single-flight
      if (isPaused) return;                                // skip while paused
      if (transcripts.length === lastTranscriptCountRef.current) return; // no new content
      const cfg = await resolveModelConfig();
      if (!cfg) {
        await emit('live-notes-error', 'No LLM provider configured');
        return;
      }
      const recent = buildRecentTranscriptText(transcripts, intervalMs);
      if (!recent.trim()) return;
      inFlightRef.current = true;
      await emit('live-notes-refreshing');
      try {
        const result = await liveNotesService.generate(meetingId, recent, latestRef.current, cfg);
        setLatest(result);
        lastTranscriptCountRef.current = transcripts.length;
        await emit('live-notes-update', result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await emit('live-notes-error', msg);
      } finally {
        inFlightRef.current = false;
      }
    };

    const handle = window.setInterval(tick, intervalMs);
    // Floating-window-triggered manual refresh and pause.
    const unlistenRefreshP = listen<void>('live-notes-refresh-request', () => {
      void tick();
    });
    const unlistenPauseP = listen<void>('live-notes-pause-request', () => {
      setEnabledForMeeting(false);
    });

    return () => {
      window.clearInterval(handle);
      unlistenRefreshP.then(u => u()).catch(() => {});
      unlistenPauseP.then(u => u()).catch(() => {});
    };
  }, [isRecording, enabledForMeeting, isPaused, meetingId, transcripts, setLatest, setEnabledForMeeting]);
}

function buildRecentTranscriptText(
  transcripts: Array<{ text: string; audio_start_time?: number; speaker?: string }>,
  intervalMs: number
): string {
  // Window = min(intervalMs * 3, 5 minutes), per the design spec.
  const windowMs = Math.min(intervalMs * 3, 5 * 60 * 1000);
  const last = transcripts[transcripts.length - 1];
  if (!last || last.audio_start_time === undefined) {
    return transcripts.map(formatLine).join('\n');
  }
  const cutoff = last.audio_start_time - windowMs / 1000;
  return transcripts
    .filter(t => (t.audio_start_time ?? 0) >= cutoff)
    .map(formatLine)
    .join('\n');
}

function formatLine(t: { text: string; audio_start_time?: number; speaker?: string }): string {
  const ts = formatStamp(t.audio_start_time ?? 0);
  const who = t.speaker === 'me' ? 'You' : t.speaker === 'others' ? 'Other' : '';
  return who ? `[${ts}] ${who}: ${t.text}` : `[${ts}] ${t.text}`;
}

function formatStamp(seconds: number): string {
  const mm = Math.floor(seconds / 60).toString().padStart(2, '0');
  const ss = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

async function resolveModelConfig(): Promise<LiveNotesModelConfig | null> {
  const s = await liveNotesService.getSettings();
  if (s.provider !== 'inherit') {
    if (!s.model) return null;
    return { provider: s.provider, model: s.model };
  }
  // Inherit from saved-summary model config (api_get_model_config).
  const { invoke } = await import('@tauri-apps/api/core');
  const config: any = await invoke('api_get_model_config').catch(() => null);
  if (!config || !config.provider || !config.model) return null;
  return {
    provider: config.provider,
    model: config.model,
    api_key: config.apiKey ?? undefined,
    ollama_endpoint: config.ollamaEndpoint ?? undefined,
  };
}
