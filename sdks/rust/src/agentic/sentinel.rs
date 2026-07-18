//! Concrete `SecretRedactor` implementation — the sentinel scan defined by
//! ADR-0028 §D13, driven by ADR-0022 §D10 classification and the D12
//! category list. Closes issue #54.
//!
//! Faithful to D13's exact mechanism
//! (`docs/adr/0028-agentic-telemetry-usage-receipts-lineage-and-redaction.md`):
//!
//! 1. A key-name check against the D12 category list runs first — a value
//!    can be sensitive purely because of the field it lives in, regardless
//!    of shape.
//! 2. Fixed-format matchers (bearer token, JWT, PEM private-key block,
//!    cloud-provider access-key pattern, pre-signed URL query parameter)
//!    run next.
//! 3. A Shannon-entropy fallback (>= 4.0 bits/char over a contiguous token
//!    of >= 20 characters) runs ONLY if no fixed-format matcher hit — a
//!    match is classified by pattern first, entropy only as a fallback.
//! 4. Traversal is a bounded-depth-8 DFS: a value reached at depth 9 or
//!    deeper is replaced with `[max-depth-exceeded]` without further
//!    recursion. Cycles are broken by an identity visited-set and replaced
//!    with `[cyclic-reference]`. Matches are replaced with
//!    `[redacted:<category>]`, where `<category>` is a D12 category name,
//!    or `secret-pattern` / `high-entropy` for value-only matches.
//!
//! `serde_json::Value` is an owned tree: Rust's ownership model makes it
//! structurally impossible for a value to contain itself, so a literal
//! cycle can never reach [`SentinelSecretRedactor::redact_value`] through
//! the public API. The walker is still written against a small internal
//! [`GraphValue`] representation that supports genuine `Rc<RefCell<_>>`
//! aliasing, so the identical cycle guard protects a caller that ever
//! hands the redactor a shared, graph-shaped structure (e.g. a telemetry
//! attribute cache built incrementally with interior mutability), and the
//! guard is exercised directly in the test suite below with a real cycle.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Number, Value};

use crate::agentic::credentials::{SecretClassification, SecretRedactor};

/// D12/D13 category list consulted by the key-name check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum D12Category {
    Prompts,
    Messages,
    ToolArgumentsResults,
    Source,
    RepositoryUrls,
    Patches,
    Credentials,
    EnvironmentValues,
    WebhookBodies,
    SignedUrls,
    RawTenantUserIdentifiers,
}

impl D12Category {
    fn as_str(self) -> &'static str {
        match self {
            D12Category::Prompts => "prompts",
            D12Category::Messages => "messages",
            D12Category::ToolArgumentsResults => "tool-arguments-results",
            D12Category::Source => "source",
            D12Category::RepositoryUrls => "repository-urls",
            D12Category::Patches => "patches",
            D12Category::Credentials => "credentials",
            D12Category::EnvironmentValues => "environment-values",
            D12Category::WebhookBodies => "webhook-bodies",
            D12Category::SignedUrls => "signed-urls",
            D12Category::RawTenantUserIdentifiers => "raw-tenant-user-identifiers",
        }
    }
}

const MAX_DEPTH: usize = 8;
const ENTROPY_THRESHOLD_BITS_PER_CHAR: f64 = 4.0;
const ENTROPY_MIN_TOKEN_LEN: usize = 20;

const MAX_DEPTH_MARKER: &str = "[max-depth-exceeded]";
const CYCLIC_MARKER: &str = "[cyclic-reference]";

