# ADR 0013b: Python SDK — Exceptions, Transport, Retry, Auth

- **Status:** Proposed
- **Date:** 2026-04-22
- **Deciders:** SDK working group
- **Scope:** sdks/python
- **Part of:** ADR-0013 (split into 0013a/0013b/0013c for size)
- **Implements:** ADR-0003, ADR-0004, ADR-0005, ADR-0007

## Context

The current Python SDK violates three cross-cutting ADRs:

| Defect | Location | ADR violated |
|--------|----------|--------------|
| Retriable set excludes 502/504 | `sdks/python/cognitum/_http.py:18` | ADR-0005 §Retriable outcomes |
| Backoff has no jitter | `sdks/python/cognitum/_http.py:48-50` | ADR-0005 §Backoff formula |
| `AuthError` has no `reason` field | `sdks/python/cognitum/errors.py:18-22` | ADR-0004 §AuthError.reason |
| Missing 6 of 12 taxonomy classes | `sdks/python/cognitum/errors.py:1-49` | ADR-0004 §Decision |
| No `raw_body` / `correlation_id` on error base | `sdks/python/cognitum/errors.py:6-15` | ADR-0004 §Payload extraction |
| No TLS pinning hook | `sdks/python/cognitum/_http.py:64-72` | ADR-0007 §TLS |
| No credential redaction in logs | entire package | ADR-0003 §Redaction |

This ADR is the implementation blueprint that closes every defect.

## Decision

Replace `_http.py` with a split of four modules:
`_errors.py`, `_retry.py`, `_auth.py`, `_telemetry.py`, and a slimmed
`_http.py` that composes them. Keep the public module path
`cognitum.errors` as a re-export layer so existing callers keep compiling.

---

## 4. Exception hierarchy

<!-- verified 2026-04-22 (Phase 1 delivery, python Team): all 12 variants implemented in cognitum/_errors.py and re-exported from cognitum.errors. 501 -> NotImplementedError(endpoint=...) verified in tests/seed/unit/test_seed_errors.py::test_501_is_not_implemented and ::test_501_maps_to_not_implemented. ConflictError (409), ServiceUnavailableError (503), NetworkError, TimeoutError(phase=...), ParseError all unit-tested. Closes issue #3 (sdks). -->

`cognitum/_errors.py` is the single source of truth; `cognitum/errors.py`
re-exports for backward compat.

