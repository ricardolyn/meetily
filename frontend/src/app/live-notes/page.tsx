'use client';

import { LiveNotesPanel } from '@/components/LiveNotes/LiveNotesPanel';

export default function LiveNotesPage() {
  // The floating window loads this route. The panel listens for events
  // emitted by the main window's useLiveNotes hook.
  return (
    <div className="h-screen w-screen overflow-hidden bg-white">
      <LiveNotesPanel />
    </div>
  );
}
