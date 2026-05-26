'use client';

import { useEffect, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { Loader2, RefreshCw, X } from 'lucide-react';

interface LiveNotes {
  right_now: string;
  asked_of_you: string[];
  action_items: string[];
  generated_at: string;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'refreshing' }
  | { kind: 'ok'; at: string }
  | { kind: 'error'; message: string };

export function LiveNotesPanel() {
  const [notes, setNotes] = useState<LiveNotes | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  useEffect(() => {
    const unlistens: Array<() => void> = [];
    (async () => {
      unlistens.push(
        await listen<LiveNotes>('live-notes-update', event => {
          setNotes(event.payload);
          setStatus({ kind: 'ok', at: event.payload.generated_at });
        })
      );
      unlistens.push(
        await listen<void>('live-notes-refreshing', () => {
          setStatus({ kind: 'refreshing' });
        })
      );
      unlistens.push(
        await listen<string>('live-notes-error', event => {
          setStatus({ kind: 'error', message: event.payload });
        })
      );
    })();
    return () => {
      for (const u of unlistens) u();
    };
  }, []);

  async function refreshNow() {
    // Ask the main window's useLiveNotes hook to fire a tick out-of-band.
    await emit('live-notes-refresh-request').catch(() => {});
  }

  async function pauseForMeeting() {
    // Tell the main window to disable live notes for the current meeting.
    await emit('live-notes-pause-request').catch(() => {});
  }

  return (
    <div className="flex flex-col h-full text-sm">
      <header className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 bg-gray-50">
        <span className="flex-1 font-medium text-gray-700">Live notes</span>
        <span className="text-xs text-gray-500">
          {status.kind === 'refreshing' && (
            <Loader2 className="w-3.5 h-3.5 animate-spin inline" />
          )}
          {status.kind === 'ok' && `updated ${formatTime(status.at)}`}
          {status.kind === 'error' && (
            <span className="text-amber-600" title={status.message}>
              refresh failed
            </span>
          )}
        </span>
        <button
          onClick={refreshNow}
          className="text-gray-500 hover:text-gray-800"
          title="Refresh now"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={pauseForMeeting}
          className="text-gray-500 hover:text-gray-800"
          title="Pause for this meeting"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        <Section title="Right now">
          {notes?.right_now ? (
            <p className="text-gray-800 leading-snug">{notes.right_now}</p>
          ) : (
            <Empty />
          )}
        </Section>

        <Section title="Asked of you">
          {notes && notes.asked_of_you.length > 0 ? (
            <ul className="list-disc list-inside text-gray-800 space-y-1">
              {notes.asked_of_you.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          ) : (
            <Empty />
          )}
        </Section>

        <Section title="Action items so far">
          {notes && notes.action_items.length > 0 ? (
            <ul className="list-disc list-inside text-gray-800 space-y-1">
              {notes.action_items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          ) : (
            <Empty />
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs uppercase tracking-wide text-gray-500 font-semibold mb-1">
        {title}
      </h3>
      {children}
    </div>
  );
}

function Empty() {
  return <p className="text-xs text-gray-400 italic">— nothing yet</p>;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
