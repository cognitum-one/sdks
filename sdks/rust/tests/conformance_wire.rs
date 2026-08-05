//! Rust adapter for the shared request-body conformance corpus (issue #75).
//!
//! Deserialising the fixture into the public request types and serialising it
//! through serde exercises the same wire path used by `MetaLlmClient`, while
//! keeping this test independent of network credentials or a live service.

#![cfg(feature = "meta-llm")]

use cognitum_one::meta_llm::types::{
    AnthropicMessageRequest, ChatCompletionRequest, EmbeddingRequest,
};
use serde_json::Value;

const CORPUS: &str = include_str!("../../fixtures/wire/meta-llm-request-bodies-v1.json");

fn cases() -> Vec<Value> {
    serde_json::from_str::<Value>(CORPUS)
        .expect("wire corpus is valid JSON")["cases"]
        .as_array()
        .expect("wire corpus cases is an array")
        .clone()
}

#[test]
fn corpus_is_complete() {
    let cases = cases();
    assert!(cases.len() >= 5);
    for case in cases {
        assert!(case["id"].as_str().is_some(), "case needs an id");
        assert!(case["why"].as_str().is_some(), "case needs why");
        assert!(case["expectedBody"].is_object(), "case needs expectedBody");
    }
}

#[test]
fn requests_serialize_to_the_canonical_bodies() {
    for case in cases() {
        let operation = case["operation"].as_str().expect("operation");
        let input = &case["input"];
        let body = match operation {
            "chat.completions" => serde_json::to_value(
                serde_json::from_value::<ChatCompletionRequest>(input.clone())
                    .expect("chat request matches public type"),
            ),
            "embeddings" => serde_json::to_value(
                serde_json::from_value::<EmbeddingRequest>(input.clone())
                    .expect("embedding request matches public type"),
            ),
            "messages.create" => serde_json::to_value(
                serde_json::from_value::<AnthropicMessageRequest>(input.clone())
                    .expect("messages request matches public type"),
            ),
            other => panic!("unsupported corpus operation {other}"),
        }
        .expect("request serializes");

        assert_eq!(normalise_numbers(&body), normalise_numbers(&case["expectedBody"]), "case {}", case["id"]);
        assert_no_nulls(&body, &case["id"].to_string());
    }
}

fn normalise_numbers(value: &Value) -> Value {
    match value {
        Value::Number(number) => Value::from(number.as_f64().expect("finite JSON number")),
        Value::Array(items) => Value::Array(items.iter().map(normalise_numbers).collect()),
        Value::Object(fields) => fields
            .iter()
            .map(|(key, item)| (key.clone(), normalise_numbers(item)))
            .collect(),
        Value::Null | Value::Bool(_) | Value::String(_) => value.clone(),
    }
}

fn assert_no_nulls(value: &Value, path: &str) {
    match value {
        Value::Null => panic!("explicit null at {path}"),
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                assert_no_nulls(item, &format!("{path}[{index}]"));
            }
        }
        Value::Object(fields) => {
            for (name, item) in fields {
                assert_no_nulls(item, &format!("{path}.{name}"));
            }
        }
        Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}
