/**
 * Tauri-side helpers for the Live Notes feature: settings persistence
 * (via tauri-plugin-store) + the LLM call wrapper.
 */

import { invoke } from '@tauri-apps/api/core';
import { load, type Store } from '@tauri-apps/plugin-store';

export interface LiveNotes {
  right_now: string;
  asked_of_you: string[];
  action_items: string[];
  generated_at: string;
}

export interface LiveNotesModelConfig {
  provider: string;
  model: string;
  api_key?: string;
  ollama_endpoint?: string;
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

const STORE_FILE = 'store.json';
const STORE_KEY = 'liveNotes';

const DEFAULT_SETTINGS: LiveNotesSettings = {
  enabledByDefault: false,
  intervalSeconds: 60,
  provider: 'inherit',
  model: null,
};

// Promise singleton so concurrent callers (React Strict Mode double-mount,
// multiple settings components) all reuse the same load() call. The
// `defaults: {}` is required by the plugin-store type definition even
// though we hold defaults ourselves at the application layer.
let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (storePromise === null) {
    storePromise = load(STORE_FILE, { autoSave: true, defaults: {} });
  }
  return storePromise;
}

export const liveNotesService = {
  async getSettings(): Promise<LiveNotesSettings> {
    const store = await getStore();
    const stored = (await store.get<Partial<LiveNotesSettings>>(STORE_KEY)) ?? {};
    return { ...DEFAULT_SETTINGS, ...stored };
  },

  async setSettings(next: LiveNotesSettings): Promise<void> {
    const store = await getStore();
    await store.set(STORE_KEY, next);
    await store.save();
  },

  generate(
    meetingId: string,
    recentTranscripts: string,
    previousNotes: LiveNotes | null,
    modelConfig: LiveNotesModelConfig
  ): Promise<LiveNotes> {
    return invoke<LiveNotes>('api_generate_live_notes', {
      meetingId,
      recentTranscripts,
      previousNotes,
      modelConfig,
    });
  },
};
