'use client';

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ChatMessage } from '@/services/chatService';

export type ChatStatus =
  | { kind: 'idle' }
  | { kind: 'asking' }
  | { kind: 'error'; message: string };

interface ChatContextValue {
  /** Whether the chat panel is open for the current meeting. */
  enabledForMeeting: boolean;
  setEnabledForMeeting: (v: boolean) => void;
  /** Clear conversation + status for a fresh recording. */
  resetForMeeting: () => void;
  messages: ChatMessage[];
  appendMessage: (m: ChatMessage) => void;
  status: ChatStatus;
  setStatus: (s: ChatStatus) => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChatContext must be used within ChatProvider');
  return ctx;
}

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [enabledForMeeting, setEnabledForMeeting] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>({ kind: 'idle' });

  const appendMessage = useCallback((m: ChatMessage) => {
    setMessages(prev => [...prev, m]);
  }, []);

  const resetForMeeting = useCallback(() => {
    setMessages([]);
    setStatus({ kind: 'idle' });
  }, []);

  const value = useMemo<ChatContextValue>(
    () => ({
      enabledForMeeting,
      setEnabledForMeeting,
      resetForMeeting,
      messages,
      appendMessage,
      status,
      setStatus,
    }),
    [enabledForMeeting, resetForMeeting, messages, appendMessage, status]
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}
