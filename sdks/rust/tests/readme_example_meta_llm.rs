#![cfg(feature = "meta-llm")]
//! Exercises the exact construction + streaming shape shown in this crate's
//! README "Agentic layer (v0.3)" section end-to-end (mocked HTTP server), so
//! a future API rename fails this test instead of only being caught by
//! manual inspection (see cognitum-one/sdks#122).

use std::sync::Arc;

use cognitum_one::agentic::{StaticApiKeyCredentialProvider, StaticApiKeyCredentialProviderOptions};
use cognitum_one::meta_llm::types::{ChatCompletionRequest, ChatMessage, ChatMessageContent, ChatRole};
use cognitum_one::meta_llm::{MetaLlmClient, MetaLlmClientConfig, OpenAiStreamEvent};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn readme_example_streams_content_delta() {
    let server = MockServer::start().await;
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hello\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n",
    );
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(body.as_bytes().to_vec(), "text/event-stream"),
        )
        .mount(&server)
        .await;

    let base_url = server.uri();
    let mut config = MetaLlmClientConfig::new(&base_url);
    config.allow_insecure_http = true; // mock server is plain HTTP; README uses a real https:// origin
    config.credential_provider = Some(Arc::new(
        StaticApiKeyCredentialProvider::new(
            "meta-llm",
            &base_url,
            &base_url, // audience must match base_url (ADR-0022 §D3)
            StaticApiKeyCredentialProviderOptions {
                api_key: Some("sk-test-canary-1234".to_owned()),
                ..Default::default()
            },
        )
        .unwrap(),
    ));

    let llm = MetaLlmClient::new(config).unwrap();

    let request = ChatCompletionRequest {
        model: "cognitum-meta-llm".into(),
        messages: vec![ChatMessage {
            role: ChatRole::User,
            content: Some(ChatMessageContent::Text("hello".into())),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        }],
        max_tokens: None, temperature: None, top_p: None, n: None, stream: None, stop: None,
        presence_penalty: None, frequency_penalty: None, logit_bias: None, user: None,
        tools: None, tool_choice: None, response_format: None, seed: None, routing_controls: None,
    };

    let mut stream = llm.chat_completions_stream(&request, None, None).await.unwrap();
    let mut deltas = String::new();
    while let Some(envelope) = stream.next_envelope().await.unwrap() {
        if let OpenAiStreamEvent::ContentDelta { delta, .. } = envelope.event {
            deltas.push_str(&delta);
        }
    }

    assert_eq!(deltas, "hello");
}
