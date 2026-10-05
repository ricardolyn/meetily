// Turning raw LLM text into structured data. Pure functions only (no Tauri),
// shared by the in-meeting features that ask the model for a JSON object.

use serde_json::Value;

/// Take at most `n` chars from `s` without slicing inside a multi-byte
/// UTF-8 codepoint. `&s[..n]` panics if byte index `n` lands inside a
/// codepoint (emoji, accented letter, CJK, etc.).
pub fn head_chars(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

/// Parse the JSON object an LLM was asked to return.
///
/// Tolerates a markdown code fence around the object and, failing a direct
/// parse, extracts the first balanced `{ ... }` block — local models often
/// wrap the object in prose like "Here is the JSON: { ... }".
pub fn parse_json_object(raw: &str) -> Result<Value, String> {
    let cleaned = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    if let Ok(value) = serde_json::from_str(cleaned) {
        return Ok(value);
    }

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
    })
}

/// Read `key` as an array of strings, trimming each entry and dropping
/// empty or non-string ones. Missing or non-array values yield an empty list.
pub fn string_array(value: &Value, key: &str) -> Vec<String> {
    let mut items = Vec::new();
    let Some(entries) = value.get(key).and_then(Value::as_array) else {
        return items;
    };
    for entry in entries {
        let Some(text) = entry.as_str() else {
            continue;
        };
        let text = text.trim();
        if !text.is_empty() {
            items.push(text.to_string());
        }
    }
    items
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn head_chars_does_not_split_multibyte_chars() {
        assert_eq!(head_chars("ação", 2), "aç");
        assert_eq!(head_chars("short", 50), "short");
    }

    #[test]
    fn parses_plain_object() {
        let value = parse_json_object(r#"{"a": 1}"#).unwrap();
        assert_eq!(value["a"], 1);
    }

    #[test]
    fn parses_fenced_object() {
        let value = parse_json_object("```json\n{\"a\": 2}\n```").unwrap();
        assert_eq!(value["a"], 2);
    }

    #[test]
    fn extracts_object_from_prose() {
        let raw = "Sure! Here is the JSON: {\"a\": {\"b\": \"}\"}} hope it helps";
        let value = parse_json_object(raw).unwrap();
        assert_eq!(value["a"]["b"], "}");
    }

    #[test]
    fn rejects_output_without_object() {
        let err = parse_json_object("no json here").unwrap_err();
        assert!(err.contains("no JSON object"));
    }

    #[test]
    fn rejects_unbalanced_object() {
        let err = parse_json_object("prefix {\"a\": 1").unwrap_err();
        assert!(err.contains("no JSON object"));
    }

    #[test]
    fn string_array_trims_and_skips_junk() {
        let value: Value =
            serde_json::from_str(r#"{"k": ["  one ", "", 3, "two"]}"#).unwrap();
        assert_eq!(string_array(&value, "k"), vec!["one", "two"]);
    }

    #[test]
    fn string_array_missing_or_wrong_type_is_empty() {
        let value: Value = serde_json::from_str(r#"{"k": "not an array"}"#).unwrap();
        assert!(string_array(&value, "k").is_empty());
        assert!(string_array(&value, "missing").is_empty());
    }
}
