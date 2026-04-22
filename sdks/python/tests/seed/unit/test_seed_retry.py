"""Unit tests for cognitum.seed._retry — ADR-0005 + ADR-0013b §6."""

from __future__ import annotations

import random
import statistics

import pytest

from cognitum.seed._retry import (
    RetryPolicy,
    compute_delay,
    compute_delay_ms,
    is_retriable,
    is_retriable_status,
    parse_retry_after,
)


class TestIsRetriableStatus:
    def test_retriable_set_includes_502_and_504(self) -> None:
        # ADR-0005 / issue #8: the Python retriable set MUST include 502/504.
        for code in (429, 500, 502, 503, 504):
            assert is_retriable_status(code), f"{code} must be retriable"

    def test_non_retriable_statuses(self) -> None:
        for code in (400, 401, 403, 404, 405, 409, 422, 501):
            assert not is_retriable_status(code), f"{code} must NOT be retriable"


class TestIsRetriable:
    def test_get_on_500_retries(self) -> None:
        assert is_retriable(method="GET", status_code=500, body_sent=True)

    def test_get_on_401_does_not_retry(self) -> None:
        assert not is_retriable(method="GET", status_code=401, body_sent=True)

    def test_post_on_500_without_idempotency_does_not_retry(self) -> None:
        # ADR-0005 §Idempotency rule + issue #9.
        assert not is_retriable(
            method="POST", status_code=500, body_sent=True, idempotent=False
        )

    def test_post_on_500_with_idempotent_true_retries(self) -> None:
        assert is_retriable(
            method="POST", status_code=500, body_sent=True, idempotent=True
        )

    def test_post_on_429_always_retries(self) -> None:
        assert is_retriable(
            method="POST", status_code=429, body_sent=True, idempotent=False
        )

    def test_post_on_503_always_retries(self) -> None:
        assert is_retriable(
            method="POST", status_code=503, body_sent=True, idempotent=False
        )

    def test_transport_error_always_retries(self) -> None:
        assert is_retriable(
            method="POST", status_code=None, is_transport_error=True, body_sent=False
        )

    def test_connect_timeout_retries(self) -> None:
        assert is_retriable(
            method="POST",
            status_code=None,
            is_timeout=True,
            timeout_phase="connect",
            body_sent=False,
        )

    def test_read_timeout_on_post_with_body_does_not_retry(self) -> None:
        assert not is_retriable(
            method="POST",
            status_code=None,
            is_timeout=True,
            timeout_phase="read",
            body_sent=True,
            idempotent=False,
        )

    def test_read_timeout_on_get_retries(self) -> None:
        assert is_retriable(
            method="GET",
            status_code=None,
            is_timeout=True,
            timeout_phase="read",
            body_sent=True,
        )


class TestParseRetryAfter:
    def test_retry_after_seconds_header(self) -> None:
        hint = parse_retry_after({"Retry-After": "2"}, None)
        assert hint == 2000

    def test_retry_after_float_header(self) -> None:
        hint = parse_retry_after({"Retry-After": "0.5"}, None)
        assert hint == 500

    def test_retry_after_http_date(self) -> None:
        hint = parse_retry_after(
            {"Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT"},
            None,
            now_unix=1445412479.0,  # one second earlier than the date
        )
        assert hint is not None
        assert 900 <= hint <= 1100

    def test_retry_after_us_in_body(self) -> None:
        # seed idiom — microseconds in body.
        hint = parse_retry_after(None, {"retry_after_us": 1_500_000})
        assert hint == 1500

    def test_english_body_hint(self) -> None:
        # seed v0.20.0 english-language form.
        hint = parse_retry_after(
            None, {"error": "rate limited — retry after 1s"}
        )
        assert hint == 1000

    def test_no_hint_returns_none(self) -> None:
        assert parse_retry_after({}, None) is None
        assert parse_retry_after(None, {}) is None
        assert parse_retry_after(None, {"error": "no hint"}) is None

    def test_header_wins_over_body(self) -> None:
        hint = parse_retry_after(
            {"Retry-After": "3"}, {"retry_after_us": 1_000_000}
        )
        assert hint == 3000


class TestComputeDelay:
    def test_equal_jitter_in_bounds(self) -> None:
        policy = RetryPolicy()
        rng = random.Random(0)
        for attempt in range(4):
            d = compute_delay_ms(attempt=attempt, policy=policy, rng=rng)
            raw = min(policy.cap_ms, policy.base_ms * (2**attempt))
            assert raw <= d <= raw + policy.base_ms

    def test_server_hint_wins(self) -> None:
        d = compute_delay_ms(
            attempt=0,
            policy=RetryPolicy(),
            server_hint_ms=5000,
            rng=random.Random(0),
        )
        assert d == 5000

    def test_cap_enforced(self) -> None:
        d = compute_delay_ms(
            attempt=20, policy=RetryPolicy(), rng=random.Random(0)
        )
        assert d <= RetryPolicy().cap_ms

    def test_compute_delay_seconds_equal_jitter(self) -> None:
        rng = random.Random(42)
        samples = [compute_delay(attempt=0, rng=rng) for _ in range(100)]
        assert all(0 <= s <= 0.5 for s in samples)
        # Expect meaningful variance (equal-jitter).
        assert statistics.pvariance(samples) > 0.005

    def test_compute_delay_respects_cap(self) -> None:
        rng = random.Random(0)
        for attempt in range(20):
            d = compute_delay(attempt=attempt, rng=rng)
            assert d <= 30.0
