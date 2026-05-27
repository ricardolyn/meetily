'use client';

import { useEffect, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { Loader2, PanelRightClose, RefreshCw, Square, X } from 'lucide-react';
import {
  useLiveNotesContext,
  type LiveNotesStatus,
} from '@/contexts/LiveNotesContext';

interface LiveNotes {
  right_now: string;
  asked_of_you: string[];
  action_items: string[];
  generated_at: string;
}

interface Props {
  /** When true, runs inside the main window (no Tauri events needed). */
  inline?: boolean;
}

export function LiveNotesPanel({ inline = false }: Props) {
  if (inline) return <InlineLiveNotesPanel />;
  return <FloatingLiveNotesPanel />;
}

function InlineLiveNotesPanel() {
  const { latest, status, refresh, setEnabledForMeeting, setPanelMode } =
    useLiveNotesContext();

  return (
    <PanelChrome
      status={status}
      onRefresh={refresh}
      onPause={() => setEnabledForMeeting(false)}
      extraAction={{
        icon: <Square className="w-3.5 h-3.5" />,
        title: 'Pop out to floating window',
        onClick: () => setPanelMode('floating'),
      }}
      notes={latest}
    />
  );
}

function FloatingLiveNotesPanel() {
  const [notes, setNotes] = useState<LiveNotes | null>(null);
  const [status, setStatus] = useState<LiveNotesStatus>({ kind: 'idle' });

  useEffect(() => {
    // `cancelled` guards against unmounting before listen() resolves,
    // otherwise the cleanup runs on a partial array and leaks listeners.
    let cancelled = false;
    const unlistens: Array<() => void> = [];
    (async () => {
      const u1 = await listen<LiveNotes>('live-notes-update', event => {
        setNotes(event.payload);
        setStatus({ kind: 'ok', at: event.payload.generated_at });
      });
      if (cancelled) { u1(); return; }
      unlistens.push(u1);

      const u2 = await listen<void>('live-notes-refreshing', () => {
        setStatus({ kind: 'refreshing' });
      });
      if (cancelled) { u2(); return; }
      unlistens.push(u2);

      const u3 = await listen<string>('live-notes-error', event => {
        setStatus({ kind: 'error', message: event.payload });
      });
      if (cancelled) { u3(); return; }
      unlistens.push(u3);
    })();
    return () => {
      cancelled = true;
      for (const u of unlistens) u();
    };
  }, []);

  return (
    <PanelChrome
      status={status}
      onRefresh={() => { void emit('live-notes-refresh-request').catch(() => {}); }}
      onPause={() => { void emit('live-notes-pause-request').catch(() => {}); }}
      extraAction={{
        icon: <PanelRightClose className="w-3.5 h-3.5" />,
        title: 'Dock back to side panel',
        onClick: () => { void emit('live-notes-dock-request').catch(() => {}); },
      }}
      notes={notes}
    />
  );
}

interface PanelChromeProps {
  status: LiveNotesStatus;
  onRefresh: () => void;
  onPause: () => void;
  extraAction?: { icon: React.ReactNode; title: string; onClick: () => void };
  notes: LiveNotes | null;
}

function PanelChrome({ status, onRefresh, onPause, extraAction, notes }: PanelChromeProps) {
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
              {/timed out/i.test(status.message) ? 'took too long' : 'refresh failed'}
            </span>
          )}
        </span>
        <button
          onClick={onRefresh}
          className="text-gray-500 hover:text-gray-800"
          title="Refresh now"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
        {extraAction && (
          <button
            onClick={extraAction.onClick}
            className="text-gray-500 hover:text-gray-800"
            title={extraAction.title}
          >
            {extraAction.icon}
          </button>
        )}
        <button
          onClick={onPause}
          className="text-gray-500 hover:text-gray-800"
          title="Turn off for this meeting"
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
              {notes.asked_of_you.map(item => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <Empty />
          )}
        </Section>

        <Section title="Action items so far">
          {notes && notes.action_items.length > 0 ? (
            <ul className="list-disc list-inside text-gray-800 space-y-1">
              {notes.action_items.map(item => (
                <li key={item}>{item}</li>
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
