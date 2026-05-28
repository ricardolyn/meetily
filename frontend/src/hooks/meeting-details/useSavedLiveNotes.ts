import { useEffect, useState } from 'react';
import { liveNotesService, type LiveNotes } from '@/services/liveNotesService';

/**
 * Load a meeting's persisted `live_notes.json` if it exists. Returns
 * `null` while loading or when the meeting has no saved live notes.
 */
export function useSavedLiveNotes(folderPath: string | null | undefined): {
  notes: LiveNotes | null;
  loading: boolean;
} {
  const [notes, setNotes] = useState<LiveNotes | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!folderPath) {
      setNotes(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    liveNotesService
      .load(folderPath)
      .then(result => {
        if (cancelled) return;
        setNotes(result);
      })
      .catch(() => {
        if (cancelled) return;
        setNotes(null);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [folderPath]);

  return { notes, loading };
}
