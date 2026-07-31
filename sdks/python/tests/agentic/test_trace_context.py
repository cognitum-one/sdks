"""Tests for W3C Trace Context parse/generate/join logic and stable
span-name builders (ADR-0028 D2)."""

from __future__ import annotations

from cognitum.agentic.trace_context import (
    DEFAULT_TRACE_FLAGS,
    TraceStateMember,
    format_trace_state,
    generate_trace_parent,
    harnessaas_span_name,
    join_or_generate_trace_context,
    meta_llm_span_name,
    meta_proxy_span_name,
    metaharness_span_name,
    parse_trace_parent,
    parse_trace_state,
)

VALID_TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"


def test_parses_the_spec_example_traceparent() -> None:
    ctx = parse_trace_parent(VALID_TRACEPARENT)
    assert ctx is not None
    assert ctx.trace_parent == VALID_TRACEPARENT
    assert ctx.trace_state is None


def test_rejects_wrong_version() -> None:
    assert parse_trace_parent("01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01") is None
    assert parse_trace_parent("ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01") is None


def test_rejects_wrong_trace_id_length() -> None:
    assert parse_trace_parent("00-4bf92f3577b34da6a3ce929d0e0e47-00f067aa0ba902b7-01") is None
    assert parse_trace_parent("00-4bf92f3577b34da6a3ce929d0e0e473600-00f067aa0ba902b7-01") is None


def test_rejects_all_zero_trace_id() -> None:
    assert parse_trace_parent("00-00000000000000000000000000000000-00f067aa0ba902b7-01") is None


def test_rejects_all_zero_parent_id() -> None:
    assert parse_trace_parent("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01") is None


def test_rejects_wrong_parent_id_length() -> None:
    assert parse_trace_parent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902-01") is None
    assert parse_trace_parent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7ff-01") is None


def test_rejects_wrong_separator_count() -> None:
    assert parse_trace_parent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7") is None
    assert (
        parse_trace_parent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra") is None
    )
    assert parse_trace_parent("not-a-traceparent-at-all-really") is None


def test_rejects_non_hex_characters() -> None:
    assert parse_trace_parent("00-ZZf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01") is None
    assert parse_trace_parent("00-4Bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01") is None
    assert parse_trace_parent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-ZZ") is None


def test_parse_never_raises_on_empty_or_garbage_input() -> None:
    assert parse_trace_parent("") is None
    assert parse_trace_parent("-") is None
    assert parse_trace_parent("----") is None


def test_rejects_wrong_length_trace_flags() -> None:
    assert parse_trace_parent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-0") is None
    assert parse_trace_parent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-011") is None


def test_generate_produces_a_valid_reparseable_traceparent() -> None:
    ctx = generate_trace_parent()
    assert ctx.trace_parent is not None
    reparsed = parse_trace_parent(ctx.trace_parent)
    assert reparsed is not None
    assert reparsed.trace_parent == ctx.trace_parent
    assert ctx.trace_parent.endswith(f"-{DEFAULT_TRACE_FLAGS}")


def test_generate_produces_distinct_values_across_calls() -> None:
    a = generate_trace_parent().trace_parent
    b = generate_trace_parent().trace_parent
    assert a != b


def test_tracestate_round_trips() -> None:
    members = parse_trace_state("congo=t61rcWkgMzE,rojo=00f067aa0ba902b7")
    assert members is not None
    assert len(members) == 2
    assert members[0] == TraceStateMember(key="congo", value="t61rcWkgMzE")
    formatted = format_trace_state(members)
    assert formatted == "congo=t61rcWkgMzE,rojo=00f067aa0ba902b7"
    assert parse_trace_state(formatted) == members


def test_tracestate_accepts_vendor_tenant_key() -> None:
    members = parse_trace_state("tenant-1@vendor=value1")
    assert members is not None
    assert members[0].key == "tenant-1@vendor"


def test_tracestate_rejects_empty_header() -> None:
    assert parse_trace_state("") is None
    assert parse_trace_state("   ") is None


def test_tracestate_rejects_too_many_members() -> None:
    header = ",".join(f"k{i}=v" for i in range(33))
    assert parse_trace_state(header) is None


def test_tracestate_accepts_exactly_32_members() -> None:
    header = ",".join(f"k{i}=v" for i in range(32))
    assert parse_trace_state(header) is not None


def test_tracestate_rejects_malformed_key_and_value() -> None:
    assert parse_trace_state("Congo=value") is None  # uppercase key
    assert parse_trace_state("congo=") is None  # empty value
    assert parse_trace_state("=value") is None  # empty key
    assert parse_trace_state("congo=va,lue") is None  # comma splits into malformed members
    assert parse_trace_state("congo=va=lue") is None  # '=' inside value
    assert parse_trace_state("con go=value") is None  # space in key
    assert parse_trace_state("congo= value") is None  # leading space in value
    assert parse_trace_state("a@b@c=value") is None  # more than one '@'
    # W3C tracestate OWS is space/HTAB only (RFC 7230 OWS) -- a form-feed
    # is not OWS and must not be silently trimmed away, so it fails the
    # key's charset check. Matches Rust's `trim_matches(' ' | '\t')`.
    assert parse_trace_state("\x0ccongo=value") is None


def test_join_with_valid_incoming_header_reuses_trace_id_new_parent_id() -> None:
    joined = join_or_generate_trace_context(VALID_TRACEPARENT)
    assert joined.trace_parent is not None
    assert joined.trace_parent.startswith("00-4bf92f3577b34da6a3ce929d0e0e4736-")
    assert "00f067aa0ba902b7" not in joined.trace_parent


def test_join_with_invalid_incoming_header_falls_back_to_generation_without_raising() -> None:
    joined = join_or_generate_trace_context("garbage-not-a-traceparent")
    assert joined.trace_parent is not None
    assert parse_trace_parent(joined.trace_parent) is not None


def test_join_falls_back_on_a_variety_of_malformed_incoming_headers() -> None:
    bad_inputs = [
        "garbage-not-a-traceparent",
        "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
        "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
        "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        "",
    ]
    for bad in bad_inputs:
        joined = join_or_generate_trace_context(bad)
        assert joined.trace_parent is not None
        message = f"fallback for {bad!r} must be valid"
        assert parse_trace_parent(joined.trace_parent) is not None, message


def test_join_with_no_incoming_header_generates() -> None:
    joined = join_or_generate_trace_context()
    assert joined.trace_parent is not None


def test_join_carries_valid_incoming_tracestate_and_drops_invalid_one() -> None:
    joined = join_or_generate_trace_context(VALID_TRACEPARENT, "congo=t61rcWkgMzE")
    assert joined.trace_state == "congo=t61rcWkgMzE"

    joined_invalid = join_or_generate_trace_context(VALID_TRACEPARENT, "Not Valid")
    assert joined_invalid.trace_state is None


def test_span_name_builders_match_adr_0028_format_exactly() -> None:
    assert (
        meta_llm_span_name("chat.completions.create")
        == "cognitum.meta_llm.chat.completions.create"
    )
    assert meta_proxy_span_name("route") == "cognitum.meta_proxy.route"
    assert metaharness_span_name("score") == "cognitum.metaharness.score"
    assert harnessaas_span_name("solve") == "cognitum.harnessaas.solve"
