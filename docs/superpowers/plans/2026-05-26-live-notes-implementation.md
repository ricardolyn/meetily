# Live Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in floating panel that auto-summarizes the in-progress meeting every N seconds (default 60), surfacing "Right now / Asked of you / Action items so far", with per-meeting manual override.

**Architecture:** New isolated Rust command `api_generate_live_notes` reuses the existing `summary::llm_client::generate_summary` helper but never touches DB tables or files — purely runtime, single-flight. A second Tauri window (`live-notes`, `alwaysOnTop`) renders the result. A React hook (`useLiveNotes`) drives the interval timer from the main app during recording. Settings persisted via `tauri-plugin-store`.

**Tech Stack:** Rust (Tauri 2.11, sqlx, tokio, reqwest), Next.js/React 18, `@tauri-apps/api/core` + `@tauri-apps/api/window`.

**Branch:** `feat/projects` (continuing). All commits go there; CI build via `gh workflow run build-macos.yml --repo ricardolyn/meetily --ref feat/projects -F sign-build=false -F build-type=release -F upload-artifacts=true`.

**Verification model:** No Rust unit tests exist in this repo; verification is manual through the running app after each task's CI build. Each task ends with a "Manual verification" subsection listing what to confirm.

---

## File map

**Create:**
- `frontend/src-tauri/src/live_notes/mod.rs` — `LiveNotes` struct, `LiveNotesModelConfig` struct, `api_generate_live_notes` Tauri command.
- `frontend/src/app/live-notes/page.tsx` — Next.js route that the floating window loads.
- `frontend/src/components/LiveNotes/LiveNotesPanel.tsx` — three-section display used by the floating window.
- `frontend/src/components/LiveNotesSettings.tsx` — settings UI (toggle, interval, model).
- `frontend/src/components/RecordingControls/LiveNotesPill.tsx` — the in-recording-controls pill.
- `frontend/src/hooks/useLiveNotes.ts` — interval timer, single-flight, settings/override resolution.
- `frontend/src/services/liveNotesService.ts` — TS wrapper around the Tauri command + store reads.
- `frontend/src/contexts/LiveNotesContext.tsx` — small context so RecordingControls and the floating window can share the latest result + per-meeting override toggle.

**Modify:**
- `frontend/src-tauri/src/lib.rs` — declare `pub mod live_notes`, register `api_generate_live_notes` in `invoke_handler!`.
- `frontend/src-tauri/tauri.conf.json` — add the `live-notes` window definition.
- `frontend/src/app/layout.tsx` — mount `LiveNotesProvider` in the provider tree.
- `frontend/src/app/page.tsx` (or wherever `RecordingControls` is rendered) — render `<LiveNotesPill />` inside the recording controls bar.
- `frontend/src/components/PreferenceSettings.tsx` — render `<LiveNotesSettings />` in the General tab.

---

## Risk callouts

| Task | Risk | Why |
|---|---|---|
| 1. Backend command | MEDIUM | First time gluing `generate_summary` into a non-summary path; LLM JSON parsing can fail. Fail-soft handling required. |
| 2. Floating window | LOW | Tauri config + a Next.js page, both well-trodden in this repo. |
| 3. Settings + store | LOW | Same pattern used by recording prefs. |
| 4. Wiring (timer + window show/hide) | HIGH | Coordinates window lifecycle, React state, recording state, and the per-meeting override. Where most bugs will live. |
| 5. Polish (refresh-now, error display, single-flight) | LOW | Incremental refinements after the wiring works. |

---

## Task 1 — Backend command (live_notes module)

**Files:**
- Create: `frontend/src-tauri/src/live_notes/mod.rs`
- Modify: `frontend/src-tauri/src/lib.rs` (add `pub mod live_notes;` near other modules; add `live_notes::api_generate_live_notes` to the `tauri::generate_handler!` list)

- [ ] **Step 1: Create the module**

Create `frontend/src-tauri/src/live_notes/mod.rs`:

