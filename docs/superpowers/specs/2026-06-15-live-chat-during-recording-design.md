# Live Chat During Recording — Design

## Summary

Add a chat panel that appears during recording, letting the user ask questions
about what has been discussed so far. An LLM answers using the live meeting
transcript as context. The conversation is multi-turn and is saved with the
meeting for later viewing.

This mirrors the existing **live-notes** feature, which is the closest analog:
an in-session feature that feeds transcript text to the LLM via a Tauri command
and persists a JSON artifact in the meeting folder.

## Decisions

| Aspect | Decision |
|--------|----------|
| Transcript context | **Whole meeting so far** — the full transcript from the start of recording up to now |
| Conversation memory | **Multi-turn** — prior Q&A is included so follow-ups work |
| Answer display | **Wait-then-show** — spinner, then the full answer (no token streaming) |
| Placement | **Panel beside the Live Notes panel** during recording |
| Persistence | **Saved with the meeting** as `chat.json` in the meeting folder; viewable later in meeting details |
| Model | **Reuses the existing configured model** (same resolution live-notes uses); no new settings UI in v1 |

## Key architectural choice: flatten history into the prompt

The shared Rust LLM function `summary::llm_client::generate_summary()` takes a
single system prompt + single user prompt — **not** a message array. It backs
every provider (OpenAI, Claude, Groq, Ollama, OpenRouter, BuiltInAI,
CustomOpenAI).

Rather than rebuild the LLM client to support native multi-turn message arrays
across all seven providers, we **flatten the conversation history and the full
transcript into the user prompt**. This delivers multi-turn memory and
whole-meeting context with zero changes to the LLM client and works uniformly
across every provider. In a wait-then-show UI there is no user-visible
difference from native message arrays.

The alternative (native message-array chat path in `llm_client`) was rejected:
significantly more plumbing, per-provider request shaping, for no v1 benefit.

## Architecture

### Rust — new `chat/` module (parallel to `live_notes/`)

New file `frontend/src-tauri/src/chat/mod.rs` exposing three Tauri commands,
registered in `lib.rs` alongside the live-notes commands.

```rust
#[tauri::command]
pub async fn api_ask_meeting<R: Runtime>(
    app: AppHandle<R>,
    meeting_id: String,            // ephemeral, for logging (matches live_notes)
    transcript: String,            // whole-meeting text, "[MM:SS] You/Other: ..."
    history: Vec<ChatMessage>,     // prior turns this session
    question: String,              // the new user question
    model_config: ChatModelConfig, // same shape as LiveNotesModelConfig
) -> Result<ChatMessage, String>;  // the assistant reply

#[tauri::command]
pub async fn api_save_chat(folder_path: String, session: ChatSession) -> Result<(), String>;

#[tauri::command]
pub async fn api_get_chat(folder_path: String) -> Result<Option<ChatSession>, String>;
```

- `api_ask_meeting` builds the prompt (below), calls `generate_summary` with a
  60-second timeout (generous because whole-meeting prompts are large), returns
  the assistant `ChatMessage` with `timestamp: Utc::now()`. On timeout or
  provider error it returns `Err(String)`.
- `api_save_chat` writes `<folder_path>/chat.json` using the atomic
  temp-file + rename pattern from `live_notes::api_save_live_notes`.
- `api_get_chat` reads and parses `<folder_path>/chat.json`, returning `None`
  when the file is absent.

**Prompt construction:**

System prompt:
> You answer the user's questions about an ongoing meeting, using only the
> meeting transcript provided. In the transcript, lines starting with "You:" are
> the user you are helping; lines starting with "Other:" are other participants.
> Answer concisely. If the answer is not in the transcript, say you don't see it
> discussed rather than guessing.

User prompt (single string):
```
Meeting transcript so far:
<transcript>

Conversation so far:
You: <history[0].content>
Assistant: <history[1].content>
... (prior turns)

New question:
<question>
```

