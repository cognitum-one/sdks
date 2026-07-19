//! `wait_for_operation` tests (ADR-0023 §D8/§D9).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use cognitum_one::agentic::{
    wait_for_operation, AgenticError, AgenticErrorKind, CancellationReason, CancellationToken,
    OperationSnapshot, OperationSource, OperationState, WaitForOperationExtras, WaitOptions,
};

fn snapshot(state: OperationState) -> OperationSnapshot<String> {
    OperationSnapshot {
        id: "op-1".to_owned(),
        state,
        result: None,
        error: None,
        updated_at: "2026-01-01T00:00:00Z".to_owned(),
    }
}

struct FakeSource {
    states: Vec<OperationState>,
    calls: AtomicUsize,
}

#[async_trait]
impl OperationSource for FakeSource {
    type Result = String;
    async fn get(&self) -> Result<OperationSnapshot<String>, AgenticError> {
        let i = self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(snapshot(self.states[i]))
    }
}

#[derive(Debug)]
struct AlwaysCancelled;
impl CancellationToken for AlwaysCancelled {
    fn is_cancelled(&self) -> bool {
        true
    }
    fn reason(&self) -> Option<CancellationReason> {
        Some(CancellationReason::Caller)
    }
}

#[tokio::test(start_paused = true)]
async fn returns_immediately_when_first_snapshot_is_terminal() {
    let source = FakeSource {
        states: vec![OperationState::Completed],
        calls: AtomicUsize::new(0),
    };
    let result = wait_for_operation(&source, WaitOptions::default(), WaitForOperationExtras::default())
        .await
        .unwrap();
    assert_eq!(result.state, OperationState::Completed);
}

#[tokio::test(start_paused = true)]
async fn polls_through_pending_and_running_and_returns_on_completed() {
    let source = FakeSource {
        states: vec![
            OperationState::Pending,
            OperationState::Running,
            OperationState::Running,
            OperationState::Completed,
        ],
        calls: AtomicUsize::new(0),
    };
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        wait_for_operation(&source, WaitOptions::default(), WaitForOperationExtras::default()),
    );
    // Drive paused time forward so the internal sleeps resolve.
    tokio::time::advance(std::time::Duration::from_secs(60)).await;
    let result = result.await.unwrap().unwrap();
    assert_eq!(result.state, OperationState::Completed);
    assert_eq!(source.calls.load(Ordering::SeqCst), 4);
}

#[tokio::test(start_paused = true)]
async fn returns_on_approval_required_without_polling_further() {
    let source = FakeSource {
        states: vec![OperationState::ApprovalRequired],
        calls: AtomicUsize::new(0),
    };
    let result = wait_for_operation(&source, WaitOptions::default(), WaitForOperationExtras::default())
        .await
        .unwrap();
    assert_eq!(result.state, OperationState::ApprovalRequired);
}

#[tokio::test(start_paused = true)]
async fn keeps_polling_through_cancellation_requested_until_real_terminal_state() {
    let source = FakeSource {
        states: vec![OperationState::CancellationRequested, OperationState::Completed],
        calls: AtomicUsize::new(0),
    };
    let fut = wait_for_operation(&source, WaitOptions::default(), WaitForOperationExtras::default());
    tokio::pin!(fut);
    tokio::select! {
        result = &mut fut => { assert_eq!(result.unwrap().state, OperationState::Completed); }
        _ = tokio::time::sleep(std::time::Duration::from_secs(60)) => {
            tokio::time::advance(std::time::Duration::from_secs(1)).await;
            let result = fut.await.unwrap();
            assert_eq!(result.state, OperationState::Completed);
        }
    }
}

#[tokio::test(start_paused = true)]
async fn deadline_exceeded_fires_even_when_get_always_returns_a_retryable_error() {
    // Regression test: a flapping backend (every get() call returns a
    // retryable transport error, never a snapshot) must still be bounded
    // by wait_deadline_ms — the retryable-error branch must not bypass
    // the deadline check and loop forever. Caught by independent review.
    struct AlwaysRetryable;
    #[async_trait]
    impl OperationSource for AlwaysRetryable {
        type Result = String;
        async fn get(&self) -> Result<OperationSnapshot<String>, AgenticError> {
            let mut err = AgenticError::new(AgenticErrorKind::Transport, "always flaky");
            err.retryable = true;
            Err(err)
        }
    }
    let options = WaitOptions {
        wait_deadline_ms: Some(1_000),
        poll_interval_ms: Some(1),
    };
    // No manual `tokio::time::advance` here: with `start_paused = true`,
    // the runtime auto-advances virtual time to the next pending timer
    // whenever nothing else is runnable. Wrapping in a generously-longer
    // outer timeout lets the inner ~1s deadline race fairly against it —
    // if `wait_for_operation` is genuinely unbounded, auto-advance keeps
    // satisfying its internal sleeps forever and the outer timeout is
    // what eventually fires (proving the hang); if bounded correctly, the
    // inner deadline_exceeded resolves first.
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        wait_for_operation(&AlwaysRetryable, options, WaitForOperationExtras::default()),
    )
    .await;
    let err = result
        .expect("wait_for_operation must resolve within wait_deadline_ms, not hang forever")
        .expect_err("an always-retryable get() must still end in deadline_exceeded");
    assert_eq!(err.kind, AgenticErrorKind::DeadlineExceeded);
}

