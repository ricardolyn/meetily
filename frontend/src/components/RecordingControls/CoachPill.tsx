'use client';

import { Lightbulb } from 'lucide-react';
import { useCoachContext } from '@/contexts/CoachContext';

interface Props {
  /** True while a recording is active; pill is hidden otherwise. */
  isRecording: boolean;
}

export function CoachPill({ isRecording }: Props) {
  const { enabledForMeeting, setEnabledForMeeting } = useCoachContext();

  if (!isRecording) return null;

  return (
    <button
      onClick={() => setEnabledForMeeting(!enabledForMeeting)}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border ${
        enabledForMeeting
          ? 'bg-blue-50 text-blue-700 border-blue-200'
          : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
      }`}
      title="Suggestions for what to say next"
    >
      <Lightbulb className="w-3.5 h-3.5" />
      <span>Coach</span>
    </button>
  );
}