fn normalize_field_name(field_name: &str) -> String {
    field_name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

// D12/D13 category list, ADR-0028 §D12 and §D13's restatement of it:
// prompts, messages, tool arguments/results, source, repository URLs,
// patches, credentials, environment values, webhook bodies, signed URLs,
// raw tenant/user identifiers.
fn key_name_rule(field_name: Option<&str>) -> Option<(D12Category, SecretClassification)> {
    let normalized = normalize_field_name(field_name?);
    let hit = |names: &[&str]| names.contains(&normalized.as_str());
    if hit(&["credential", "credentials", "apikey", "clientsecret", "secret", "token", "password", "accesskey", "authorization"]) {
        return Some((D12Category::Credentials, SecretClassification::Secret));
    }
    if hit(&["env", "environment", "envvars", "environmentvalues", "environmentvariables"]) {
        return Some((D12Category::EnvironmentValues, SecretClassification::Secret));
    }
    if hit(&["signedurl", "presignedurl", "signedurls"]) {
        return Some((D12Category::SignedUrls, SecretClassification::Secret));
    }
    if hit(&["webhookbody", "webhookpayload", "webhookbodies"]) {
        return Some((D12Category::WebhookBodies, SecretClassification::Sensitive));
    }
    if hit(&["userid", "tenantid", "rawuserid", "rawtenantid", "accountid"]) {
        return Some((D12Category::RawTenantUserIdentifiers, SecretClassification::Sensitive));
    }
    if hit(&["prompt", "prompts", "systemprompt"]) {
        return Some((D12Category::Prompts, SecretClassification::Sensitive));
    }
    if hit(&["message", "messages", "chatmessages"]) {
        return Some((D12Category::Messages, SecretClassification::Sensitive));
    }
    if hit(&["toolarguments", "toolresults", "toolargs", "tooloutput"]) {
        return Some((D12Category::ToolArgumentsResults, SecretClassification::Sensitive));
    }
    if hit(&["source", "sourcecode", "sourcefiles"]) {
        return Some((D12Category::Source, SecretClassification::Sensitive));
    }
    if hit(&["repositoryurl", "repourl", "repositoryurls"]) {
        return Some((D12Category::RepositoryUrls, SecretClassification::Sensitive));
    }
    if hit(&["patch", "patches", "diff"]) {
        return Some((D12Category::Patches, SecretClassification::Sensitive));
    }
    None
}

// Fixed-format matchers (ADR-0028 §D13), evaluated before the entropy
// fallback. Each matches a *whole* leaf value, since D13 replaces the leaf
// entirely rather than redacting a substring.
static BEARER_TOKEN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^bearer\s+[a-z0-9._~+/-]{16,}=*$").unwrap());
static JWT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}$").unwrap());
static PEM_PRIVATE_KEY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"-----BEGIN[ A-Z0-9]*PRIVATE KEY-----").unwrap());
// AWS access/session key IDs (AKIA.../ASIA...) and Google API keys (AIza...).
static CLOUD_ACCESS_KEY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}\b").unwrap()
});
// Pre-signed URL query parameters (SigV4, generic "Signature=", Azure SAS).
static PRESIGNED_URL_PARAM_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)[?&](?:X-Amz-Signature|X-Amz-Credential|Signature|se)=").unwrap());
// Maximal runs of token-shaped characters, used to find contiguous
// candidates for the entropy fallback without over-matching plain prose.
static TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[A-Za-z0-9+/=_.~-]+").unwrap());

fn matches_fixed_format(value: &str) -> bool {
    BEARER_TOKEN_RE.is_match(value)
        || JWT_RE.is_match(value)
        || PEM_PRIVATE_KEY_RE.is_match(value)
        || CLOUD_ACCESS_KEY_RE.is_match(value)
        || PRESIGNED_URL_PARAM_RE.is_match(value)
}

/// Shannon entropy in bits/char over a string's character distribution.
fn shannon_entropy(token: &str) -> f64 {
    let n = token.chars().count();
    if n == 0 {
        return 0.0;
    }
    let mut counts = std::collections::HashMap::new();
    for ch in token.chars() {
        *counts.entry(ch).or_insert(0usize) += 1;
    }
    let n = n as f64;
    counts
        .values()
        .map(|&count| {
            let p = count as f64 / n;
            -p * p.log2()
        })
        .sum()
}

fn matches_entropy_fallback(value: &str) -> bool {
    TOKEN_RE.find_iter(value).any(|m| {
        let token = m.as_str();
        token.chars().count() >= ENTROPY_MIN_TOKEN_LEN
            && shannon_entropy(token) >= ENTROPY_THRESHOLD_BITS_PER_CHAR
    })
}

/// Redacted-leaf category, per D13: a D12 category, or a value-only match.
fn classify_leaf(field_name: Option<&str>, value: &str) -> Option<&'static str> {
    if let Some((category, _)) = key_name_rule(field_name) {
        return Some(category.as_str());
    }
    if matches_fixed_format(value) {
        return Some("secret-pattern");
    }
    if matches_entropy_fallback(value) {
        return Some("high-entropy");
    }
    None
}

/// Internal graph-shaped value used to make cycle detection meaningfully
/// testable (see module docs). Mirrors [`serde_json::Value`] but allows
/// `Rc<RefCell<_>>` aliasing between nodes.
#[derive(Clone)]
enum GraphValue {
    Null,
    Bool(bool),
    Number(Number),
    String(String),
    Array(Vec<Rc<RefCell<GraphValue>>>),
    Object(Vec<(String, Rc<RefCell<GraphValue>>)>),
}