`generate_summary` params: `max_tokens` ~800, `temperature` ~0.3,
`top_p` ~0.9. No JSON parsing — the reply is free-form markdown text, trimmed.

### Data shapes (shared Rust serde + TS interface)

```ts
interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string; // ISO datetime
}
interface ChatSession {
  messages: ChatMessage[];
}
```

`chat.json` on disk is a serialized `ChatSession`.

### Frontend

- **`ChatContext`** (`frontend/src/contexts/ChatContext.tsx`) — holds
  `messages: ChatMessage[]` for the current session and a `status`
  (idle / asking / error), keyed to the current meeting. Reset when a new
  recording starts.
- **`useLiveChat` hook** (`frontend/src/hooks/useLiveChat.ts`) — exposes
  `ask(question)`:
  1. Build whole-meeting transcript text from `TranscriptContext`
     (reuse/extend the formatter `useLiveNotes` uses, without the 5-minute
     window cap).
  2. Append the user `ChatMessage` to context (optimistic).
  3. Set status `asking`; invoke `api_ask_meeting` with the current history
     (excluding the just-added user message, which is passed as `question`).
  4. On success append the assistant reply; on error set `status: error` and
     keep the typed question recoverable (do not clear the input).

  Also listens for `recording-stopped`; if messages exist and a `folder_path`
  is provided, calls `api_save_chat(folderPath, { messages })`.
- **`chatService`** (`frontend/src/services/chatService.ts`) — thin `invoke`
  wrappers for the three commands (mirrors `liveNotesService`).
- **`ChatPanel`** (`frontend/src/components/Chat/ChatPanel.tsx`) — message list
  + text input + send button, placed next to the Live Notes panel during
  recording. User bubbles right-aligned, assistant bubbles rendered with the
  already-installed `react-markdown` + `remark-gfm`. A "thinking…" spinner
  (reuse the live-notes status `Loader2` pattern) shows while `status==='asking'`.
  Enter sends; Shift+Enter inserts a newline.
- **`ChatViewerPanel`** (`frontend/src/components/MeetingDetails/ChatViewerPanel.tsx`)
  + **`useSavedChat(folderPath)`** (`frontend/src/hooks/meeting-details/useSavedChat.ts`)
  — read-only render of saved Q&A as a new tab in the meeting-details page
  (parallel to `LiveNotesViewerPanel`). The tab is omitted when `chat.json`
  is absent.

### Meeting identity

Same model as live notes: `meeting_id` is passed through for logging only; the
durable link is the **`folder_path`** emitted by `recording-stopped` and stored
in the `meetings` table. Saving and later loading are both folder-based.

## Error handling

- LLM timeout (60s) or provider error → `api_ask_meeting` returns `Err`; the
  hook sets `status: error`, shows an inline error bubble/notice, and preserves
  the user's typed question so they can retry. Input remains usable.
- No model configured / missing API key → surfaced as the same error path with
  a clear message (reuse the model-config resolution and its existing error
  text from the live-notes path).
- Save-on-stop failure → logged as a warning (matches live-notes); does not
  block recording teardown.
- Empty transcript (user asks before anyone has spoken) → still call the LLM;
  the system prompt instructs it to say nothing has been discussed yet.

## Testing

- **Rust** (`chat/mod.rs` unit tests): prompt builder produces expected string
  for empty history, single turn, and multi-turn; reply trimming; `api_get_chat`
  returns `None` for a missing file and round-trips a saved `ChatSession`.
- **Frontend**: `useLiveChat` assembles whole-meeting transcript text correctly,
  appends user then assistant messages in order, and on error keeps the question
  and sets error status. Test behavior via the hook's public surface, mocking
  the `invoke` boundary only.

## Out of scope (v1)

Token streaming; per-chat model picker; editing/deleting messages; separate
chat export; chat after recording has stopped (post-stop view is read-only).
Each is straightforward to add later without reworking this design.
