// Live in-meeting notes. Generation is runtime-only and never writes to
// the DB so it can never overwrite the saved summary. At the end of a
// recording, the latest snapshot is persisted as `live_notes.json` next
// to the meeting's `transcripts.json` so the UI can show it after the
// fact.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use log::{error as log_error, info as log_info, warn as log_warn};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager as _, Runtime};
use tokio::time::{timeout, Duration};

use crate::summary::llm_client::{generate_summary, LLMProvider};

/// Hard cap on a single LLM call. Prevents a stuck local model from
/// queuing requests forever. Wraps the entire `generate_summary` future,
/// so this also dominates the BuiltInAI provider's internal 15-minute
/// timeout — the outer drop fires first.
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
    /// e.g. "ollama", "claude", "openai", "groq", "openrouter", "custom-openai".
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub ollama_endpoint: Option<String>,
    #[serde(default)]
    pub custom_openai_endpoint: Option<String>,
}

#[tauri::command]
pub async fn api_generate_live_notes<R: Runtime>(
    app: AppHandle<R>,
    meeting_id: String,
    recent_transcripts: String,
    previous_notes: Option<LiveNotes>,
    model_config: LiveNotesModelConfig,
) -> Result<LiveNotes, String> {
    log_info!(
        "api_generate_live_notes called: meeting_id={}, transcripts_chars={}, provider={}, model={}, has_custom_endpoint={}",
        meeting_id,
        recent_transcripts.len(),
        model_config.provider,
        model_config.model,
        model_config.custom_openai_endpoint.as_deref().map(|s| !s.is_empty()).unwrap_or(false),
    );

    if recent_transcripts.trim().is_empty() {
        return Err("Recent transcripts are empty; nothing to summarize".to_string());
    }

    let provider = parse_provider(&model_config.provider)?;
    let system_prompt = SYSTEM_PROMPT.to_string();
    let user_prompt = build_user_prompt(&recent_transcripts, previous_notes.as_ref());

    let app_data_dir = app.path().app_data_dir().ok();

    let client = Client::new();
    let call_future = generate_summary(
        &client,
        &provider,
        &model_config.model,
        model_config.api_key.as_deref().unwrap_or(""),
        &system_prompt,
        &user_prompt,
        model_config.ollama_endpoint.as_deref(),
        model_config.custom_openai_endpoint.as_deref(),
        Some(700),
        Some(0.2),
        Some(0.9),
        app_data_dir.as_ref(),
        None,
    );

    log_info!(
        "Live notes: dispatching to {:?} (model={}, has_api_key={}, has_ollama_endpoint={}, prompt_chars={})",
        provider,
        model_config.model,
        model_config.api_key.as_deref().map(|k| !k.is_empty()).unwrap_or(false),
        model_config.ollama_endpoint.is_some(),
        user_prompt.len(),
    );

    let raw = match timeout(LLM_CALL_TIMEOUT, call_future).await {
        Ok(Ok(s)) => {
            log_info!(
                "Live notes: LLM responded with {} chars. First 200: {}",
                s.len(),
                head_chars(&s, 200)
            );
            s
        }
        Ok(Err(e)) => {
            log_error!("Live notes LLM call failed: {}", e);
            return Err(format!("LLM call failed: {}", e));
        }
        Err(_) => {
            log_warn!("Live notes LLM call exceeded {:?}; aborting", LLM_CALL_TIMEOUT);
            return Err("LLM call timed out".to_string());
        }
    };

    match parse_llm_output(&raw) {
        Ok(notes) => {
            log_info!(
                "Live notes: parsed OK — right_now_chars={}, asked={}, actions={}",
                notes.right_now.len(),
                notes.asked_of_you.len(),
                notes.action_items.len(),
            );
            Ok(notes)
        }
        Err(e) => {
            log_error!("Live notes: parse failed — {}. Full LLM output:\n{}", e, raw);
            Err(e)
        }
    }
}

