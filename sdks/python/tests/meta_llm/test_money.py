"""Issue #90: only the simple decimal-string case (``"0.0042"``) was
previously exercised anywhere in this SDK. Adds a round-trip test for a
JSON-number amount sitting exactly on the classic binary-floating-point
boundary, plus a high-precision string that no ``float`` could represent
exactly -- the entire reason ``Money.amount`` is typed as ``Decimal``,
parsed via ``str(amount_raw)`` rather than straight from a ``float``.
"""

from __future__ import annotations

from decimal import Decimal

from cognitum.meta_llm.types.money import parse_money


def test_parses_simple_string_amount() -> None:
    money = parse_money({"amount": "0.0042", "currency": "USD"})
    assert money is not None
    assert money.amount == Decimal("0.0042")
    assert money.currency == "USD"


def test_round_trips_number_amount_at_float_precision_boundary() -> None:
    # 0.1 + 0.2 in IEEE-754 double precision is 0.30000000000000004, not
    # 0.3. Python's `str()` of that float uses the shortest round-tripping
    # decimal representation, so `Decimal(str(amount_raw))` must come back
    # byte-for-byte, proving `parse_money` performs no additional
    # rounding/rescaling of its own on the number path.
    money = parse_money({"amount": 0.30000000000000004, "currency": "USD"})
    assert money is not None
    assert money.amount == Decimal("0.30000000000000004")
    assert str(money.amount) == "0.30000000000000004"


def test_preserves_high_precision_string_amount_exactly() -> None:
    # Beyond what any `float` could represent exactly -- must survive
    # untouched.
    money = parse_money(
        {"amount": "123.456789012345678901234567890", "currency": "USD"}
    )
    assert money is not None
    assert str(money.amount) == "123.456789012345678901234567890"


def test_accepts_currency_code_fallback_key() -> None:
    money = parse_money({"amount": "1.00", "currency_code": "EUR"})
    assert money is not None
    assert money.currency == "EUR"


def test_returns_none_for_missing_or_malformed_value() -> None:
    assert parse_money(None) is None
    assert parse_money({"amount": "1.00"}) is None
    assert parse_money({"currency": "USD"}) is None
    assert parse_money({"amount": True, "currency": "USD"}) is None
