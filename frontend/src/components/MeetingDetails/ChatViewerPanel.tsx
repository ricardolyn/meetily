'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage, ChatSession } from '@/services/chatService';

interface Props {
  session: ChatSession;
}

export function ChatViewerPanel({ session }: Props) {
  return (
    <div className="flex flex-col h-full bg-white">
      <header className="px-6 py-4 border-b border-gray-200">
        <h2 className="text-base font-semibold text-gray-900">Chat</h2>
        <p className="text-xs text-gray-500 mt-1">
          Questions you asked live during the meeting
        </p>
      </header>
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
        {session.messages.length === 0 ? (
          <p className="text-sm text-gray-400 italic">— none</p>
        ) : (
          session.messages.map((m, i) => <Bubble key={`${m.timestamp}-${i}`} message={m} />)
        )}
      </div>
    </div>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={
          'max-w-[80%] rounded-lg px-3 py-2 text-sm ' +
          (isUser ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-800')
        }
      >
        {isUser ? (
          <p className="whitespace-pre-wrap leading-relaxed">{message.content}</p>
        ) : (
          <div className="prose prose-sm max-w-none leading-relaxed [&_p]:my-1 [&_ul]:my-1 [&_li]:my-0">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