impl From<Value> for GraphValue {
    fn from(value: Value) -> Self {
        match value {
            Value::Null => GraphValue::Null,
            Value::Bool(b) => GraphValue::Bool(b),
            Value::Number(n) => GraphValue::Number(n),
            Value::String(s) => GraphValue::String(s),
            Value::Array(items) => GraphValue::Array(
                items
                    .into_iter()
                    .map(|item| Rc::new(RefCell::new(GraphValue::from(item))))
                    .collect(),
            ),
            Value::Object(map) => GraphValue::Object(
                map.into_iter()
                    .map(|(k, v)| (k, Rc::new(RefCell::new(GraphValue::from(v)))))
                    .collect(),
            ),
        }
    }
}

/// Bounded-depth-8 DFS with cycle detection via an identity visited-set
/// (ancestor stack of `Rc` pointer addresses), per ADR-0028 §D13.
fn walk_graph(
    node: &Rc<RefCell<GraphValue>>,
    field_name: Option<&str>,
    depth: usize,
    ancestors: &mut Vec<usize>,
) -> Value {
    if depth > MAX_DEPTH {
        return Value::String(MAX_DEPTH_MARKER.to_string());
    }

    let ptr = Rc::as_ptr(node) as usize;
    if ancestors.contains(&ptr) {
        return Value::String(CYCLIC_MARKER.to_string());
    }

    // Clone what we need out of the borrow before recursing, since a
    // recursive call may itself need to borrow this same `Rc` again for an
    // unrelated sibling (borrow_mut is never held across recursion here).
    let snapshot = node.borrow().clone();
    match snapshot {
        GraphValue::Null => Value::Null,
        GraphValue::Bool(b) => Value::Bool(b),
        GraphValue::Number(n) => Value::Number(n),
        GraphValue::String(s) => match classify_leaf(field_name, &s) {
            Some(category) => Value::String(format!("[redacted:{category}]")),
            None => Value::String(s),
        },
        GraphValue::Array(items) => {
            ancestors.push(ptr);
            let result = items
                .iter()
                .map(|item| walk_graph(item, field_name, depth + 1, ancestors))
                .collect();
            ancestors.pop();
            Value::Array(result)
        }
        GraphValue::Object(entries) => {
            ancestors.push(ptr);
            let mut map = Map::new();
            for (key, val) in &entries {
                map.insert(key.clone(), walk_graph(val, Some(key), depth + 1, ancestors));
            }
            ancestors.pop();
            Value::Object(map)
        }
    }
}

/// Concrete `SecretRedactor` (ADR-0022 §D1/§D10) implementing the exact
/// sentinel-scan mechanism specified by ADR-0028 §D13.
#[derive(Debug, Default, Clone, Copy)]
pub struct SentinelSecretRedactor;

impl SentinelSecretRedactor {
    pub fn new() -> Self {
        Self
    }
}

impl SecretRedactor for SentinelSecretRedactor {
    fn classify(&self, field_name: &str, value: &Value) -> SecretClassification {
        if let Some((_, classification)) = key_name_rule(Some(field_name)) {
            return classification;
        }
        if let Value::String(s) = value {
            if matches_fixed_format(s) || matches_entropy_fallback(s) {
                return SecretClassification::Secret;
            }
        }
        SecretClassification::Public
    }