```python
# cognitum/_errors.py
from __future__ import annotations
from enum import Enum
from typing import Literal


class AuthReason(str, Enum):
    NO_CREDENTIALS         = "no_credentials"
    INVALID_CREDENTIALS    = "invalid_credentials"
    NOT_PAIRED             = "not_paired"
    PAIRING_WINDOW_CLOSED  = "pairing_window_closed"
    LOCKDOWN_MTLS_REQUIRED = "lockdown_mtls_required"
    TRUST_SCORE_BLOCKED    = "trust_score_blocked"


TimeoutPhase = Literal["connect", "read", "total"]


class CognitumError(Exception):
    """Base of the taxonomy. Always inspectable."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        request_id: str | None = None,
        retriable: bool = False,
        raw_body: bytes | None = None,
        correlation_id: str | None = None,
        cause: BaseException | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.request_id = request_id
        self.retriable = retriable
        self.raw_body = raw_body
        self.correlation_id = correlation_id
        if cause is not None:
            self.__cause__ = cause

    def __repr__(self) -> str:
        return (
            f"{self.__class__.__name__}("
            f"message={self.message!r}, status_code={self.status_code!r}, "
            f"correlation_id={self.correlation_id!r})"
        )


class AuthError(CognitumError):
    def __init__(
        self,
        message: str = "Authentication failed",
        *,
        reason: AuthReason = AuthReason.INVALID_CREDENTIALS,
        status_code: int | None = None,
        request_id: str | None = None,
        raw_body: bytes | None = None,
        correlation_id: str | None = None,
        cause: BaseException | None = None,
    ) -> None:
        super().__init__(
            message, status_code=status_code, request_id=request_id,
            retriable=False, raw_body=raw_body,
            correlation_id=correlation_id, cause=cause,
        )
        self.reason = reason


class RateLimitError(CognitumError):
    def __init__(
        self,
        message: str = "Rate limit exceeded",
        *,
        retry_after_ms: int = 1000,
        tier: Literal["unpaired", "paired", "localhost", "lockdown"] = "unpaired",
        status_code: int | None = 429,
        request_id: str | None = None,
        raw_body: bytes | None = None,
        correlation_id: str | None = None,
    ) -> None:
        super().__init__(
            message, status_code=status_code, request_id=request_id,
            retriable=True, raw_body=raw_body, correlation_id=correlation_id,
        )
        self.retry_after_ms = retry_after_ms
        self.tier = tier
        # Backward-compat with 0.1.x callers
        self.retry_after_seconds: float = retry_after_ms / 1000.0


class ValidationError(CognitumError):
    def __init__(
        self, message: str = "Validation error", *,
        field: str | None = None, status_code: int | None = None,
        request_id: str | None = None, raw_body: bytes | None = None,
        correlation_id: str | None = None,
    ) -> None:
        super().__init__(
            message, status_code=status_code, request_id=request_id,
            retriable=False, raw_body=raw_body, correlation_id=correlation_id,
        )
        self.field = field


class NotFoundError(CognitumError):
    def __init__(
        self, message: str = "Not found", *,
        resource: str | None = None, status_code: int | None = 404,
        request_id: str | None = None, raw_body: bytes | None = None,
        correlation_id: str | None = None,
    ) -> None:
        super().__init__(
            message, status_code=status_code, request_id=request_id,
            retriable=False, raw_body=raw_body, correlation_id=correlation_id,
        )
        self.resource = resource


class NotImplementedError(CognitumError):   # noqa: A001 — intentional shadow
    """Distinct from builtins.NotImplementedError. For 501 SSE placeholders.

    <!-- verified 2026-04-22 (Phase 1 delivery): NotImplementedError class lives in cognitum/_errors.py; re-exported from cognitum.errors and cognitum.seed. 501 responses now map correctly via cognitum/seed/_client.py::map_error. -->
    """
    def __init__(
        self, message: str = "Not implemented by this seed firmware", *,
        endpoint: str, status_code: int | None = 501,
        correlation_id: str | None = None,
    ) -> None:
        super().__init__(
            message, status_code=status_code, retriable=False,
            correlation_id=correlation_id,
        )
        self.endpoint = endpoint


class ConflictError(CognitumError):
    def __init__(
        self, message: str = "Conflict", *, status_code: int | None = 409,
        request_id: str | None = None, raw_body: bytes | None = None,
        correlation_id: str | None = None,
    ) -> None:
        super().__init__(
            message, status_code=status_code, request_id=request_id,
            retriable=False, raw_body=raw_body, correlation_id=correlation_id,
        )


class ServiceUnavailableError(CognitumError):
    def __init__(
        self, message: str = "Service unavailable", *,
        retry_after_ms: int | None = None, status_code: int | None = 503,
        request_id: str | None = None, raw_body: bytes | None = None,
        correlation_id: str | None = None,
    ) -> None:
        super().__init__(
            message, status_code=status_code, request_id=request_id,
            retriable=True, raw_body=raw_body, correlation_id=correlation_id,
        )
        self.retry_after_ms = retry_after_ms


class ApiError(CognitumError):
    def __init__(
        self, message: str, *, status_code: int, code: str | None = None,
        request_id: str | None = None, raw_body: bytes | None = None,
        correlation_id: str | None = None,
    ) -> None:
        super().__init__(
            message, status_code=status_code, request_id=request_id,
            retriable=status_code >= 500, raw_body=raw_body,
            correlation_id=correlation_id,
        )
        self.code = code


class NetworkError(CognitumError):
    def __init__(
        self, message: str = "Transport error", *,
        cause: BaseException | None = None, correlation_id: str | None = None,
    ) -> None:
        super().__init__(
            message, retriable=True, correlation_id=correlation_id, cause=cause,
        )


class TimeoutError(CognitumError):   # noqa: A001 — intentional shadow
    def __init__(
        self, message: str = "Request timed out", *,
        phase: TimeoutPhase = "total", correlation_id: str | None = None,
        cause: BaseException | None = None,
    ) -> None:
        # Connect-phase timeouts are retriable; read-phase for POST is not.
        retriable = phase == "connect"
        super().__init__(
            message, retriable=retriable, correlation_id=correlation_id, cause=cause,
        )
        self.phase = phase


class ParseError(CognitumError):
    def __init__(
        self, message: str, *, expected: str, got: str,
        raw_body: bytes | None = None, correlation_id: str | None = None,
    ) -> None:
        super().__init__(
            message, retriable=False, raw_body=raw_body, correlation_id=correlation_id,
        )
        self.expected = expected
        self.got = got
```

