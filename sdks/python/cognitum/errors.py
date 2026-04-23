"""Public error re-exports (backward compat with 0.1.x callers).

The canonical taxonomy lives in :mod:`cognitum._errors`. The classes imported
here are the same objects — ``isinstance`` checks against either module hit.
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
    NotImplementedError,  # noqa: A004
    ParseError,
    RateLimitError,
    ServiceUnavailableError,
    TimeoutError,  # noqa: A004
    TimeoutPhase,
    TlsPinError,
    TrustScoreBlockedError,
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
    "TimeoutPhase",
    "TlsPinError",
    "TrustScoreBlockedError",
    "ValidationError",
]