```rust
// Live in-meeting notes. Runtime-only — never writes to DB or disk so it
// can never overwrite the saved summary. Called every N seconds from the
// frontend during an active recording.

use chrono::{DateTime, Utc};
use log::{error as log_error, info as log_info, warn as log_warn};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};
use tokio::time::{timeout, Duration};

use crate::state::AppState;
use crate::summary::llm_client::{generate_summary, LLMProvider};

/// Hard cap on a single LLM call. Prevents a stuck local model from
/// queuing requests forever.
const LLM_CALL_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveNotes {
    pub right_now: String,
    pub asked_of_you: Vec<String>,
    pub action_items: Vec<String>,
    pub generated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LiveNotesModelConfig {
    /// e.g. "ollama", "claude", "openai", "groq", "openrouter".
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub ollama_endpoint: Option<String>,
}

#[tauri::command]
pub async fn api_generate_live_notes<R: Runtime>(
    app: AppHandle<R>,
    _state: tauri::State<'_, AppState>,
    meeting_id: String,
    recent_transcripts: String,
    previous_notes: Option<LiveNotes>,
    model_config: LiveNotesModelConfig,
) -> Result<LiveNotes, String> {
    log_info!(
        "api_generate_live_notes called: meeting_id={}, transcripts_chars={}, provider={}, model={}",
        meeting_id,
        recent_transcripts.len(),
        model_config.provider,
        model_config.model
    );

    if recent_transcripts.trim().is_empty() {
        return Err("Recent transcripts are empty; nothing to summarize".to_string());
    }

    let provider = parse_provider(&model_config.provider)?;
    let system_prompt = SYSTEM_PROMPT.to_string();
    let user_prompt = build_user_prompt(&recent_transcripts, previous_notes.as_ref());

    let app_data_dir = app
        .path()
        .app_data_dir()
        .ok();

    let client = Client::new();
    let call_future = generate_summary(
        &client,
        &provider,
        &model_config.model,
        model_config.api_key.as_deref().unwrap_or(""),
        &system_prompt,
        &user_prompt,
        model_config.ollama_endpoint.as_deref(),
        None,           // custom_openai_endpoint
        Some(700),      // max_tokens — three short sections fit easily
        Some(0.2),      // temperature — keep it factual
        Some(0.9),      // top_p
        app_data_dir.as_ref(),
        None,           // cancellation_token
    );

    let raw = match timeout(LLM_CALL_TIMEOUT, call_future).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            log_error!("Live notes LLM call failed: {}", e);
            return Err(format!("LLM call failed: {}", e));
        }
        Err(_) => {
            log_warn!("Live notes LLM call exceeded {:?}; aborting", LLM_CALL_TIMEOUT);
            return Err("LLM call timed out".to_string());
        }
    };

    parse_llm_output(&raw)
}

fn parse_provider(name: &str) -> Result<LLMProvider, String> {
    match name.to_lowercase().as_str() {
        "ollama" => Ok(LLMProvider::Ollama),
        "claude" | "anthropic" => Ok(LLMProvider::Claude),
        "openai" => Ok(LLMProvider::OpenAI),
        "groq" => Ok(LLMProvider::Groq),
        "openrouter" => Ok(LLMProvider::OpenRouter),
        "builtin" | "builtinai" | "builtin_ai" => Ok(LLMProvider::BuiltInAI),
        other => Err(format!("Unsupported provider for live notes: {}", other)),
    }
}

const SYSTEM_PROMPT: &str =
    "You are taking live notes during a meeting for someone who may briefly step away. \
     Be concise and scannable. Output ONLY a JSON object with keys \
     \"right_now\" (string, 1-2 sentences), \
     \"asked_of_you\" (array of strings, empty if nothing), \
     \"action_items\" (array of strings). \
     For \"asked_of_you\", include only questions or asks directed at the user \
     that have not yet been answered. \
     For \"action_items\", carry forward and de-duplicate items from the \
     previous notes below, and add new ones. Each item must be 12 words or fewer.";

fn build_user_prompt(recent_transcripts: &str, previous: Option<&LiveNotes>) -> String {
    let previous_json = match previous {
        Some(p) => serde_json::to_string(&serde_json::json!({
            "right_now": p.right_now,
            "asked_of_you": p.asked_of_you,
            "action_items": p.action_items,
        }))
        .unwrap_or_else(|_| "none yet".to_string()),
        None => "none yet".to_string(),
    };

    format!(
        "Previous notes:\n{}\n\nRecent transcript:\n{}",
        previous_json, recent_transcripts
    )
}

fn parse_llm_output(raw: &str) -> Result<LiveNotes, String> {
    // LLM may wrap JSON in markdown code fences. Strip ```json … ``` if present.
    let cleaned = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let parsed: serde_json::Value = serde_json::from_str(cleaned)
        .map_err(|e| format!("LLM output is not valid JSON: {} (raw: {})", e, &raw[..raw.len().min(200)]))?;

    let right_now = parsed
        .get("right_now")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let asked_of_you = parsed
        .get("asked_of_you")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| s.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let action_items = parsed
        .get("action_items")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| s.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(LiveNotes {
        right_now,
        asked_of_you,
        action_items,
        generated_at: Utc::now(),
    })
}
```

- [ ] **Step 2: Register the module + command in lib.rs**

In `frontend/src-tauri/src/lib.rs`, add `pub mod live_notes;` next to the other `pub mod` declarations (alongside `pub mod cleanup;`).

Then inside the `tauri::generate_handler![...]` block (the same one that already lists `tray::refresh_tray_menu`), append `live_notes::api_generate_live_notes,` so the command is callable from JS.

