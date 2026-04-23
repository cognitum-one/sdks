"""Seed-scoped re-export of the 12-variant taxonomy (ADR-0004).

The canonical classes live in :mod:`cognitum._errors` (created by this ADR-0013b
phase). This module exists so ``from cognitum.seed._errors import ...`` is a
stable import path for seed resources and transport.
"""

from __future__ import annotations

from cognitum._errors import (
    ApiError,
    AuthError,
    AuthReason,
    CognitumError,
    ConfigError,
    ConflictError,
    NetworkError,
    NotFoundError,
    NotImplementedError,  # noqa: A004 — intentional shadow per ADR-0013b
    ParseError,
    RateLimitError,
    ServiceUnavailableError,
    TimeoutError,  # noqa: A004 — intentional shadow
    TrustScoreBlockedError,
    UnsupportedError,
    ValidationError,
)

__all__ = [
    "ApiError",
    "AuthError",
    "AuthReason",
    "CognitumError",
    "ConfigError",
    "ConflictError",
    "NetworkError",
    "NotFoundError",
    "NotImplementedError",
    "ParseError",
    "RateLimitError",
    "ServiceUnavailableError",
    "TimeoutError",
    "TrustScoreBlockedError",
    "UnsupportedError",
    "ValidationError",
]
