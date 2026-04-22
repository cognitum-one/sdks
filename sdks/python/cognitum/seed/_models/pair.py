"""Pairing wire models (`/api/v1/pair*`)."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from cognitum.seed._token_book import SecretString


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


def _empty_secret() -> SecretString:
    return SecretString("")


@dataclass(slots=True, frozen=True)
class PairCreateResponse:
    """Response from ``POST /api/v1/pair``.

    ``token`` is wrapped in :class:`SecretString` so ``repr(response)``,
    ``str(response)``, ``print(response)``, and structured logging all
    redact the freshly-minted pairing token (issue #15 / P-A2).
    Call ``.token.as_str()`` on the request path only.
    """

    paired: bool = False
    token: SecretString = field(default_factory=_empty_secret)
    client_name: str = ""
    extra: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> "PairCreateResponse":
        kwargs, extra = _split_known(data, {"paired", "token", "client_name"})
        # Wrap the wire-level string immediately so it cannot leak via
        # an interim dataclass repr.
        raw_token = kwargs.pop("token", "")
        token = raw_token if isinstance(raw_token, SecretString) else SecretString(str(raw_token))
        return cls(token=token, extra=extra, **kwargs)