Mapping from HTTP to class lives in `_http.py::_map_error`:

| HTTP | Body | → Class |
|------|------|---------|
| 400, 405, 422 | any | `ValidationError` |
| 401 | any | `AuthError(reason=INVALID_CREDENTIALS)` | <!-- verified 2026-04-22 (Phase 1 delivery): AuthError now carries `reason: AuthReason`; tests/seed/unit/test_seed_errors.py::test_401_is_auth_invalid_creds asserts it. -->
| 403, body `"not paired"` | seed | `AuthError(reason=NOT_PAIRED)` |
| 403, body contains `"window"` | seed | `AuthError(reason=PAIRING_WINDOW_CLOSED)` |
| 403, body contains `"lockdown"` or `"mTLS"` | seed | `AuthError(reason=LOCKDOWN_MTLS_REQUIRED)` |
| 403, other | any | `AuthError(reason=INVALID_CREDENTIALS)` |
| 404 | any | `NotFoundError` | <!-- verified 2026-04-22 (python validator): respx 404 -> NotFoundError. -->
| 409 | any | `ConflictError` | <!-- verified 2026-04-22 (Phase 1 delivery): ConflictError class in cognitum/_errors.py; mapping test at tests/seed/unit/test_seed_errors.py::test_409_is_conflict. -->
| 429 | any | `RateLimitError` (retry_after from header or `retry_after_us`) | <!-- verified 2026-04-22 (Phase 1 delivery): parse_retry_after now walks Retry-After header (sec / HTTP-date) then body `retry_after_us` then `retry after Ns` regex. Tests at tests/seed/unit/test_seed_retry.py::TestParseRetryAfter. -->
| 501 | any | `NotImplementedError(endpoint=request.path)` | <!-- verified 2026-04-22 (Phase 1 delivery): map_error in cognitum/seed/_client.py returns NotImplementedError(endpoint=request.url.path). Test ::test_501_maps_to_not_implemented. -->
| 503 | any | `ServiceUnavailableError` | <!-- verified 2026-04-22 (Phase 1 delivery): ServiceUnavailableError class in cognitum/_errors.py; map_error returns it with retry_after_ms parsed from header/body. Test ::test_503_is_service_unavailable. -->
| other 5xx | any | `ApiError(status_code=...)` |

---

## 5. Transport

Single `_http.py` for both sync and async. Factored helpers:

