'use client';

import { useEffect, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { Loader2, PanelRightClose, RefreshCw, Square, X } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { useCoachContext, type CoachStatus } from '@/contexts/CoachContext';
import { useLiveNotesContext } from '@/contexts/LiveNotesContext';
import type { CoachSuggestion } from '@/services/coachService';

interface Props {
  /** When true, runs inside the main window (state from context). */
  inline?: boolean;
  /** Side-panel tab switcher shown as the header title. */
  tabs: React.ReactNode;
}

export function CoachPanel({ inline = false, tabs }: Props) {
  if (inline) return <InlineCoachPanel tabs={tabs} />;
  return <FloatingCoachPanel tabs={tabs} />;
}

function InlineCoachPanel({ tabs }: { tabs: React.ReactNode }) {
  const { context, setContext, latest, status, refresh, setEnabledForMeeting } =
    useCoachContext();
  const { setPanelMode } = useLiveNotesContext();

  return (
    <CoachChrome
      tabs={tabs}
      status={status}
      suggestion={latest}
      onRefresh={refresh}
      onClose={() => setEnabledForMeeting(false)}
      extraAction={{
        icon: <Square className="w-3.5 h-3.5" />,
        title: 'Pop out to floating window',
        onClick: () => setPanelMode('floating'),
      }}
    >
      <ContextEditor value={context} onChange={setContext} />
    </CoachChrome>
  );
}

function FloatingCoachPanel({ tabs }: { tabs: React.ReactNode }) {
  const [suggestion, setSuggestion] = useState<CoachSuggestion | null>(null);
  const [status, setStatus] = useState<CoachStatus>({ kind: 'idle' });

  useEffect(() => {
    // `cancelled` guards against unmounting before listen() resolves.
    let cancelled = false;
    const unlistens: Array<() => void> = [];
    (async () => {
      const u1 = await listen<CoachSuggestion>('coach-update', event => {
        setSuggestion(event.payload);
        setStatus({ kind: 'ok', at: event.payload.generated_at });
      });
      if (cancelled) { u1(); return; }
      unlistens.push(u1);

      const u2 = await listen<void>('coach-refreshing', () => {
        setStatus({ kind: 'refreshing' });
      });
      if (cancelled) { u2(); return; }
      unlistens.push(u2);

      const u3 = await listen<string>('coach-error', event => {
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
    <CoachChrome
      tabs={tabs}
      status={status}
      suggestion={suggestion}
      onRefresh={() => { void emit('coach-refresh-request').catch(() => {}); }}
      onClose={() => { void emit('coach-close-request').catch(() => {}); }}
      extraAction={{
        icon: <PanelRightClose className="w-3.5 h-3.5" />,
        title: 'Dock back to side panel',
        onClick: () => { void emit('live-notes-dock-request').catch(() => {}); },
      }}
    />
  );
}

interface CoachChromeProps {
  tabs: React.ReactNode;
  status: CoachStatus;
  suggestion: CoachSuggestion | null;
  onRefresh: () => void;
  onClose: () => void;
  extraAction: { icon: React.ReactNode; title: string; onClick: () => void };
  /** Extra content above the suggestion (the context editor, main window only). */
  children?: React.ReactNode;
}

function CoachChrome({
  tabs,
  status,
  suggestion,
  onRefresh,
  onClose,
  extraAction,
  children,
}: CoachChromeProps) {
  const isRefreshing = status.kind === 'refreshing';

  return (
    <div className="flex flex-col h-full text-sm">
      <header className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 bg-gray-50">
        <div className="flex-1 min-w-0">{tabs}</div>
        <span className="text-xs text-gray-500">
          {status.kind === 'ok' && `updated ${formatTime(status.at)}`}
        </span>
        <button
          onClick={extraAction.onClick}
          className="text-gray-500 hover:text-gray-800"
          title={extraAction.title}
        >
          {extraAction.icon}
        </button>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-800"
          title="Turn off Coach for this meeting"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {children}
        <SuggestionView suggestion={suggestion} isRefreshing={isRefreshing} />
        {status.kind === 'error' && (
          <p className="text-xs text-amber-600" title={status.message}>
            {/timed out/i.test(status.message) ? 'The model took too long. Try again.' : status.message}
          </p>
        )}
      </div>

      <div className="border-t border-gray-200 p-2">
        <button
          onClick={onRefresh}
          disabled={isRefreshing}
          className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {isRefreshing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4" />
          )}
          {isRefreshing ? 'Thinking…' : 'Suggest what to say'}
        </button>
      </div>
    </div>
  );
}

function SuggestionView({
  suggestion,
  isRefreshing,
}: {
  suggestion: CoachSuggestion | null;
  isRefreshing: boolean;
}) {
  if (!suggestion) {
    return (
      <p className="text-xs text-gray-400 italic">
        {isRefreshing
          ? 'Reading the conversation…'
          : 'Click “Suggest what to say” whenever you want a hint.'}
      </p>
    );
  }

  return (
    <div className={`space-y-4 ${isRefreshing ? 'opacity-60' : ''}`}>
      {suggestion.reply && (
        <Section title="Say next">
          <p className="rounded-md bg-blue-50 border border-blue-100 px-3 py-2 text-gray-900 leading-snug">
            {suggestion.reply}
          </p>
        </Section>
      )}
      {suggestion.talking_points.length > 0 && (
        <Section title="Talking points">
          <ul className="list-disc list-inside text-gray-800 space-y-1">
            {suggestion.talking_points.map(point => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function ContextEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(value.trim().length === 0);

  return (
    <Section
      title="Context"
      action={
        <button
          onClick={() => setEditing(!editing)}
          className="text-xs text-blue-600 hover:text-blue-800"
        >
          {editing ? 'Done' : 'Edit'}
        </button>
      }
    >
      {editing ? (
        <Textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          rows={6}
          placeholder="Who you're talking to, your goal, anything to keep in mind (job description, CV, agenda…)"
          className="text-xs"
        />
      ) : (
        <p className="text-xs text-gray-600 whitespace-pre-wrap line-clamp-3">
          {value.trim() || 'No context yet. Add some for better suggestions.'}
        </p>
      )}
    </Section>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-xs uppercase tracking-wide text-gray-500 font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