    fn redact_value(&self, value: Value) -> Value {
        let root: Rc<RefCell<GraphValue>> = Rc::new(RefCell::new(GraphValue::from(value)));
        walk_graph(&root, None, 0, &mut Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // A syntactically bearer-token-shaped string. Not a real credential.
    const BEARER_TOKEN: &str = "Bearer AbCdEfGhIjKlMnOpQrStUvWxYz0123456789.-_ABCDEF";

    // High-entropy but not a recognized fixed format (no dots, no known prefix).
    const HIGH_ENTROPY_UNRECOGNIZED: &str = "Xk92LpQz8vT3mNc7Rw4YbHj1FdEa6Su0";

    // Long but genuinely low-entropy prose.
    const NORMAL_SENTENCE: &str = "The quick brown fox jumps over the lazy dog in the summer evening.";

    /// Build `depth` levels of nesting (a1 -> a2 -> ... -> a<depth>: leaf).
    fn build_nested(depth: usize, leaf: Value) -> Value {
        let mut node = leaf;
        for i in (1..=depth).rev() {
            node = json!({ format!("a{i}"): node });
        }
        node
    }

    #[test]
    fn a_redacts_bearer_token_shaped_string_in_flat_object() {
        let redactor = SentinelSecretRedactor::new();
        let input = json!({ "authToken": BEARER_TOKEN, "note": "hello" });
        let out = redactor.redact_value(input);
        assert_eq!(out["authToken"], json!("[redacted:secret-pattern]"));
        assert_eq!(out["note"], json!("hello"));
    }

    #[test]
    fn b_redacts_secret_buried_in_nested_object_depth_under_8() {
        let redactor = SentinelSecretRedactor::new();
        // 3 levels deep: well within the depth-8 bound. Field name
        // deliberately neutral so this exercises the *value-shape*
        // matcher, not the D12 key-name check (covered separately below).
        let input = build_nested(3, json!({ "value": BEARER_TOKEN, "safe": "ok" }));
        let out = redactor.redact_value(input);
        assert_eq!(out["a1"]["a2"]["a3"]["value"], json!("[redacted:secret-pattern]"));
        assert_eq!(out["a1"]["a2"]["a3"]["safe"], json!("ok"));
    }

    #[test]
    fn c_replaces_value_at_exactly_depth_9_with_max_depth_marker() {
        let redactor = SentinelSecretRedactor::new();
        // 9 levels of nesting (a1..a9) puts the leaf itself at depth 9.
        let input = build_nested(9, json!(BEARER_TOKEN));
        let out = redactor.redact_value(input);
        assert_eq!(
            out["a1"]["a2"]["a3"]["a4"]["a5"]["a6"]["a7"]["a8"]["a9"],
            json!("[max-depth-exceeded]")
        );
    }

    #[test]
    fn d_breaks_cyclic_self_referential_structure_without_infinite_loop() {
        // Rc<RefCell<GraphValue>> is genuinely aliasable, unlike an owned
        // serde_json::Value, so this builds a real self-reference.
        let root = Rc::new(RefCell::new(GraphValue::Object(vec![(
            "name".to_string(),
            Rc::new(RefCell::new(GraphValue::String("root".to_string()))),
        )])));
        if let GraphValue::Object(entries) = &mut *root.borrow_mut() {
            entries.push(("self".to_string(), Rc::clone(&root)));
        }

        let out = walk_graph(&root, None, 0, &mut Vec::new());

        assert_eq!(out["name"], json!("root"));
        assert_eq!(out["self"], json!("[cyclic-reference]"));
    }

    #[test]
    fn e_redacts_high_entropy_string_not_a_recognized_secret_format() {
        let redactor = SentinelSecretRedactor::new();
        assert_eq!(
            redactor.classify("note", &json!(HIGH_ENTROPY_UNRECOGNIZED)),
            SecretClassification::Secret
        );
        let out = redactor.redact_value(json!({ "note": HIGH_ENTROPY_UNRECOGNIZED }));
        assert_eq!(out["note"], json!("[redacted:high-entropy]"));
    }

    #[test]
    fn f_does_not_falsely_redact_normal_low_entropy_string() {
        let redactor = SentinelSecretRedactor::new();
        assert_eq!(
            redactor.classify("description", &json!(NORMAL_SENTENCE)),
            SecretClassification::Public
        );
        let out = redactor.redact_value(json!({ "description": NORMAL_SENTENCE }));
        assert_eq!(out["description"], json!(NORMAL_SENTENCE));
    }

    #[test]
    fn classify_consults_d12_key_name_list_independent_of_value_shape() {
        let redactor = SentinelSecretRedactor::new();
        assert_eq!(
            redactor.classify("apiKey", &json!("not-secret-shaped-value")),
            SecretClassification::Secret
        );
        assert_eq!(
            redactor.classify("prompt", &json!("hello there")),
            SecretClassification::Sensitive
        );
        assert_eq!(
            redactor.classify("repositoryUrl", &json!("https://example.test/repo")),
            SecretClassification::Sensitive
        );
        assert_eq!(redactor.classify("count", &json!("42")), SecretClassification::Public);
    }

    #[test]
    fn generic_redact_round_trips_through_redact_value() {
        #[derive(Debug, serde::Serialize, serde::Deserialize, PartialEq)]
        struct Payload {
            #[serde(rename = "authToken")]
            auth_token: String,
            note: String,
        }

        let redactor = SentinelSecretRedactor::new();
        let out = redactor.redact(Payload {
            auth_token: BEARER_TOKEN.to_string(),
            note: "hello".to_string(),
        });
        assert_eq!(out.auth_token, "[redacted:secret-pattern]");
        assert_eq!(out.note, "hello");
    }
}