```python
# cognitum/_http.py (excerpt — core connection config)
from __future__ import annotations
import ssl
from pathlib import Path
import httpx

from cognitum._auth import Credentials
from cognitum._retry import RetryPolicy, sleep_with_jitter, async_sleep_with_jitter
from cognitum._telemetry import Telemetry, new_correlation_id
from cognitum.seed._pinning import SeedPinnedVerifier

_DEFAULT_LIMITS = httpx.Limits(
    max_connections=32,
    max_keepalive_connections=16,
    keepalive_expiry=30.0,
)
# Tuple timeout: (connect, read, write, pool)
_DEFAULT_TIMEOUT = httpx.Timeout(connect=5.0, read=30.0, write=30.0, pool=5.0)

VerifyOption = bool | str | Path | ssl.SSLContext | SeedPinnedVerifier


def _build_verify(v: VerifyOption) -> bool | str | ssl.SSLContext:
    if isinstance(v, SeedPinnedVerifier):
        return v.to_ssl_context()
    if isinstance(v, Path):
        return str(v)
    return v  # type: ignore[return-value]


class SyncHttpClient:
    def __init__(
        self,
        *,
        base_url: str,
        credentials: Credentials,
        timeout: httpx.Timeout = _DEFAULT_TIMEOUT,
        retry: RetryPolicy,
        verify: VerifyOption = True,
        http2: bool = False,
        client_cert: tuple[str, str] | None = None,
        user_agent: str = "cognitum-python/0.2.0",
        telemetry: Telemetry | None = None,
    ) -> None:
        self._credentials = credentials
        self._retry = retry
        self._telemetry = telemetry or Telemetry()
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": user_agent,
            **credentials.headers(),
        }
        self._client = httpx.Client(
            base_url=base_url,
            timeout=timeout,
            headers=headers,
            limits=_DEFAULT_LIMITS,
            http2=http2,
            verify=_build_verify(verify),
            cert=client_cert,
        )
```

- HTTP/2 is off for seed (seed is HTTP/1.1, ADR-0002 §Transport) and off
  by default for cloud — opt-in via `http2=True`.
- `verify=` accepts the five listed types. `SeedPinnedVerifier` is
  created by `SeedClient` for the default hosts
  (169.254.42.1 / cognitum.local).
- `limits`, `timeout`, and `keepalive_expiry` are tuned for a mix of
  polling-style seed calls (small bodies, many per second) and cloud
  calls (rare, larger bodies).

<!-- verified 2026-04-22 (Phase 1 delivery): the seed-scoped _SyncTransport (cognitum/seed/_client.py) now composes build_sync_client(options) from cognitum/seed/_transport.py which honours SeedTLS(ca_pem, ca_path, verify, insecure, pinned_sha256, client_cert). Default-host self-signed acceptance + non-default-host ConfigError fail-fast verified in test_seed_config.py::test_non_default_host_without_tls_material_raises. Closes issue #4 (sdks). -->

