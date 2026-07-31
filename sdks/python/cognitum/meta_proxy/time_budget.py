"""``ProxyTimeBudget`` (ADR-0025a §D8)::

    ProxyTimeBudget {
      connect_timeout,
      first_byte_timeout,
      idle_stream_timeout,
      overall_deadline
    }

§D8: "The process currently uses a 10-second connect timeout and no overall
timeout. The SDK supplies cancellation and an optional overall deadline.
Timing out one request never kills the Proxy." -- so ``connect_timeout_ms``
has a documented 10s default (matching the deployed Proxy's own
connect-timeout behavior) while ``overall_deadline_ms`` has NO default: it
is caller-supplied only, and its absence means "no overall timeout" exactly
as today.

This is a Proxy-specific type distinct from ADR-0023's generic
``TimeBudget`` (:mod:`cognitum.agentic`) -- ADR-0025a names exactly these
four fields, no more -- even though :mod:`cognitum.meta_proxy.stream.chat_completions_stream`
internally applies the identical "race the blocking read against the
smallest remaining budget" pattern PR #88 proved correct for direct
``MetaLlmClient`` streaming.
"""

from __future__ import annotations

from dataclasses import dataclass

#: Matches the Proxy's own documented connect-timeout behavior (ADR-0025a §D8, Context).
DEFAULT_PROXY_CONNECT_TIMEOUT_MS = 10_000


@dataclass(frozen=True)
class ProxyTimeBudget:
    """Caller-supplied time budget for one Proxy chat/Messages call (ADR-0025a §D8)."""

    #: Bounds each HTTP attempt (initial POST, and the at-most-one
    #: 401-refresh retry) from send until a response begins arriving.
    #: ``None`` resolves to :data:`DEFAULT_PROXY_CONNECT_TIMEOUT_MS` via
    #: :func:`resolve_proxy_time_budget`.
    connect_timeout_ms: int | None = None
    #: Bounds the wait for the first SSE body byte after a response begins. No default.
    first_byte_timeout_ms: int | None = None
    #: Bounds the wait between subsequent SSE body bytes once streaming has started. No default.
    idle_stream_timeout_ms: int | None = None
    #: Bounds the ENTIRE call (pre-byte connect/retry phase plus the full
    #: streaming read) from the moment the caller invokes the method. No
    #: default -- §D8: omission means no overall timeout, matching today's
    #: undocumented-but-real Proxy behavior.
    overall_deadline_ms: int | None = None


@dataclass(frozen=True)
class ResolvedProxyTimeBudget:
    """:class:`ProxyTimeBudget` after defaulting -- ``connect_timeout_ms`` is always present."""

    connect_timeout_ms: int
    first_byte_timeout_ms: int | None = None
    idle_stream_timeout_ms: int | None = None
    overall_deadline_ms: int | None = None


def resolve_proxy_time_budget(budget: ProxyTimeBudget | None) -> ResolvedProxyTimeBudget:
    """Apply :data:`DEFAULT_PROXY_CONNECT_TIMEOUT_MS`; other fields pass through unchanged."""
    if budget is None:
        return ResolvedProxyTimeBudget(connect_timeout_ms=DEFAULT_PROXY_CONNECT_TIMEOUT_MS)
    return ResolvedProxyTimeBudget(
        connect_timeout_ms=(
            budget.connect_timeout_ms
            if budget.connect_timeout_ms is not None
            else DEFAULT_PROXY_CONNECT_TIMEOUT_MS
        ),
        first_byte_timeout_ms=budget.first_byte_timeout_ms,
        idle_stream_timeout_ms=budget.idle_stream_timeout_ms,
        overall_deadline_ms=budget.overall_deadline_ms,
    )


__all__ = [
    "DEFAULT_PROXY_CONNECT_TIMEOUT_MS",
    "ProxyTimeBudget",
    "ResolvedProxyTimeBudget",
    "resolve_proxy_time_budget",
]
