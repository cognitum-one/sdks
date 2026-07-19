"""W3C Trace Context parse / generate / join logic and stable span-name
builders (ADR-0028 D2).

This module ADDS real logic on top of the :class:`TraceContext` carrier
type frozen in ``./telemetry.py`` during the D1/D3 pass (PR #115) -- it does
not redefine that type. Per D2: "Remote HTTP clients propagate W3C
``traceparent`` and ``tracestate`` when enabled and when allowed by the
product contract... Trace context is generated or joined by the SDK but
never used as an authorization, tenant, idempotency, or evidence identity.
Untrusted server or subprocess trace values are validated before joining."

Nothing in this module performs network I/O or wires into a product
client's HTTP request logic (meta_llm/meta_proxy/metaharness/harnessaas) --
that is explicitly out of scope for this pass, mirroring how
``sse/parser.py`` shipped as a protocol-agnostic core before any product
wired it in.

Spec simplifications made in this pass
---------------------------------------

- **Version**: only ``traceparent`` version ``"00"`` is accepted. The
  spec's own forward-compatibility rule (Trace Context, "Versioning of
  traceparent") allows a higher version to append trailing fields after
  ``trace-flags``; this SDK has no use for any such field, so rather than
  parse-and-ignore unknown trailing data, any non-``"00"`` version (or a
  ``traceparent`` that does not split into exactly four ``-``-separated
  fields) is treated as invalid input. Per D2's "untrusted values must be
  validated before joining," :func:`join_or_generate_trace_context` simply
  falls back to generating a fresh trace context in that case rather than
  guessing at a newer wire shape.
- **``tracestate``**: a "reasonably strict" validator, not the full spec.
  Enforced: non-empty, at most 32 members, each ``key=value`` pair with a
  key restricted to lowercase alphanumerics plus ``-``/``*``/``_``/``/``
  (with at most one ``@`` tenant/vendor separator, each side non-empty) and
  a value restricted to printable ASCII (0x20-0x7E) excluding ``,``/``=``
  and leading/trailing spaces. Not enforced: the spec's separate tenant-id
  (<=241 chars) / vendor-id (<=13 chars) length caps around ``@`` -- this
  pass uses one shared 256-char cap on each side instead.
- **Random source**: :mod:`secrets` (already used elsewhere in this module
  tree, e.g. ``oauth_token_provider.py``) is a cryptographically secure
  OS-backed source, so generation here uses ``secrets.token_hex`` directly
  -- no new dependency, and no need to fall back to a non-cryptographic
  PRNG (unlike the Rust SDK, where the equivalent secure-random dependency,
  ``uuid``, is feature-gated behind product features this base module
  cannot depend on).
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass

from cognitum.agentic.telemetry import TraceContext

#: The only ``traceparent`` version this implementation accepts. See the
#: module docstring's "Version" simplification.
TRACE_VERSION = "00"

#: Default ``trace-flags`` value used when this SDK generates a new
#: trace-parent: bit 0 ("sampled") set.
DEFAULT_TRACE_FLAGS = "01"

#: Max ``tracestate`` list members this parser accepts (matches the W3C
#: spec's own cap).
MAX_TRACESTATE_MEMBERS = 32

_HEX_DIGITS = set("0123456789abcdef")
_KEY_CHARS = set("abcdefghijklmnopqrstuvwxyz0123456789-*_/")


@dataclass(frozen=True)
class _TraceParentComponents:
    trace_id: str
    parent_id: str
    trace_flags: str


def _is_lowercase_hex(s: str, expected_len: int) -> bool:
    return len(s) == expected_len and all(c in _HEX_DIGITS for c in s)


def _is_all_zero(s: str) -> bool:
    return all(c == "0" for c in s)


def _parse_trace_parent_components(header: str) -> _TraceParentComponents | None:
    """Splits and validates a raw ``traceparent`` header. Returns ``None``
    on ANY malformed input -- never raises."""
    parts = header.split("-")
    if len(parts) != 4:
        return None  # wrong separator count
    version, trace_id, parent_id, trace_flags = parts
    if version != TRACE_VERSION:
        return None
    if not _is_lowercase_hex(trace_id, 32) or _is_all_zero(trace_id):
        return None
    if not _is_lowercase_hex(parent_id, 16) or _is_all_zero(parent_id):
        return None
    if not _is_lowercase_hex(trace_flags, 2):
        return None
    return _TraceParentComponents(trace_id=trace_id, parent_id=parent_id, trace_flags=trace_flags)


def parse_trace_parent(header: str) -> TraceContext | None:
    """Parses and validates a raw ``traceparent`` header value (W3C Trace
    Context: ``{version}-{trace-id}-{parent-id}-{trace-flags}``, e.g.
    ``00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01``).

    Returns ``None`` on ANY malformed input (wrong version, wrong
    hex-char-count, all-zero trace-id or parent-id, wrong separator count,
    non-hex characters) -- never raises, matching D2's "untrusted server or
    subprocess trace values are validated before joining."
    """
    if _parse_trace_parent_components(header) is None:
        return None
    return TraceContext(trace_parent=header)


def _random_hex_nonzero(byte_len: int) -> str:
    # Astronomically unlikely to loop more than once; guards against the
    # all-zero case the spec forbids.
    while True:
        value = secrets.token_hex(byte_len)
        if not _is_all_zero(value):
            return value


def _generate_trace_parent_string() -> str:
    """Formats a fresh, valid ``traceparent`` string: a random 32-hex-char
    trace-id and 16-hex-char parent-id (both guaranteed nonzero),
    ``trace-flags = "01"`` (sampled). Factored out (rather than reading
    ``generate_trace_parent().trace_parent`` back, which is typed
    ``str | None`` on :class:`TraceContext`) so callers that always have a
    concrete string -- like :func:`join_or_generate_trace_context` -- never
    need to narrow an ``Optional`` they know is never ``None`` here.
    """
    trace_id = _random_hex_nonzero(16)  # 16 bytes -> 32 hex chars
    parent_id = _random_hex_nonzero(8)  # 8 bytes -> 16 hex chars
    return f"{TRACE_VERSION}-{trace_id}-{parent_id}-{DEFAULT_TRACE_FLAGS}"


def generate_trace_parent() -> TraceContext:
    """Generates a fresh, valid ``traceparent`` (see
    :func:`_generate_trace_parent_string`)."""
    return TraceContext(trace_parent=_generate_trace_parent_string())


@dataclass(frozen=True)
class TraceStateMember:
    """One validated ``tracestate`` list member."""

    key: str
    value: str


def _is_valid_tracestate_key_charset(s: str) -> bool:
    if not s or len(s) > 256:
        return False
    first = s[0]
    if not (first.isdigit() or ("a" <= first <= "z")):
        # First char must be a lowercase letter or digit, not '-'/'*'/'_'/'/'.
        return False
    return all(c in _KEY_CHARS for c in s)


def _is_valid_tracestate_key(key: str) -> bool:
    if key.count("@") > 1:
        return False
    if "@" in key:
        tenant, vendor = key.split("@", 1)
        return (
            bool(tenant)
            and bool(vendor)
            and _is_valid_tracestate_key_charset(tenant)
            and _is_valid_tracestate_key_charset(vendor)
        )
    return _is_valid_tracestate_key_charset(key)


def _is_valid_tracestate_value(value: str) -> bool:
    if not value or len(value) > 256:
        return False
    if value.startswith(" ") or value.endswith(" "):
        return False
    return all(0x20 <= ord(c) <= 0x7E and c not in (",", "=") for c in value)


def parse_trace_state(header: str) -> list[TraceStateMember] | None:
    """Parses a raw ``tracestate`` header value into an ordered list of
    validated ``key=value`` members (comma-separated, up to
    :data:`MAX_TRACESTATE_MEMBERS`).

    Returns ``None`` on ANY malformed input (empty, too many members,
    malformed key/value characters) -- never raises. See the module
    docstring for exactly which spec details this validator simplifies.
    """
    if not header.strip():
        return None
    members: list[TraceStateMember] = []
    for raw_member in header.split(","):
        # W3C tracestate OWS is space/HTAB only (RFC 7230 OWS), not
        # arbitrary Unicode whitespace -- match Rust's
        # `trim_matches(' ' | '\t')` exactly rather than `str.strip()`'s
        # broader definition.
        member = raw_member.strip(" \t")
        if not member:
            return None
        if "=" not in member:
            return None
        key, value = member.split("=", 1)
        if not _is_valid_tracestate_key(key) or not _is_valid_tracestate_value(value):
            return None
        members.append(TraceStateMember(key=key, value=value))
    if not members or len(members) > MAX_TRACESTATE_MEMBERS:
        return None
    return members


def format_trace_state(members: list[TraceStateMember]) -> str:
    """Formats a list of ``tracestate`` members back into the wire string."""
    return ",".join(f"{m.key}={m.value}" for m in members)


def join_or_generate_trace_context(
    incoming_traceparent_header: str | None = None,
    incoming_tracestate_header: str | None = None,
) -> TraceContext:
    """Joins an incoming, untrusted ``traceparent``/``tracestate`` pair if
    valid, or generates a fresh trace context otherwise.

    Per D2: a receiving service keeps the incoming trace-id but generates
    its own new parent-id/span-id (this SDK is a new span in the same
    trace); ``trace-flags`` is reset to :data:`DEFAULT_TRACE_FLAGS` since
    this pass does not interpret or propagate the incoming sampling bit. An
    invalid incoming ``traceparent`` NEVER raises and NEVER gets joined --
    it falls back to generation, matching "untrusted server or subprocess
    trace values are validated before joining." An invalid incoming
    ``tracestate`` is silently dropped (treated as absent) rather than
    invalidating the whole join.
    """
    parsed_trace_state = (
        parse_trace_state(incoming_tracestate_header) if incoming_tracestate_header else None
    )
    trace_state = format_trace_state(parsed_trace_state) if parsed_trace_state else None

    components = (
        _parse_trace_parent_components(incoming_traceparent_header)
        if incoming_traceparent_header
        else None
    )

    if components is not None:
        new_parent_id = _random_hex_nonzero(8)
        trace_parent = (
            f"{TRACE_VERSION}-{components.trace_id}-{new_parent_id}-{DEFAULT_TRACE_FLAGS}"
        )
    else:
        trace_parent = _generate_trace_parent_string()

    return TraceContext(trace_parent=trace_parent, trace_state=trace_state)


# ---------------------------------------------------------------------
# D2: Stable span names, ``cognitum.<product>.<operation>`` format.
# ---------------------------------------------------------------------


def meta_llm_span_name(operation: str) -> str:
    """Builds the stable span name ``cognitum.meta_llm.<operation>``."""
    return f"cognitum.meta_llm.{operation}"


def meta_proxy_span_name(operation: str) -> str:
    """Builds the stable span name ``cognitum.meta_proxy.<operation>``."""
    return f"cognitum.meta_proxy.{operation}"


def metaharness_span_name(operation: str) -> str:
    """Builds the stable span name ``cognitum.metaharness.<operation>``."""
    return f"cognitum.metaharness.{operation}"


def harnessaas_span_name(operation: str) -> str:
    """Builds the stable span name ``cognitum.harnessaas.<operation>``."""
    return f"cognitum.harnessaas.{operation}"


__all__ = [
    "TRACE_VERSION",
    "DEFAULT_TRACE_FLAGS",
    "MAX_TRACESTATE_MEMBERS",
    "TraceStateMember",
    "parse_trace_parent",
    "generate_trace_parent",
    "parse_trace_state",
    "format_trace_state",
    "join_or_generate_trace_context",
    "meta_llm_span_name",
    "meta_proxy_span_name",
    "metaharness_span_name",
    "harnessaas_span_name",
]
