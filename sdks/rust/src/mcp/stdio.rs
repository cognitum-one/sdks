//! Stdio-backed [`Transport`] implementation.
//!
//! Spawns a subprocess and frames JSON-RPC messages as newline-delimited
//! UTF-8 over its stdin/stdout. Stderr is continuously drained on a
//! background `tokio::task` so the child cannot wedge the pipe. Parity
//! with Node's `createStdioTransport(cmd, args)`.
//!
//! See `sdks/node/src/mcp-stdio.ts` for the Node-side reference shape —
//! the wire format is byte-identical (one JSON object per line, no
//! content-length prefix, no Content-Type header).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::task::JoinHandle;
use tokio::time::timeout;

use super::transport::{JsonRpcMessage, McpError, Transport};

/// Graceful shutdown budget: after dropping stdin we give the child this
/// long to exit on its own before we force-kill.
const CLOSE_GRACE: Duration = Duration::from_secs(5);

/// Newline-delimited JSON stdio transport for MCP subprocess servers.
pub struct StdioTransport {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    stdout: Option<BufReader<ChildStdout>>,
    /// Handle to the stderr drain task so `close()` can await its exit.
    stderr_task: Option<JoinHandle<()>>,
    line_buf: String,
}

impl StdioTransport {
    /// Start a new builder.
    pub fn builder() -> StdioTransportBuilder {
        StdioTransportBuilder::default()
    }

    /// Access the still-running child's OS-level pid. `None` after `close()`.
    pub fn pid(&self) -> Option<u32> {
        self.child.as_ref().and_then(|c| c.id())
    }
}

/// Fluent builder for a [`StdioTransport`].
///
/// ```rust,no_run
/// # async fn demo() -> Result<(), cognitum_rs::mcp::McpError> {
/// use cognitum_rs::mcp::StdioTransport;
/// let transport = StdioTransport::builder()
///     .command("npx")
///     .args(["-y", "@some/mcp-server"])
///     .env("SOME_KEY", "secret")
///     .spawn()?;
/// # let _ = transport;
/// # Ok(()) }
/// ```
#[derive(Debug, Clone)]
pub struct StdioTransportBuilder {
    command: Option<String>,
    args: Vec<String>,
    env: BTreeMap<String, String>,
    cwd: Option<PathBuf>,
    /// When `true`, inherit the parent's full env in addition to `env`
    /// overlays. Defaults to `true` to match Node's behaviour.
    inherit_env: bool,
}

impl StdioTransportBuilder {
    /// Set the executable to spawn.
    pub fn command(mut self, command: impl Into<String>) -> Self {
        self.command = Some(command.into());
        self
    }

    /// Append a single argument.
    pub fn arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push(arg.into());
        self
    }

    /// Set the full argument list (replaces any prior `.arg()` calls).
    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args = args.into_iter().map(Into::into).collect();
        self
    }

    /// Overlay a single env var.
    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(key.into(), value.into());
        self
    }

    /// Working directory for the child process.
    pub fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    /// Toggle parent-env inheritance. Defaults to `true`.
    pub fn inherit_env(mut self, inherit: bool) -> Self {
        self.inherit_env = inherit;
        self
    }

    /// Spawn the subprocess and return the live transport.
    pub fn spawn(mut self) -> Result<StdioTransport, McpError> {
        let command = self
            .command
            .take()
            .ok_or_else(|| McpError::Other("StdioTransport: command not set".into()))?;
        let mut cmd = Command::new(&command);
        cmd.args(&self.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if !self.inherit_env {
            cmd.env_clear();
        }
        for (k, v) in &self.env {
            cmd.env(k, v);
        }
        if let Some(cwd) = &self.cwd {
            cmd.current_dir(cwd);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| McpError::Other(format!("spawn {command}: {e}")))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| McpError::Other("no stdin pipe".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| McpError::Other("no stdout pipe".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| McpError::Other("no stderr pipe".into()))?;

        // Drain stderr on a background task. Don't propagate errors —
        // losing stderr is never a reason to tear down the transport.
        let stderr_task = tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break,
                    Ok(_) => {
                        // Trim trailing newline for cleaner logs.
                        let trimmed = line.trim_end_matches(['\r', '\n']);
                        if !trimmed.is_empty() {
                            // tracing isn't a dep; the seed tree uses
                            // `eprintln!` sparingly for operator-visible
                            // breadcrumbs (see src/seed/client.rs). Match
                            // that style here — one line per subprocess
                            // stderr line, prefixed so it's greppable.
                            eprintln!("[mcp-stdio] {trimmed}");
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(StdioTransport {
            child: Some(child),
            stdin: Some(stdin),
            stdout: Some(BufReader::new(stdout)),
            stderr_task: Some(stderr_task),
            line_buf: String::new(),
        })
    }
}

// Manual Default so `inherit_env` defaults to `true` (matches Node's
// behaviour of inheriting the parent env unless the caller clears it).
impl Default for StdioTransportBuilder {
    fn default() -> Self {
        Self {
            command: None,
            args: Vec::new(),
            env: BTreeMap::new(),
            cwd: None,
            inherit_env: true,
        }
    }
}

#[async_trait]
impl Transport for StdioTransport {
    async fn send(&mut self, msg: JsonRpcMessage) -> Result<(), McpError> {
        let stdin = self.stdin.as_mut().ok_or(McpError::Closed)?;
        let mut bytes = serde_json::to_vec(&msg)?;
        bytes.push(b'\n');
        stdin.write_all(&bytes).await?;
        stdin.flush().await?;
        Ok(())
    }

    async fn recv(&mut self) -> Result<JsonRpcMessage, McpError> {
        let stdout = self.stdout.as_mut().ok_or(McpError::Closed)?;
        self.line_buf.clear();
        let n = stdout.read_line(&mut self.line_buf).await?;
        if n == 0 {
            return Err(McpError::Closed);
        }
        let trimmed = self.line_buf.trim_end_matches(['\r', '\n']);
        let msg: JsonRpcMessage = serde_json::from_str(trimmed)?;
        Ok(msg)
    }

    async fn close(&mut self) -> Result<(), McpError> {
        // 1. Drop stdin → EOF to child.
        drop(self.stdin.take());
        // 2. Wait CLOSE_GRACE for graceful exit, then kill.
        if let Some(mut child) = self.child.take() {
            match timeout(CLOSE_GRACE, child.wait()).await {
                Ok(Ok(_status)) => {}
                Ok(Err(e)) => return Err(McpError::Io(e)),
                Err(_) => {
                    // Graceful budget blown — force kill. Ignore NotFound
                    // (child may have just exited between wait + kill).
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                }
            }
        }
        // 3. Drop stdout reader and stderr task. The drain task loops
        //    until read_line returns 0 (EOF), which already happened
        //    when the child died. awaiting it here is a no-op fast path.
        self.stdout.take();
        if let Some(task) = self.stderr_task.take() {
            let _ = task.await;
        }
        Ok(())
    }
}
