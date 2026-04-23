//! Integration tests for the MCP stdio transport (OQ-4).
//!
//! Uses a tiny `sh` shim as the "MCP server" so we don't need a full
//! server binary on PATH. The shim reads newline-delimited JSON from
//! stdin and echoes a JSON-RPC-2.0-shaped response on stdout, while
//! also emitting one line on stderr to exercise the drain path.
//!
//! The tests only run on Unix-ish systems where `sh` is on PATH — if
//! `sh` isn't present (e.g. some minimal CI images) the test is
//! skipped rather than failing loudly.

use std::time::Duration;

use cognitum_rs::mcp::{JsonRpcMessage, McpClient, McpError, StdioTransport, Transport};
use serde_json::{json, Value};
use tokio::time::timeout;

/// Shim that echoes each stdin line back as a valid JSON-RPC response.
///
/// The id is hardcoded to 1 because the tests here only send one request
/// at a time; `McpClient::request()` increments from 1 so the first call
/// gets id=1, which matches. For multi-request tests we build responses
/// manually.
const ECHO_SHIM: &str = r#"
while IFS= read -r line; do
    # Emit one stderr breadcrumb to prove the drain task doesn't deadlock.
    echo "echo-shim got: $line" 1>&2
    # Wrap whatever came in as the `result.echo` of a JSON-RPC response.
    # Use printf to avoid shell interpreting backslashes.
    printf '{"jsonrpc":"2.0","id":1,"result":{"echo":%s}}\n' "$line"
done
"#;

fn sh_on_path() -> bool {
    std::process::Command::new("sh")
        .arg("-c")
        .arg("true")
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[tokio::test]
async fn transport_send_recv_round_trip() {
    if !sh_on_path() {
        eprintln!("skipping: sh not on PATH");
        return;
    }
    let mut transport = StdioTransport::builder()
        .command("sh")
        .args(["-c", ECHO_SHIM])
        .spawn()
        .expect("spawn");

    // Send a plain JSON-RPC request.
    let req = JsonRpcMessage::request(1u64, "ping", json!({"hello": "world"}));
    transport.send(req).await.expect("send");

    let reply = timeout(Duration::from_secs(5), transport.recv())
        .await
        .expect("recv did not time out")
        .expect("recv ok");

    assert_eq!(reply.jsonrpc, "2.0");
    assert_eq!(reply.id, Some(json!(1)));
    // The echo shim wraps the whole inbound line; assert the method we
    // sent bubbled through.
    let result = reply.result.expect("response has result");
    let echo = result.get("echo").expect("echo field");
    assert_eq!(echo.get("method"), Some(&Value::String("ping".into())));

    transport.close().await.expect("close");
}

#[tokio::test]
async fn close_kills_subprocess_cleanly() {
    if !sh_on_path() {
        eprintln!("skipping: sh not on PATH");
        return;
    }
    // `cat` runs forever until stdin closes. `close()` drops stdin,
    // which gives `cat` its EOF — it should exit inside CLOSE_GRACE (5s).
    let mut transport = StdioTransport::builder()
        .command("cat")
        .spawn()
        .expect("spawn cat");

    let pid = transport.pid().expect("pid before close");
    assert!(pid > 0);

    // Round-trip one message so we know the pipes are wired up.
    transport
        .send(JsonRpcMessage::notification("noop", json!({})))
        .await
        .expect("send");
    // `cat` echoes verbatim, so recv should decode the same JSON we sent.
    let reply = timeout(Duration::from_secs(3), transport.recv())
        .await
        .expect("recv did not time out")
        .expect("recv ok");
    assert_eq!(reply.method, Some("noop".into()));

    let close_started = std::time::Instant::now();
    transport.close().await.expect("close");
    // Graceful exit path — well under the 5s budget.
    assert!(
        close_started.elapsed() < Duration::from_secs(5),
        "close took too long: {:?}",
        close_started.elapsed()
    );
    // After close the transport reports no pid.
    assert!(transport.pid().is_none());
}

#[tokio::test]
async fn stderr_drain_does_not_block_send() {
    if !sh_on_path() {
        eprintln!("skipping: sh not on PATH");
        return;
    }
    // Shim that spams stderr BEFORE responding. Without a dedicated
    // drain task this would fill the ~64 KB stderr pipe buffer and
    // wedge the child, so we'd time out on recv().
    let spam = r#"
for i in $(seq 1 4096); do
    echo "stderr-spam-$i" 1>&2
done
while IFS= read -r line; do
    printf '{"jsonrpc":"2.0","id":1,"result":{}}\n'
done
"#;

    let mut transport = StdioTransport::builder()
        .command("sh")
        .args(["-c", spam])
        .spawn()
        .expect("spawn");

    // Give the child a moment to spam stderr before we do anything.
    tokio::time::sleep(Duration::from_millis(50)).await;

    transport
        .send(JsonRpcMessage::request(1u64, "ping", json!({})))
        .await
        .expect("send");

    let reply = timeout(Duration::from_secs(5), transport.recv())
        .await
        .expect("recv did not time out")
        .expect("recv ok");
    assert_eq!(reply.id, Some(json!(1)));

    transport.close().await.expect("close");
}

#[tokio::test]
async fn mcp_client_request_returns_rpc_error_on_server_error() {
    if !sh_on_path() {
        eprintln!("skipping: sh not on PATH");
        return;
    }
    // Always-error shim: whatever the client sends, we return a JSON-RPC
    // error object with code -32601.
    let err_shim = r#"
while IFS= read -r line; do
    printf '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}\n'
done
"#;
    let transport = StdioTransport::builder()
        .command("sh")
        .args(["-c", err_shim])
        .spawn()
        .expect("spawn");
    let mut client = McpClient::new(transport);

    let result = client.request("nonexistent", json!({})).await;
    let err = result.expect_err("server returned JSON-RPC error");
    match err {
        McpError::Rpc { code, ref message } => {
            assert_eq!(code, -32601);
            assert!(message.contains("Method not found"), "got: {}", message);
        }
        other => panic!("unexpected error: {other:?}"),
    }
    client.close().await.expect("close");
}

#[tokio::test]
async fn builder_requires_command() {
    // No command set → spawn() returns a deterministic error rather than
    // a panic or a crash inside tokio's Command.
    let result = StdioTransport::builder().spawn();
    let err = match result {
        Ok(_) => panic!("spawn() with no command should fail"),
        Err(e) => e,
    };
    let msg = err.to_string();
    assert!(msg.contains("command"), "error mentions command: {msg}");
}
