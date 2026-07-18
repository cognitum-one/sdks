"""Regression tests for issue #15 — ``PairCreateResponse.token`` must be
wrapped in :class:`SecretString` so ``repr``, ``str``, and structured
logging of the response do not leak the freshly-minted pairing token.

Covers security-audit finding P-A2 / ADR-0007 §Credential handling.
"""

from __future__ import annotations

from cognitum.seed._models import PairCreateResponse
from cognitum.seed._token_book import SecretString

SENTINEL = "super-secret-token-9f3a2bc81d7e4fa65ceb0f12"


def test_token_is_secret_string_type() -> None:
    resp = PairCreateResponse.from_wire(
        {"paired": True, "token": SENTINEL, "client_name": "c"}
    )
    assert isinstance(resp.token, SecretString)


def test_repr_does_not_leak_token() -> None:
    resp = PairCreateResponse.from_wire(
        {"paired": True, "token": SENTINEL, "client_name": "c"}
    )
    rendered = repr(resp)
    assert SENTINEL not in rendered
    assert "redacted" in rendered.lower()


def test_str_does_not_leak_token() -> None:
    resp = PairCreateResponse.from_wire(
        {"paired": True, "token": SENTINEL, "client_name": "c"}
    )
    rendered = str(resp)
    assert SENTINEL not in rendered


def test_extra_fields_captured_without_token_in_repr() -> None:
    # device_id lives in `extra` (the seed returns it but the dataclass
    # doesn't model it). It is NOT secret, so it's fine for it to appear
    # — this test only guards against the token leak.
    resp = PairCreateResponse.from_wire(
        {
            "paired": True,
            "token": SENTINEL,
            "client_name": "c",
            "device_id": "ad7d7e7b-56e7-4e03-b078-939209858144",
        }
    )
    assert SENTINEL not in repr(resp)
    assert SENTINEL not in str(resp)
    # Non-secret extras remain observable.
    assert resp.extra["device_id"].startswith("ad7d7e7b")


def test_token_value_still_accessible_via_as_str() -> None:
    # Deliberate readback path for the request layer.
    resp = PairCreateResponse.from_wire(
        {"paired": True, "token": SENTINEL, "client_name": "c"}
    )
    assert resp.token.as_str() == SENTINEL
    assert len(resp.token) == len(SENTINEL)
    assert bool(resp.token) is True


def test_empty_token_redacted_but_falsy() -> None:
    # Defensive: a seed that forgot to send `token` still returns a
    # SecretString wrapper — no leaking empty string, and bool() is
    # False so callers can detect the missing value.
    resp = PairCreateResponse.from_wire({"paired": False, "client_name": "c"})
    assert isinstance(resp.token, SecretString)
    assert resp.token.as_str() == ""
    assert bool(resp.token) is False
    assert SENTINEL not in repr(resp)


def test_f_string_interpolation_does_not_leak() -> None:
    resp = PairCreateResponse.from_wire(
        {"paired": True, "token": SENTINEL, "client_name": "c"}
    )
    formatted = f"pair response: {resp}"
    assert SENTINEL not in formatted


def test_logging_format_does_not_leak() -> None:
    # `logger.info("%s", resp)` goes through __str__ / __repr__ — same
    # path as the above but makes the intent explicit.
    resp = PairCreateResponse.from_wire(
        {"paired": True, "token": SENTINEL, "client_name": "c"}
    )
    # Simulate the formatter — intentionally %-style (mirrors
    # `logger.info("%s", resp)`), not a stylistic choice, so it's exempt
    # from the f-string modernization rule.
    simulated = "%s / %r" % (resp, resp)  # noqa: UP031
    assert SENTINEL not in simulated
