//! Rust adapter for the cross-language request-body corpus.
//!
//! `sdks/fixtures/wire/` -- ADR-0030a §D1 Wire layer, issue #75.
//!
//! Deserialises each case's `input` into the SDK's real request type and
//! serialises it exactly as the client does, then asserts the body equals the
//! canonical one Node and Python also produce.

#![cfg(feature = "meta-llm")]

use std::fs;
use std::path::PathBuf;

use serde_json::Value;

fn corpus() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures/wire/meta-llm-request-bodies-v1.json");
    serde_json::from_str(&fs::read_to_string(&path).expect("corpus readable")).expect("valid JSON")
}

/// Round-trip through the real request type for the operation, exactly as
/// `MetaLlmClient` does before POSTing.
fn serialise(operation: &str, input: &Value) -> Value {
    use cognitum_one::meta_llm::types::{anthropic, openai};
    match operation {
        "chat.completions" => {
            let r: openai::ChatCompletionRequest =
                serde_json::from_value(input.clone()).expect("chat request");
            serde_json::to_value(&r).expect("serialise")
        }
        "embeddings" => {
            let r: openai::EmbeddingRequest =
                serde_json::from_value(input.clone()).expect("embedding request");
            serde_json::to_value(&r).expect("serialise")
        }
        "messages.create" => {
            let r: anthropic::AnthropicMessageRequest =
                serde_json::from_value(input.clone()).expect("messages request");
            serde_json::to_value(&r).expect("serialise")
        }
        other => panic!("corpus references an unmapped operation: {other}"),
    }
}

/// Normalise numbers before comparing: JSON has one number type, so `0` and
/// `0.0` are the same value. See `numberComparisonNote` in the corpus.
fn normalise(value: &Value) -> Value {
    match value {
        Value::Number(n) => serde_json::json!(n.as_f64().unwrap_or(f64::NAN)),
        Value::Array(items) => Value::Array(items.iter().map(normalise).collect()),
        Value::Object(map) => {
            Value::Object(map.iter().map(|(k, v)| (k.clone(), normalise(v))).collect())
        }
        other => other.clone(),
    }
}

fn null_paths(value: &Value, at: &str, out: &mut Vec<String>) {
    match value {
        Value::Null => out.push(at.to_owned()),
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                null_paths(item, &format!("{at}[{i}]"), out);
            }
        }
        Value::Object(map) => {
            for (key, item) in map {
                null_paths(item, &format!("{at}.{key}"), out);
            }
        }
        _ => {}
    }
}

#[test]
fn corpus_loaded_and_complete() {
    let corpus = corpus();
    let cases = corpus["cases"].as_array().expect("cases");
    assert!(cases.len() >= 5, "corpus shrank to {}", cases.len());
    for case in cases {
        assert!(case["id"].is_string() && case["why"].is_string());
        assert!(case["expectedBody"].is_object());
    }
}

#[test]
fn requests_serialise_to_the_canonical_body() {
    let corpus = corpus();
    for case in corpus["cases"].as_array().expect("cases") {
        let id = case["id"].as_str().unwrap();
        let actual = serialise(case["operation"].as_str().unwrap(), &case["input"]);
        assert_eq!(normalise(&actual), normalise(&case["expectedBody"]), "case {id}");
    }
}

#[test]
fn no_null_is_sent_for_an_unset_optional() {
    // The specific defect: without `skip_serializing_if` every unset Option
    // went out as an explicit null, and the gateway rejects that form --
    // `messages[0].name: null` returned HTTP 400 from production.
    let corpus = corpus();
    for case in corpus["cases"].as_array().expect("cases") {
        let id = case["id"].as_str().unwrap();
        let body = serialise(case["operation"].as_str().unwrap(), &case["input"]);
        let mut nulls = Vec::new();
        null_paths(&body, "$", &mut nulls);
        assert!(nulls.is_empty(), "case {id}: explicit nulls at {nulls:?}");
    }
}
