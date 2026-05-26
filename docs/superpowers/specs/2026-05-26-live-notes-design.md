# Live Notes — Design Spec

**Date:** 2026-05-26
**Status:** Approved for implementation
**Owner:** ricardolyn

## Problem

During a meeting the user is often focused on the call window (Zoom / Meet / Teams) with Meetily hidden behind it. If they zone out for a moment or get asked something unexpected ("what did we decide last week about X?"), they have nothing immediate to glance at — the existing summary only runs after the meeting ends. They want a small, always-visible panel that quietly maintains the most recent context.

## Goals

- Surface, in near real-time, what is being discussed, what has been asked of the user, and the running list of action items, while a meeting is being recorded.
- Stay visible above the call window without taking screen real estate.
- Be opt-in globally and individually controllable per meeting.
- Do not interfere with the existing manual saved-summary flow.

## Non-goals

- Persisting live notes to disk or DB (runtime-only; the saved summary remains authoritative).
- Full speaker diarization beyond what's already in `transcripts.json`.
- Multi-language; we inherit whatever the configured LLM supports.

## UI

### Floating window

A second Tauri window declared in `tauri.conf.json`:

```jsonc
{
  "label": "live-notes",
  "title": "Live notes",
  "alwaysOnTop": true,
  "decorations": false,
  "transparent": false,
  "resizable": true,
  "width": 320,
  "height": 480,
  "minWidth": 280,
  "minHeight": 320,
  "visible": false
}
```

Hidden by default; the main app calls `window.show()` when recording starts AND live-notes is active for the meeting, `window.hide()` when recording stops or the user pauses. Stays loaded so position is preserved between meetings.

### Layout

Three vertically-stacked sections, scrollable as a unit:

```
┌─ Live notes • updated 14:32:05 [⟳] [×] ─┐
│ Right now                                │
│   <1–2 sentences>                        │
├──────────────────────────────────────────┤
│ Asked of you                             │
│   • <bullet>                             │
├──────────────────────────────────────────┤
│ Action items so far                      │
│   • <bullet>                             │
└──────────────────────────────────────────┘
```

Header has a refresh-now button (`⟳`) and a pause-for-this-meeting button (`×`). When a refresh is in flight, the timestamp shows a small spinner instead of the time.

### Per-meeting control in the main app

A `Live Notes` pill inside the recording controls bar (`RecordingControls.tsx`), visible only during active recording. States:

- `Off` (gray)
- `On · <interval>` (blue)
- `Refreshing…` (animated)

Click toggles on/off for the current meeting, overriding the global default. A `▾` opens a menu: **Refresh now**, **Change interval (this meeting)**, **Open floating window**.

## Settings

New section in `PreferenceSettings.tsx`:

| Setting | Type | Default |
|---|---|---|
| Run automatically when recording | bool | `false` |
| Refresh interval | enum (30 s, 1 min, 2 min, 5 min, 10 min) | 1 min |
| Provider | enum (`inherit`, `ollama`, `claude`, `openai`, `groq`, `openrouter`) | `inherit` |
| Model | string | `null` (use saved-summary model when `provider = inherit`) |

Persisted via `tauri-plugin-store` under the key `liveNotes` alongside existing recording prefs. Read/write through two new Tauri commands `api_get_live_notes_settings` / `api_set_live_notes_settings`.

Per-meeting overrides live in React component state only; reset on the next recording.

## Backend

### New module

`frontend/src-tauri/src/live_notes/mod.rs` exposes a single command:

```rust
#[tauri::command]
pub async fn api_generate_live_notes(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    recent_transcripts: String,
    previous_notes: Option<LiveNotes>,
    model_config: LiveNotesModelConfig,
) -> Result<LiveNotes, String>;
```

