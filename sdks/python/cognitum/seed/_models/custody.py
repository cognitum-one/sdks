"""Custody wire models (`/api/v1/custody/*`)."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True, frozen=True)
class Epoch:
    epoch: int = 0
    extra: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> Epoch:
        known = {"epoch"}
        kwargs: dict[str, Any] = {}
        extra: dict[str, Any] = {}
        for k, v in data.items():
            (kwargs if k in known else extra)[k] = v
        return cls(**kwargs, extra=extra)
