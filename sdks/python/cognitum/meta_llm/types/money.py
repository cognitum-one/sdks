"""ADR-0028's ``Money``: an exact decimal amount + ISO-4217 currency,
decoded from wire USD decimal values so cost/price/savings fields never
enter the public domain model as binary floating point (ADR-0024b §D3:
"Wire fields such as current USD price values decode into ADR-0028 decimal
``Money``; they never enter the public domain model as binary floating
point").

Uses the standard-library :class:`decimal.Decimal` (Python's built-in
decimal-safe primitive) rather than a plain ``float`` -- no new dependency
is needed here. ``CostObservation.amount``
(``cognitum.agentic.receipts.CostObservation``) is still a plain ``float``
from the earlier ADR-0028 receipt/lineage stub -- that is an existing gap,
out of scope to fix here, not something this type inherits (reused
verbatim per the task's own instruction).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any


@dataclass(frozen=True)
class Money:
    """Exact decimal amount + ISO-4217 currency code (e.g. ``"USD"``)."""

    amount: Decimal
    currency: str


def parse_money(raw: Any) -> Money | None:
    """Decode a wire money value into a :class:`Money`. Accepts ``amount``
    as either a decimal string (preferred -- exact) or a JSON number
    (tolerated; a JSON number has already lost the ability to represent
    arbitrary decimal precision at the parse boundary, but this decoder
    performs no further floating-point arithmetic on it -- it goes straight
    through ``Decimal(str(amount))``, never rounded or rescaled). Returns
    ``None`` for a missing or malformed value rather than fabricating a
    zero amount.
    """
    if not isinstance(raw, dict):
        return None
    amount_raw = raw.get("amount")
    currency = raw.get("currency") or raw.get("currency_code")
    if not isinstance(currency, str):
        return None
    if isinstance(amount_raw, (str, int, float)) and not isinstance(amount_raw, bool):
        try:
            return Money(amount=Decimal(str(amount_raw)), currency=currency)
        except InvalidOperation:
            return None
    return None


__all__ = ["Money", "parse_money"]
