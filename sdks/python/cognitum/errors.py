"""Exception hierarchy for the Cognitum SDK."""

from __future__ import annotations


class CognitumError(Exception):
    """Base exception for all Cognitum SDK errors."""

    def __init__(self, message: str, code: str | None = None) -> None:
        self.message = message
        self.code = code
        super().__init__(message)

    def __repr__(self) -> str:
        return f"{self.__class__.__name__}(message={self.message!r}, code={self.code!r})"


class AuthError(CognitumError):
    """Raised when authentication fails (HTTP 401/403)."""

    def __init__(self, message: str = "Authentication failed") -> None:
        super().__init__(message, code="auth_error")


class RateLimitError(CognitumError):
    """Raised when the API rate limit is exceeded (HTTP 429)."""

    def __init__(
        self,
        message: str = "Rate limit exceeded",
        retry_after_seconds: float | None = None,
    ) -> None:
        super().__init__(message, code="rate_limited")
        self.retry_after_seconds = retry_after_seconds


class ValidationError(CognitumError):
    """Raised when request validation fails (HTTP 400/422)."""

    def __init__(self, message: str = "Validation error") -> None:
        super().__init__(message, code="validation_error")


class NotFoundError(CognitumError):
    """Raised when a requested resource is not found (HTTP 404)."""

    def __init__(self, message: str = "Resource not found") -> None:
        super().__init__(message, code="not_found")
