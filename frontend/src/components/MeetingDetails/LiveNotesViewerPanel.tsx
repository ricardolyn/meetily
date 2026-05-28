'use client';

import type { LiveNotes } from '@/services/liveNotesService';

interface Props {
  notes: LiveNotes;
}

export function LiveNotesViewerPanel({ notes }: Props) {
  return (
    <div className="flex flex-col h-full bg-white">
      <header className="px-6 py-4 border-b border-gray-200">
        <h2 className="text-base font-semibold text-gray-900">Live notes</h2>
        <p className="text-xs text-gray-500 mt-1">
          Captured during the meeting · last updated {formatTime(notes.generated_at)}
        </p>
      </header>
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
        <Section title="Right now">
          {notes.right_now ? (
            <p className="text-gray-800 leading-relaxed">{notes.right_now}</p>
          ) : (
            <Empty />
          )}
        </Section>

        <Section title="Asked of you">
          {notes.asked_of_you.length > 0 ? (
            <ul className="list-disc pl-5 text-gray-800 space-y-1">
              {notes.asked_of_you.map(item => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <Empty />
          )}
        </Section>

        <Section title="Action items">
          {notes.action_items.length > 0 ? (
            <ul className="list-disc pl-5 text-gray-800 space-y-1">
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
      <h3 className="text-xs uppercase tracking-wide text-gray-500 font-semibold mb-2">
        {title}
      </h3>
      {children}
    </div>
  );
}

function Empty() {
  return <p className="text-sm text-gray-400 italic">— none</p>;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