- [ ] **Step 3: Commit and trigger CI**

```bash
git add frontend/src-tauri/src/live_notes/mod.rs frontend/src-tauri/src/lib.rs
git commit -m "feat(live-notes): add api_generate_live_notes Rust command"
git push origin feat/projects
gh workflow run build-macos.yml --repo ricardolyn/meetily --ref feat/projects \
  -F sign-build=false -F build-type=release -F upload-artifacts=true
```

- [ ] **Manual verification**

Wait for the CI build to succeed. Download the artifact and swap into `/Applications/meetily.app` (same procedure used in earlier iterations). Open DevTools in the running app and call from the JS console:

```js
const { invoke } = window.__TAURI__.core;
await invoke('api_generate_live_notes', {
  meetingId: 'test-1',
  recentTranscripts: '[00:01] Tom: Can you ship the spec by Friday?\n[00:05] You: Sure.',
  previousNotes: null,
  modelConfig: { provider: 'ollama', model: 'llama3:8b', apiKey: '', ollamaEndpoint: 'http://localhost:11434' },
});
```

Expected: the call returns a `LiveNotes` object with `right_now`, `asked_of_you`, `action_items`. If you don't have Ollama running, expect "LLM call failed" — that's also OK; it confirms the command path works.

---

## Task 2 — Floating window (Tauri config + Next.js route)

**Files:**
- Modify: `frontend/src-tauri/tauri.conf.json` (extend `app.windows[]`)
- Create: `frontend/src/app/live-notes/page.tsx`
- Create: `frontend/src/components/LiveNotes/LiveNotesPanel.tsx`

- [ ] **Step 1: Add the window definition**

In `frontend/src-tauri/tauri.conf.json`, the `app.windows` array currently has one entry (the main window). Append a second one:

```jsonc
{
    "label": "live-notes",
    "title": "Live notes",
    "url": "/live-notes",
    "alwaysOnTop": true,
    "decorations": false,
    "transparent": false,
    "resizable": true,
    "width": 320,
    "height": 480,
    "minWidth": 280,
    "minHeight": 320,
    "visible": false,
    "skipTaskbar": true
}
```

Both windows must be inside the same `windows: [...]` array. Trailing comma in JSONC is OK.

- [ ] **Step 2: Create the route page**

Create `frontend/src/app/live-notes/page.tsx`:

```tsx
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
```

- [ ] **Step 3: Create the panel component (event listener + render)**

Create `frontend/src/components/LiveNotes/LiveNotesPanel.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { Loader2, RefreshCw, X } from 'lucide-react';

interface LiveNotes {
  right_now: string;
  asked_of_you: string[];
  action_items: string[];
  generated_at: string;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'refreshing' }
  | { kind: 'ok'; at: string }
  | { kind: 'error'; message: string };

export function LiveNotesPanel() {
  const [notes, setNotes] = useState<LiveNotes | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  useEffect(() => {
    const unlistens: Array<() => void> = [];
    (async () => {
      unlistens.push(
        await listen<LiveNotes>('live-notes-update', event => {
          setNotes(event.payload);
          setStatus({ kind: 'ok', at: event.payload.generated_at });
        })
      );
      unlistens.push(
        await listen<void>('live-notes-refreshing', () => {
          setStatus({ kind: 'refreshing' });
        })
      );
      unlistens.push(
        await listen<string>('live-notes-error', event => {
          setStatus({ kind: 'error', message: event.payload });
        })
      );
    })();
    return () => {
      for (const u of unlistens) u();
    };
  }, []);

  async function refreshNow() {
    // Ask the main window to fire a tick out-of-band.
    await invoke('plugin:event|emit', {
      event: 'live-notes-refresh-request',
      payload: null,
    }).catch(() => {
      // Fallback: emit via app event channel
      // (no-op if not supported; the main window listens for this).
    });
  }

  async function pauseForMeeting() {
    // Tell the main window to disable live notes for the current meeting.
    await invoke('plugin:event|emit', {
      event: 'live-notes-pause-request',
      payload: null,
    }).catch(() => {});
  }

  return (
    <div className="flex flex-col h-full text-sm">
      <header className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 bg-gray-50">
        <span className="flex-1 font-medium text-gray-700">Live notes</span>
        <span className="text-xs text-gray-500">
          {status.kind === 'refreshing' && (
            <Loader2 className="w-3.5 h-3.5 animate-spin inline" />
          )}
          {status.kind === 'ok' && `updated ${formatTime(status.at)}`}
          {status.kind === 'error' && (
            <span className="text-amber-600" title={status.message}>
              refresh failed
            </span>
          )}
        </span>
        <button
          onClick={refreshNow}
          className="text-gray-500 hover:text-gray-800"
          title="Refresh now"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={pauseForMeeting}
          className="text-gray-500 hover:text-gray-800"
          title="Pause for this meeting"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        <Section title="Right now">
          {notes?.right_now ? (
            <p className="text-gray-800 leading-snug">{notes.right_now}</p>
          ) : (
            <Empty />
          )}
        </Section>

        <Section title="Asked of you">
          {notes && notes.asked_of_you.length > 0 ? (
            <ul className="list-disc list-inside text-gray-800 space-y-1">
              {notes.asked_of_you.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          ) : (
            <Empty />
          )}
        </Section>

        <Section title="Action items so far">
          {notes && notes.action_items.length > 0 ? (
            <ul className="list-disc list-inside text-gray-800 space-y-1">
              {notes.action_items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          ) : (
            <Empty />
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs uppercase tracking-wide text-gray-500 font-semibold mb-1">
        {title}
      </h3>
      {children}
    </div>
  );
}

function Empty() {
  return <p className="text-xs text-gray-400 italic">— nothing yet</p>;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
```

