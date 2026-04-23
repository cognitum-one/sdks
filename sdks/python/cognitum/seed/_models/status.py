"""GET /api/v1/status."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True, frozen=True)
class Status:
    device_id: str = ""
    uptime_secs: int = 0
    epoch: int = 0
    total_vectors: int = 0
    deleted_vectors: int = 0
    file_size_bytes: int = 0
    dimension: int = 0
    paired: bool = False
    extra: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> "Status":
        known = {
            "device_id",
            "uptime_secs",
            "epoch",
            "total_vectors",
            "deleted_vectors",
            "file_size_bytes",
            "dimension",
            "paired",
        }
        kwargs: dict[str, Any] = {}
        extra: dict[str, Any] = {}
        for k, v in data.items():
            if k in known:
                kwargs[k] = v
            else:
                extra[k] = v
        return cls(**kwargs, extra=extra)
