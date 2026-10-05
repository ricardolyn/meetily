'use client';

import { SidePanel } from '@/components/SidePanel/SidePanel';

export default function LiveNotesPage() {
  // The floating window loads this route. The panel listens for events
  // emitted by the main window (useSidePanelWindow, useLiveNotes, useCoach).
  return (
    <div className="h-screen w-screen overflow-hidden bg-white">
      <SidePanel />
    </div>
  );
}
