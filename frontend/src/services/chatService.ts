/**
 * Tauri-side helpers for the Live Chat feature: ask a question about the
 * ongoing meeting, and persist/load the conversation alongside the meeting.
 */

import { invoke } from '@tauri-apps/api/core';
import type { LlmModelConfig } from '@/services/modelConfig';

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** ISO datetime. */
  timestamp: string;
}

export interface ChatSession {
  messages: ChatMessage[];
}

export const chatService = {
  /** Answer a question using the whole-meeting transcript + prior turns. */
  ask(
    meetingId: string,
    transcript: string,
    history: ChatMessage[],
    question: string,
    modelConfig: LlmModelConfig
  ): Promise<ChatMessage> {
    return invoke<ChatMessage>('api_ask_meeting', {
      meetingId,
      transcript,
      history,
      question,
      modelConfig,
    });
  },

  /** Persist the conversation to `chat.json` in the meeting folder. */
  save(folderPath: string, session: ChatSession): Promise<void> {
    return invoke<void>('api_save_chat', { folderPath, session });
  },

  /** Load a previously-saved conversation. Returns null if the file is absent. */
  load(folderPath: string): Promise<ChatSession | null> {
    return invoke<ChatSession | null>('api_get_chat', { folderPath });
  },
};
