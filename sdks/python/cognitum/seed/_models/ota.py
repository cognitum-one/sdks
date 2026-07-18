"""OTA wire models (`/api/v1/ota/*`)."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any


def _split(data: Mapping[str, Any], known: set[str]) -> tuple[dict, dict]:
    kwargs: dict[str, Any] = {}
    extra: dict[str, Any] = {}
    for k, v in data.items():
        (kwargs if k in known else extra)[k] = v
    return kwargs, extra


@dataclass(slots=True, frozen=True)
class OtaConfig:
    enabled: bool = False
    channel: str = "stable"
    check_interval_secs: int = 0
    extra: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> OtaConfig:
        kwargs, extra = _split(data, {"enabled", "channel", "check_interval_secs"})
        return cls(**kwargs, extra=extra)


@dataclass(slots=True, frozen=True)
class OtaCheckNowResponse:
    triggered: bool = False
    message: str = ""
    check_interval_secs: int = 0
    channel: str = "stable"
    extra: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> OtaCheckNowResponse:
        kwargs, extra = _split(
            data, {"triggered", "message", "check_interval_secs", "channel"}
        )
        return cls(**kwargs, extra=extra)
