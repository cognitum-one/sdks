"""Pure retry helpers for the seed transport (ADR-0005 + ADR-0013b §6).

Nothing here imports httpx; inputs are plain dicts / Mapping so tests stay
fast and deterministic.
"""

from __future__ import annotations

import random
import re
import time
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from typing import Mapping

_RETRIABLE_STATUS: frozenset[int] = frozenset({429, 500, 502, 503, 504})
_IDEMPOTENT_METHODS: frozenset[str] = frozenset({"GET", "HEAD", "DELETE", "PUT"})

_RETRY_AFTER_RX = re.compile(r"retry after\s+([0-9]+(?:\.[0-9]+)?)\s*s", re.IGNORECASE)


@dataclass(slots=True, frozen=True)
class RetryPolicy:
    """Knobs from ADR-0005 §Budget."""

    max_retries: int = 3
    base_ms: int = 500
    cap_ms: int = 30_000
    max_elapsed_ms: int = 60_000


def is_retriable_status(status_code: int) -> bool:
    """Shortcut used by the integration tests to sanity-check status coverage."""
    return status_code in _RETRIABLE_STATUS


def is_retriable(
    *,
    method: str,
    status_code: int | None,
    is_transport_error: bool = False,
    is_timeout: bool = False,
    timeout_phase: str | None = None,
    body_sent: bool = False,
    idempotent: bool = False,
) -> bool:
    """Decide if a failed attempt is safe to retry.

    Implements ADR-0005 §Retriable outcomes + §Idempotency rule.
    """
    if is_transport_error:
        return True
    if is_timeout:
        if timeout_phase == "connect":
            return True
        return not body_sent or method.upper() in _IDEMPOTENT_METHODS
    if status_code is None:
        return False
    if status_code not in _RETRIABLE_STATUS:
        return False
    if method.upper() == "POST":
        if status_code in (429, 503):
            return True
        if idempotent:
            return True
        return not body_sent
    return True


def _parse_header_retry_after(header: str, now_unix: float | None) -> int | None:
    header = header.strip()
    try:
        return int(max(0.0, float(header)) * 1000)
    except ValueError:
        pass
    try:
        dt = parsedate_to_datetime(header)
        if dt is None:
            return None
        target = dt.timestamp()
        now = now_unix if now_unix is not None else time.time()
        return int(max(0.0, (target - now) * 1000))
    except (TypeError, ValueError):
        return None


def parse_retry_after(
    headers: Mapping[str, str] | None,
    body: Mapping[str, object] | None = None,
    *,
    now_unix: float | None = None,
) -> int | None:
    """Return the server-provided retry hint in ms, or ``None``.

    Resolution order (ADR-0005 §"429 handling"):
    1. ``Retry-After`` header — seconds.
    2. ``Retry-After`` header — HTTP-date.
    3. ``retry_after_us`` from JSON body.
    4. Regex ``retry after Ns`` on the body's ``error`` field.
    """
    if headers is not None:
        # httpx.Headers is case-insensitive but a plain dict is not.
        header = headers.get("Retry-After") or headers.get("retry-after")
        if header is not None:
            ms = _parse_header_retry_after(header, now_unix)
            if ms is not None:
                return ms
    if body is not None:
        us = body.get("retry_after_us")
        if isinstance(us, (int, float)) and us >= 0:
            return int(us / 1000)
        err = body.get("error")
        if isinstance(err, str):
            m = _RETRY_AFTER_RX.search(err)
            if m:
                return int(float(m.group(1)) * 1000)
    return None


def compute_delay_ms(
    *,
    attempt: int,
    policy: RetryPolicy = RetryPolicy(),
    server_hint_ms: int | None = None,
    rng: random.Random | None = None,
) -> int:
    """Equal-jitter exponential backoff per ADR-0005 §Backoff formula."""
    r = rng or random
    raw = min(policy.cap_ms, policy.base_ms * (2**attempt))
    jitter = r.uniform(0, policy.base_ms)
    computed = int(raw + jitter)
    hint = server_hint_ms or 0
    return min(policy.cap_ms, max(hint, computed))


def compute_delay(
    attempt: int,
    base: float = 0.5,
    cap: float = 30.0,
    *,
    rng: random.Random | None = None,
) -> float:
    """Seconds-valued convenience used by the :mod:`_client` fast path."""
    r = rng or random
    return r.uniform(0.0, min(cap, base * (2**attempt)))


__all__ = [
    "RetryPolicy",
    "compute_delay",
    "compute_delay_ms",
    "is_retriable",
    "is_retriable_status",
    "parse_retry_after",
]
