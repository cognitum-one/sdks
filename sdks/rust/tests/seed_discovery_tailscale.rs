//! `TailscaleDiscovery` integration tests (ADR-0016a §D6, closes OQ-11).
//!
//! We can't stub `std::process::Command` directly, so these tests drive
//! the provider end-to-end by pointing `.with_command(...)` at a small
//! shell script that echoes fixture JSON on stdout. The script is
//! materialised in a `tempfile::NamedTempFile`-free way using the
//! system's `/bin/sh` + an inline script: `TailscaleDiscovery` invokes
//! the script with `status --json`, the script ignores the args and
//! prints the fixture, we parse and assert on the peer list.
//!
//! On Windows CI this test suite is skipped — see the `cfg(unix)` gate.
//! Core parsing + predicate logic has unit coverage inside
//! `src/seed/discovery/tailscale.rs` which runs on every platform.

#![cfg(feature = "seed")]
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use cognitum_rs::error::Error;
use cognitum_rs::seed::{Discovery, TailscaleDiscovery};

const FIXTURE_STATUS: &str = r#"{
    "Self": {
        "HostName": "ruvultra",
        "DNSName": "ruvultra.tail1234.ts.net.",
        "Online": true
    },
    "Peer": {
        "nodekey_a": {
            "HostName": "cognitum-61bc",
            "DNSName": "cognitum-61bc.tail1234.ts.net.",
            "Online": true
        },
        "nodekey_b": {
            "HostName": "cognitum-aaaa",
            "DNSName": "cognitum-aaaa.tail1234.ts.net.",
            "Online": true
        },
        "nodekey_c": {
            "HostName": "laptop-joe",
            "DNSName": "laptop-joe.tail1234.ts.net.",
            "Online": true
        }
    }
}"#;

/// Write a small shell script that prints the supplied stdout and
/// returns the given exit code. Returns the path to the executable.
fn write_stub_script(name: &str, stdout: &str, exit: i32) -> PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!("cognitum-tailscale-stub-{name}-{}.sh", std::process::id()));
    // Heredoc-free single-line cat using printf + shell quoting; we want
    // the fixture literal so JSON quotes don't confuse the outer shell.
    let escaped = stdout.replace('\'', "'\\''");
    let script = format!(
        "#!/bin/sh\nprintf '%s' '{escaped}'\nexit {exit}\n"
    );
    fs::write(&path, script).expect("write stub");
    let mut perms = fs::metadata(&path).expect("stat").permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&path, perms).expect("chmod");
    path
}

#[tokio::test]
async fn tailscale_discovery_parses_fixture_and_filters_by_prefix() {
    let stub = write_stub_script("ok", FIXTURE_STATUS, 0);
    let provider = TailscaleDiscovery::new().with_command(stub.to_string_lossy().into_owned());
    let peers = provider.discover().await.expect("discover");

    let mut urls: Vec<String> = peers.iter().map(|p| p.url.clone()).collect();
    urls.sort();
    assert_eq!(
        urls,
        vec![
            "https://cognitum-61bc.tail1234.ts.net:8443".to_owned(),
            "https://cognitum-aaaa.tail1234.ts.net:8443".to_owned(),
        ]
    );
    for p in &peers {
        assert!(p.device_id.is_none());
        assert!(p.tls_fingerprint.is_none());
    }
    fs::remove_file(&stub).ok();
}

#[tokio::test]
async fn tailscale_discovery_respects_custom_port() {
    let stub = write_stub_script("port", FIXTURE_STATUS, 0);
    let provider = TailscaleDiscovery::new()
        .with_command(stub.to_string_lossy().into_owned())
        .with_port(18443);
    let peers = provider.discover().await.expect("discover");
    for p in &peers {
        assert!(p.url.ends_with(":18443"), "url {} must use override port", p.url);
    }
    fs::remove_file(&stub).ok();
}

#[tokio::test]
async fn tailscale_discovery_reports_missing_binary() {
    let provider = TailscaleDiscovery::new().with_command("/nonexistent/tailscale-xyz");
    let err = provider.discover().await.expect_err("missing binary must fail");
    assert!(
        matches!(err, Error::Validation(ref m) if m.contains("not found on PATH")),
        "got: {err:?}"
    );
}

#[tokio::test]
async fn tailscale_discovery_rejects_malformed_json() {
    let stub = write_stub_script("bad-json", "this is not json", 0);
    let provider = TailscaleDiscovery::new().with_command(stub.to_string_lossy().into_owned());
    let err = provider.discover().await.expect_err("bad json must fail");
    assert!(
        matches!(err, Error::Validation(ref m) if m.contains("failed to parse")),
        "got: {err:?}"
    );
    fs::remove_file(&stub).ok();
}
