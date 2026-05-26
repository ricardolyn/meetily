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
  // Mirror reactive state into refs so the tick can read fresh values
  // without putting them on the effect's dep array — otherwise the
  // interval would be torn down and re-created on every transcript update.
  const latestRef = useRef<LiveNotes | null>(null);
  const transcriptsRef = useRef(transcripts);
  const isPausedRef = useRef(isPaused);
  latestRef.current = latest;
  transcriptsRef.current = transcripts;
  isPausedRef.current = isPaused;

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
  // NOTE: `transcripts` / `isPaused` deliberately NOT in the dep array — we
  // read them through refs above so the interval is established once per
  // recording (not re-created on every transcript). The no-new-transcripts
  // guard inside the tick handles the freshness check.
  // TODO(v2): re-read settings on a "live-notes-settings-changed" event so
  // interval changes mid-recording apply without restarting the recording.
  useEffect(() => {
    if (!isRecording || !enabledForMeeting || !meetingId) return;
    const intervalMs = (settingsRef.current?.intervalSeconds ?? 60) * 1000;
    let mounted = true;

    const tick = async () => {
      if (!mounted) return;
      if (inFlightRef.current) return;                    // single-flight
      if (isPausedRef.current) return;                     // skip while paused
      const currentTranscripts = transcriptsRef.current;
      if (currentTranscripts.length === lastTranscriptCountRef.current) return;
      const cfg = await resolveModelConfig();
      if (!cfg) {
        await emit('live-notes-error', 'No LLM provider configured');
        return;
      }
      const recent = buildRecentTranscriptText(currentTranscripts, intervalMs);
      if (!recent.trim()) return;
      inFlightRef.current = true;
      await emit('live-notes-refreshing');
      try {
        const result = await liveNotesService.generate(meetingId, recent, latestRef.current, cfg);
        if (!mounted) return;
        setLatest(result);
        lastTranscriptCountRef.current = currentTranscripts.length;
        await emit('live-notes-update', result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[live-notes] tick failed:', msg);
        await emit('live-notes-error', msg);
      } finally {
        inFlightRef.current = false;
      }
    };

    const handle = window.setInterval(tick, intervalMs);
    // Floating-window-triggered manual refresh and pause. `mounted` gate
    // covers the race where the listen() Promise resolves after teardown.
    const unlistenRefreshP = listen<void>('live-notes-refresh-request', () => {
      if (!mounted) return;
      void tick();
    });
    const unlistenPauseP = listen<void>('live-notes-pause-request', () => {
      if (!mounted) return;
      setEnabledForMeeting(false);
    });

    return () => {
      mounted = false;
      window.clearInterval(handle);
      unlistenRefreshP.then(u => u()).catch(() => {});
      unlistenPauseP.then(u => u()).catch(() => {});
    };
  }, [isRecording, enabledForMeeting, meetingId, setLatest, setEnabledForMeeting]);
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
