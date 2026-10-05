/**
 * Tauri-side helpers for the Live Coach: ask for a suggestion of what to say
 * next, and remember the last context the user wrote (to pre-fill the next
 * call).
 */

import { invoke } from '@tauri-apps/api/core';
import { getAppStore } from '@/services/appStore';
import type { LlmModelConfig } from '@/services/modelConfig';

/** Mirrors the Rust `coach::suggestion::CoachSuggestion` struct. */
export interface CoachSuggestion {
  reply: string;
  talking_points: string[];
  /** ISO datetime. */
  generated_at: string;
}

const STORE_KEY = 'coach';

interface CoachStore {
  lastContext?: string;
}

export const coachService = {
  async getLastContext(): Promise<string> {
    const store = await getAppStore();
    const stored = await store.get<CoachStore>(STORE_KEY);
    return stored?.lastContext ?? '';
  },

  async setLastContext(context: string): Promise<void> {
    const store = await getAppStore();
    await store.set(STORE_KEY, { lastContext: context } satisfies CoachStore);
    await store.save();
  },

  suggest(
    meetingId: string,
    context: string,
    transcript: string,
    modelConfig: LlmModelConfig
  ): Promise<CoachSuggestion> {
    return invoke<CoachSuggestion>('api_coach_suggest', {
      meetingId,
      context,
      transcript,
      modelConfig,
    });
  },
};
