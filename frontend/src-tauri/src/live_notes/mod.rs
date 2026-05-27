// Live in-meeting notes. Runtime-only — never writes to DB or disk so it
// can never overwrite the saved summary. Called every N seconds from the
// frontend during an active recording.

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
        None,
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
                &s[..s.len().min(200)]
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
                    &raw[..raw.len().min(200)]
                )
            })?;
            serde_json::from_str(json_slice).map_err(|e| {
                format!(
                    "LLM output is not valid JSON: {} (raw: {})",
                    e,
                    &raw[..raw.len().min(200)]
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
