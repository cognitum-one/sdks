//! Drive the published crates.io SDK against the live Cognitum gateway.
//!
//! The workflow copies this source into a clean Cargo consumer project whose
//! dependency is an exact published `cognitum-one` version.

use std::env;
use std::process::Command;
use std::sync::Arc;

use cognitum_one::agentic::{
    StaticApiKeyCredentialProvider, StaticApiKeyCredentialProviderOptions,
};
use cognitum_one::meta_llm::types::{
    AnthropicContentBlock, AnthropicMessageContent, AnthropicMessageParam, AnthropicMessageRequest,
    AnthropicRole, ChatCompletionRequest, ChatMessage, ChatMessageContent, ChatRole, UsageQuery,
};
use cognitum_one::meta_llm::{MetaLlmClient, MetaLlmClientConfig};

fn require(condition: bool, message: impl Into<String>) -> Result<(), String> {
    condition.then_some(()).ok_or_else(|| message.into())
}

fn current_month() -> Result<String, String> {
    let output = Command::new("date")
        .args(["-u", "+%Y-%m"])
        .output()
        .map_err(|error| format!("could not determine the UTC usage month: {error}"))?;
    require(
        output.status.success(),
        "date failed while determining the UTC usage month",
    )?;
    let month = String::from_utf8(output.stdout)
        .map_err(|error| format!("date returned invalid UTF-8: {error}"))?;
    let month = month.trim().to_owned();
    require(
        month.len() == 7,
        format!("date returned an invalid usage month: {month:?}"),
    )?;
    Ok(month)
}

fn chat_request() -> ChatCompletionRequest {
    ChatCompletionRequest {
        model: "cognitum-low".into(),
        messages: vec![ChatMessage {
            role: ChatRole::User,
            content: Some(ChatMessageContent::Text("Reply with exactly: ok".into())),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        }],
        max_tokens: Some(8),
        temperature: None,
        top_p: None,
        n: None,
        stream: None,
        stop: None,
        presence_penalty: None,
        frequency_penalty: None,
        logit_bias: None,
        user: None,
        tools: None,
        tool_choice: None,
        response_format: None,
        seed: None,
        routing_controls: None,
    }
}

fn messages_request() -> AnthropicMessageRequest {
    AnthropicMessageRequest {
        model: "cognitum-low".into(),
        messages: vec![AnthropicMessageParam {
            role: AnthropicRole::User,
            content: AnthropicMessageContent::Text("Reply with exactly: ok".into()),
        }],
        max_tokens: 8,
        system: None,
        temperature: None,
        top_p: None,
        top_k: None,
        stop_sequences: None,
        stream: None,
        tools: None,
        tool_choice: None,
        metadata: None,
        routing_controls: None,
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let base_url =
        env::var("COGNITUM_API_BASE_URL").unwrap_or_else(|_| "https://api.cognitum.one".to_owned());
    let api_key = env::var("COGNITUM_API_KEY").map_err(|_| "COGNITUM_API_KEY is not set")?;
    let provider = StaticApiKeyCredentialProvider::new(
        "meta-llm",
        &base_url,
        &base_url,
        StaticApiKeyCredentialProviderOptions {
            api_key: Some(api_key),
            ..Default::default()
        },
    )?;
    let mut config = MetaLlmClientConfig::new(&base_url);
    config.credential_provider = Some(Arc::new(provider));
    let client = MetaLlmClient::new(config)?;

    println!("live Rust smoke against {base_url}");

    let health = client.health().await?;
    require(
        health.data.status == "healthy",
        format!("expected healthy, got {:?}", health.data.status),
    )?;
    println!("ok   health reports healthy");

    let models = client.models().await?;
    require(!models.data.models.is_empty(), "model list is empty")?;
    require(
        models
            .data
            .models
            .iter()
            .any(|model| model.id == "cognitum-low"),
        "model list is missing cognitum-low",
    )?;
    println!("ok   models lists the tier aliases");

    let identity = client.whoami().await?.data;
    require(
        identity.account_id.is_some()
            || identity.credential_type.is_some()
            || identity.tenant_id.is_some(),
        "identity response has no identity fields",
    )?;
    println!("ok   whoami returns authenticated identity");

    let completion = client.chat_completions(&chat_request()).await?.data;
    let content = completion
        .choices
        .first()
        .and_then(|choice| choice.message.content.as_ref())
        .and_then(|content| match content {
            ChatMessageContent::Text(text) => Some(text.as_str()),
            ChatMessageContent::Parts(_) => None,
        });
    require(
        content.is_some_and(|text| !text.trim().is_empty()),
        "empty completion content",
    )?;
    require(
        completion.usage.is_some_and(|usage| usage.total_tokens > 0),
        "completion reported zero or missing total_tokens",
    )?;
    println!("ok   chat.completions returns real content");

    let message = client.messages_create(&messages_request()).await?.data;
    let text = message.content.iter().find_map(|block| match block {
        AnthropicContentBlock::Text { text } => Some(text.as_str()),
        _ => None,
    });
    require(
        text.is_some_and(|value| !value.trim().is_empty()),
        "empty message content",
    )?;
    println!("ok   messages.create returns real content");

    let month = current_month()?;
    let usage = client.usage(&UsageQuery::new(&month, &month)).await?.data;
    require(
        usage
            .totals
            .total_tokens
            .is_some_and(|total_tokens| total_tokens > 0),
        "usage reports zero or missing total_tokens",
    )?;
    require(
        usage.totals.requests.is_some_and(|requests| requests > 0),
        "usage reports zero monthly requests",
    )?;
    println!("ok   usage returns non-empty monthly accounting");
    println!("\nall Rust live checks passed against {base_url}");
    Ok(())
}
