"""``MetaHarnessClient`` domain types (ADR-0026a §D3). Pure data shapes --
no bridge I/O, no process spawn. See :mod:`cognitum.metaharness.client` for
why every operation that would use these types is currently a fail-closed
stub (ADR-0026a §D7: the upstream bridge protocol these types describe
does not exist yet).

Unknown additive fields and unknown enum variants are preserved verbatim
wherever the ADR requires it (§D3: "Types preserve unknown additive
response fields and unknown event variants. Unknown security-sensitive
enums block the dependent mutation or trust claim."), following the same
``raw`` preservation convention :func:`cognitum.meta_proxy.client._parse_status`
uses.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from cognitum.agentic import VerificationLevel, VerificationResult

# ---------------------------------------------------------------------------
# RepositorySource -- §D3 tagged union
# ---------------------------------------------------------------------------

_KNOWN_VERIFICATION_LEVELS: frozenset[str] = frozenset(
    {"none", "shape", "digest", "cryptographic", "anchored"}
)


@dataclass(frozen=True)
class LocalRepository:
    """A repository already materialized on local disk (ADR-0026a §D3)."""

    canonical_path: str
    expected_tree_digest: str | None = None
    kind: Literal["local"] = "local"


@dataclass(frozen=True)
class GitRepository:
    """A repository resolved from a remote Git URL to one exact commit
    (ADR-0026a §D3).
    """

    url: str
    resolved_commit_sha: str
    requested_ref: str | None = None
    credential_reference: str | None = None
    kind: Literal["git"] = "git"


#: ``RepositorySource = LocalRepository | GitRepository`` (ADR-0026a §D3),
#: tagged by the ``kind`` field.
RepositorySource = LocalRepository | GitRepository

# ---------------------------------------------------------------------------
# ScaffoldRequestV1
# ---------------------------------------------------------------------------

SCAFFOLD_REQUEST_SCHEMA_V1: Literal["cognitum.metaharness.scaffold-request.v1"] = (
    "cognitum.metaharness.scaffold-request.v1"
)


@dataclass(frozen=True)
class ScaffoldRequestV1:
    """A non-mutating request to plan a new harness scaffold (ADR-0026a §D2, §D3)."""

    name: str
    template: str
    hosts: list[str]
    target: str
    #: ADR-0026a §D3 names this field without further specifying its shape;
    #: the upstream OSS generator's exact ``darwin`` semantics belong to the
    #: bridge contract (ADR-0026b, blocked per §D7). Typed as ``Any`` rather
    #: than guessed at -- same convention as ``MetaProxyUpstreamReceipt``
    #: (:mod:`cognitum.meta_proxy.envelope`).
    darwin: Any
    primary_host: str | None = None
    description: str | None = None
    repository_source: RepositorySource | None = None
    schema: Literal["cognitum.metaharness.scaffold-request.v1"] = SCAFFOLD_REQUEST_SCHEMA_V1


# ---------------------------------------------------------------------------
# ScaffoldPlan
# ---------------------------------------------------------------------------

SCAFFOLD_PLAN_SCHEMA_V1: Literal["cognitum.metaharness.scaffold-plan.v1"] = (
    "cognitum.metaharness.scaffold-plan.v1"
)


@dataclass(frozen=True)
class FileAction:
    """One planned filesystem action (ADR-0026a §D3: "actions:
    List<FileAction>"). The ADR does not enumerate ``kind``'s exact values,
    so unknown additive fields are preserved verbatim under ``raw`` rather
    than dropped.
    """

    kind: str
    path: str
    content_digest: str | None = None
    raw: dict[str, Any] | None = None


@dataclass(frozen=True)
class GeneratorIdentity:
    """Generator product identity captured in a ``ScaffoldPlan`` (ADR-0026a §D3, §D4 hello)."""

    product: str
    package_version: str | None = None
    generator_version: str | None = None
    source_revision: str | None = None
    raw: dict[str, Any] | None = None


@dataclass(frozen=True)
class TemplateIdentity:
    """Template identity captured in a ``ScaffoldPlan`` (ADR-0026a §D3)."""

    template: str
    template_version: str | None = None
    raw: dict[str, Any] | None = None


@dataclass(frozen=True)
class ScaffoldPlan:
    """A deterministic, non-mutating scaffold plan (ADR-0026a §D2, §D3)."""

    plan_id: str
    plan_digest: str
    created_at: str
    expires_at: str
    generator_identity: GeneratorIdentity
    template_identity: TemplateIdentity
    canonical_target: str
    target_before_digest: str
    request_digest: str
    actions: list[FileAction] = field(default_factory=list)
    unresolved_variables: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    destructive: bool = False
    estimated_files: int = 0
    estimated_bytes: int = 0
    repository_commit: str | None = None
    #: Unknown additive fields preserved verbatim (ADR-0026a §D3).
    raw: dict[str, Any] | None = None
    schema: Literal["cognitum.metaharness.scaffold-plan.v1"] = SCAFFOLD_PLAN_SCHEMA_V1


# ---------------------------------------------------------------------------
# ApplyApproval
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ApplyApproval:
    """Caller approval binding one ``scaffold()`` call to an unexpired
    ``ScaffoldPlan`` (ADR-0026a §D2, §D3).
    """

    plan_digest: str
    approved_at: str
    #: Opaque label, not an identity assertion (ADR-0026a §D3).
    approved_by: str | None = None


# ---------------------------------------------------------------------------
# ScaffoldResult
# ---------------------------------------------------------------------------

SCAFFOLD_RESULT_SCHEMA_V1: Literal["cognitum.metaharness.scaffold-result.v1"] = (
    "cognitum.metaharness.scaffold-result.v1"
)

#: The one terminal process outcome (ADR-0026a §D5). ``cancelled_after_commit``
#: still returns the committed result plus a cancellation flag rather than
#: pretending rollback occurred; ``indeterminate_mutation`` is high-severity
#: and blocks automatic recovery.
ProcessCommitOutcome = Literal[
    "succeeded",
    "failed",
    "cancelled_before_commit",
    "cancelled_after_commit",
    "indeterminate_mutation",
]


@dataclass(frozen=True)
class GeneratedFile:
    """One file materialized by a completed ``scaffold()`` call (ADR-0026a §D3)."""

    path: str
    content_digest: str | None = None
    raw: dict[str, Any] | None = None


@dataclass(frozen=True)
class HarnessManifest:
    """The upstream harness manifest, fields preserved verbatim (ADR-0026a
    §D3: "The actual manifest fields are preserved: ``schema``,
    ``generator``, ``template``, ``template_version``, ``vars``, ``hosts``,
    ``files``, ``generated_at``, and optional ``meta``."). Package version,
    generator version, template version, bridge protocol, and source
    revision are independent -- the SDK never infers one from another.
    """

    schema: str
    generator: str
    template: str
    template_version: str
    vars: dict[str, Any] = field(default_factory=dict)
    hosts: list[str] = field(default_factory=list)
    files: list[str] = field(default_factory=list)
    generated_at: str = ""
    meta: dict[str, Any] | None = None
    #: Unknown additive fields preserved verbatim (ADR-0026a §D3).
    raw: dict[str, Any] | None = None


@dataclass(frozen=True)
class WitnessVerification:
    """Witness verification result (ADR-0026a §D3, wrapping ADR-0028's
    five-level ``VerificationResult`` from :mod:`cognitum.agentic` -- never
    duplicated). ``WitnessVerification(verification.level="shape",
    valid=True)`` is never logged or serialized as cryptographically
    verified (§D3).
    """

    verification: VerificationResult
    witness_schema: str | None = None
    manifest_digest: str | None = None
    entry_digests: list[str] | None = None
    #: Unknown additive fields preserved verbatim, per §D3/§D6.
    raw_unknown: dict[str, Any] | None = None


@dataclass(frozen=True)
class ScaffoldResult:
    """The result of a completed, committed (or cancelled) ``scaffold()``
    call (ADR-0026a §D2, §D3).
    """

    plan_digest: str
    manifest: HarnessManifest
    target_after_digest: str
    commit_outcome: ProcessCommitOutcome
    verification: WitnessVerification
    files: list[GeneratedFile] = field(default_factory=list)
    unresolved_variables: list[str] = field(default_factory=list)
    #: Unknown additive fields preserved verbatim (ADR-0026a §D3).
    raw: dict[str, Any] | None = None
    schema: Literal["cognitum.metaharness.scaffold-result.v1"] = SCAFFOLD_RESULT_SCHEMA_V1


# ---------------------------------------------------------------------------
# Catalog descriptors and opaque operation results (§D2)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TemplateDescriptor:
    """One entry of ``list_templates()`` (ADR-0026a §D2: "descriptor lists")."""

    id: str
    raw: dict[str, Any] | None = None


@dataclass(frozen=True)
class HostDescriptor:
    """One entry of ``list_hosts()`` (ADR-0026a §D2: "descriptor lists")."""

    id: str
    raw: dict[str, Any] | None = None


#: Opaque payload types for operations whose result shape is entirely
#: bridge-defined and unpublished (ADR-0026a §D7 blockers #1-#3). Typed as
#: ``Any`` rather than guessed at, matching ``MetaProxyUpstreamReceipt``'s
#: convention (:mod:`cognitum.meta_proxy.envelope`).
RepositoryAnalysis = Any
RepositoryScore = Any
HarnessValidationResult = Any
HarnessComparisonResult = Any

#: Lifecycle states for a locally owned process operation (ADR-0026a §D2,
#: §D5). Non-terminal states mirror ``OperationState``
#: (:mod:`cognitum.agentic.operations`); terminal states are §D5's five
#: normative process outcomes verbatim.
ProcessRunState = Literal[
    "pending",
    "running",
    "cancelling",
    "succeeded",
    "failed",
    "cancelled_before_commit",
    "cancelled_after_commit",
    "indeterminate_mutation",
]


# ---------------------------------------------------------------------------
# Wire parsing helpers -- unknown-field / unknown-enum preservation (§D3, §D6)
# ---------------------------------------------------------------------------

_KNOWN_MANIFEST_KEYS = frozenset(
    {
        "schema",
        "generator",
        "template",
        "template_version",
        "vars",
        "hosts",
        "files",
        "generated_at",
        "meta",
    }
)


def parse_harness_manifest(data: dict[str, Any]) -> HarnessManifest:
    """Parse a raw wire manifest object into :class:`HarnessManifest`,
    preserving every field not in the ADR-0026a §D3 known-fields list under
    ``raw`` rather than dropping it.
    """
    raw = {k: v for k, v in data.items() if k not in _KNOWN_MANIFEST_KEYS}
    return HarnessManifest(
        schema=str(data.get("schema", "")),
        generator=str(data.get("generator", "")),
        template=str(data.get("template", "")),
        template_version=str(data.get("template_version", "")),
        vars=dict(data.get("vars", {})),
        hosts=list(data.get("hosts", [])),
        files=list(data.get("files", [])),
        generated_at=str(data.get("generated_at", "")),
        meta=data.get("meta"),
        raw=raw or None,
    )


_KNOWN_WITNESS_TOP_KEYS = frozenset(
    {"verification", "witness_schema", "manifest_digest", "entry_digests"}
)


def parse_witness_verification(data: dict[str, Any]) -> WitnessVerification:
    """Parse a raw wire witness-verification object into
    :class:`WitnessVerification`.

    Fails closed on an unrecognized ``verification.level`` (ADR-0026a
    §D3/§D6: "Unknown security-sensitive enums block the dependent mutation
    or trust claim.") -- an unknown level is coerced to ``"none"``/
    ``valid=False`` rather than passed through as a trust claim the rest of
    this SDK does not recognize.
    """
    verification_raw: dict[str, Any] = data.get("verification", {}) or {}
    reported_level = verification_raw.get("level")
    level_known = isinstance(reported_level, str) and reported_level in _KNOWN_VERIFICATION_LEVELS
    level: VerificationLevel = reported_level if level_known else "none"  # type: ignore[assignment]
    warnings = list(verification_raw.get("warnings") or [])
    if not level_known:
        warnings.append(
            f'unknown verification level "{reported_level}" fails closed to "none" '
            "(ADR-0026a §D3/§D6)"
        )

    verification = VerificationResult(
        level=level,
        valid=bool(verification_raw.get("valid")) if level_known else False,
        checked_at=str(verification_raw.get("checked_at", "")),
        algorithm=verification_raw.get("algorithm"),
        key_id=verification_raw.get("key_id"),
        subject_digest=verification_raw.get("subject_digest"),
        warnings=warnings or None,
        failure=verification_raw.get("failure"),
    )

    raw_unknown = {k: v for k, v in data.items() if k not in _KNOWN_WITNESS_TOP_KEYS}

    return WitnessVerification(
        verification=verification,
        witness_schema=data.get("witness_schema"),
        manifest_digest=data.get("manifest_digest"),
        entry_digests=list(data["entry_digests"]) if "entry_digests" in data else None,
        raw_unknown=raw_unknown or None,
    )


__all__ = [
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
