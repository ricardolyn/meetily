'use client';

import { useEffect, useRef, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { LiveNotesPanel } from '@/components/LiveNotes/LiveNotesPanel';
import { CoachPanel } from '@/components/Coach/CoachPanel';
import { useLiveNotesContext } from '@/contexts/LiveNotesContext';
import { useCoachContext } from '@/contexts/CoachContext';
import type { SidePanelState } from '@/hooks/useSidePanelWindow';

type SidePanelTab = 'notes' | 'coach';

interface Props {
  /** When true, runs inside the main window (state from context). */
  inline?: boolean;
}

/** The live side panel: a tab per feature that is on (Live notes, Coach). */
export function SidePanel({ inline = false }: Props) {
  if (inline) return <InlineSidePanel />;
  return <FloatingSidePanel />;
}

function InlineSidePanel() {
  const { enabledForMeeting: notesEnabled } = useLiveNotesContext();
  const { enabledForMeeting: coachEnabled } = useCoachContext();
  const [tab, setTab] = useActiveTab(notesEnabled, coachEnabled);
  const tabs = (
    <PanelTabs notesOn={notesEnabled} coachOn={coachEnabled} active={tab} onChange={setTab} />
  );

  return tab === 'coach' ? <CoachPanel inline tabs={tabs} /> : <LiveNotesPanel inline tabs={tabs} />;
}

function FloatingSidePanel() {
  const [state, setState] = useState<SidePanelState>({ notesEnabled: false, coachEnabled: false });
  const [tab, setTab] = useActiveTab(state.notesEnabled, state.coachEnabled);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      const u = await listen<SidePanelState>('side-panel-state', event => {
        setState(event.payload);
      });
      if (cancelled) { u(); return; }
      unlisten = u;
      // Ask the main window for the current tabs and content now that we
      // are listening (it may have emitted before this window mounted).
      void emit('side-panel-state-request').catch(() => {});
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  if (!state.notesEnabled && !state.coachEnabled) {
    return <p className="p-3 text-xs text-gray-400 italic">Waiting for the main window…</p>;
  }

  const tabs = (
    <PanelTabs
      notesOn={state.notesEnabled}
      coachOn={state.coachEnabled}
      active={tab}
      onChange={setTab}
    />
  );

  // Both stay mounted: each keeps its last content from events while hidden.
  return (
    <>
      <div className="h-full" hidden={tab !== 'notes'}>
        <LiveNotesPanel tabs={tabs} />
      </div>
      <div className="h-full" hidden={tab !== 'coach'}>
        <CoachPanel tabs={tabs} />
      </div>
    </>
  );
}

/**
 * Which tab to show. Switches to a feature when it is turned on, and away
 * from one when it is turned off (Coach wins if both turn on together).
 */
function useActiveTab(
  notesOn: boolean,
  coachOn: boolean
): [SidePanelTab, (tab: SidePanelTab) => void] {
  const [tab, setTab] = useState<SidePanelTab>(coachOn ? 'coach' : 'notes');
  const previous = useRef({ notesOn, coachOn });

  useEffect(() => {
    const was = previous.current;
    previous.current = { notesOn, coachOn };
    if (coachOn && !was.coachOn) {
      setTab('coach');
      return;
    }
    if (notesOn && !was.notesOn) {
      setTab('notes');
      return;
    }
    setTab(current => {
      if (current === 'coach' && !coachOn && notesOn) return 'notes';
      if (current === 'notes' && !notesOn && coachOn) return 'coach';
      return current;
    });
  }, [notesOn, coachOn]);

  return [tab, setTab];
}

function PanelTabs({
  notesOn,
  coachOn,
  active,
  onChange,
}: {
  notesOn: boolean;
  coachOn: boolean;
  active: SidePanelTab;
  onChange: (tab: SidePanelTab) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {notesOn && (
        <TabButton active={active === 'notes'} onClick={() => onChange('notes')}>
          Live notes
        </TabButton>
      )}
      {coachOn && (
        <TabButton active={active === 'coach'} onClick={() => onChange('coach')}>
          Coach
        </TabButton>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'rounded-md px-2 py-0.5 text-sm font-medium transition-colors ' +
        (active ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800')
      }
    >
      {children}
    </button>
  );
}
