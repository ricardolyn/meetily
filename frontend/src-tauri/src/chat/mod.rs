// Live in-meeting chat. The user asks questions during a recording and an
// LLM answers from the live transcript. Like live notes, generation is
// runtime-only and never touches the DB. The conversation is persisted as
// `chat.json` next to the meeting's `transcripts.json` when the recording
// stops, so the UI can show it after the fact.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use log::{error as log_error, info as log_info, warn as log_warn};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager as _, Runtime};
use tokio::time::{timeout, Duration};

use crate::summary::llm_client::{generate_summary, LLMProvider};

/// Hard cap on a single chat LLM call. More generous than live notes because
/// a chat answer carries the whole-meeting transcript in its prompt, so the
/// request is larger and slower — especially on local models.
const LLM_CALL_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSession {
    pub messages: Vec<ChatMessage>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatModelConfig {
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

/// Answer a question about the ongoing meeting using the whole-meeting
/// transcript plus the prior turns of this chat session as context. Returns
/// the assistant's reply as a `ChatMessage`.
#[tauri::command]
pub async fn api_ask_meeting<R: Runtime>(
    app: AppHandle<R>,
    meeting_id: String,
    transcript: String,
    history: Vec<ChatMessage>,
    question: String,
    model_config: ChatModelConfig,
) -> Result<ChatMessage, String> {
    log_info!(
        "api_ask_meeting called: meeting_id={}, transcript_chars={}, history_turns={}, question_chars={}, provider={}, model={}",
        meeting_id,
        transcript.len(),
        history.len(),
        question.len(),
        model_config.provider,
        model_config.model,
    );

    if question.trim().is_empty() {
        return Err("Question is empty".to_string());
    }

    let provider = parse_provider(&model_config.provider)?;
    let system_prompt = SYSTEM_PROMPT.to_string();
    let user_prompt = build_user_prompt(&transcript, &history, &question);

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
        Some(800),
        Some(0.3),
        Some(0.9),
        app_data_dir.as_ref(),
        None,
    );

    log_info!(
        "Chat: dispatching to {:?} (model={}, has_api_key={}, has_ollama_endpoint={}, prompt_chars={})",
        provider,
        model_config.model,
        model_config.api_key.as_deref().map(|k| !k.is_empty()).unwrap_or(false),
        model_config.ollama_endpoint.is_some(),
        user_prompt.len(),
    );

    let raw = match timeout(LLM_CALL_TIMEOUT, call_future).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            log_error!("Chat LLM call failed: {}", e);
            return Err(format!("LLM call failed: {}", e));
        }
        Err(_) => {
            log_warn!("Chat LLM call exceeded {:?}; aborting", LLM_CALL_TIMEOUT);
            return Err("LLM call timed out".to_string());
        }
    };

    let answer = raw.trim().to_string();
    if answer.is_empty() {
        return Err("LLM returned an empty answer".to_string());
    }

    log_info!("Chat: answered with {} chars", answer.len());
    Ok(ChatMessage {
        role: ChatRole::Assistant,
        content: answer,
        timestamp: Utc::now(),
    })
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
        other => Err(format!("Unsupported provider for chat: {}", other)),
    }
}

const SYSTEM_PROMPT: &str =
    "You answer the user's questions about an ongoing meeting, using only the \
     meeting transcript provided. In the transcript, lines starting with \"You:\" \
     are the user you are helping; lines starting with \"Other:\" are other \
     participants. Answer concisely and directly. If the answer is not in the \
     transcript, say you don't see it discussed rather than guessing. You may use \
     simple Markdown (bullet points, bold) when it makes the answer clearer.";

fn build_user_prompt(transcript: &str, history: &[ChatMessage], question: &str) -> String {
    let mut prompt = String::new();
    prompt.push_str("Meeting transcript so far:\n");
    let transcript = transcript.trim();
    if transcript.is_empty() {
        prompt.push_str("(nothing has been transcribed yet)");
    } else {
        prompt.push_str(transcript);
    }
    prompt.push_str("\n\n");

    if !history.is_empty() {
        prompt.push_str("Conversation so far:\n");
        for message in history {
            let who = match message.role {
                ChatRole::User => "You",
                ChatRole::Assistant => "Assistant",
            };
            prompt.push_str(who);
            prompt.push_str(": ");
            prompt.push_str(message.content.trim());
            prompt.push('\n');
        }
        prompt.push('\n');
    }

    prompt.push_str("New question:\n");
    prompt.push_str(question.trim());
    prompt
}

