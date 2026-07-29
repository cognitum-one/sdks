//! Security-boundary tests for wait_for_operation.

use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use cognitum_one::agentic::{
    wait_for_operation, AgenticError, AgenticErrorKind, OperationSnapshot, OperationSource,
    WaitForOperationExtras, WaitOptions,
};

struct AlwaysDenied {
    calls: AtomicUsize,
}

#[async_trait]
impl OperationSource for AlwaysDenied {
    type Result = String;

    async fn get(&self) -> Result<OperationSnapshot<String>, AgenticError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Err(AgenticError::new(AgenticErrorKind::PermissionDenied, "denied"))
    }
}

#[tokio::test]
async fn permission_denial_is_never_retried() {
    let denied = AlwaysDenied {
        calls: AtomicUsize::new(0),
    };
    let error = wait_for_operation(&denied, WaitOptions::default(), WaitForOperationExtras::default())
        .await
        .expect_err("permission denial must fail");
    assert_eq!(error.kind, AgenticErrorKind::PermissionDenied);
    assert_eq!(denied.calls.load(Ordering::SeqCst), 1);
}

struct AlwaysRetryable;

#[async_trait]
impl OperationSource for AlwaysRetryable {
    type Result = String;

    async fn get(&self) -> Result<OperationSnapshot<String>, AgenticError> {
        let mut error = AgenticError::new(AgenticErrorKind::Transport, "retry");
        error.retryable = true;
        Err(error)
    }
}

#[tokio::test(start_paused = true)]
async fn retryable_polling_is_bounded_by_deadline() {
    let options = WaitOptions {
        wait_deadline_ms: Some(10),
        poll_interval_ms: Some(5),
    };
    let result = tokio::time::timeout(
        std::time::Duration::from_millis(100),
        wait_for_operation(&AlwaysRetryable, options, WaitForOperationExtras::default()),
    )
    .await
    .expect("wait loop must remain bounded")
    .expect_err("retryable failures must end at the deadline");
    assert_eq!(result.kind, AgenticErrorKind::DeadlineExceeded);
}
