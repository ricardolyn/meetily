// Live in-meeting notes. Generation is runtime-only and never writes to
// the DB so it can never overwrite the saved summary. At the end of a
// recording, the latest snapshot is persisted as `live_notes.json` next
// to the meeting's `transcripts.json` so the UI can show it after the
// fact.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use log::{error as log_error, info as log_info, warn as log_warn};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager as _, Runtime};
use tokio::time::Duration;

use crate::live_llm::output::{parse_json_object, string_array};
use crate::live_llm::{run_prompt, LlmModelConfig, PromptRequest};

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

#[tauri::command]
pub async fn api_generate_live_notes<R: Runtime>(
    app: AppHandle<R>,
    meeting_id: String,
    recent_transcripts: String,
    previous_notes: Option<LiveNotes>,
    model_config: LlmModelConfig,
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

    let user_prompt = build_user_prompt(&recent_transcripts, previous_notes.as_ref());
    let raw = run_prompt(
        &app,
        &model_config,
        PromptRequest {
            label: "Live notes",
            system_prompt: SYSTEM_PROMPT,
            user_prompt: &user_prompt,
            max_tokens: 700,
            temperature: 0.2,
            timeout: LLM_CALL_TIMEOUT,
        },
    )
    .await?;

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

const SYSTEM_PROMPT: &str =
    "You are taking live notes during a meeting for someone who may briefly step away. \
     The transcript labels each line by speaker: lines starting with \"You:\" are the \
     user you are helping; lines starting with \"Other:\" are other participants. \
     Use those labels to decide who said what, but assign asks and actions by the \
     person responsible for doing them, not by who spoke. \
     Be concise and scannable. Output ONLY a JSON object with keys \
     \"right_now\" (string, 1-2 sentences summarizing the current topic), \
     \"asked_of_you\" (array of strings, empty if nothing), \
     \"action_items\" (array of strings). \
     For \"asked_of_you\", include only questions or asks directed at the user \
     that have not yet been answered. \
     For \"action_items\", include ONLY things the user is on the hook for — items \
     they committed to themselves, OR items another participant assigned or asked \
     them to do. Do NOT include commitments by others that don't involve the user. \
     Carry forward and de-duplicate items from the previous notes provided, and add \
     new ones. Each item must be 12 words or fewer.";

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
    let parsed = parse_json_object(raw)?;
    let right_now = parsed
        .get("right_now")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    Ok(LiveNotes {
        right_now,
        asked_of_you: string_array(&parsed, "asked_of_you"),
        action_items: string_array(&parsed, "action_items"),
        generated_at: Utc::now(),
    })
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