- [ ] **Step 4: Commit and CI**

```bash
git add frontend/src-tauri/tauri.conf.json \
        frontend/src/app/live-notes/page.tsx \
        frontend/src/components/LiveNotes/LiveNotesPanel.tsx
git commit -m "feat(live-notes): add floating window + panel UI"
git push origin feat/projects
gh workflow run build-macos.yml --repo ricardolyn/meetily --ref feat/projects \
  -F sign-build=false -F build-type=release -F upload-artifacts=true
```

- [ ] **Manual verification**

After install, open DevTools and run:

```js
const { getCurrentWindow, WebviewWindow } = window.__TAURI__.window;
const win = await WebviewWindow.getByLabel('live-notes');
await win.show();
```

The floating window should appear with three empty sections labelled "Right now / Asked of you / Action items so far" and a header reading `Live notes`. The "× nothing yet" empty state should show in each section.

---

## Task 3 — Settings UI + persistence

**Files:**
- Create: `frontend/src/services/liveNotesService.ts`
- Create: `frontend/src/components/LiveNotesSettings.tsx`
- Modify: `frontend/src/components/PreferenceSettings.tsx`

- [ ] **Step 1: Create the service**

Create `frontend/src/services/liveNotesService.ts`:

```ts
/**
 * Tauri-side helpers for the Live Notes feature: settings persistence
 * (via tauri-plugin-store) + the LLM call wrapper.
 */

import { invoke } from '@tauri-apps/api/core';
import { load, type Store } from '@tauri-apps/plugin-store';

export interface LiveNotes {
  right_now: string;
  asked_of_you: string[];
  action_items: string[];
  generated_at: string;
}

export interface LiveNotesModelConfig {
  provider: string;
  model: string;
  api_key?: string;
  ollama_endpoint?: string;
}

export interface LiveNotesSettings {
  /** Run automatically when a recording is active. */
  enabledByDefault: boolean;
  /** Refresh interval in seconds. */
  intervalSeconds: 30 | 60 | 120 | 300 | 600;
  /** "inherit" = use the same provider/model as the saved-summary config. */
  provider: 'inherit' | 'ollama' | 'claude' | 'openai' | 'groq' | 'openrouter' | 'builtin';
  /** Null when provider is "inherit"; otherwise the model name. */
  model: string | null;
}

const STORE_FILE = 'store.json';
const STORE_KEY = 'liveNotes';

const DEFAULT_SETTINGS: LiveNotesSettings = {
  enabledByDefault: false,
  intervalSeconds: 60,
  provider: 'inherit',
  model: null,
};

let cachedStore: Store | null = null;
async function getStore(): Promise<Store> {
  if (!cachedStore) {
    cachedStore = await load(STORE_FILE, { autoSave: true });
  }
  return cachedStore;
}

export const liveNotesService = {
  async getSettings(): Promise<LiveNotesSettings> {
    const store = await getStore();
    const stored = (await store.get<Partial<LiveNotesSettings>>(STORE_KEY)) ?? {};
    return { ...DEFAULT_SETTINGS, ...stored };
  },

  async setSettings(next: LiveNotesSettings): Promise<void> {
    const store = await getStore();
    await store.set(STORE_KEY, next);
    await store.save();
  },

  generate(
    meetingId: string,
    recentTranscripts: string,
    previousNotes: LiveNotes | null,
    modelConfig: LiveNotesModelConfig
  ): Promise<LiveNotes> {
    return invoke<LiveNotes>('api_generate_live_notes', {
      meetingId,
      recentTranscripts,
      previousNotes,
      modelConfig,
    });
  },
};
```

- [ ] **Step 2: Create the settings UI**

