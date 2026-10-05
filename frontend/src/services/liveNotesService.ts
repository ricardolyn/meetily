/**
 * Tauri-side helpers for the Live Notes feature: settings persistence
 * (via tauri-plugin-store) + the LLM call wrapper.
 */

import { invoke } from '@tauri-apps/api/core';
import { getAppStore } from '@/services/appStore';
import type { LlmModelConfig } from '@/services/modelConfig';

export interface LiveNotes {
  right_now: string;
  asked_of_you: string[];
  action_items: string[];
  generated_at: string;
}

export interface LiveNotesSettings {
  /** Run automatically when a recording is active. */
  enabledByDefault: boolean;
  /** Refresh interval in seconds. */
  intervalSeconds: 30 | 60 | 120 | 300 | 600;
  /** "inherit" = use the same provider/model as the saved-summary config. */
  provider: 'inherit' | 'ollama' | 'claude' | 'openai' | 'groq' | 'openrouter' | 'builtin';
  /** Null when provider is "inherit"; otherwise the model name. */
  model: string | null;
}

const STORE_KEY = 'liveNotes';

const DEFAULT_SETTINGS: LiveNotesSettings = {
  enabledByDefault: false,
  intervalSeconds: 60,
  provider: 'inherit',
  model: null,
};

export const liveNotesService = {
  async getSettings(): Promise<LiveNotesSettings> {
    const store = await getAppStore();
    const stored = (await store.get<Partial<LiveNotesSettings>>(STORE_KEY)) ?? {};
    return { ...DEFAULT_SETTINGS, ...stored };
  },

  async setSettings(next: LiveNotesSettings): Promise<void> {
    const store = await getAppStore();
    await store.set(STORE_KEY, next);
    await store.save();
  },

  generate(
    meetingId: string,
    recentTranscripts: string,
    previousNotes: LiveNotes | null,
    modelConfig: LlmModelConfig
  ): Promise<LiveNotes> {
    return invoke<LiveNotes>('api_generate_live_notes', {
      meetingId,
      recentTranscripts,
      previousNotes,
      modelConfig,
    });
  },

  /** Persist the final snapshot to `live_notes.json` in the meeting folder. */
  save(folderPath: string, notes: LiveNotes): Promise<void> {
    return invoke<void>('api_save_live_notes', { folderPath, notes });
  },

  /** Load a previously-saved snapshot. Returns null if the file is absent. */
  load(folderPath: string): Promise<LiveNotes | null> {
    return invoke<LiveNotes | null>('api_get_live_notes', { folderPath });
  },
};