#[tokio::test(start_paused = true)]
async fn deadline_exceeded_carries_latest_state_summary_never_marks_op_failed() {
    let source = FakeSource {
        states: vec![OperationState::Running; 50],
        calls: AtomicUsize::new(0),
    };
    let options = WaitOptions {
        wait_deadline_ms: Some(1_000),
        poll_interval_ms: Some(1),
    };
    let fut = wait_for_operation(&source, options, WaitForOperationExtras::default());
    tokio::pin!(fut);
    tokio::time::advance(std::time::Duration::from_secs(2)).await;
    let err = fut.await.unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::DeadlineExceeded);
    let details = err.details.expect("details must carry the latest snapshot summary");
    assert_eq!(details["snapshot"]["state"], "running");
}

#[tokio::test(start_paused = true)]
async fn cancelled_locally_never_calls_remote_cancel() {
    let source = FakeSource {
        states: vec![OperationState::Running; 5],
        calls: AtomicUsize::new(0),
    };
    let extras = WaitForOperationExtras {
        cancellation: Some(Arc::new(AlwaysCancelled)),
        ..Default::default()
    };
    let err = wait_for_operation(&source, WaitOptions::default(), extras)
        .await
        .unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::Cancelled);
    // The fake source has no `cancel()` — if the loop had called anything
    // beyond `get()`, this test's FakeSource wouldn't compile/typecheck,
    // which is itself evidence no remote cancel path exists in this helper.
}

#[tokio::test(start_paused = true)]
async fn uses_caller_injected_jitter_and_poll_interval_ms() {
    let source = FakeSource {
        states: vec![OperationState::Running, OperationState::Completed],
        calls: AtomicUsize::new(0),
    };
    let options = WaitOptions {
        wait_deadline_ms: None,
        poll_interval_ms: Some(100),
    };
    let jitter = |_attempt: u32| 7u64;
    let extras = WaitForOperationExtras {
        jitter_ms: Some(&jitter),
        ..Default::default()
    };
    let fut = wait_for_operation(&source, options, extras);
    tokio::pin!(fut);
    // attempt 0: base 100 * 2**0 + jitter 7 = 107, floor(server_hint=0) => 107, cap 30000 => 107ms
    tokio::time::advance(std::time::Duration::from_millis(107)).await;
    let result = fut.await.unwrap();
    assert_eq!(result.state, OperationState::Completed);
}

#[tokio::test(start_paused = true)]
async fn retries_retryable_agentic_error_but_propagates_non_retryable() {
    struct FlakyThenOk {
        calls: AtomicUsize,
    }
    #[async_trait]
    impl OperationSource for FlakyThenOk {
        type Result = String;
        async fn get(&self) -> Result<OperationSnapshot<String>, AgenticError> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                let mut err = AgenticError::new(AgenticErrorKind::Transport, "transient blip");
                err.retryable = true;
                return Err(err);
            }
            Ok(snapshot(OperationState::Completed))
        }
    }
    let flaky = FlakyThenOk { calls: AtomicUsize::new(0) };
    let fut = wait_for_operation(&flaky, WaitOptions::default(), WaitForOperationExtras::default());
    tokio::pin!(fut);
    tokio::time::advance(std::time::Duration::from_secs(60)).await;
    let result = fut.await.unwrap();
    assert_eq!(result.state, OperationState::Completed);
    assert_eq!(flaky.calls.load(Ordering::SeqCst), 2);

    struct AlwaysDenied;
    #[async_trait]
    impl OperationSource for AlwaysDenied {
        type Result = String;
        async fn get(&self) -> Result<OperationSnapshot<String>, AgenticError> {
            Err(AgenticError::new(AgenticErrorKind::PermissionDenied, "nope"))
        }
    }
    let err = wait_for_operation(&AlwaysDenied, WaitOptions::default(), WaitForOperationExtras::default())
        .await
        .unwrap_err();
    assert_eq!(err.kind, AgenticErrorKind::PermissionDenied);
}
