"""Request-body serialisation for the wire (ADR-0030a §D1 Wire layer).

``dataclasses.asdict`` keeps every field, so an unset optional goes out as an
explicit ``null``. That is not the same request as omitting it, and the
gateway does not treat it as the same request::

    {"n": null}   -> HTTP 400  "Only n=1 is supported in v1."
    (n absent)    -> HTTP 200

Verified against api.cognitum.one on 2026-07-31: the published Python SDK
could not complete a basic chat completion for this reason, while the Node
SDK -- which builds its body from only the fields a caller set -- worked.
Rust had the same defect from missing ``skip_serializing_if``.

Absent and null are different on the wire. This module makes "the caller did
not set it" serialise as absent, which is what every one of these OpenAI- and
Anthropic-shaped contracts means by an optional field.
"""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
from typing import Any


def _drop_none(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    return {key: value for key, value in pairs if value is not None}


def request_body(request: Any) -> dict[str, Any]:
    """Serialise a request dataclass, omitting fields the caller left unset.

    Recurses through nested dataclasses (a chat ``messages`` list, say) via
    ``asdict``'s ``dict_factory``, so a message's unset ``name`` is omitted
    too -- that one produced ``messages[0].name must be a string, got null``
    from the live gateway.

    A caller who explicitly wants a JSON null must pass a sentinel the
    contract defines; there is deliberately no way to express it by leaving a
    field at ``None``, because ``None`` is what an unset optional already is.
    """
    if not is_dataclass(request) or isinstance(request, type):
        raise TypeError(f"request_body expects a dataclass instance, got {type(request)!r}")
    return asdict(request, dict_factory=_drop_none)


__all__ = ["request_body"]
