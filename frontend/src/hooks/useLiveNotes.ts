import { useCallback, useEffect, useRef } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
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
 * on an interval, broadcasts results to both the inline panel (via
 * context) and the floating window (via events).
 */
export function useLiveNotes(meetingId: string | null) {
  const { transcripts } = useTranscripts();
  const { isRecording, isPaused } = useRecordingState();

  const {
    enabledForMeeting,
    setEnabledForMeeting,
    resetForMeeting,
    setLatest,
    latest,
    setStatus,
    panelMode,
    setPanelMode,
    registerRefreshFn,
  } = useLiveNotesContext();

  const inFlightRef = useRef(false);
  const lastTranscriptCountRef = useRef(0);
  const settingsRef = useRef<LiveNotesSettings | null>(null);
  // Refs mirror reactive state so the tick reads fresh values without
  // re-creating the interval on every transcript update.
  const latestRef = useRef<LiveNotes | null>(null);
  const transcriptsRef = useRef(transcripts);
  const isPausedRef = useRef(isPaused);
  latestRef.current = latest;
  transcriptsRef.current = transcripts;
  isPausedRef.current = isPaused;

  useEffect(() => {
    liveNotesService.getSettings().then(s => {
      settingsRef.current = s;
    });
  }, []);

  useEffect(() => {
    if (isRecording) {
      liveNotesService.getSettings().then(s => {
        settingsRef.current = s;
        resetForMeeting(s.enabledByDefault);
        lastTranscriptCountRef.current = 0;
      });
    }
  }, [isRecording, resetForMeeting]);

  // Show the floating window only when the user has explicitly chosen
  // floating mode AND the feature is on for the current meeting. Driven
  // through a Rust command so a single log trail lands in meetily.log
  // even when devtools is unavailable in release builds.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const shouldShow = isRecording && enabledForMeeting && panelMode === 'floating';
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        if (cancelled) return;
        await invoke('api_set_live_notes_window_visible', { visible: shouldShow });
      } catch (e) {
        console.error('[live-notes] floating window toggle failed:', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isRecording, enabledForMeeting, panelMode]);

  // Persist the final snapshot when recording stops. The Rust side emits
  // `recording-stopped` with the folder path it just wrote `transcripts.json`
  // into; we drop `live_notes.json` next to it. Best-effort: silent on
  // error since failure shouldn't block the post-recording flow.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const u = await listen<{ folder_path?: string }>('recording-stopped', async event => {
        const notes = latestRef.current;
        const folderPath = event.payload?.folder_path;
        if (!notes || !folderPath) return;
        try {
          await liveNotesService.save(folderPath, notes);
        } catch (e) {
          console.warn('[live-notes] save on stop failed:', e);
        }
      });
      if (cancelled) {
        u();
        return;
      }
      unlisten = u;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Stable refresh trigger exposed via context. The tick fn is rebuilt
  // each time the effect re-runs; we update tickRef so the trigger
  // always calls the latest closure.
  const tickRef = useRef<() => Promise<void>>(async () => {});
  const refresh = useCallback(() => {
    void tickRef.current();
  }, []);
  useEffect(() => {
    registerRefreshFn(refresh);
    return () => registerRefreshFn(null);
  }, [refresh, registerRefreshFn]);

  // The actual tick. NOTE: `transcripts`/`isPaused` deliberately not in
  // the dep array; refs above give us freshness without churn.
  useEffect(() => {
    if (!isRecording || !enabledForMeeting || !meetingId) return;
    const intervalMs = (settingsRef.current?.intervalSeconds ?? 60) * 1000;
    let mounted = true;

    const tick = async () => {
      if (!mounted) return;
      if (inFlightRef.current) return;
      if (isPausedRef.current) return;
      const currentTranscripts = transcriptsRef.current;
      if (currentTranscripts.length === lastTranscriptCountRef.current) return;
      const cfg = await resolveModelConfig();
      if (!cfg) {
        const msg = 'No LLM provider configured';
        setStatus({ kind: 'error', message: msg });
        await emit('live-notes-error', msg);
        return;
      }
      const recent = buildRecentTranscriptText(currentTranscripts, intervalMs);
      if (!recent.trim()) return;
      inFlightRef.current = true;
      setStatus({ kind: 'refreshing' });
      await emit('live-notes-refreshing');
      try {
        const result = await liveNotesService.generate(meetingId, recent, latestRef.current, cfg);
        if (!mounted) return;
        setLatest(result);
        setStatus({ kind: 'ok', at: result.generated_at });
        lastTranscriptCountRef.current = currentTranscripts.length;
        await emit('live-notes-update', result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[live-notes] tick failed:', msg);
        setStatus({ kind: 'error', message: msg });
        await emit('live-notes-error', msg);
      } finally {
        inFlightRef.current = false;
      }
    };
    tickRef.current = tick;

    const handle = window.setInterval(tick, intervalMs);
    // Floating-window-triggered manual refresh and pause; mounted gate
    // covers the race where listen() resolves after teardown.
    const unlistenRefreshP = listen<void>('live-notes-refresh-request', () => {
      if (!mounted) return;
      void tick();
    });
    const unlistenPauseP = listen<void>('live-notes-pause-request', () => {
      if (!mounted) return;
      setEnabledForMeeting(false);
    });
    const unlistenDockP = listen<void>('live-notes-dock-request', () => {
      if (!mounted) return;
      setPanelMode('inline');
    });

    return () => {
      mounted = false;
      window.clearInterval(handle);
      unlistenRefreshP.then(u => u()).catch(() => {});
      unlistenPauseP.then(u => u()).catch(() => {});
      unlistenDockP.then(u => u()).catch(() => {});
    };
  }, [isRecording, enabledForMeeting, meetingId, setLatest, setEnabledForMeeting, setStatus, setPanelMode]);
}

function buildRecentTranscriptText(
  transcripts: Array<{ text: string; audio_start_time?: number; speaker?: string }>,
  intervalMs: number
): string {
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
  const { invoke } = await import('@tauri-apps/api/core');
  const config: any = await invoke('api_get_model_config').catch(() => null);
  if (!config || !config.provider || !config.model) return null;

  // For custom-openai the endpoint + API key + model live in a separate
  // JSON row, not in api_get_model_config's response. Fetch it here so the
  // inherit path can drive a custom OpenAI-compatible proxy.
  if (config.provider === 'custom-openai') {
    const custom: any = await invoke('api_get_custom_openai_config').catch(() => null);
    if (!custom || !custom.endpoint || !custom.model) return null;
    return {
      provider: 'custom-openai',
      model: custom.model,
      api_key: custom.apiKey ?? undefined,
      custom_openai_endpoint: custom.endpoint,
    };
  }

  return {
    provider: config.provider,
    model: config.model,
    api_key: config.apiKey ?? undefined,
    ollama_endpoint: config.ollamaEndpoint ?? undefined,
  };
}
