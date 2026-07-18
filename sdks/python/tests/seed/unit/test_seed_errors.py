"""Unit tests for cognitum._errors — 12-variant taxonomy (ADR-0004)."""

from __future__ import annotations

import json

import httpx
import pytest

from cognitum._errors import (
    ApiError,
    AuthError,
    AuthReason,
    CognitumError,
    ConfigError,
    ConflictError,
    NetworkError,
    NotFoundError,
    ParseError,
    RateLimitError,
    ServiceUnavailableError,
    ValidationError,
)
from cognitum._errors import (
    NotImplementedError as SeedNotImplementedError,
)
from cognitum._errors import (
    TimeoutError as SeedTimeoutError,
)
from cognitum.seed._client import map_error


def _make_response(
    status: int,
    body: dict | None = None,
    *,
    headers: dict | None = None,
) -> httpx.Response:
    req = httpx.Request("GET", "https://cognitum.local:8443/api/v1/status")
    content = json.dumps(body).encode() if body is not None else b""
    h = {"Content-Type": "application/json"} if body is not None else {}
    if headers:
        h.update(headers)
    return httpx.Response(status, request=req, content=content, headers=h)


class TestTaxonomyClasses:
    def test_all_twelve_variants_instantiate(self) -> None:
        # ADR-0004 §Decision — closed taxonomy of 12.
        classes = [
            CognitumError("x"),
            AuthError("x"),
            RateLimitError("x"),
            ValidationError("x"),
            NotFoundError("x"),
            SeedNotImplementedError("x", endpoint="/p"),
            ConflictError("x"),
            ServiceUnavailableError("x"),
            ApiError("x", status_code=500),
            NetworkError("x"),
            SeedTimeoutError("x"),
            ParseError("x", expected="a", got="b"),
        ]
        for exc in classes:
            assert isinstance(exc, CognitumError)

    def test_auth_reason_has_six_canonical(self) -> None:
        wire = {r.value for r in AuthReason}
        assert wire == {
            "no_credentials",
            "invalid_credentials",
            "not_paired",
            "pairing_window_closed",
            "lockdown_mtls_required",
            "trust_score_blocked",
        }

    def test_rate_limit_retry_after_seconds_back_compat(self) -> None:
        # 0.1.x callers use retry_after_seconds; ensure we still accept it.
        exc = RateLimitError("x", retry_after_seconds=2.5)
        assert exc.retry_after_ms == 2500
        assert exc.retry_after_seconds == pytest.approx(2.5)

    def test_rate_limit_default_retry_after(self) -> None:
        exc = RateLimitError("x")
        assert exc.retry_after_ms == 1000

    def test_timeout_phase_connect_retriable(self) -> None:
        assert SeedTimeoutError(phase="connect").retriable is True

    def test_timeout_phase_read_not_retriable(self) -> None:
        assert SeedTimeoutError(phase="read").retriable is False

    def test_network_error_retriable(self) -> None:
        assert NetworkError().retriable is True

    def test_api_error_5xx_retriable(self) -> None:
        assert ApiError("x", status_code=500).retriable is True
        assert ApiError("x", status_code=502).retriable is True

    def test_api_error_4xx_not_retriable(self) -> None:
        assert ApiError("x", status_code=418).retriable is False

    def test_service_unavailable_retriable(self) -> None:
        assert ServiceUnavailableError().retriable is True

    def test_parse_error_not_retriable(self) -> None:
        assert ParseError("x").retriable is False

    def test_cognitum_error_has_inspection_fields(self) -> None:
        exc = CognitumError(
            "x",
            status_code=500,
            raw_body=b"body",
            correlation_id="id",
        )
        assert exc.message == "x"
        assert exc.status_code == 500
        assert exc.raw_body == b"body"
        assert exc.correlation_id == "id"

    def test_config_error_is_validation_error(self) -> None:
        exc = ConfigError("bad cfg")
        assert isinstance(exc, ValidationError)


class TestStatusMapping:
    # ADR-0013b §Mapping from HTTP to class table.

    def test_400_is_validation(self) -> None:
        exc = map_error(_make_response(400, {"error": "bad"}))
        assert isinstance(exc, ValidationError)

    def test_401_is_auth_invalid_creds(self) -> None:
        exc = map_error(_make_response(401, {"error": "nope"}))
        assert isinstance(exc, AuthError)
        assert exc.reason == AuthReason.INVALID_CREDENTIALS

    def test_403_not_paired(self) -> None:
        exc = map_error(_make_response(403, {"error": "not paired"}))
        assert isinstance(exc, AuthError)
        assert exc.reason == AuthReason.NOT_PAIRED

    def test_403_pairing_window(self) -> None:
        exc = map_error(_make_response(403, {"error": "pairing window closed"}))
        assert isinstance(exc, AuthError)
        assert exc.reason == AuthReason.PAIRING_WINDOW_CLOSED

    def test_403_lockdown(self) -> None:
        exc = map_error(_make_response(403, {"error": "lockdown: mTLS required"}))
        assert isinstance(exc, AuthError)
        assert exc.reason == AuthReason.LOCKDOWN_MTLS_REQUIRED

    def test_404_is_not_found(self) -> None:
        exc = map_error(_make_response(404, {"error": "nope"}))
        assert isinstance(exc, NotFoundError)

    def test_409_is_conflict(self) -> None:
        exc = map_error(_make_response(409, {"error": "conflict"}))
        assert isinstance(exc, ConflictError)

    def test_422_is_validation(self) -> None:
        exc = map_error(_make_response(422, {"error": "bad"}))
        assert isinstance(exc, ValidationError)

    def test_429_is_rate_limit_with_retry_after_seconds_header(self) -> None:
        exc = map_error(
            _make_response(
                429,
                {"error": "rate limited"},
                headers={"Retry-After": "2"},
            )
        )
        assert isinstance(exc, RateLimitError)
        assert exc.retry_after_ms == 2000

    def test_429_parses_retry_after_us_body(self) -> None:
        exc = map_error(
            _make_response(429, {"retry_after_us": 1_500_000})
        )
        assert isinstance(exc, RateLimitError)
        assert exc.retry_after_ms == 1500

    def test_429_parses_english_body(self) -> None:
        exc = map_error(
            _make_response(429, {"error": "rate limited — retry after 1s"})
        )
        assert isinstance(exc, RateLimitError)
        assert exc.retry_after_ms == 1000

    def test_501_is_not_implemented(self) -> None:
        # Issue #3: 501 MUST map to NotImplementedError, not generic.
        exc = map_error(_make_response(501, {"error": "nope"}))
        assert isinstance(exc, SeedNotImplementedError)
        assert exc.endpoint  # non-empty path captured

    def test_503_is_service_unavailable(self) -> None:
        exc = map_error(
            _make_response(503, {"error": "lockdown"}),
        )
        assert isinstance(exc, ServiceUnavailableError)

    def test_500_is_api_error_retriable(self) -> None:
        exc = map_error(_make_response(500, {"error": "boom"}))
        assert isinstance(exc, ApiError)
        assert exc.retriable is True

    def test_502_is_api_error_retriable(self) -> None:
        exc = map_error(_make_response(502, {"error": "bad gw"}))
        assert isinstance(exc, ApiError)
        assert exc.retriable is True

    def test_504_is_api_error_retriable(self) -> None:
        exc = map_error(_make_response(504, {"error": "gw timeout"}))
        assert isinstance(exc, ApiError)
        assert exc.retriable is True
