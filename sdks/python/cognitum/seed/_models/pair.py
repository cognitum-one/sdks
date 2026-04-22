"""Pairing wire models (`/api/v1/pair*`)."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any


def _split_known(data: Mapping[str, Any], known: set[str]) -> tuple[dict, dict]:
    kwargs: dict[str, Any] = {}
    extra: dict[str, Any] = {}
    for k, v in data.items():
        (kwargs if k in known else extra)[k] = v
    return kwargs, extra


@dataclass(slots=True, frozen=True)
class PairStatus:
    paired: bool = False
    client_count: int = 0
    pairing_window_open: bool = False
    window_remaining_secs: int = 0
    extra: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> "PairStatus":
        known = {
            "paired",
            "client_count",
            "pairing_window_open",
            "window_remaining_secs",
        }
        kwargs, extra = _split_known(data, known)
        return cls(**kwargs, extra=extra)


@dataclass(slots=True, frozen=True)
class PairCreateResponse:
    paired: bool = False
    token: str = ""
    client_name: str = ""
    extra: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> "PairCreateResponse":
        kwargs, extra = _split_known(data, {"paired", "token", "client_name"})
        return cls(**kwargs, extra=extra)
