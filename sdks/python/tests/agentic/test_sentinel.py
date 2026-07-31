"""SentinelSecretRedactor conformance -- closes cognitum-one/sdks#54 (Python).

Pins the exact mechanism specified by ADR-0028 D13: fixed-format matchers,
an entropy fallback, a D12 key-name check, bounded-depth-8 DFS traversal,
and cycle detection.
"""

from __future__ import annotations

from typing import Any

from cognitum.agentic.sentinel import SentinelSecretRedactor

redactor = SentinelSecretRedactor()

# A syntactically bearer-token-shaped string. Not a real credential.
BEARER_TOKEN = "Bearer AbCdEfGhIjKlMnOpQrStUvWxYz0123456789.-_ABCDEF"

# High-entropy but not a recognized fixed format (no dots, no known prefix).
HIGH_ENTROPY_UNRECOGNIZED = "Xk92LpQz8vT3mNc7Rw4YbHj1FdEa6Su0"

# Realistic 32/64-char hex-encoded secrets (e.g. API keys, session tokens,
# hashes) -- a very common real-world secret shape. Their per-string Shannon
# entropy is 3.46 / 3.68 bits/char: well above the hex-charset-scoped 3.0
# threshold, but nowhere near the unreachable 4.0 theoretical max for a
# 16-symbol alphabet that the old single global threshold required.
HEX_SECRET_32 = "eee65f53e9421ce50211670eae679f02"
HEX_SECRET_64 = "a4c123b1612dd272d1371c17149d439536b3216fdaeeb975729fae923d5a4fd1"

# Long but genuinely low-entropy prose.
NORMAL_SENTENCE = "The quick brown fox jumps over the lazy dog in the summer evening."


def _build_nested(depth: int, leaf: Any) -> Any:
    """Build `depth` levels of nesting (a1 -> a2 -> ... -> a<depth>: leaf)."""
    node: Any = leaf
    for i in range(depth, 0, -1):
        node = {f"a{i}": node}
    return node


def test_a_redacts_bearer_token_shaped_string_in_flat_dict() -> None:
    out = redactor.redact({"authToken": BEARER_TOKEN, "note": "hello"})
    assert out["authToken"] == "[redacted:secret-pattern]"
    assert out["note"] == "hello"


def test_b_redacts_secret_buried_in_nested_dict_depth_under_8() -> None:
    # 3 levels deep: well within the depth-8 bound. Field name deliberately
    # neutral so this exercises the *value-shape* matcher, not the D12
    # key-name check (covered separately below).
    input_ = _build_nested(3, {"value": BEARER_TOKEN, "safe": "ok"})
    out = redactor.redact(input_)
    assert out["a1"]["a2"]["a3"]["value"] == "[redacted:secret-pattern]"
    assert out["a1"]["a2"]["a3"]["safe"] == "ok"


def test_c_replaces_value_at_exactly_depth_9_with_max_depth_marker() -> None:
    # 9 levels of nesting (a1..a9) puts the leaf itself at depth 9.
    input_ = _build_nested(9, BEARER_TOKEN)
    out = redactor.redact(input_)
    assert out["a1"]["a2"]["a3"]["a4"]["a5"]["a6"]["a7"]["a8"]["a9"] == (
        "[max-depth-exceeded]"
    )


def test_d_breaks_cyclic_self_referential_structure_without_infinite_loop() -> None:
    obj: dict[str, Any] = {"name": "root"}
    obj["self"] = obj

    out = redactor.redact(obj)

    assert out["name"] == "root"
    assert out["self"] == "[cyclic-reference]"


def test_e_redacts_high_entropy_string_not_a_recognized_secret_format() -> None:
    assert redactor.classify("note", HIGH_ENTROPY_UNRECOGNIZED) == "secret"
    out = redactor.redact({"note": HIGH_ENTROPY_UNRECOGNIZED})
    assert out["note"] == "[redacted:high-entropy]"


def test_f_does_not_falsely_redact_normal_low_entropy_string() -> None:
    assert redactor.classify("description", NORMAL_SENTENCE) == "public"
    out = redactor.redact({"description": NORMAL_SENTENCE})
    assert out["description"] == NORMAL_SENTENCE


def test_g_redacts_32_char_hex_secret_via_entropy_fallback() -> None:
    # This is the exact case that was silently failing before: a hex-only
    # token's entropy (3.46 bits/char here) can never reach the 4.0 bits/char
    # theoretical max for a 16-symbol alphabet, so a single global 4.0
    # threshold never fires for real hex secrets. The charset-scoped 3.0
    # threshold catches it.
    assert redactor.classify("note", HEX_SECRET_32) == "secret"
    out = redactor.redact({"note": HEX_SECRET_32})
    assert out["note"] == "[redacted:high-entropy]"


def test_h_redacts_64_char_hex_secret_via_entropy_fallback() -> None:
    assert redactor.classify("note", HEX_SECRET_64) == "secret"
    out = redactor.redact({"note": HEX_SECRET_64})
    assert out["note"] == "[redacted:high-entropy]"


def test_classify_consults_d12_key_name_list_independent_of_value_shape() -> None:
    assert redactor.classify("apiKey", "not-secret-shaped-value") == "secret"
    assert redactor.classify("prompt", "hello there") == "sensitive"
    assert redactor.classify("repositoryUrl", "https://example.test/repo") == "sensitive"
    assert redactor.classify("count", "42") == "public"
