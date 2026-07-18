"""Discovery wire types: health, models, whoami (ADR-0024a §D1, §D2).

No service-owned OpenAPI contract exists yet (ADR-0024a §D9 gate #1), so
these stay intentionally permissive (``raw`` passthrough) rather than
pretending to be the eventual GA contract.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class MetaLlmHealth:
    """``health()`` response -- process-level only, never identity or readiness."""

    status: str
    version: str | None = None
    #: Unrecognized fields from the server response, preserved verbatim.
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class MetaLlmModelInfo:
    """A single entry from ``models()``.

    ``/v1/models`` may not list every accepted alias (ADR-0024a Context).
    """

    id: str
    object: str | None = None
    owned_by: str | None = None
    created: int | None = None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class MetaLlmModelList:
    """``models()`` response."""

    models: list[MetaLlmModelInfo]
    object: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class MetaLlmWhoAmI:
    """``whoami()`` response -- authenticated account and credential type only."""

    account_id: str | None = None
    credential_type: str | None = None
    scopes: list[str] = field(default_factory=list)
    tenant_id: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)


__all__ = ["MetaLlmHealth", "MetaLlmModelInfo", "MetaLlmModelList", "MetaLlmWhoAmI"]