const CHAT_FILENAME: &str = "chat.json";

fn chat_path(folder_path: &str) -> PathBuf {
    Path::new(folder_path).join(CHAT_FILENAME)
}

/// Persist the chat conversation next to the meeting's `transcripts.json`.
/// Atomic via temp-file + rename so a crash mid-write can't truncate an
/// existing file.
#[tauri::command]
pub async fn api_save_chat(folder_path: String, session: ChatSession) -> Result<(), String> {
    let target = chat_path(&folder_path);
    let temp = Path::new(&folder_path).join(".chat.json.tmp");

    let json = serde_json::to_string_pretty(&session)
        .map_err(|e| format!("Failed to serialize chat: {}", e))?;

    log_info!(
        "api_save_chat: writing {} ({} bytes, {} messages)",
        target.display(),
        json.len(),
        session.messages.len(),
    );

    tokio::fs::write(&temp, json.as_bytes())
        .await
        .map_err(|e| format!("Failed to write temp chat file: {}", e))?;
    tokio::fs::rename(&temp, &target)
        .await
        .map_err(|e| format!("Failed to rename chat temp file: {}", e))?;

    Ok(())
}

/// Read a previously-saved `chat.json`. Returns `None` when the file is
/// absent (older meeting, or chat wasn't used) so callers can hide the UI
/// tab without an error path.
#[tauri::command]
pub async fn api_get_chat(folder_path: String) -> Result<Option<ChatSession>, String> {
    let target = chat_path(&folder_path);
    let bytes = match tokio::fs::read(&target).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Failed to read chat.json: {}", e)),
    };
    let session: ChatSession =
        serde_json::from_slice(&bytes).map_err(|e| format!("chat.json is not valid: {}", e))?;
    Ok(Some(session))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: ChatRole, content: &str) -> ChatMessage {
        ChatMessage {
            role,
            content: content.to_string(),
            timestamp: Utc::now(),
        }
    }

    #[test]
    fn prompt_without_history_has_transcript_and_question() {
        let prompt = build_user_prompt("[00:01] Other: hello", &[], "what did they say?");
        assert!(prompt.contains("Meeting transcript so far:"));
        assert!(prompt.contains("[00:01] Other: hello"));
        assert!(prompt.contains("New question:"));
        assert!(prompt.contains("what did they say?"));
        assert!(!prompt.contains("Conversation so far:"));
    }

    #[test]
    fn prompt_with_history_labels_each_turn() {
        let history = vec![
            msg(ChatRole::User, "who is presenting?"),
            msg(ChatRole::Assistant, "Alex is."),
        ];
        let prompt = build_user_prompt("[00:01] Other: hi", &history, "and after that?");
        assert!(prompt.contains("Conversation so far:"));
        assert!(prompt.contains("You: who is presenting?"));
        assert!(prompt.contains("Assistant: Alex is."));
        // History block precedes the new question.
        let conv = prompt.find("Conversation so far:").unwrap();
        let newq = prompt.find("New question:").unwrap();
        assert!(conv < newq);
    }

    #[test]
    fn prompt_handles_empty_transcript() {
        let prompt = build_user_prompt("   ", &[], "anything discussed?");
        assert!(prompt.contains("(nothing has been transcribed yet)"));
    }

    #[test]
    fn role_serializes_lowercase() {
        let json = serde_json::to_string(&ChatRole::Assistant).unwrap();
        assert_eq!(json, "\"assistant\"");
        let role: ChatRole = serde_json::from_str("\"user\"").unwrap();
        assert_eq!(role, ChatRole::User);
    }

    #[tokio::test]
    async fn get_chat_returns_none_for_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        let result = api_get_chat(path).await.unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn save_then_get_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        let session = ChatSession {
            messages: vec![
                msg(ChatRole::User, "what's the deadline?"),
                msg(ChatRole::Assistant, "Friday."),
            ],
        };
        api_save_chat(path.clone(), session).await.unwrap();
        let loaded = api_get_chat(path).await.unwrap().unwrap();
        assert_eq!(loaded.messages.len(), 2);
        assert_eq!(loaded.messages[0].role, ChatRole::User);
        assert_eq!(loaded.messages[1].content, "Friday.");
    }
}
