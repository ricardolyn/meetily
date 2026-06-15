import { useEffect, useState } from 'react';
import { chatService, type ChatSession } from '@/services/chatService';

/**
 * Load a meeting's persisted `chat.json` if it exists. Returns `null` while
 * loading or when the meeting has no saved chat.
 */
export function useSavedChat(folderPath: string | null | undefined): {
  session: ChatSession | null;
  loading: boolean;
} {
  const [session, setSession] = useState<ChatSession | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!folderPath) {
      setSession(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    chatService
      .load(folderPath)
      .then(result => {
        if (cancelled) return;
        setSession(result);
      })
      .catch(() => {
        if (cancelled) return;
        setSession(null);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [folderPath]);

  return { session, loading };
}