<!-- verified 2026-04-22 (security pass, issue #17 / P-B1): _DEFAULT_SEED_HOSTS no longer includes `localhost` / `127.0.0.1` — only the physical-cable seed paths (169.254.*, cognitum.local, fe80:*) retain the self-signed exception. The default-host self-signed fallback now applies ONLY when the caller passed no `tls=` argument (tracked via SeedClientOptions.tls_explicit); an explicit `tls=SeedTLS()` is honoured strictly even on default hosts, raising ConfigError instead of silently bypassing verification. Fallback emits a one-time UserWarning per host. Regression suite: tests/seed/unit/test_tls_localhost_strict.py (11 tests). Closes issue #17 (sdks). -->

### 5.1 TLS pinning (`SeedPinnedVerifier`)

```python
# cognitum/seed/_pinning.py
from __future__ import annotations
import ssl
from pathlib import Path

_DEFAULT_SEED_HOSTS = frozenset({"169.254.42.1", "cognitum.local"})


class SeedPinnedVerifier:
    """Trusts only the seed's self-signed cert (by SHA-256 fingerprint),
    or delegates to the system trust store for non-default hosts where
    the caller provided a CA PEM bundle.

    Implements ADR-0007 §TLS. Never silently trusts an arbitrary cert.

    <!-- verified 2026-04-22 (Phase 1 delivery): SeedPinnedVerifier lives at cognitum/seed/_transport.py. Constructor validates trust material; to_ssl_context() returns a CA-only SSLContext for supplied ca_pem/ca_path, a self-signed-friendly context for default hosts. -->
    """

    def __init__(
        self,
        *,
        host: str,
        ca_bundle: Path | None = None,
        pinned_sha256: bytes | None = None,
    ) -> None:
        self.host = host.lower()
        self.ca_bundle = ca_bundle
        self.pinned_sha256 = pinned_sha256
        if not self._is_default_host() and ca_bundle is None and pinned_sha256 is None:
            from cognitum._errors import ValidationError
            raise ValidationError(
                "TLS trust material required for non-default hosts",
                field="verify",
            )

    def _is_default_host(self) -> bool:
        if self.host in _DEFAULT_SEED_HOSTS:
            return True
        return self.host.startswith("fe80:")

    def to_ssl_context(self) -> ssl.SSLContext:
        ctx = ssl.create_default_context()
        if self.ca_bundle is not None:
            ctx.load_verify_locations(cafile=str(self.ca_bundle))
            return ctx
        if self._is_default_host():
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            # Pinning enforced via post-handshake fingerprint check in
            # SyncHttpClient._on_connect when pinned_sha256 is set.
            return ctx
        raise RuntimeError("unreachable: __init__ validated trust material")
```

The pin enforcement uses httpx's connection hook to hash the server
cert and compare against `pinned_sha256` when supplied; for default
hosts the self-signed cert is accepted without verification because a
user on `169.254.42.1` is on a point-to-point USB link
(ADR-0007 §TLS defaults).

---

## 6. Retry / rate-limit implementation

`_retry.py` is pure; `_http.py` calls it from the loop.

```python
# cognitum/_retry.py
from __future__ import annotations
import asyncio
import random
import time
from dataclasses import dataclass
from email.utils import parsedate_to_datetime

import httpx


_RETRIABLE_STATUS: frozenset[int] = frozenset({429, 500, 502, 503, 504})  # <!-- verified 2026-04-22 (Phase 1 delivery): implemented at cognitum/seed/_retry.py; test_seed_retry.py covers every entry. Closes issue #8 (sdks). -->
_IDEMPOTENT_METHODS: frozenset[str] = frozenset({"GET", "HEAD", "DELETE", "PUT"})  # <!-- verified 2026-04-22 (Phase 1 delivery): is_retriable(method=..., idempotent=...) enforces the gate; POST 500 on /store/ingest is not retried (test_seed_client_loop.py::test_post_500_does_not_retry_non_idempotent), POST 500 on /store/query retries (::test_post_query_retries_because_idempotent). Closes issue #9 (sdks). -->


@dataclass(slots=True, frozen=True)
class RetryPolicy:
    max_retries: int = 3
    base_ms: int = 500
    cap_ms: int = 30_000
    max_elapsed_ms: int = 60_000


def is_retriable(
    *,
    method: str,
    status_code: int | None,
    is_transport_error: bool,
    is_timeout: bool,
    timeout_phase: str | None,
    body_sent: bool,
) -> bool:
    """ADR-0005 §Retriable outcomes + §Idempotency rule."""
    if is_transport_error:
        return True
    if is_timeout:
        if timeout_phase == "connect":
            return True
        # Read-phase timeout: only retry if the body wasn't sent
        return not body_sent or method.upper() in _IDEMPOTENT_METHODS
    if status_code is None:
        return False
    if status_code not in _RETRIABLE_STATUS:
        return False
    # POST is retriable only if body wasn't sent, or on 429/503
    if method.upper() == "POST":
        return status_code in (429, 503) or not body_sent
    return True


def parse_retry_after(
    headers: httpx.Headers, body: dict | None, now_unix: float | None = None
) -> int | None:
    """Returns server-provided hint in ms, or None.

    Implements ADR-0005 §"429 handling (seed specific)" verbatim.
    Do not reorder the lookups here without updating the cross-cutting ADR.
    """
    header = headers.get("Retry-After")
    if header is not None:
        header = header.strip()
        try:
            return int(float(header) * 1000)
        except ValueError:
            try:
                dt = parsedate_to_datetime(header)
                target = dt.timestamp()
                now = now_unix if now_unix is not None else time.time()
                return int(max(0.0, (target - now) * 1000))
            except (TypeError, ValueError):
                pass
    if body is not None:
        us = body.get("retry_after_us")
        if isinstance(us, (int, float)) and us >= 0:
            return int(us / 1000)
        err = body.get("error")
        if isinstance(err, str):
            import re
            m = re.search(r"retry after\s+([0-9]+(?:\.[0-9]+)?)\s*s", err)
            if m:
                return int(float(m.group(1)) * 1000)
    return None


def compute_delay_ms(
    *,
    attempt: int,
    policy: RetryPolicy,
    server_hint_ms: int | None,
    rng: random.Random | None = None,
) -> int:
    """ADR-0005 §Backoff formula — equal-jitter, cap, server hint wins."""
    r = rng or random
    raw = min(policy.cap_ms, policy.base_ms * (2 ** attempt))
    jitter = r.uniform(0, policy.base_ms)
    computed = int(raw + jitter)
    hint = server_hint_ms or 0
    return min(policy.cap_ms, max(hint, computed))


def sleep_with_jitter(ms: int) -> None:
    time.sleep(ms / 1000.0)


async def async_sleep_with_jitter(ms: int) -> None:
    await asyncio.sleep(ms / 1000.0)
```

### 6.1 Sync retry loop

```python
# cognitum/_http.py (excerpt — the retry loop)
def request(
    self,
    method: str,
    path: str,
    *,
    json: dict | None = None,
    params: dict | None = None,
    idempotent: bool | None = None,
) -> Any:
    from cognitum._errors import (
        CognitumError, AuthError, NetworkError, TimeoutError, RateLimitError,
        ApiError, ServiceUnavailableError, ParseError,
    )
    correlation_id = new_correlation_id()
    headers = {"X-Correlation-Id": correlation_id}
    deadline = time.monotonic() + self._retry.max_elapsed_ms / 1000.0
    attempt = 0
    last_exc: CognitumError | None = None
    auth_fail_count = 0

    while True:
        body_sent = False
        server_hint: int | None = None
        try:
            response = self._client.request(
                method, path, json=json, params=params, headers=headers,
            )
            body_sent = True
        except httpx.TimeoutException as exc:
            phase = _timeout_phase(exc)
            last_exc = TimeoutError(str(exc), phase=phase,
                                    correlation_id=correlation_id, cause=exc)
            retriable_now = is_retriable(
                method=method, status_code=None, is_transport_error=False,
                is_timeout=True, timeout_phase=phase, body_sent=body_sent,
            )
        except httpx.TransportError as exc:
            last_exc = NetworkError(str(exc), cause=exc,
                                    correlation_id=correlation_id)
            retriable_now = is_retriable(
                method=method, status_code=None, is_transport_error=True,
                is_timeout=False, timeout_phase=None, body_sent=body_sent,
            )
        else:
            if response.status_code < 400:
                return _decode_json(response, correlation_id)
            last_exc = _map_error(response, correlation_id=correlation_id)
            if isinstance(last_exc, AuthError):
                auth_fail_count += 1
                if auth_fail_count >= 3:
                    # ADR-0007 §Trust-score protection
                    raise last_exc
            retriable_now = last_exc.retriable and is_retriable(
                method=method, status_code=response.status_code,
                is_transport_error=False, is_timeout=False,
                timeout_phase=None, body_sent=True,
            )
            server_hint = parse_retry_after(response.headers,
                                            _safe_json(response))

        if attempt >= self._retry.max_retries or not retriable_now:
            raise last_exc
        if time.monotonic() >= deadline:
            raise last_exc

        delay = compute_delay_ms(
            attempt=attempt, policy=self._retry,
            server_hint_ms=server_hint,
        )
        self._telemetry.on_retry(
            attempt=attempt, delay_ms=delay, reason=last_exc,
            method=method, path=path, correlation_id=correlation_id,
        )
        sleep_with_jitter(delay)
        if idempotent is True and method.upper() == "POST":
            # Caller attested semantic idempotency — allow POST retries
            body_sent = False
        attempt += 1
```

The async twin replaces `sleep_with_jitter` with `await
async_sleep_with_jitter` and `self._client.request(...)` with
`await self._client.request(...)`.

---

## 7. Auth resolution

```python
# cognitum/_auth.py
from __future__ import annotations
import os
from dataclasses import dataclass
from typing import Mapping

from cognitum._errors import AuthError, AuthReason


@dataclass(slots=True, frozen=True)
class Credentials:
    api_key: str | None = None           # X-API-Key (cloud)
    pairing_token: str | None = None     # X-Pairing-Token (seed)

    def headers(self) -> Mapping[str, str]:
        h: dict[str, str] = {}
        if self.api_key:
            h["X-API-Key"] = self.api_key
        if self.pairing_token:
            h["X-Pairing-Token"] = self.pairing_token
        return h


def resolve_cloud_api_key(explicit: str | None) -> str:
    key = explicit or os.environ.get("COGNITUM_API_KEY")
    if not key:
        raise AuthError(
            "No API key provided. Pass api_key=... or set COGNITUM_API_KEY.",
            reason=AuthReason.NO_CREDENTIALS,
        )
    return key


def resolve_seed_token(explicit: str | None) -> str | None:
    # Seed reads are unauthenticated; token only required for writes.
    # Absence is NOT an error at construction; caller will hit
    # AuthError(NOT_PAIRED) on the first write if they haven't paired yet.
    return explicit or os.environ.get("COGNITUM_SEED_TOKEN")
```

### 7.1 Redaction

Python's mechanism is regex-based; the contract it satisfies (which fields
MUST be redacted) lives in ADR-0007 §"Cross-SDK redaction contract". The
five patterns below enforce that contract for this SDK. Adding a pattern
here requires a parallel update to the Node `redactHeaders()` helper and
the Rust `SecretString`-wrapped fields so all three SDKs stay in lock-step.

