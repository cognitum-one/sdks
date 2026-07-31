//! Rust adapter for the cross-language error-mapping corpus.
//!
//! `sdks/fixtures/error-mapping/` -- ADR-0030a §D1 Domain layer, issue #75.
//!
//! Node and Python run the SAME cases through their own mappers. Each
//! language's own suite only ever checks that language against itself; this is
//! the one that catches the three drifting apart.
//!
//! The mapper itself (`MetaLlmClient::map_http_error`) is `pub(super)`, so the
//! kind-mapping half of this adapter lives in-crate at
//! `src/meta_llm/http.rs`. What runs here is the part an external caller can
//! reach: the `Retry-After` parser, which is where the four-way divergence
//! this corpus was written to catch actually lived.

#![cfg(feature = "meta-llm")]

use std::fs;
use std::path::PathBuf;

use cognitum_one::agentic::parse_retry_after_ms;
use serde_json::Value;

fn corpus() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures/error-mapping/meta-llm-http-errors-v1.json");
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read corpus at {}: {e}", path.display()));
    serde_json::from_str(&text).expect("corpus is valid JSON")
}

#[test]
fn corpus_loaded_and_well_formed() {
    // Guards the adapter itself: a fixture that failed to load, or a corpus
    // silently emptied, must not read as a green run.
    let corpus = corpus();
    let cases = corpus["cases"].as_array().expect("cases array");
    assert!(cases.len() > 20, "corpus shrank to {} cases", cases.len());
    for case in cases {
        assert!(case["id"].is_string(), "every case needs an id");
        assert!(case["expected"].is_object(), "every case needs an expectation");
        assert!(case["why"].is_string(), "every case must say why it exists");
    }
}

#[test]
fn retry_after_parsing_matches_the_corpus_at_the_pinned_instant() {
    // ADR-0030a §D5: deterministic, no wall clock. The corpus pins the instant.
    let corpus = corpus();
    let now_ms = corpus["nowMsForHttpDateCases"].as_i64().expect("pinned instant");
    let mut checked = 0;

    for case in corpus["cases"].as_array().expect("cases array") {
        let Some(header) = case["response"]["headers"]["retry-after"].as_str() else {
            continue;
        };
        let expected = case
            .get("retryAfterMsAtPinnedInstant")
            .unwrap_or(&case["expected"]["retryAfterMs"])
            .as_u64();

        assert_eq!(
            parse_retry_after_ms(Some(header), now_ms),
            expected,
            "case {} header {header:?}",
            case["id"]
        );
        checked += 1;
    }

    assert!(checked >= 5, "expected several Retry-After cases, checked {checked}");
}

#[test]
fn retry_after_grammar_matches_the_corpus() {
    // Every row in this corpus section disagreed across the three SDKs before
    // the grammar was spelled out instead of delegated to each platform's
    // date parser.
    let corpus = corpus();
    let now_ms = corpus["nowMsForHttpDateCases"].as_i64().expect("pinned instant");
    let edges = corpus["retryAfterEdgeCases"].as_array().expect("edge cases");
    assert!(edges.len() >= 20, "grammar corpus shrank to {}", edges.len());

    for edge in edges {
        let header = edge["header"].as_str().expect("header");
        let expected = edge["expectedMs"].as_u64();
        assert_eq!(
            parse_retry_after_ms(Some(header), now_ms),
            expected,
            "header {header:?} ({})",
            edge["why"]
        );
    }
}

#[test]
fn declared_divergences_stay_declared() {
    // A knownDivergence is a deliberate exception. Without this, adding one
    // turns a regression green instantly and nobody notices.
    let corpus = corpus();
    let invariants = &corpus["divergenceInvariants"];
    let languages: Vec<&str> = invariants["languages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l.as_str().unwrap())
        .collect();
    let max_languages = invariants["maxLanguagesPerDivergence"].as_u64().unwrap() as usize;

    let mut divergent: Vec<&str> = Vec::new();
    for case in corpus["cases"].as_array().unwrap() {
        let Some(divergence) = case.get("knownDivergence") else {
            continue;
        };
        let id = case["id"].as_str().unwrap();
        divergent.push(id);

        for key in invariants["requiredKeys"].as_array().unwrap() {
            let key = key.as_str().unwrap();
            assert!(divergence.get(key).is_some(), "{id} needs {key}");
        }
        let overrides = languages.iter().filter(|l| divergence.get(*l).is_some()).count();
        assert!(
            (1..=max_languages).contains(&overrides),
            "{id} declares {overrides} language override(s)"
        );
    }

    let mut expected: Vec<&str> = invariants["expectedDivergentCaseIds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    divergent.sort_unstable();
    expected.sort_unstable();
    assert_eq!(divergent, expected, "the set of divergent cases changed");
}

#[test]
fn an_absent_or_blank_header_yields_no_hint() {
    // "No hint" must mean "use local policy", never "retry now".
    assert_eq!(parse_retry_after_ms(None, 0), None);
    assert_eq!(parse_retry_after_ms(Some(""), 0), None);
    assert_eq!(parse_retry_after_ms(Some("   "), 0), None);
}

#[test]
fn a_hint_is_clamped_rather_than_honoured_unbounded() {
    // A server asking us to sleep for a year is better failed than obeyed.
    let a_year_in_seconds = (400 * 24 * 60 * 60).to_string();
    assert_eq!(
        parse_retry_after_ms(Some(&a_year_in_seconds), 0),
        Some(cognitum_one::agentic::MAX_RETRY_AFTER_MS)
    );
}

#[test]
fn signed_and_exponent_forms_are_not_delta_seconds() {
    // RFC 9110 defines delta-seconds as 1*DIGIT. Coercing these is what made
    // the three SDKs disagree in the first place.
    for malformed in ["-30", "+30", "1e3", "30.5", "30s", "0x1e"] {
        assert_eq!(parse_retry_after_ms(Some(malformed), 0), None, "{malformed}");
    }
}
