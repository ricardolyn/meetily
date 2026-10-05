// Shared plumbing for the in-meeting LLM features (live notes, chat, coach):
// the model config the frontend sends, and a single timed prompt runner on top
// of the summary LLM client so every provider works the same way.

pub mod output;

use log::{error as log_error, info as log_info, warn as log_warn};
use reqwest::Client;
use serde::Deserialize;
use tauri::{AppHandle, Manager as _, Runtime};
use tokio::time::{timeout, Duration};

use crate::summary::llm_client::{generate_summary, LLMProvider};
use output::head_chars;

/// Model settings resolved by the frontend (same model as saved summaries).
#[derive(Debug, Clone, Deserialize)]
pub struct LlmModelConfig {
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

/// One prompt to send. `label` only names the feature in log lines.
pub struct PromptRequest<'a> {
    pub label: &'a str,
    pub system_prompt: &'a str,
    pub user_prompt: &'a str,
    pub max_tokens: u32,
    pub temperature: f32,
    /// Hard cap on the whole call, so a stuck local model can't hang the UI.
    /// Also dominates the BuiltInAI provider's own longer internal timeout.
    pub timeout: Duration,
}

/// Run `request` against the configured model and return the raw reply text.
///
/// # Errors
/// Returns a user-facing message when the provider name is unknown, the
/// provider call fails, or the call exceeds `request.timeout`.
pub async fn run_prompt<R: Runtime>(
    app: &AppHandle<R>,
    config: &LlmModelConfig,
    request: PromptRequest<'_>,
) -> Result<String, String> {
    let provider = LLMProvider::from_str(&config.provider)?;
    let app_data_dir = app.path().app_data_dir().ok();
    let client = Client::new();

    log_info!(
        "{}: dispatching to {:?} (model={}, has_api_key={}, has_ollama_endpoint={}, has_custom_endpoint={}, prompt_chars={})",
        request.label,
        provider,
        config.model,
        config.api_key.as_deref().is_some_and(|k| !k.is_empty()),
        config.ollama_endpoint.is_some(),
        config.custom_openai_endpoint.as_deref().is_some_and(|e| !e.is_empty()),
        request.user_prompt.len(),
    );

    let call = generate_summary(
        &client,
        &provider,
        &config.model,
        config.api_key.as_deref().unwrap_or(""),
        request.system_prompt,
        request.user_prompt,
        config.ollama_endpoint.as_deref(),
        config.custom_openai_endpoint.as_deref(),
        Some(request.max_tokens),
        Some(request.temperature),
        Some(0.9),
        app_data_dir.as_ref(),
        None,
    );

    match timeout(request.timeout, call).await {
        Ok(Ok(reply)) => {
            log_info!(
                "{}: LLM responded with {} chars. First 200: {}",
                request.label,
                reply.len(),
                head_chars(&reply, 200)
            );
            Ok(reply)
        }
        Ok(Err(e)) => {
            log_error!("{} LLM call failed: {}", request.label, e);
            Err(format!("LLM call failed: {}", e))
        }
        Err(_) => {
            log_warn!(
                "{} LLM call exceeded {:?}; aborting",
                request.label,
                request.timeout
            );
            Err("LLM call timed out".to_string())
        }
    }
}
