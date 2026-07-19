"""MetaHarness client (ADR-0026a). Product namespace per §D1:
``cognitum.metaharness``.

Issue #64 / M4 start: ``MetaHarnessClient`` construction (§D1, zero I/O) and
the §D2 public method surface as fail-closed stubs (every upstream
capability is blocked -- see :mod:`cognitum.metaharness.client`'s module
docstring for the full ADR-0026a §D7 blocker list). Domain types (§D3) are
pure data shapes with no bridge dependency. §D1's browser-runtime rejection
is N/A for this package: Python has no browser/WASM (Pyodide) distribution
surface for ``cognitum`` (see ``pyproject.toml`` -- no such build target
exists), so there is nothing to guard, matching
:mod:`cognitum.meta_proxy`'s precedent.

Per ADR-0019 §D4, this package depends on ``cognitum.agentic`` and MUST NOT
be imported by any other product module (``cognitum.meta_llm``,
``cognitum.meta_proxy``, ``cognitum.harnessaas``). It never composes those
clients either (ADR-0026a §D1).

This package is imported eagerly by callers of ``cognitum.metaharness`` but
is NOT imported by ``cognitum/__init__.py`` itself, matching
``cognitum.meta_proxy``'s convention (issue #20's cold-start import graph
fix).
"""

from __future__ import annotations

from cognitum.metaharness.client import MetaHarnessClient
from cognitum.metaharness.config import (
    DEFAULT_HANDSHAKE_TIMEOUT_MS,
    MetaHarnessConfig,
    MetaHarnessTelemetryEvent,
    MetaHarnessTelemetryHooks,
)
from cognitum.metaharness.types import (
    SCAFFOLD_PLAN_SCHEMA_V1,
    SCAFFOLD_REQUEST_SCHEMA_V1,
    SCAFFOLD_RESULT_SCHEMA_V1,
    ApplyApproval,
    FileAction,
    GeneratedFile,
    GeneratorIdentity,
    GitRepository,
    HarnessComparisonResult,
    HarnessManifest,
    HarnessValidationResult,
    HostDescriptor,
    LocalRepository,
    ProcessCommitOutcome,
    ProcessRunState,
    RepositoryAnalysis,
    RepositoryScore,
    RepositorySource,
    ScaffoldPlan,
    ScaffoldRequestV1,
    ScaffoldResult,
    TemplateDescriptor,
    TemplateIdentity,
    WitnessVerification,
    parse_harness_manifest,
    parse_witness_verification,
)

__all__ = [
    "MetaHarnessClient",
    "DEFAULT_HANDSHAKE_TIMEOUT_MS",
    "MetaHarnessConfig",
    "MetaHarnessTelemetryEvent",
    "MetaHarnessTelemetryHooks",
    "SCAFFOLD_REQUEST_SCHEMA_V1",
    "SCAFFOLD_PLAN_SCHEMA_V1",
    "SCAFFOLD_RESULT_SCHEMA_V1",
    "LocalRepository",
    "GitRepository",
    "RepositorySource",
    "ScaffoldRequestV1",
    "FileAction",
    "GeneratorIdentity",
    "TemplateIdentity",
    "ScaffoldPlan",
    "ApplyApproval",
    "ProcessCommitOutcome",
    "GeneratedFile",
    "HarnessManifest",
    "WitnessVerification",
    "ScaffoldResult",
    "TemplateDescriptor",
    "HostDescriptor",
    "RepositoryAnalysis",
    "RepositoryScore",
    "HarnessValidationResult",
    "HarnessComparisonResult",
    "ProcessRunState",
    "parse_harness_manifest",
    "parse_witness_verification",
]