fn parse_provider(name: &str) -> Result<LLMProvider, String> {
    match name.to_lowercase().as_str() {
        "ollama" => Ok(LLMProvider::Ollama),
        "claude" | "anthropic" => Ok(LLMProvider::Claude),
        "openai" => Ok(LLMProvider::OpenAI),
        "groq" => Ok(LLMProvider::Groq),
        "openrouter" => Ok(LLMProvider::OpenRouter),
        "builtin" | "builtinai" | "builtin_ai" => Ok(LLMProvider::BuiltInAI),
        "custom-openai" | "customopenai" | "custom_openai" => Ok(LLMProvider::CustomOpenAI),
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
     previous notes provided, and add new ones. Each item must be 12 words or fewer.";

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
    let cleaned = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    // Local models frequently emit prose preambles like "Here is the JSON
    // object: { ... }" or trailing explanations. Fall back to extracting
    // the largest balanced `{ ... }` block before giving up.
    let parsed: serde_json::Value = match serde_json::from_str(cleaned) {
        Ok(v) => v,
        Err(_) => {
            let json_slice = extract_json_object(cleaned).ok_or_else(|| {
                format!(
                    "LLM output contained no JSON object (raw: {})",
                    head_chars(raw, 200)
                )
            })?;
            serde_json::from_str(json_slice).map_err(|e| {
                format!(
                    "LLM output is not valid JSON: {} (raw: {})",
                    e,
                    head_chars(raw, 200)
                )
            })?
        }
    };

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

/// Take at most `n` chars from `s` without slicing inside a multi-byte
/// UTF-8 codepoint. `&s[..n]` panics if byte index `n` lands inside a
/// codepoint (emoji, accented letter, CJK, etc.).
fn head_chars(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

/// Find the first balanced `{ ... }` block in `s`, respecting nesting and
/// double-quoted strings. Returns the slice including the braces.
fn extract_json_object(s: &str) -> Option<&str> {
    let bytes = s.as_bytes();
    let start = bytes.iter().position(|&b| b == b'{')?;
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escape = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if escape {
            escape = false;
            continue;
        }
        if in_string {
            match b {
                b'\\' => escape = true,
                b'"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&s[start..=i]);
                }
            }
            _ => {}
        }
    }
    None
}

const LIVE_NOTES_FILENAME: &str = "live_notes.json";

fn live_notes_path(folder_path: &str) -> PathBuf {
    Path::new(folder_path).join(LIVE_NOTES_FILENAME)
}

/// Persist the latest live-notes snapshot next to the meeting's
/// `transcripts.json`. Atomic via temp-file + rename so a crash mid-write
/// can't truncate an existing file.
#[tauri::command]
pub async fn api_save_live_notes(
    folder_path: String,
    notes: LiveNotes,
) -> Result<(), String> {
    let target = live_notes_path(&folder_path);
    let temp = Path::new(&folder_path).join(".live_notes.json.tmp");

    let json = serde_json::to_string_pretty(&notes)
        .map_err(|e| format!("Failed to serialize live notes: {}", e))?;

    log_info!(
        "api_save_live_notes: writing {} ({} bytes, {} action_items)",
        target.display(),
        json.len(),
        notes.action_items.len(),
    );

    tokio::fs::write(&temp, json.as_bytes())
        .await
        .map_err(|e| format!("Failed to write temp live_notes file: {}", e))?;
    tokio::fs::rename(&temp, &target)
        .await
        .map_err(|e| format!("Failed to rename live_notes temp file: {}", e))?;

    Ok(())
}

/// Show or hide the pre-declared floating "live-notes" window. Driven
/// from Rust so we get a single log trail in meetily.log when the JS
/// path is opaque (release builds, no devtools).
#[tauri::command]
pub async fn api_set_live_notes_window_visible<R: Runtime>(
    app: AppHandle<R>,
    visible: bool,
) -> Result<(), String> {
    use tauri::WebviewWindowBuilder;

    let label = "live-notes";
    let existing = app.get_webview_window(label);

    log_info!(
        "api_set_live_notes_window_visible: visible={}, exists_pre_call={}",
        visible,
        existing.is_some(),
    );

    let window = if let Some(w) = existing {
        w
    } else {
        // Recreate dynamically if the pre-declared window was never
        // instantiated (asset 404, capability error, etc).
        log_info!("live-notes window missing; building dynamically");
        WebviewWindowBuilder::new(
            &app,
            label,
            tauri::WebviewUrl::App("live-notes.html".into()),
        )
        .title("Live notes")
        .inner_size(320.0, 480.0)
        .min_inner_size(280.0, 320.0)
        .always_on_top(true)
        .decorations(false)
        .skip_taskbar(true)
        .center()
        .visible(false)
        .build()
        .map_err(|e| {
            log_error!("Failed to build live-notes window: {}", e);
            format!("Failed to build live-notes window: {}", e)
        })?
    };

    if visible {
        window.show().map_err(|e| {
            log_error!("live-notes window show() failed: {}", e);
            format!("show failed: {}", e)
        })?;
        window.set_focus().map_err(|e| {
            log_warn!("live-notes window set_focus() failed: {}", e);
            format!("set_focus failed: {}", e)
        })?;
        log_info!("live-notes window shown");
    } else {
        window.hide().map_err(|e| {
            log_error!("live-notes window hide() failed: {}", e);
            format!("hide failed: {}", e)
        })?;
        log_info!("live-notes window hidden");
    }

    Ok(())
}

/// Read a previously-saved `live_notes.json`. Returns `None` when the file
/// is absent (older meeting, or live notes wasn't used) so callers can
/// hide the UI tab without an error path.
#[tauri::command]
pub async fn api_get_live_notes(folder_path: String) -> Result<Option<LiveNotes>, String> {
    let target = live_notes_path(&folder_path);
    let bytes = match tokio::fs::read(&target).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Failed to read live_notes.json: {}", e)),
    };
    let notes: LiveNotes = serde_json::from_slice(&bytes)
        .map_err(|e| format!("live_notes.json is not valid: {}", e))?;
    Ok(Some(notes))
}