Create `frontend/src/components/LiveNotesSettings.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { liveNotesService, type LiveNotesSettings } from '@/services/liveNotesService';

const INTERVAL_OPTIONS = [
  { value: 30, label: 'Every 30 seconds' },
  { value: 60, label: 'Every 1 minute' },
  { value: 120, label: 'Every 2 minutes' },
  { value: 300, label: 'Every 5 minutes' },
  { value: 600, label: 'Every 10 minutes' },
] as const;

const PROVIDER_OPTIONS = [
  { value: 'inherit', label: 'Same as saved summary' },
  { value: 'ollama', label: 'Ollama (local)' },
  { value: 'claude', label: 'Claude' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'groq', label: 'Groq' },
  { value: 'openrouter', label: 'OpenRouter' },
] as const;

export function LiveNotesSettings() {
  const [settings, setSettings] = useState<LiveNotesSettings | null>(null);

  useEffect(() => {
    liveNotesService.getSettings().then(setSettings);
  }, []);

  async function update(patch: Partial<LiveNotesSettings>) {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      await liveNotesService.setSettings(next);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save settings');
    }
  }

  if (!settings) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }

  return (
    <section className="space-y-4 py-4">
      <header>
        <h3 className="text-base font-semibold">Live notes</h3>
        <p className="text-sm text-gray-600 mt-1">
          Show a floating panel during recording with what's being discussed
          right now, questions asked of you, and a running list of action items.
          You can override the default per meeting from the recording controls.
        </p>
      </header>

      <div className="flex items-center justify-between">
        <Label className="font-normal">Run automatically when recording</Label>
        <Switch
          checked={settings.enabledByDefault}
          onCheckedChange={v => update({ enabledByDefault: v })}
        />
      </div>

      <div className="flex items-center justify-between gap-4">
        <Label className="font-normal">Refresh interval</Label>
        <Select
          value={String(settings.intervalSeconds)}
          onValueChange={v => update({ intervalSeconds: Number(v) as LiveNotesSettings['intervalSeconds'] })}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INTERVAL_OPTIONS.map(opt => (
              <SelectItem key={opt.value} value={String(opt.value)}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between gap-4">
        <Label className="font-normal">Model</Label>
        <Select
          value={settings.provider}
          onValueChange={v => update({ provider: v as LiveNotesSettings['provider'], model: v === 'inherit' ? null : settings.model })}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDER_OPTIONS.map(opt => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {settings.provider !== 'inherit' && (
        <div className="flex items-center justify-between gap-4">
          <Label className="font-normal">Model name</Label>
          <input
            className="w-48 h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm"
            placeholder="e.g. llama3:8b"
            value={settings.model ?? ''}
            onChange={e => update({ model: e.target.value || null })}
          />
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Render in PreferenceSettings**

In `frontend/src/components/PreferenceSettings.tsx`, import the new component and render it at the end of the form's main scrollable area:

```tsx
import { LiveNotesSettings } from './LiveNotesSettings';

// ...inside the returned JSX, after the existing settings sections:
<LiveNotesSettings />
```

- [ ] **Step 4: Commit and CI**

```bash
git add frontend/src/services/liveNotesService.ts \
        frontend/src/components/LiveNotesSettings.tsx \
        frontend/src/components/PreferenceSettings.tsx
git commit -m "feat(live-notes): settings UI + persistence via tauri-plugin-store"
git push origin feat/projects
gh workflow run build-macos.yml --repo ricardolyn/meetily --ref feat/projects \
  -F sign-build=false -F build-type=release -F upload-artifacts=true
```

- [ ] **Manual verification**

In the running app, open Settings → General. Scroll to the "Live notes" section. Toggle "Run automatically", change the interval and the model dropdown. Reload the app (Cmd+R inside the window) and confirm the settings are preserved.

---

## Task 4 — Wiring: timer hook, context, recording-controls pill, window lifecycle

This is the highest-risk task because it coordinates window show/hide, React state, recording state, and the per-meeting override. Implement in one focused pass and verify thoroughly.

**Files:**
- Create: `frontend/src/contexts/LiveNotesContext.tsx`
- Create: `frontend/src/hooks/useLiveNotes.ts`
- Create: `frontend/src/components/RecordingControls/LiveNotesPill.tsx`
- Modify: `frontend/src/app/layout.tsx` (mount `<LiveNotesProvider>` in the existing provider tree)
- Modify: `frontend/src/app/page.tsx` (render `<LiveNotesPill />` inside the recording controls area, beside the existing project picker chip)

- [ ] **Step 1: Context**

Create `frontend/src/contexts/LiveNotesContext.tsx`:

```tsx
'use client';

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { LiveNotes } from '@/services/liveNotesService';

interface LiveNotesContextValue {
  /** True if live notes should run for the current meeting. */
  enabledForMeeting: boolean;
  /** Override switch (only meaningful during an active recording). */
  setEnabledForMeeting: (v: boolean) => void;
  /** Reset to "use the global default" — called when a recording starts. */
  resetForMeeting: (defaultEnabled: boolean) => void;
  /** Latest result, shared between RecordingControls and the floating window. */
  latest: LiveNotes | null;
  setLatest: (n: LiveNotes | null) => void;
}

