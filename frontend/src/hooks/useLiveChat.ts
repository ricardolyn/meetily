import { useCallback, useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useChatContext } from '@/contexts/ChatContext';
import { chatService, type ChatModelConfig } from '@/services/chatService';

/**
 * Drives the live-chat lifecycle from the main window. Exposes `ask()` to
 * answer a question from the whole-meeting transcript plus the prior turns
 * of this session, resets the conversation when a new recording starts, and
 * persists it as `chat.json` when recording stops.
 */
export function useLiveChat(meetingId: string | null) {
  const { transcripts } = useTranscripts();
  const { isRecording } = useRecordingState();
  const { messages, appendMessage, setStatus, resetForMeeting } = useChatContext();

  // Refs mirror reactive state so `ask` reads fresh values without being
  // re-created on every transcript update or new message.
  const transcriptsRef = useRef(transcripts);
  const messagesRef = useRef(messages);
  const inFlightRef = useRef(false);
  transcriptsRef.current = transcripts;
  messagesRef.current = messages;

  useEffect(() => {
    if (isRecording) resetForMeeting();
  }, [isRecording, resetForMeeting]);

  // Persist the conversation when recording stops. Best-effort: silent on
  // error since failure shouldn't block the post-recording flow.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const u = await listen<{ folder_path?: string }>('recording-stopped', async event => {
        const current = messagesRef.current;
        const folderPath = event.payload?.folder_path;
        if (current.length === 0 || !folderPath) return;
        try {
          await chatService.save(folderPath, { messages: current });
        } catch (e) {
          console.warn('[live-chat] save on stop failed:', e);
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

  const ask = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed || inFlightRef.current || !meetingId) return;

      const cfg = await resolveModelConfig();
      if (!cfg) {
        setStatus({ kind: 'error', message: 'No LLM provider configured' });
        return;
      }

      const history = messagesRef.current;
      const transcript = buildFullTranscriptText(transcriptsRef.current);
      const now = new Date().toISOString();
      appendMessage({ role: 'user', content: trimmed, timestamp: now });

      inFlightRef.current = true;
      setStatus({ kind: 'asking' });
      try {
        const reply = await chatService.ask(meetingId, transcript, history, trimmed, cfg);
        appendMessage(reply);
        setStatus({ kind: 'idle' });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[live-chat] ask failed:', msg);
        setStatus({ kind: 'error', message: msg });
      } finally {
        inFlightRef.current = false;
      }
    },
    [meetingId, appendMessage, setStatus]
  );

  return { ask };
}

function buildFullTranscriptText(
  transcripts: Array<{ text: string; audio_start_time?: number; speaker?: string }>
): string {
  return transcripts.map(formatLine).join('\n');
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

async function resolveModelConfig(): Promise<ChatModelConfig | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  const config: any = await invoke('api_get_model_config').catch(() => null);
  if (!config || !config.provider || !config.model) return null;

  // For custom-openai the endpoint + API key + model live in a separate JSON
  // row, not in api_get_model_config's response.
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
