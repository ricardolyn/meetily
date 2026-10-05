// Live coach: on request, suggests what the user could say next during a
// call, from notes they wrote before or during the call plus the transcript
// so far. Runtime-only; nothing is written to disk or the DB.

pub mod suggestion;

use log::{error as log_error, info as log_info};
use tauri::{AppHandle, Runtime};
use tokio::time::Duration;

use crate::live_llm::{run_prompt, LlmModelConfig, PromptRequest};
use suggestion::{build_user_prompt, parse_suggestion, CoachSuggestion, SYSTEM_PROMPT};

/// Same budget as chat: the prompt carries the whole-meeting transcript.
const LLM_CALL_TIMEOUT: Duration = Duration::from_secs(60);

/// Suggest what the user could say next.
///
/// # Errors
/// Returns a user-facing message when there is neither context nor
/// transcript to work from, or when the LLM call or its parsing fails.
#[tauri::command]
pub async fn api_coach_suggest<R: Runtime>(
    app: AppHandle<R>,
    meeting_id: String,
    context: String,
    transcript: String,
    model_config: LlmModelConfig,
) -> Result<CoachSuggestion, String> {
    log_info!(
        "api_coach_suggest called: meeting_id={}, context_chars={}, transcript_chars={}, provider={}, model={}",
        meeting_id,
        context.len(),
        transcript.len(),
        model_config.provider,
        model_config.model,
    );

    if context.trim().is_empty() && transcript.trim().is_empty() {
        return Err(
            "Nothing to go on yet: add some context or wait for the conversation to start"
                .to_string(),
        );
    }

    let user_prompt = build_user_prompt(&context, &transcript);
    let raw = run_prompt(
        &app,
        &model_config,
        PromptRequest {
            label: "Coach",
            system_prompt: SYSTEM_PROMPT,
            user_prompt: &user_prompt,
            max_tokens: 600,
            temperature: 0.4,
            timeout: LLM_CALL_TIMEOUT,
        },
    )
    .await?;

    parse_suggestion(&raw).inspect_err(|e| {
        log_error!("Coach: parse failed — {}. Full LLM output:\n{}", e, raw);
    })
}
