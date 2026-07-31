"""``MetaHarnessClient`` construction and configuration (ADR-0026a §D1, §D3).

Type-only scaffolding plus construction-time validation for issue #64 / M4
start. Construction performs NO I/O -- it "resolves configuration only.
[It performs] no npm access, process spawn, repository read, filesystem
write, capability probe, login, or prompt" (§D1). See
:mod:`cognitum.metaharness.client` for the fail-closed method stubs this
pass ships instead of any real bridge call.

Mirrors :mod:`cognitum.meta_proxy.config`'s construction conventions
exactly: a resolved config dataclass and the same telemetry-hook shape.
Unlike Meta Proxy, there is no HTTP loopback origin here at all -- the
bridge is a child process over stdio (ADR-0026a §D4) -- so there is nothing
analogous to ``origin`` to default or validate. The §D1/§D10 "zero I/O"
requirement this module upholds instead is structural: construction only
reads and defaults plain fields, never touching npm, a process, or a
filesystem path.

§D3's ``distribution``, ``workspace_policy``, ``process_policy``, and
``diagnostic_policy`` sub-shapes are owned by ADR-0026b (process,
filesystem, and npm/npx supply chain) -- that ADR is explicitly out of
scope for this pass (§D7 blocker #1: "reviewed 0.4.1 is not published at
the registry state"), so they are typed here as opaque ``dict`` values
rather than guessed at in detail.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

#: Default warm-bridge-handshake budget -- matches §D4's default parser
#: limit table exactly.
DEFAULT_HANDSHAKE_TIMEOUT_MS = 2_000


class MetaHarnessTelemetryHooks(Protocol):
    """Caller-supplied telemetry hooks (ADR-0028), matching
    :class:`cognitum.meta_proxy.config.MetaProxyTelemetryHooks`'s
    convention. Hooks MUST NOT receive secrets.
    """

    def on_request_start(self, operation: str, request_id: str) -> None: ...

    def on_request_end(self, event: MetaHarnessTelemetryEvent) -> None: ...


@dataclass(frozen=True)
class MetaHarnessTelemetryEvent:
    """A single telemetry observation emitted around one MetaHarnessClient operation."""

    operation: str
    request_id: str
    duration_ms: float | None = None


@dataclass
class MetaHarnessConfig:
    """Construction config for :class:`cognitum.metaharness.client.MetaHarnessClient`
    (ADR-0026a §D3).

    Every field is resolved with zero I/O (§D1). None of ``distribution``,
    ``workspace_policy``, or ``process_policy`` is read from disk, npm, or
    the environment here -- they are plain caller-supplied values, held
    as-is.

    §D3's ``distribution``, ``workspace_policy``, ``process_policy``, and
    ``diagnostic_policy`` sub-shapes are owned by ADR-0026b (out of scope
    here) and are therefore typed as opaque ``dict[str, Any]`` values.
    """

    #: Locked OSS distribution identity (ADR-0026b, out of scope here).
    distribution: dict[str, Any] | None = None
    #: Workspace containment policy (ADR-0026b, out of scope here).
    workspace_policy: dict[str, Any] | None = None
    #: Child-process containment policy (ADR-0026b, out of scope here).
    process_policy: dict[str, Any] | None = None
    #: Milliseconds. Budget for locating/validating the locked distribution
    #: before bridge acquisition (ADR-0026b).
    acquisition_timeout_ms: float | None = None
    #: Milliseconds. Defaults to ``DEFAULT_HANDSHAKE_TIMEOUT_MS`` (2000),
    #: matching §D4's "Warm bridge handshake | 2 seconds" default parser limit.
    handshake_timeout_ms: float = DEFAULT_HANDSHAKE_TIMEOUT_MS
    #: Milliseconds. Per-operation budget once a bridge protocol exists (§D4).
    operation_timeout_ms: float | None = None
    #: Diagnostic redaction/retention policy (ADR-0026a §D5, ADR-0028).
    #: Opaque -- the exact shape is bridge-defined and not yet published.
    diagnostic_policy: dict[str, Any] | None = None
    #: Feature-flagged preview capabilities this caller opts into (ADR-0026a
    #: §D7: "a released SDK may offer only a feature-flagged, read-only
    #: development preview with the exact verified distribution"). Opting in
    #: to a name here never grants an operation that is otherwise blocked --
    #: every §D2 method still fails closed until its upstream capability
    #: exists.
    preview_features: list[str] = field(default_factory=list)
    telemetry: MetaHarnessTelemetryHooks | None = None

    def __post_init__(self) -> None:
        if self.handshake_timeout_ms <= 0:
            raise ValueError("MetaHarnessConfig.handshake_timeout_ms must be a positive number")
        if self.acquisition_timeout_ms is not None and self.acquisition_timeout_ms <= 0:
            raise ValueError("MetaHarnessConfig.acquisition_timeout_ms must be a positive number")
        if self.operation_timeout_ms is not None and self.operation_timeout_ms <= 0:
            raise ValueError("MetaHarnessConfig.operation_timeout_ms must be a positive number")
        # Copy, rather than alias, the caller's list -- matches the Node
        # SDK's `resolveMetaHarnessClientConfig` convention.
        self.preview_features = list(self.preview_features)


__all__ = [
    "DEFAULT_HANDSHAKE_TIMEOUT_MS",
    "MetaHarnessTelemetryEvent",
    "MetaHarnessTelemetryHooks",
    "MetaHarnessConfig",
]
