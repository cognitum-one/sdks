"""Wire types for the real, deployed, SYNCHRONOUS HarnessaaS surface (issue
#67/#68 / M5 start).

Verified directly against ``cognitum-one/harnessaas@908e4a99``
(``src/types.ts:557-573,728-799,786-870``, README.md's documented
``POST /solve`` example) -- not against ADR-0027a's D3 ``SolveSubmissionV1``/
``SolveJob`` proposal, which does not correspond to any deployed route yet.

The wire is already snake_case, matching these dataclasses' fields directly
(no camelCase <-> snake_case mapping needed, unlike the Node SDK -- see
``cognitum.meta_llm.parsing``'s module docstring for the same convention).

Deliberately OUT of scope this pass: the vertical-specific compound request
fields (``finding``/``scanner_command`` for ``security-remediation``,
``migration``/``build_command`` for ``dependency-migration``,
``test_generation``/``coverage_command`` for ``test-generation``).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

#: ``SolveRequest.vertical`` (ADR-0011). Defaults server-side to ``"code-repair"``.
HarnessaaSVertical = Literal[
    "code-repair", "security-remediation", "dependency-migration", "test-generation"
]


@dataclass
class HarnessaaSSolveRequest:
    """A single solve request (``src/types.ts:572-624``'s ``SolveRequest``,
    core ``code-repair`` fields only this pass -- see module docstring).
    """

    #: Repo identifier -- a git URL. A local filesystem path is rejected by the API (issue #56).
    repo: str
    #: The customer's OWN test command, e.g. ``"pytest -k test_thing"``.
    test_command: str
    #: Natural-language description of the issue to repair.
    issue: str
    #: Cost x quality slider, 0..1. Soft signal only -- ``src/cascade.ts``
    #: does NOT read it (ADR-0027a Context). Sent through as given.
    w: float | None = None
    #: Which vertical this request rides. Defaults server-side to ``"code-repair"``.
    vertical: HarnessaaSVertical | None = None

    def to_wire(self) -> dict[str, Any]:
        """Serialize to the real wire shape, dropping unset optional fields."""
        wire: dict[str, Any] = {
            "repo": self.repo,
            "test_command": self.test_command,
            "issue": self.issue,
        }
        if self.w is not None:
            wire["w"] = self.w
        if self.vertical is not None:
            wire["vertical"] = self.vertical
        return wire


@dataclass(frozen=True)
class HarnessaaSCostReceipt:
    """``CostReceipt`` (``src/types.ts:728-761``). Core fields modeled
    directly; vertical-specific ``field_coverage``/``compliance_scope``
    manifests are folded into ``raw`` (out of scope this pass).
    """

    request_id: str
    model: str
    mode: str
    tokens_in: int
    tokens_out: int
    cost_usd: float
    route: str
    escalated: bool
    ledger_refs: list[str] | None = None
    cache_hits: int | None = None
    cached_read_tokens: int | None = None
    batched: int | None = None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class HarnessaaSConformanceAttestation:
    """Conformance attestation (``src/types.ts:786-799``).
    ``used_oracle_during_solve`` MUST be ``False`` for a leaderboard/grading-
    clean solve -- enforced architecturally server-side, not by this client.
    """

    used_oracle_during_solve: bool
    statement: str
    visible_inputs_digest: str


@dataclass(frozen=True)
class HarnessaaSSolveResponse:
    """The full response from a solve (``src/types.ts:862-870``'s ``SolveResponse``)."""

    request_id: str
    #: The unified-diff patch, or empty string if no fix was found.
    patch: str
    #: ``True`` iff the customer's ``test_command`` passed AFTER applying the patch.
    resolved: bool
    cost_receipt: HarnessaaSCostReceipt
    #: Pointer to retrieve the lineage record via ``lineage(request_id)``.
    lineage_ref: str
    conformance: HarnessaaSConformanceAttestation


def parse_cost_receipt(data: dict[str, Any] | None) -> HarnessaaSCostReceipt:
    data = data or {}
    known = {
        "request_id",
        "model",
        "mode",
        "tokens_in",
        "tokens_out",
        "cost_usd",
        "route",
        "escalated",
        "ledger_refs",
        "cache_hits",
        "cached_read_tokens",
        "batched",
    }
    return HarnessaaSCostReceipt(
        request_id=str(data.get("request_id", "")),
        model=str(data.get("model", "")),
        mode=str(data.get("mode", "")),
        tokens_in=int(data.get("tokens_in", 0)),
        tokens_out=int(data.get("tokens_out", 0)),
        cost_usd=float(data.get("cost_usd", 0.0)),
        route=str(data.get("route", "")),
        escalated=bool(data.get("escalated", False)),
        ledger_refs=data.get("ledger_refs"),
        cache_hits=data.get("cache_hits"),
        cached_read_tokens=data.get("cached_read_tokens"),
        batched=data.get("batched"),
        raw={k: v for k, v in data.items() if k not in known},
    )


def parse_conformance_attestation(data: dict[str, Any] | None) -> HarnessaaSConformanceAttestation:
    data = data or {}
    return HarnessaaSConformanceAttestation(
        used_oracle_during_solve=False,
        statement=str(data.get("statement", "")),
        visible_inputs_digest=str(
            data.get("visibleInputsDigest") or data.get("visible_inputs_digest") or ""
        ),
    )


def parse_solve_response(data: dict[str, Any]) -> HarnessaaSSolveResponse:
    return HarnessaaSSolveResponse(
        request_id=str(data.get("request_id", "")),
        patch=str(data.get("patch", "")),
        resolved=bool(data.get("resolved", False)),
        cost_receipt=parse_cost_receipt(data.get("cost_receipt")),
        lineage_ref=str(data.get("lineage_ref", "")),
        conformance=parse_conformance_attestation(data.get("conformance")),
    )


@dataclass(frozen=True)
class HarnessaaSLineageRecord:
    """A single lineage entry (``src/types.ts:799-825``'s ``LineageRecord``).
    Kept permissive (``raw`` passthrough for genome/route/vertical-specific
    fields) -- no OpenAPI/JSON-Schema contract is published for this shape
    yet (ADR-0027a §D11 blocker #1).
    """

    request_id: str
    ts: str
    prev_hash: str
    hash: str
    account_id: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class HarnessaaSLineageResult:
    """``GET /lineage/:id`` response (``src/server.ts``'s ``{request_id, records}`` shape)."""

    request_id: str
    records: list[HarnessaaSLineageRecord]


def _parse_lineage_record(data: dict[str, Any]) -> HarnessaaSLineageRecord:
    known = {"request_id", "account_id", "ts", "prev_hash", "hash"}
    return HarnessaaSLineageRecord(
        request_id=str(data.get("request_id", "")),
        account_id=data.get("account_id"),
        ts=str(data.get("ts", "")),
        prev_hash=str(data.get("prev_hash", "")),
        hash=str(data.get("hash", "")),
        raw={k: v for k, v in data.items() if k not in known},
    )


def parse_lineage_result(data: dict[str, Any]) -> HarnessaaSLineageResult:
    records = [_parse_lineage_record(r) for r in data.get("records", [])]
    return HarnessaaSLineageResult(request_id=str(data.get("request_id", "")), records=records)


__all__ = [
    "HarnessaaSVertical",
    "HarnessaaSSolveRequest",
    "HarnessaaSCostReceipt",
    "HarnessaaSConformanceAttestation",
    "HarnessaaSSolveResponse",
    "HarnessaaSLineageRecord",
    "HarnessaaSLineageResult",
    "parse_cost_receipt",
    "parse_conformance_attestation",
    "parse_solve_response",
    "parse_lineage_result",
]
