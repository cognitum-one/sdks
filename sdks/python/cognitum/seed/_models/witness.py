"""Witness-chain wire models (`/api/v1/witness/*`)."""

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
class WitnessEntry:
    index: int = 0
    parent_hash: str = ""
    action_hash: str = ""
    signature: str = ""
    epoch: int = 0
    extra: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> "WitnessEntry":
        kwargs, extra = _split_known(
            data, {"index", "parent_hash", "action_hash", "signature", "epoch"}
        )
        return cls(**kwargs, extra=extra)


@dataclass(slots=True, frozen=True)
class WitnessChain:
    entries: tuple[WitnessEntry, ...] = ()
    chain_length: int = 0
    extra: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> "WitnessChain":
        raw = data.get("entries") or data.get("chain") or []
        entries = tuple(
            WitnessEntry.from_wire(e) if isinstance(e, Mapping) else WitnessEntry()
            for e in raw
        )
        chain_length = int(data.get("chain_length", len(entries)))
        extra = {
            k: v for k, v in data.items() if k not in ("entries", "chain", "chain_length")
        }
        return cls(entries=entries, chain_length=chain_length, extra=extra)
