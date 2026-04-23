"""Per-call knobs for :class:`SeedClient` / :class:`AsyncSeedClient`
(ADR-0016b §"Per-call knobs").

Every resource method accepts an optional :class:`CallOptions` bag that
overrides the client-wide routing / timeout / retry defaults for one
call. The SDK-side sentinels are:

* ``peer`` — pin this one call to the named endpoint URL. Unknown peer
  raises :class:`ConfigError` immediately (no silent fallback).
* ``prefer`` — override closest-first selection for this call only.
* ``consistency`` — ADR-0016a §D4. ``"strong"`` raises
  :class:`UnsupportedError` (seed has no quorum protocol);
  ``"eventual"`` bypasses session stickiness; ``"session"`` is the
  default and keeps the pinned peer if present.
* ``timeout`` — float overrides the total timeout; a 3-tuple overrides
  (connect, read, total).
* ``retries`` — ``None`` keeps the client default, ``0`` disables retry
  entirely for this call, ``>=1`` caps it. Use ``DISABLE_RETRY``
  (alias for ``0``) if the intent needs to be crystal-clear.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any, Literal

import httpx

from cognitum._errors import ConfigError, UnsupportedError
from cognitum.seed._peers import PeerSet


Prefer = Literal["closest", "local-first", "random", "any"]
Consistency = Literal["session", "eventual", "strong"]

# Sentinel: `retries=DISABLE_RETRY` makes the intent explicit in call sites.
# Kept as an alias of 0 so `retries=0` keeps working and there's no magic.
DISABLE_RETRY: int = 0


@dataclass(slots=True, frozen=True)
class CallOptions:
    """Per-request overrides (ADR-0016b)."""

    peer: str | None = None
    prefer: Prefer | None = None
    consistency: Consistency | None = None
    timeout: float | tuple[float, float, float] | None = None
    retries: int | None = None

    def validate(self) -> None:
        """Cheap, local-only validation. Does not look at the peer set."""
        if self.prefer is not None and self.prefer not in (
            "closest",
            "local-first",
            "random",
            "any",
        ):
            raise ConfigError(
                f"CallOptions.prefer must be one of closest/local-first/"
                f"random/any, got {self.prefer!r}",
                field="options.prefer",
            )
        if self.consistency is not None and self.consistency not in (
            "session",
            "eventual",
            "strong",
        ):
            raise ConfigError(
                f"CallOptions.consistency must be one of session/eventual/"
                f"strong, got {self.consistency!r}",
                field="options.consistency",
            )
        if self.consistency == "strong":
            raise UnsupportedError(
                "strong consistency unsupported; seed has no quorum protocol",
                feature="consistency=strong",
            )
        if self.retries is not None and self.retries < 0:
            raise ConfigError(
                f"CallOptions.retries must be >=0 or None, got {self.retries!r}",
                field="options.retries",
            )
        if isinstance(self.timeout, (int, float)) and self.timeout <= 0:
            raise ConfigError(
                "CallOptions.timeout (scalar) must be positive",
                field="options.timeout",
            )
        if isinstance(self.timeout, tuple):
            if len(self.timeout) != 3 or any(
                (not isinstance(v, (int, float)) or v <= 0)
                for v in self.timeout
            ):
                raise ConfigError(
                    "CallOptions.timeout tuple must be (connect, read, total) "
                    "of 3 positive numbers",
                    field="options.timeout",
                )


@dataclass(slots=True)
class ResolvedCallOptions:
    """Internal shape after merging :class:`CallOptions` with client defaults.

    Produced by :func:`resolve_call_options` so the sync and async
    transports share a single validation + resolution path (keeps both
    request loops short).
    """

    effective_peer_key: str | None
    max_retries: int
    timeout_override: httpx.Timeout | None
    total_deadline_s: float | None


def resolve_call_options(
    options: CallOptions | None,
    *,
    pinned_peer_key: str | None,
    default_max_retries: int,
    peers: PeerSet,
    peers_lock: threading.Lock,
) -> ResolvedCallOptions:
    """Validate + merge per-call options into effective transport params.

    Raises :class:`UnsupportedError` on ``consistency="strong"`` and
    :class:`ConfigError` on unknown peer / bad timeout / bad retries.
    """
    effective_peer_key = pinned_peer_key
    max_retries = default_max_retries
    timeout_override: httpx.Timeout | None = None
    total_deadline_s: float | None = None

    if options is None:
        return ResolvedCallOptions(
            effective_peer_key=effective_peer_key,
            max_retries=max_retries,
            timeout_override=timeout_override,
            total_deadline_s=total_deadline_s,
        )

    options.validate()

    if options.consistency == "eventual":
        effective_peer_key = None
    if options.peer is not None:
        want = options.peer.rstrip("/")
        with peers_lock:
            found = peers.find_by_key(want)
        if found is None:
            raise ConfigError(
                f"options.peer {options.peer!r} is not a configured endpoint",
                field="options.peer",
            )
        effective_peer_key = want
    if options.retries is not None:
        max_retries = options.retries
    if options.timeout is not None:
        if isinstance(options.timeout, tuple):
            c, r, t = options.timeout
            timeout_override = httpx.Timeout(
                connect=float(c), read=float(r),
                write=float(r), pool=float(t),
            )
            total_deadline_s = float(t)
        else:
            t = float(options.timeout)
            timeout_override = httpx.Timeout(t)
            total_deadline_s = t

    return ResolvedCallOptions(
        effective_peer_key=effective_peer_key,
        max_retries=max_retries,
        timeout_override=timeout_override,
        total_deadline_s=total_deadline_s,
    )


__all__ = [
    "CallOptions",
    "Consistency",
    "DISABLE_RETRY",
    "Prefer",
    "ResolvedCallOptions",
    "resolve_call_options",
]
