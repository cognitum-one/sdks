"""``MetaHarnessClient`` (ADR-0026a). Issue #64 / M4 start.

This pass implements exactly §D1 (construction -- zero I/O) and the §D2
public method SIGNATURES, every one of which is a fail-closed stub that
raises :class:`~cognitum.agentic.UnsupportedCapabilityError` BEFORE any
process, network, or filesystem access.

§D7 states the reason directly: the OSS ``metaharness`` package has no
published ``bridge --stdio`` protocol (or any versioned machine contract)
this client could talk to yet. Seven concrete blockers are listed:

1. reviewed 0.4.1 is not published at the registry state;
2. no versioned JSONL bridge covers the SDK operations;
3. package/generator/template versions disagree and output/cancel is
   nonuniform;
4. ``from-repo`` is mutable and unresolved variables do not fail by
   default;
5. witness docs, runtime shape, verification, and publish claims disagree;
6. wrapper result/dependency is stale and private CLI collides/
   process-exits;
7. external-template and full-eject flags overstate implemented behavior.

Until these close, "a released SDK may offer only a feature-flagged,
read-only development preview" (§D7) -- which is not yet the case here:
every operational method fails closed, full stop. This mirrors how
:class:`cognitum.meta_proxy.client.MetaProxyClient`'s M3-start pass declared
ONLY ``status``/``capabilities`` as real methods and omitted everything
else -- except here essentially the ENTIRE §D2 surface is blocked (even
``capabilities()`` itself: there is no bridge ``hello`` handshake to answer
it), so every method is declared as a stub rather than omitted, per this
ADR's explicit instruction that the shape be visible while blocked.

Construction mirrors :class:`cognitum.meta_proxy.client.MetaProxyClient`'s
conventions exactly: a resolved config object and the same telemetry-hook
shape. §D1's browser-runtime rejection is N/A for this package -- Python
has no browser/WASM (Pyodide) distribution surface for ``cognitum`` (same
rationale :mod:`cognitum.meta_proxy.client` gives), so there is nothing to
guard.

Explicitly out of scope this pass (do not attempt): any real npm package
acquisition/version checking (ADR-0026b), any actual child-process spawn or
JSON-Lines bridge communication, any real scaffold/analyze/score/
witness-verify logic, and the optional ``MetaHarnessProxyLifecycleProvider``
adapter (needs ADR-0025b, not started).

This client is async-only, mirroring
:class:`cognitum.meta_proxy.client.MetaProxyClient`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from cognitum.agentic import UnsupportedCapabilityError
from cognitum.metaharness.config import MetaHarnessConfig

if TYPE_CHECKING:
    from cognitum.agentic import CapabilitySet
    from cognitum.metaharness.types import (
        ApplyApproval,
        HarnessComparisonResult,
        HarnessManifest,
        HarnessValidationResult,
        HostDescriptor,
        RepositoryAnalysis,
        RepositoryScore,
        RepositorySource,
        ScaffoldPlan,
        ScaffoldRequestV1,
        ScaffoldResult,
        TemplateDescriptor,
        WitnessVerification,
    )

_PRODUCT = "metaharness"


@dataclass(frozen=True)
class _BlockedOperation:
    """One row of the ADR-0026a §D7 capability table, cited verbatim in
    every stub's raised error so a caller sees exactly which upstream
    capability is missing and why, rather than a generic "not implemented".
    """

    capability: str
    blockers: str


_BLOCKED: dict[str, _BlockedOperation] = {
    "capabilities": _BlockedOperation(
        "metaharness.bridge.hello",
        'blockers #1 ("reviewed 0.4.1 is not published at the registry state") and #2 '
        '("no versioned JSONL bridge covers the SDK operations") -- there is no `hello` '
        "handshake to answer this call, so even capability discovery itself is blocked",
    ),
    "list_templates": _BlockedOperation(
        "metaharness.catalog.templates",
        'blocker #2 ("no versioned JSONL bridge covers the SDK operations")',
    ),
    "list_hosts": _BlockedOperation(
        "metaharness.catalog.hosts",
        'blocker #2 ("no versioned JSONL bridge covers the SDK operations")',
    ),
    "analyze_repository": _BlockedOperation(
        "metaharness.repository.analyze",
        'blockers #1 ("reviewed 0.4.1 is not published at the registry state") and #2 '
        '("no versioned JSONL bridge covers the SDK operations")',
    ),
    "score_repository": _BlockedOperation(
        "metaharness.repository.score",
        'blockers #1 ("reviewed 0.4.1 is not published at the registry state") and #2 '
        '("no versioned JSONL bridge covers the SDK operations")',
    ),
    "plan_scaffold": _BlockedOperation(
        "metaharness.scaffold.plan",
        'blocker #2 ("no versioned JSONL bridge covers the SDK operations") and #3 '
        '("package/generator/template versions disagree and output/cancel is nonuniform")',
    ),
    "scaffold": _BlockedOperation(
        "metaharness.scaffold.render",
        'blocker #2 ("no versioned JSONL bridge covers the SDK operations") and #4 '
        '("`from-repo` is mutable and unresolved variables do not fail by default") -- '
        "plus ADR-0026b's integrity/commit-mode/recovery gates, none of which exist yet",
    ),
    "inspect_manifest": _BlockedOperation(
        "metaharness.manifest.inspect",
        'blockers #2 ("no versioned JSONL bridge covers the SDK operations") and #3 '
        '("package/generator/template versions disagree")',
    ),
    "validate_harness": _BlockedOperation(
        "metaharness.harness.validate",
        'blocker #2 ("no versioned JSONL bridge covers the SDK operations")',
    ),
    "compare_harnesses": _BlockedOperation(
        "metaharness.harness.compare",
        'blocker #2 ("no versioned JSONL bridge covers the SDK operations")',
    ),
    "verify_witness": _BlockedOperation(
        "metaharness.witness.shape",
        'blocker #5 ("witness docs, runtime shape, verification, and publish claims '
        'disagree") -- no requested verification level (shape, digest, cryptographic, or '
        "anchored) can be honored yet",
    ),
}


def _not_yet_available(operation: str) -> Any:
    blocked = _BLOCKED[operation]
    raise UnsupportedCapabilityError(
        _PRODUCT,
        operation,
        blocked.capability,
        f"MetaHarnessClient.{operation} is not yet available: the OSS MetaHarness bridge "
        f'protocol this method requires ("{blocked.capability}") does not exist upstream '
        f"yet (ADR-0026a §D7 -- {blocked.blockers}). This method fails closed before any "
        "process, network, or filesystem access; until all seven §D7 blockers close, a "
        "released SDK may offer at most a feature-flagged, read-only development preview, "
        "which this pass does not yet ship.",
    )


class MetaHarnessClient:
    """Client for the OSS MetaHarness local generator/verifier, backed by a
    versioned JSON Lines process bridge that does not exist upstream yet
    (ADR-0026a). ``MetaHarnessClient`` never composes Meta LLM, Meta Proxy,
    HarnessaaS, or the private commercial ``@cognitum-one/metaharness`` CLI
    (§D1) -- it is the OSS generator's bounded-context client, full stop.

    Every method is ``blocked`` maturity this pass (ADR-0026a §D7: "Until
    blockers 1 through 7 close, a released SDK may offer only a
    feature-flagged, read-only development preview"). Construction never
    starts, installs, authenticates, probes, or reconfigures a process (§D1).
    """

    def __init__(self, config: MetaHarnessConfig | None = None) -> None:
        self._config = config or MetaHarnessConfig()

    @property
    def config(self) -> MetaHarnessConfig:
        """Read-only view of the effective configuration."""
        return self._config

    async def capabilities(self) -> CapabilitySet:
        """Versioned behavior safe for this caller (ADR-0026a §D2). Blocked
        this pass: there is no bridge ``hello`` handshake (§D4) to answer
        it, so even capability discovery fails closed rather than guessing.
        """
        return _not_yet_available("capabilities")

    async def list_templates(self) -> list[TemplateDescriptor]:
        """Catalog of source-defined templates (ADR-0026a §D2, Context:
        "20 source-defined templates").
        """
        return _not_yet_available("list_templates")

    async def list_hosts(self) -> list[HostDescriptor]:
        """Catalog of source-defined hosts (ADR-0026a §D2, Context: "nine
        source-defined hosts").
        """
        return _not_yet_available("list_hosts")

    async def analyze_repository(self, source: RepositorySource) -> RepositoryAnalysis:
        """Immutable analysis of a repository (ADR-0026a §D2, §D7)."""
        del source
        return _not_yet_available("analyze_repository")

    async def score_repository(self, source: RepositorySource) -> RepositoryScore:
        """Immutable scoring of a repository (ADR-0026a §D2, §D7)."""
        del source
        return _not_yet_available("score_repository")

    async def plan_scaffold(self, request: ScaffoldRequestV1) -> ScaffoldPlan:
        """Non-mutating scaffold planning (ADR-0026a §D2: "`plan_scaffold`
        is non-mutating"). Still blocked -- planning requires the same
        unpublished bridge as every other operation.
        """
        del request
        return _not_yet_available("plan_scaffold")

    async def scaffold(self, plan: ScaffoldPlan, approval: ApplyApproval) -> ScaffoldResult:
        """Apply a still-valid ``ScaffoldPlan`` with matching
        ``ApplyApproval`` (ADR-0026a §D2). No ``force``, no plan-and-apply
        convenience -- the ADR explicitly forbids eroding the plan/apply
        review boundary. Blocked pending ADR-0026b's commit/cancel/recovery
        gates in addition to the bridge itself.
        """
        del plan, approval
        return _not_yet_available("scaffold")

    async def inspect_manifest(self, target: RepositorySource) -> HarnessManifest:
        """Inspect an existing harness manifest (ADR-0026a §D2, §D3)."""
        del target
        return _not_yet_available("inspect_manifest")

    async def validate_harness(self, target: RepositorySource) -> HarnessValidationResult:
        """Validate an existing harness against its manifest (ADR-0026a §D2)."""
        del target
        return _not_yet_available("validate_harness")

    async def compare_harnesses(
        self, a: RepositorySource, b: RepositorySource
    ) -> HarnessComparisonResult:
        """Compare two harnesses (ADR-0026a §D2)."""
        del a, b
        return _not_yet_available("compare_harnesses")

    async def verify_witness(
        self, workspace_or_witness: RepositorySource | WitnessVerification
    ) -> WitnessVerification:
        """Verify a witness at the requested level (ADR-0026a §D2, §D6).
        Blocked for every level -- even ``shape``, the weakest, requires the
        bridge/kernel this pass does not have (§D7 blocker #5).
        """
        del workspace_or_witness
        return _not_yet_available("verify_witness")

    async def aclose(self) -> None:
        """Cancel only processes owned by this client (ADR-0026a §D2:
        "Closing a client cancels only processes owned by that client. It
        does not cancel a HarnessaaS job, stop Meta Proxy, or kill a
        separately launched MetaHarness CLI."). A real no-op this pass: no
        bridge process is ever spawned by any method above, so there is
        nothing to release.
        """
        # No process is ever started by this pass's stubs -- nothing to
        # cancel or release. Reserved for the real bridge-process lifecycle
        # once one exists (ADR-0026a §D4, ADR-0026b).
        return None

    async def __aenter__(self) -> MetaHarnessClient:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()


__all__ = ["MetaHarnessClient"]