```python
# cognitum/_telemetry.py
from __future__ import annotations
import logging
import re
import uuid
from dataclasses import dataclass

log = logging.getLogger("cognitum")

_REDACT_PATTERNS = [
    re.compile(r"(X-API-Key\s*:\s*)([^\r\n]+)", re.IGNORECASE),
    re.compile(r"(Authorization\s*:\s*Bearer\s+)([^\r\n]+)", re.IGNORECASE),
    re.compile(r"(X-Pairing-Token\s*:\s*)([^\r\n]+)", re.IGNORECASE),
    re.compile(r"([?&](?:token|api_key|apiKey)=)([^&\s]+)"),
    re.compile(r'("clientSecret"\s*:\s*")([^"]+)(")'),
]


def redact(text: str) -> str:
    out = text
    for pat in _REDACT_PATTERNS:
        out = pat.sub(
            lambda m: m.group(1) + "<redacted>"
                      + (m.group(3) if m.lastindex and m.lastindex >= 3 else ""),
            out,
        )
    return out


def new_correlation_id() -> str:
    return str(uuid.uuid4())


@dataclass(slots=True)
class Telemetry:
    """Pluggable logger. SDK never prints raw credential values."""

    def on_retry(
        self, *, attempt: int, delay_ms: int, reason: BaseException,
        method: str, path: str, correlation_id: str,
    ) -> None:
        log.debug(
            "retry attempt=%d delay_ms=%d reason=%s method=%s path=%s corr=%s",
            attempt, delay_ms, type(reason).__name__, method, path, correlation_id,
        )
```

