"""``DiagnosticPolicy`` / manifest-preview scaffolding (ADR-0028 D10).

Tracking issue #70 (M6). This pass freezes the policy/manifest/bundle
shapes and implements the one piece of real logic D10 actually specifies at
this layer -- "the SDK previews a manifest of categories before capture" --
as a pure computation over a caller-supplied policy.

Explicitly NOT in scope for this pass (matching the discipline already
established by ``./telemetry.py``'s ``TelemetrySink`` freeze and
``./receipts.py``'s ``ExecutionReceipt`` freeze):

- no real capture/collection logic (no reading of prompts, source, patches,
  tool arguments, or environment values from anywhere);
- no upload logic -- per D10, "Upload is a separate source-upload consent
  operation; capture never uploads automatically";
- no product client (meta_llm/meta_proxy/metaharness/harnessaas) references
  any symbol in this module yet.

Sources: ``docs/adr/0028-agentic-telemetry-usage-receipts-lineage-and-redaction.md``
D10 (lines 325-343), reusing the D12/D13 ``D12Category`` taxonomy already
frozen in ``./sentinel.py``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from cognitum.agentic.sentinel import D12Category

#: Discriminant for :class:`DiagnosticSink`. ADR-0028 D10: "local sink path
#: or callback".
DiagnosticSinkKind = Literal["local_path", "callback"]


@dataclass(frozen=True)
class DiagnosticSink:
    """Where a captured diagnostic bundle is written (ADR-0028 D10: "local
    sink path or callback").

    Mirrors the ``kind`` + kind-specific-optional-field shape already used
    by :class:`~cognitum.agentic.errors.ConsentGrant` in this package,
    rather than a ``Union`` of dataclasses. ``"callback"`` is a marker
    discriminant only: this pass has no real capture pipeline to invoke a
    callback from, so it does not model an actual callback function type
    (design decision, not an ADR quote) -- a future capture implementation
    attaches a real callback type for that kind.
    """

    kind: DiagnosticSinkKind
    #: Present iff ``kind == "local_path"``.
    path: str | None = None


@dataclass(frozen=True)
class RetentionPolicy:
    """Retention/expiry policy for a captured diagnostic bundle (ADR-0028
    D10 "retention/expiry" bullet).

    ``max_age_ms is None`` means the caller has not declared a retention
    bound in this pass -- no enforcement exists yet (no capture pipeline
    exists to enforce it against).
    """

    max_age_ms: int | None = None


@dataclass(frozen=True)
class DiagnosticPolicy:
    """Caller-declared diagnostic-capture policy (ADR-0028 D10).

    Every field maps directly onto one bullet of the ADR's list:

    - ``included_fields`` <- "included schema-classified fields". No
      validation against a real field schema/registry exists in this pass
      (design decision, not an ADR quote) -- this is a plain caller-supplied
      list of field names the policy scopes capture to.
    - ``max_bytes`` / ``max_duration_ms`` <- "maximum bytes and duration".
    - ``sink`` <- "local sink path or callback".
    - ``encryption_required`` / ``access_expectation`` <- "encryption and
      access expectations". The ADR does not specify a structured shape
      here, so a bool + free-text string is a deliberately simple, honest
      simplification (design decision, not an ADR quote).
    - ``retention`` <- "retention/expiry".
    - ``allowed_categories`` <- "whether prompt, output, source, patch,
      tool, and environment categories are individually allowed". Reuses
      the existing :data:`~cognitum.agentic.sentinel.D12Category` taxonomy
      (``./sentinel.py``) rather than a parallel type -- see
      :data:`D10_RELEVANT_CATEGORIES` for the exact 6-of-11 mapping from
      D10's prose names onto ``D12Category`` values.

    Constructing a ``DiagnosticPolicy`` performs no I/O, capture, or schema
    validation -- it is a plain value type, mirroring how ``TelemetrySink``
    (``./telemetry.py``) was frozen as a protocol before any real emission
    pipeline existed.
    """

    max_bytes: int
    max_duration_ms: int
    sink: DiagnosticSink
    encryption_required: bool
    retention: RetentionPolicy
    included_fields: list[str] = field(default_factory=list)
    access_expectation: str | None = None
    allowed_categories: set[D12Category] = field(default_factory=set)


#: The 6 of :data:`~cognitum.agentic.sentinel.D12Category`'s 11 values that
#: D10 governs, in the ADR's own prose order ("prompt, output, source,
#: patch, tool, and environment categories"). This mapping is a design
#: decision, not a literal ADR quote, since D10 uses its own short names
#: rather than the D12/D13 category names:
#:
#: - prompt -> ``"prompts"``
#: - output -> ``"messages"``
#: - source -> ``"source"``
#: - patch -> ``"patches"``
#: - tool -> ``"tool-arguments-results"``
#: - environment -> ``"environment-values"``
D10_RELEVANT_CATEGORIES: tuple[D12Category, ...] = (
    "prompts",
    "messages",
    "source",
    "patches",
    "tool-arguments-results",
    "environment-values",
)

#: Hard-coded, policy-independent never-capturable set (ADR-0028 D10):
#: "Credentials, signing private keys, proxy tokens, cookies, repository
#: credentials, and pre-signed URLs are never capturable." ``D12Category``
#: has no finer split than ``"credentials"`` for signing keys, proxy tokens,
#: cookies, and repository credentials -- all are secret-bearing
#: authentication material, matching D13's own key-name rule, which already
#: classifies "secret", "token", "password", "accesskey" fields as
#: ``"credentials"`` regardless of which specific kind of credential they
#: hold; there is no separate signing-keys/proxy-tokens/cookies category to
#: map onto. ``"signed-urls"`` covers pre-signed URLs directly. This mapping
#: is a design decision, not a literal ADR quote: it resolves the ADR's
#: six-item prose list onto exactly 2 ``D12Category`` values, not 6, because
#: the ADR's own taxonomy is coarser than its prose list.
NEVER_CAPTURABLE_CATEGORIES: tuple[D12Category, ...] = ("credentials", "signed-urls")


def is_never_capturable(category: D12Category) -> bool:
    """Whether ``category`` is unconditionally excluded from capture,
    regardless of what any :attr:`DiagnosticPolicy.allowed_categories`
    claims.

    This is the real, enforced check backing
    :func:`preview_diagnostic_manifest`'s hard block -- not merely
    documentation.
    """
    return category in NEVER_CAPTURABLE_CATEGORIES


@dataclass(frozen=True)
class DiagnosticManifest:
    """A preview of which D10-relevant categories a policy would and would
    not capture (ADR-0028 D10: "The SDK previews a manifest of categories
    before capture").
    """

    would_capture: list[D12Category] = field(default_factory=list)
    blocked_by_policy: list[D12Category] = field(default_factory=list)


def preview_diagnostic_manifest(policy: DiagnosticPolicy) -> DiagnosticManifest:
    """Computes the manifest a caller would see before capture starts.

    Pure computation over ``policy`` -- performs no I/O and does not read,
    touch, or capture any real prompt/source/patch/tool/environment
    content.

    ``would_capture`` is the intersection of ``policy.allowed_categories``
    (restricted to :data:`D10_RELEVANT_CATEGORIES`) minus
    :data:`NEVER_CAPTURABLE_CATEGORIES`. The hard block applies even if a
    caller's policy explicitly lists ``"credentials"`` or ``"signed-urls"``
    in ``allowed_categories`` -- a policy can never override it, which is
    why the loop below only ever iterates the 6 D10-relevant categories
    (neither hard-blocked category is a member of that set, so neither can
    ever reach ``would_capture`` through this function, no matter what the
    policy claims).

    ``blocked_by_policy`` lists the D10-relevant categories the policy did
    NOT allow -- distinct from the hard-blocked categories, which never
    appear in either list returned here since they are outside
    :data:`D10_RELEVANT_CATEGORIES` entirely.
    """
    would_capture: list[D12Category] = []
    blocked_by_policy: list[D12Category] = []
    for category in D10_RELEVANT_CATEGORIES:
        # Defensive re-check: D10_RELEVANT_CATEGORIES never contains a
        # hard-blocked category today, but this keeps the hard-block
        # invariant enforced in code (not just by the tuple's current
        # contents) if it is ever edited in a future pass.
        if is_never_capturable(category):
            continue
        if category in policy.allowed_categories:
            would_capture.append(category)
        else:
            blocked_by_policy.append(category)
    return DiagnosticManifest(would_capture=would_capture, blocked_by_policy=blocked_by_policy)


@dataclass(frozen=True)
class RedactionReport:
    """Minimal redaction-report shape (ADR-0028 D10: "Diagnostic bundles
    include a redaction report...").

    :class:`~cognitum.agentic.sentinel.SentinelSecretRedactor`
    (``./sentinel.py``) does not currently return a report-shaped value --
    ``redact`` returns the redacted value itself, not a summary of what was
    redacted -- so this is a new minimal type, matching the "shape freeze"
    convention already used by ``ExecutionReceipt`` (``./receipts.py``): no
    bundle-construction pipeline computes a real value for this type in
    this pass.
    """

    redaction_count: int = 0
    categories_redacted: list[D12Category] = field(default_factory=list)


@dataclass(frozen=True)
class DiagnosticBundle:
    """Frozen diagnostic-bundle field shape (ADR-0028 D10): "Diagnostic
    bundles include a redaction report, SDK and contract versions, and
    SHA-256 digest."

    Type-only stub, matching ``ExecutionReceipt`` (``./receipts.py``)'s
    freeze discipline -- no bundle-construction pipeline exists in this
    pass; nothing populates a ``DiagnosticBundle`` from real captured
    content, and no upload logic exists (D10: "capture never uploads
    automatically").
    """

    redaction_report: RedactionReport
    sdk_version: str
    contract_version: str
    sha256_digest: str


__all__ = [
    "DiagnosticSinkKind",
    "DiagnosticSink",
    "RetentionPolicy",
    "DiagnosticPolicy",
    "D10_RELEVANT_CATEGORIES",
    "NEVER_CAPTURABLE_CATEGORIES",
    "is_never_capturable",
    "DiagnosticManifest",
    "preview_diagnostic_manifest",
    "RedactionReport",
    "DiagnosticBundle",
]
