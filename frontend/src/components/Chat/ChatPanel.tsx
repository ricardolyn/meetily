'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Send, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useChatContext } from '@/contexts/ChatContext';
import type { ChatMessage } from '@/services/chatService';

interface Props {
  /** Sends a question; resolves once the answer (or error) has landed. */
  ask: (question: string) => Promise<void>;
}

export function ChatPanel({ ask }: Props) {
  const { messages, status, setEnabledForMeeting } = useChatContext();
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const isAsking = status.kind === 'asking';

  // Keep the latest message in view as the conversation grows.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, status.kind]);

  const send = () => {
    const q = draft.trim();
    if (!q || isAsking) return;
    setDraft('');
    void ask(q);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="flex flex-col h-full text-sm">
      <header className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 bg-gray-50">
        <span className="flex-1 font-medium text-gray-700">Ask this meeting</span>
        {status.kind === 'error' && (
          <span className="text-xs text-amber-600" title={status.message}>
            {/timed out/i.test(status.message) ? 'took too long' : 'failed'}
          </span>
        )}
        <button
          onClick={() => setEnabledForMeeting(false)}
          className="text-gray-500 hover:text-gray-800"
          title="Close chat for this meeting"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && status.kind !== 'asking' && (
          <p className="text-xs text-gray-400 italic">
            Ask a question about what&apos;s been discussed so far.
          </p>
        )}
        {messages.map((m, i) => (
          <Bubble key={`${m.timestamp}-${i}`} message={m} />
        ))}
        {isAsking && (
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            thinking…
          </div>
        )}
        {status.kind === 'error' && (
          <p className="text-xs text-amber-600">{status.message}</p>
        )}
      </div>

      <div className="border-t border-gray-200 p-2">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder="Ask about the meeting…"
            className="flex-1 resize-none rounded-md border border-gray-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
          <button
            onClick={send}
            disabled={!draft.trim() || isAsking}
            className="inline-flex items-center justify-center rounded-md bg-blue-600 text-white w-8 h-8 disabled:opacity-40 hover:bg-blue-700"
            title="Send"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
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
          'max-w-[85%] rounded-lg px-3 py-2 ' +
          (isUser ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-800')
        }
      >
        {isUser ? (
          <p className="whitespace-pre-wrap leading-snug">{message.content}</p>
        ) : (
          <div className="prose prose-sm max-w-none leading-snug [&_p]:my-1 [&_ul]:my-1 [&_li]:my-0">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
