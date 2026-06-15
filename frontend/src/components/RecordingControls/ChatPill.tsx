'use client';

import { MessageSquare } from 'lucide-react';
import { useChatContext } from '@/contexts/ChatContext';

interface Props {
  /** True while a recording is active; pill is hidden otherwise. */
  isRecording: boolean;
}

export function ChatPill({ isRecording }: Props) {
  const { enabledForMeeting, setEnabledForMeeting } = useChatContext();

  if (!isRecording) return null;

  return (
    <button
      onClick={() => setEnabledForMeeting(!enabledForMeeting)}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border ${
        enabledForMeeting
          ? 'bg-blue-50 text-blue-700 border-blue-200'
          : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
      }`}
      title="Ask questions about this meeting"
    >
      <MessageSquare className="w-3.5 h-3.5" />
      <span>Ask</span>
    </button>
  );
}