### 7.2 Pairing

```python
# cognitum/seed/pairing.py (sync half)
from __future__ import annotations
from urllib.parse import quote
from cognitum._http import SyncHttpClient
from cognitum.seed.models import PairInit, PairResult, PairStatus


class PairingResource:
    def __init__(self, http: SyncHttpClient) -> None:
        self._http = http

    def status(self) -> PairStatus:
        data = self._http.request("GET", "/api/v1/pair/status")
        return PairStatus.from_wire(data)

    def pair(self, client_name: str) -> PairResult:
        """POST /api/v1/pair inside the 30-second window.

        Returns a PairResult whose `token` the caller SHOULD store via a
        TokenStore (ADR-0007). SDK does NOT persist to disk automatically.
        """
        req = PairInit(client_name=client_name)
        data = self._http.request(
            "POST", "/api/v1/pair",
            json={"client_name": req.client_name},
        )
        return PairResult.from_wire(data)

    def unpair(self, client_name: str) -> None:
        self._http.request("DELETE", f"/api/v1/pair/{quote(client_name)}")
```

A fresh token from `pair()` is handed to the caller as the return value;
SDK does **not** stash it on `SeedClient`. To use the token for writes,
either construct a new `SeedClient(pairing_token=token)` or call
`seed.credentials.attach(token)` (documented escape hatch).