const LiveNotesContext = createContext<LiveNotesContextValue | null>(null);

export function useLiveNotesContext(): LiveNotesContextValue {
  const ctx = useContext(LiveNotesContext);
  if (!ctx) throw new Error('useLiveNotesContext must be used within LiveNotesProvider');
  return ctx;
}

export function LiveNotesProvider({ children }: { children: React.ReactNode }) {
  const [enabledForMeeting, setEnabledForMeeting] = useState(false);
  const [latest, setLatest] = useState<LiveNotes | null>(null);

  const resetForMeeting = useCallback((defaultEnabled: boolean) => {
    setEnabledForMeeting(defaultEnabled);
    setLatest(null);
  }, []);

  const value = useMemo<LiveNotesContextValue>(
    () => ({ enabledForMeeting, setEnabledForMeeting, resetForMeeting, latest, setLatest }),
    [enabledForMeeting, resetForMeeting, latest]
  );

  return <LiveNotesContext.Provider value={value}>{children}</LiveNotesContext.Provider>;
}
```

- [ ] **Step 2: Wrap the app**

In `frontend/src/app/layout.tsx`, add `import { LiveNotesProvider } from '@/contexts/LiveNotesContext';` and wrap it INSIDE `ProjectsProvider` and OUTSIDE `TooltipProvider` (so RecordingControls children can read it). Mirror the existing nesting style.

- [ ] **Step 3: Timer hook**

Create `frontend/src/hooks/useLiveNotes.ts`:

```ts
import { useEffect, useRef } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useLiveNotesContext } from '@/contexts/LiveNotesContext';
import { liveNotesService, type LiveNotesSettings, type LiveNotesModelConfig } from '@/services/liveNotesService';

/**
 * Drives the live-notes lifecycle from the main window. Reads recording
 * state + per-meeting override + persisted settings, fires the LLM call
 * on an interval, broadcasts results to the floating window.
 */