`LiveNotes` struct:

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LiveNotes {
    pub right_now: String,
    pub asked_of_you: Vec<String>,
    pub action_items: Vec<String>,
    pub generated_at: DateTime<Utc>,
}
```

`LiveNotesModelConfig`:

```rust
pub struct LiveNotesModelConfig {
    pub provider: String,    // e.g. "ollama", "claude", "openai"
    pub model: String,
    pub api_key: Option<String>,
    pub ollama_endpoint: Option<String>,
}
```

When the frontend settings say `provider = "inherit"`, the frontend resolves the saved-summary config and passes those values; the backend never deals with `inherit`.

### Isolation from saved summary

The command MUST NOT touch any of: `summary_processes`, `transcripts`, `transcript_chunks`, `meetings`. It does not write any files to disk. The result lives only in runtime state and in events emitted to the live-notes window. This guarantees the saved summary (and any user edits to it) is never overwritten by a live-notes tick.

### LLM call

Reuse the existing `summary::llm_client::LLMProvider` abstraction. Build a single-turn chat with the prompt below; ask the provider for JSON-mode output when supported (`format: json` for Ollama, `response_format` for OpenAI/Anthropic). Parse the response into `LiveNotes`; on parse failure, return an error so the frontend can surface a non-fatal warning and keep the previous notes visible.

### Prompt

```
You are taking live notes during a meeting for someone who may briefly
step away. Be concise and scannable. Output ONLY a JSON object with keys
"right_now" (string, 1–2 sentences), "asked_of_you" (array of strings,
empty if nothing), "action_items" (array of strings).

For "asked_of_you", include only questions or asks directed at the user
that have not yet been answered.

For "action_items", carry forward and de-duplicate items from the
previous notes below, and add new ones. Each item ≤ 12 words.

Previous notes:
{previous_notes_json or "none yet"}

Recent transcript:
{recent_transcripts}
```

### Frontend timer

New hook `useLiveNotes(meetingId)` consumed by the recording page:

- Active condition: `isRecording && liveNotesEnabledForThisMeeting`
- `setInterval(tick, intervalMs)` cleared on stop or toggle-off
- `tick()`:
  1. Skip if the previous tick is still in flight (single-flight guard)
  2. Build the recent-transcripts string from `useTranscripts` — the last `min(intervalMs * 3, 5 minutes)` of segments
  3. Skip if zero new segments since last tick
  4. Call `api_generate_live_notes` with the resolved model config and the previous `LiveNotes`
  5. On success, update local state and emit a `live-notes-update` event with the payload
  6. On failure, log + show a subtle warning in the floating window header; keep previous state

The floating window listens for `live-notes-update` and renders.

## Cost / perf

Per tick: ~300–600 input tokens + ~150–250 output tokens.

| Provider | ~$/hour @ 60s interval | Latency per tick |
|---|---|---|
| Ollama (local, gemma2:2b or similar) | $0 | 3–15 s |
| Claude Haiku | ~$0.07 | ~1 s |
| GPT-4o-mini | ~$0.05 | ~1 s |
| Claude Sonnet / GPT-4o | ~$0.30–$0.50 | ~2 s |

Safeguards: single-flight skip, zero-new-segment skip, 30 s hard timeout per call.

## Verification

- **Backend isolated test**: `api_generate_live_notes` against a stub LLM that returns canned JSON → assert parsing, dedup behaviour for `action_items` when previous notes are supplied.
- **End-to-end manual**: start a recording, enable live notes, talk through three rotating topics with a few action items; confirm the floating window updates within one interval of each topic shift and that action items accumulate without duplicates.
- **Failure mode**: kill the local Ollama process mid-recording; the next tick should error gracefully, the floating window should show a subtle "couldn't refresh" indicator, and recording itself should continue uninterrupted.
- **Cost regression**: log input + output token counts per call for the first session and confirm they stay within the budget above.

## Out of scope (deferred)

- Live notes in non-floating layouts (e.g. embedding in the main app's transcript panel). Possible follow-up.
- Persisting live notes (could be added if users explicitly request a "save snapshot" button).
- Speaker-aware live notes (depends on speaker attribution being persisted and reliable, which is partially done but not yet exposed here).