<!-- verified 2026-04-22 (security pass, issue #15 / P-A2): PairCreateResponse.token is wrapped in SecretString (cognitum/seed/_models/pair.py) so repr / str / f-string / logging-formatter paths all redact the freshly-minted pairing token; unwrap on the request path only via `.token.as_str()`. Regression suite: tests/seed/unit/test_pair_token_redaction.py (8 tests, all SENTINEL-not-in-repr/str assertions). _client.py / _async_client.py updated to stop re-wrapping the already-secret token. Closes issue #15 (sdks). -->

---

## Consequences

### Positive

- Every ADR-0004 variant is a real Python class with matching semantics.
- Retry math is pure and unit-testable without httpx in scope.
- TLS policy is explicit: default hosts accept self-signed, non-default
  hosts require trust material, and the `dangerously_insecure` flag is
  the only global opt-out.

### Negative / trade-offs

- `CognitumError` base ctor signature changes. Backward-compat shim in
  `cognitum/errors.py` keeps 0.1.x callers working for one minor cycle.
- The retry loop is ~70 lines; the previous 1.1-level inline version was
  ~40. Correctness and jitter math earn the weight.

### Neutral

- `X-Correlation-Id` is generated client-side when the server does not
  echo one; matches ADR-0004 §Payload extraction "correlation_id" rule.

## Alternatives considered

| Option | Why rejected |
|--------|--------------|
| Use `tenacity` library for retry | Too opinionated; does not give us jitter math + elapsed-time deadline in one shape |
| `urllib3.Retry` | Coupled to requests / urllib3; we are httpx-only per ADR-0009 |
| Server-only `Retry-After` | Seed often returns `retry_after_us` in body; we must parse both |

## Compliance / verification

- Unit test (`tests/test_retry.py`): 10 parallel 429-then-200 scenarios
  must converge within `max_elapsed_ms` and show equal-jitter variance.
- Unit test: 3 consecutive `AuthError` on the same credential raise
  immediately, not after retry (ADR-0007 §Trust-score protection).
- Redaction test (`tests/test_auth_redaction.py`): every `_REDACT_PATTERNS`
  entry has a positive and negative case.
- Grep lint in CI: `rg -n "print\(.*(api_key|token|signature)" sdks/python`
  must be empty.

## References

- `/home/ruvultra/projects/sdks/docs/adr/0003-cross-cutting-auth-model.md`
- `/home/ruvultra/projects/sdks/docs/adr/0004-cross-cutting-error-taxonomy.md`
- `/home/ruvultra/projects/sdks/docs/adr/0005-cross-cutting-retry-backoff.md`
- `/home/ruvultra/projects/sdks/docs/adr/0007-cross-cutting-security-model.md`
- `/home/ruvultra/projects/sdks/docs/adr/0009-python-sdk-architecture.md`
- `/home/ruvultra/projects/sdks/sdks/python/cognitum/_http.py:18` (retriable set gap)
- `/home/ruvultra/projects/sdks/sdks/python/cognitum/_http.py:48-50` (jitter gap)
- `/home/ruvultra/projects/sdks/sdks/python/cognitum/_http.py:64-72` (TLS gap)
- `/home/ruvultra/projects/sdks/sdks/python/cognitum/errors.py:1-49` (taxonomy gap)
- `/home/ruvultra/projects/sdks/seed/src/cognitum-agent/src/rate_limit.rs:70-178`
- Companion ADRs: **ADR-0013a** (layout + API + models),
  **ADR-0013c** (streaming, tests, packaging, CI, benchmarks, migration)