export function useLiveNotes(meetingId: string | null) {
  const { transcripts } = useTranscripts();
  const { isRecording, isPaused } = useRecordingState();
  const { enabledForMeeting, setEnabledForMeeting, resetForMeeting, setLatest, latest } = useLiveNotesContext();

  const inFlightRef = useRef(false);
  const lastTranscriptCountRef = useRef(0);
  const settingsRef = useRef<LiveNotesSettings | null>(null);

  // Load settings once + react to setting changes (poll on focus is fine for v1).
  useEffect(() => {
    let cancelled = false;
    liveNotesService.getSettings().then(s => {
      if (!cancelled) settingsRef.current = s;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // When a new recording starts, reset to the global default.
  useEffect(() => {
    if (isRecording) {
      const def = settingsRef.current?.enabledByDefault ?? false;
      resetForMeeting(def);
    }
  }, [isRecording, resetForMeeting]);

  // Show/hide the floating window in lockstep with enabled+recording.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const win = await WebviewWindow.getByLabel('live-notes');
      if (!win || cancelled) return;
      if (isRecording && enabledForMeeting) {
        await win.show();
      } else {
        await win.hide();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isRecording, enabledForMeeting]);

  // The actual tick.
  useEffect(() => {
    if (!isRecording || !enabledForMeeting || !meetingId) return;
    const intervalMs = (settingsRef.current?.intervalSeconds ?? 60) * 1000;

    const tick = async () => {
      if (inFlightRef.current) return;                      // single-flight
      if (isPaused) return;                                  // skip while paused
      if (transcripts.length === lastTranscriptCountRef.current) return; // no new content
      const cfg = await resolveModelConfig();
      if (!cfg) {
        await emit('live-notes-error', 'No LLM provider configured');
        return;
      }
      const recent = buildRecentTranscriptText(transcripts, intervalMs);
      if (!recent.trim()) return;
      inFlightRef.current = true;
      await emit('live-notes-refreshing');
      try {
        const result = await liveNotesService.generate(meetingId, recent, latest, cfg);
        setLatest(result);
        lastTranscriptCountRef.current = transcripts.length;
        await emit('live-notes-update', result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await emit('live-notes-error', msg);
      } finally {
        inFlightRef.current = false;
      }
    };

    const handle = window.setInterval(tick, intervalMs);
    // Also listen for floating-window-triggered manual refresh.
    const unlistenRefresh = listen<void>('live-notes-refresh-request', () => {
      void tick();
    });
    // And for the floating window's "pause for this meeting" button.
    const unlistenPause = listen<void>('live-notes-pause-request', () => {
      setEnabledForMeeting(false);
    });

    return () => {
      window.clearInterval(handle);
      unlistenRefresh.then(u => u());
      unlistenPause.then(u => u());
    };
  }, [isRecording, enabledForMeeting, isPaused, meetingId, transcripts, latest, setLatest, setEnabledForMeeting]);
}

function buildRecentTranscriptText(
  transcripts: Array<{ text: string; audio_start_time?: number; speaker?: string }>,
  intervalMs: number
): string {
  // Window = min(intervalMs * 3, 5 minutes), per the design spec.
  const windowMs = Math.min(intervalMs * 3, 5 * 60 * 1000);
  const last = transcripts[transcripts.length - 1];
  if (!last || last.audio_start_time === undefined) {
    return transcripts.map(formatLine).join('\n');
  }
  const cutoff = last.audio_start_time - windowMs / 1000;
  return transcripts
    .filter(t => (t.audio_start_time ?? 0) >= cutoff)
    .map(formatLine)
    .join('\n');
}

function formatLine(t: { text: string; audio_start_time?: number; speaker?: string }): string {
  const ts = formatStamp(t.audio_start_time ?? 0);
  const who = t.speaker === 'me' ? 'You' : t.speaker === 'others' ? 'Other' : '';
  return who ? `[${ts}] ${who}: ${t.text}` : `[${ts}] ${t.text}`;
}

function formatStamp(seconds: number): string {
  const mm = Math.floor(seconds / 60).toString().padStart(2, '0');
  const ss = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

async function resolveModelConfig(): Promise<LiveNotesModelConfig | null> {
  const s = await liveNotesService.getSettings();
  if (s.provider !== 'inherit') {
    if (!s.model) return null;
    return { provider: s.provider, model: s.model };
  }
  // Inherit from saved-summary model config (api_get_model_config).
  const { invoke } = await import('@tauri-apps/api/core');
  const config: any = await invoke('api_get_model_config').catch(() => null);
  if (!config || !config.provider || !config.model) return null;
  return {
    provider: config.provider,
    model: config.model,
    api_key: config.apiKey ?? undefined,
    ollama_endpoint: config.ollamaEndpoint ?? undefined,
  };
}
```

- [ ] **Step 4: Pill component**

Create `frontend/src/components/RecordingControls/LiveNotesPill.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { emit } from '@tauri-apps/api/event';
import { ChevronDown, Sparkles } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useLiveNotesContext } from '@/contexts/LiveNotesContext';
import { liveNotesService } from '@/services/liveNotesService';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

interface Props {
  /** True while a recording is active; pill is hidden otherwise. */
  isRecording: boolean;
}

export function LiveNotesPill({ isRecording }: Props) {
  const { enabledForMeeting, setEnabledForMeeting } = useLiveNotesContext();
  const [intervalLabel, setIntervalLabel] = useState<string>('1m');

  useEffect(() => {
    liveNotesService.getSettings().then(s => setIntervalLabel(formatInterval(s.intervalSeconds)));
  }, []);

  if (!isRecording) return null;

  async function refreshNow() {
    await emit('live-notes-refresh-request');
  }
  async function openWindow() {
    const win = await WebviewWindow.getByLabel('live-notes');
    if (win) await win.show();
  }

  return (
    <div className="inline-flex items-center gap-1">
      <button
        onClick={() => setEnabledForMeeting(!enabledForMeeting)}
        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border ${
          enabledForMeeting
            ? 'bg-blue-50 text-blue-700 border-blue-200'
            : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
        }`}
        title="Toggle live notes for this meeting"
      >
        <Sparkles className="w-3.5 h-3.5" />
        <span>Live notes</span>
        {enabledForMeeting && <span className="text-blue-500">· {intervalLabel}</span>}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="inline-flex items-center justify-center w-6 h-6 rounded-full hover:bg-gray-100 text-gray-500"
            title="Live notes options"
          >
            <ChevronDown className="w-3 h-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={refreshNow} disabled={!enabledForMeeting}>
            Refresh now
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={openWindow}>
            Open floating window
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}
```

- [ ] **Step 5: Mount pill + activate hook in page.tsx**

In `frontend/src/app/page.tsx`, near where `<ProjectPicker />` is rendered, also render `<LiveNotesPill isRecording={recordingState.isRecording} />`. Add the import. Then call the hook inside the page component:

```tsx
import { useLiveNotes } from '@/hooks/useLiveNotes';
import { LiveNotesPill } from '@/components/RecordingControls/LiveNotesPill';

// ...inside the component, after other hooks:
useLiveNotes(meetingTitle ? /* current meeting id when available */ '' : null);
```

If `meetingTitle` is the only identifier available before save, pass that; for v1 we only need a non-empty meeting identifier (the backend just uses it for logging). A later iteration can switch to the real `meeting_id` once the save flow returns it.

- [ ] **Step 6: Commit and CI**

```bash
git add frontend/src/contexts/LiveNotesContext.tsx \
        frontend/src/hooks/useLiveNotes.ts \
        frontend/src/components/RecordingControls/LiveNotesPill.tsx \
        frontend/src/app/layout.tsx \
        frontend/src/app/page.tsx
git commit -m "feat(live-notes): wire timer + pill + window lifecycle"
git push origin feat/projects
gh workflow run build-macos.yml --repo ricardolyn/meetily --ref feat/projects \
  -F sign-build=false -F build-type=release -F upload-artifacts=true
```

- [ ] **Manual verification**

Install the new build. In Settings → General → Live notes, set "Run automatically" OFF, interval = 30s, provider = `inherit`. Save.

1. Start a new recording. The "Live notes" pill should appear next to the project chip, gray.
2. Click the pill — it turns blue and shows "· 30s". The floating window appears.
3. Speak for ~30 seconds (or play a podcast through system audio). Within 30s of detection, the floating window should change from "— nothing yet" to populated content.
4. Click the pill again to disable. The floating window hides.
5. Toggle "Run automatically" ON in settings. Start another recording. Pill is blue automatically, window appears immediately.
6. Stop the recording. The pill disappears, the floating window hides.

---

## Task 5 — Polish

**Files:**
- Modify: `frontend/src/hooks/useLiveNotes.ts` (tighten error toasts; surface the timeout case clearly)
- Modify: `frontend/src/components/LiveNotes/LiveNotesPanel.tsx` (display the previous content even while "refresh failed")

- [ ] **Step 1: Differentiate timeout vs other errors in the panel header**

In `LiveNotesPanel.tsx`, when the status is `error` and the message contains "timed out", show "took too long" instead. Update the header conditional to:

```tsx
{status.kind === 'error' && (
  <span className="text-amber-600" title={status.message}>
    {/timed out/i.test(status.message) ? 'took too long' : 'refresh failed'}
  </span>
)}
```

- [ ] **Step 2: Keep last good notes visible on error**

The panel already retains `notes` state when an error arrives — confirm by reviewing the code; if not, ensure that the `live-notes-error` handler does NOT clear `notes`, only updates `status`.

- [ ] **Step 3: Disable the pill ▾ "Refresh now" when not enabled**

Already handled in the pill (disabled={!enabledForMeeting}). Sanity-check the prop spelling.

- [ ] **Step 4: Commit and CI (final build)**

```bash
git add frontend/src/hooks/useLiveNotes.ts \
        frontend/src/components/LiveNotes/LiveNotesPanel.tsx
git commit -m "feat(live-notes): polish error states + retain last good notes"
git push origin feat/projects
gh workflow run build-macos.yml --repo ricardolyn/meetily --ref feat/projects \
  -F sign-build=false -F build-type=release -F upload-artifacts=true
```

- [ ] **Manual verification (final)**

End-to-end:
1. With Ollama running, start a recording with live notes enabled, interval 30s. Confirm content updates and action items accumulate without duplicates across multiple ticks.
2. Kill the Ollama process mid-recording. The next tick should show "took too long" or "refresh failed" in the header; the previous content should remain visible.
3. Restart Ollama; the next successful tick should clear the error and update the content.
4. Toggle pause from the pill's ▾ — refresh should stop firing, window stays visible until close button hit.
5. Stop recording; pill + window both go away.

---

## Self-Review

**Spec coverage check:**
- UI floating window (spec §UI) → Task 2 ✓
- Three sections layout (spec §Layout) → Task 2 ✓
- Per-meeting controls + pill (spec §Per-meeting control) → Task 4 ✓
- Settings (spec §Settings) → Task 3 ✓
- Backend isolation (spec §Backend) → Task 1 ✓ (no DB / file writes anywhere)
- LLM call via existing `generate_summary` → Task 1 ✓
- Prompt + transcript window (spec §Prompt) → Task 1 (prompt) + Task 4 (`buildRecentTranscriptText`) ✓
- Safeguards: single-flight, zero-new-segment skip, 30s timeout → Task 1 (timeout) + Task 4 (single-flight, zero-new-segment) ✓
- Verification per failure mode → Task 5 manual ✓

**Placeholder scan:** no "TBD" / "TODO" / "Add error handling" anywhere. Every step has full code or full commands. The one judgment-call spot is the meeting-id source in Task 4 Step 5 — left as a comment explaining v1 vs follow-up.

**Type consistency:** `LiveNotes` struct fields match between Rust (`right_now`, `asked_of_you`, `action_items`, `generated_at`) and TS interface. Settings keys match between `liveNotesService.ts` and the settings UI.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-26-live-notes-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Each task is one CI build cycle so the cadence is roughly task-commit-build-review every ~15 min.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints. Faster if I keep going on the same context but no review break between tasks.

Which approach?
