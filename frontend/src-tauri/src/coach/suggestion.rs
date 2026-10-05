// What the coach asks the model and how its answer is read back. Pure
// functions only (no Tauri) so the prompt and parsing are unit-testable.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::live_llm::output::{head_chars, parse_json_object, string_array};

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
     starting with \"You:\" were said by the user; lines starting with \"Other:\" were \
     said by the other participants. Pay close attention to who said what: a \"You:\" \
     line is something the user already said, so never answer the user's own questions \
     and never repeat what they just said. Only questions from \"Other:\" lines need an \
     answer. You are also told who said the most recent line: if another participant \
     just asked the user something, the reply answers it for the user; if the user just \
     asked something, the reply is a natural follow-up for after the other person \
     answers; otherwise help the user move the conversation toward their goals. Ground \
     every suggestion in the user's notes and what has been said, \
     and never invent facts about the user that are not in their notes or the \
     transcript. Write in the language the conversation is happening in. Output ONLY a \
     JSON object with keys \"reply\" (string: 1-3 sentences the user could say next, \
     first person, natural spoken language) and \"talking_points\" (array of 2-4 short \
     strings: points to mention or questions to ask, each 15 words or fewer).";

/// Longest quote of the latest line repeated in the prompt.
const LATEST_LINE_QUOTE_CHARS: usize = 300;

/// Who said a transcript line, from its `You:` / `Other:` label.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Speaker {
    User,
    Other,
}

/// Build the user prompt from the user's notes and the transcript so far,
/// ending with an explicit statement of who said the most recent line.
pub fn build_user_prompt(context: &str, transcript: &str) -> String {
    let context = context.trim();
    let transcript = transcript.trim();
    let context = if context.is_empty() {
        "(none provided)"
    } else {
        context
    };
    let latest = latest_line_guidance(transcript);
    let transcript = if transcript.is_empty() {
        "(nothing has been said yet)"
    } else {
        transcript
    };
    format!(
        "User's notes about this conversation:\n{}\n\nTranscript so far:\n{}\n\nMost recent line:\n{}",
        context, transcript, latest
    )
}

/// Spell out who said the latest line, so the model doesn't answer the
/// user's own question back to them.
fn latest_line_guidance(transcript: &str) -> String {
    if transcript.is_empty() {
        return "Nothing has been said yet. Suggest how the user could open the conversation."
            .to_string();
    }
    let Some((speaker, text)) = last_utterance(transcript) else {
        return "The speaker of the most recent line is unknown; judge from the transcript \
                who is speaking."
            .to_string();
    };
    let quote = head_chars(text, LATEST_LINE_QUOTE_CHARS);
    match speaker {
        Speaker::User => format!(
            "Said by the USER (You): \"{}\". These are the user's own words: do not answer \
             them or repeat them. If it was a question, the other participant has not \
             answered yet, so suggest what the user could say once they reply.",
            quote
        ),
        Speaker::Other => format!(
            "Said by ANOTHER PARTICIPANT (Other): \"{}\". If it asks the user something, \
             the reply must answer it on the user's behalf.",
            quote
        ),
    }
}

/// Speaker and text of the last non-empty transcript line, when it carries a
/// `You:` / `Other:` label (lines look like `[MM:SS] You: text`).
fn last_utterance(transcript: &str) -> Option<(Speaker, &str)> {
    let line = transcript.lines().rev().map(str::trim).find(|l| !l.is_empty())?;
    let rest = line.split_once("] ").map_or(line, |(_, rest)| rest);
    if let Some(text) = rest.strip_prefix("You:") {
        return Some((Speaker::User, text.trim()));
    }
    if let Some(text) = rest.strip_prefix("Other:") {
        return Some((Speaker::Other, text.trim()));
    }
    None
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
        assert!(prompt.contains("open the conversation"));
    }

    #[test]
    fn latest_line_by_user_is_not_to_be_answered() {
        let transcript = "[00:00] Other: Hi there\n[00:01] You: Hey, how are you? Good morning.\n";
        let prompt = build_user_prompt("", transcript);
        let latest = &prompt[prompt.find("Most recent line:").unwrap()..];
        assert!(latest.contains("Said by the USER (You)"));
        assert!(latest.contains("\"Hey, how are you? Good morning.\""));
        assert!(latest.contains("do not answer"));
        assert!(!latest.contains("ANOTHER PARTICIPANT"));
    }

    #[test]
    fn latest_line_by_other_is_to_be_answered() {
        let transcript = "[00:01] You: Hello\n\n[00:05] Other: Can you walk me through your last project?\n  \n";
        let prompt = build_user_prompt("", transcript);
        let latest = &prompt[prompt.find("Most recent line:").unwrap()..];
        assert!(latest.contains("Said by ANOTHER PARTICIPANT (Other)"));
        assert!(latest.contains("walk me through your last project?"));
        assert!(!latest.contains("USER (You)"));
    }

    #[test]
    fn latest_line_without_label_is_unknown() {
        let prompt = build_user_prompt("", "[00:01] You: Hello\n[00:03] some unlabelled text");
        assert!(prompt.contains("speaker of the most recent line is unknown"));
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
