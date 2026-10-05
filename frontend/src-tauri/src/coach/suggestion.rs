// What the coach asks the model and how its answer is read back. Pure
// functions only (no Tauri) so the prompt and parsing are unit-testable.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::live_llm::output::{parse_json_object, string_array};

/// A suggestion of what the user could say next.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoachSuggestion {
    /// 1-3 sentences the user could say right now, first person.
    pub reply: String,
    /// 2-4 short points to mention or questions to ask.
    pub talking_points: Vec<String>,
    pub generated_at: DateTime<Utc>,
}

pub const SYSTEM_PROMPT: &str =
    "You are a discreet real-time coach helping the user during a live conversation \
     (an interview, a sales call, a team meeting, or any other conversation). You get \
     the user's own notes about the conversation (who they are talking to, their goals, \
     background such as a CV or job description) and the transcript so far. Lines \
     starting with \"You:\" are the user; lines starting with \"Other:\" are the other \
     participants. Focus on the most recent exchange: if someone just asked the user a \
     question, help them answer it; otherwise help them move the conversation toward \
     their goals. Ground every suggestion in the user's notes and what has been said, \
     and never invent facts about the user that are not in their notes or the \
     transcript. Write in the language the conversation is happening in. Output ONLY a \
     JSON object with keys \"reply\" (string: 1-3 sentences the user could say next, \
     first person, natural spoken language) and \"talking_points\" (array of 2-4 short \
     strings: points to mention or questions to ask, each 15 words or fewer).";

/// Build the user prompt from the user's notes and the transcript so far.
pub fn build_user_prompt(context: &str, transcript: &str) -> String {
    let context = context.trim();
    let transcript = transcript.trim();
    let context = if context.is_empty() {
        "(none provided)"
    } else {
        context
    };
    let transcript = if transcript.is_empty() {
        "(nothing has been said yet)"
    } else {
        transcript
    };
    format!(
        "User's notes about this conversation:\n{}\n\nTranscript so far:\n{}",
        context, transcript
    )
}

/// Read the model's JSON answer into a suggestion.
///
/// # Errors
/// Returns a message when the output holds no JSON object, or when it has
/// neither a reply nor any talking points.
pub fn parse_suggestion(raw: &str) -> Result<CoachSuggestion, String> {
    let parsed = parse_json_object(raw)?;
    let reply = parsed
        .get("reply")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let talking_points = string_array(&parsed, "talking_points");

    if reply.is_empty() && talking_points.is_empty() {
        return Err("LLM returned an empty suggestion".to_string());
    }

    Ok(CoachSuggestion {
        reply,
        talking_points,
        generated_at: Utc::now(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_includes_context_and_transcript() {
        let prompt = build_user_prompt("Interview for staff engineer", "[00:01] Other: Hi");
        assert!(prompt.contains("Interview for staff engineer"));
        assert!(prompt.contains("[00:01] Other: Hi"));
        let notes = prompt.find("User's notes").unwrap();
        let transcript = prompt.find("Transcript so far").unwrap();
        assert!(notes < transcript);
    }

    #[test]
    fn prompt_marks_missing_context_and_transcript() {
        let prompt = build_user_prompt("  ", "\n");
        assert!(prompt.contains("(none provided)"));
        assert!(prompt.contains("(nothing has been said yet)"));
    }

    #[test]
    fn parses_reply_and_talking_points() {
        let raw = r#"{"reply": " I led that migration. ", "talking_points": ["Scale", " Team size "]}"#;
        let suggestion = parse_suggestion(raw).unwrap();
        assert_eq!(suggestion.reply, "I led that migration.");
        assert_eq!(suggestion.talking_points, vec!["Scale", "Team size"]);
    }

    #[test]
    fn parses_fenced_output_with_prose() {
        let raw = "Here you go:\n```json\n{\"reply\": \"Sure.\", \"talking_points\": []}\n```";
        let suggestion = parse_suggestion(raw).unwrap();
        assert_eq!(suggestion.reply, "Sure.");
        assert!(suggestion.talking_points.is_empty());
    }

    #[test]
    fn accepts_talking_points_without_reply() {
        let suggestion = parse_suggestion(r#"{"talking_points": ["Ask about budget"]}"#).unwrap();
        assert!(suggestion.reply.is_empty());
        assert_eq!(suggestion.talking_points, vec!["Ask about budget"]);
    }

    #[test]
    fn rejects_empty_suggestion() {
        let err = parse_suggestion(r#"{"reply": "  ", "talking_points": []}"#).unwrap_err();
        assert!(err.contains("empty suggestion"));
    }

    #[test]
    fn rejects_non_json_output() {
        assert!(parse_suggestion("I think you should say hello").is_err());
    }
}
